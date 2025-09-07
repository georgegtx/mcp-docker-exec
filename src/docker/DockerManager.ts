import Docker from 'dockerode';
import { Readable } from 'stream';
import { nanoid } from 'nanoid';
import pLimit from 'p-limit';
import { Config } from '../config/Config.js';
import { Logger } from '../observability/Logger.js';
import { MetricsCollector } from '../observability/MetricsCollector.js';
import { StreamDemuxer } from './StreamDemuxer.js';
import { ExecSession } from './ExecSession.js';
import { CircuitBreaker } from '../resilience/CircuitBreaker.js';
import { withTimeout } from '../utils/withTimeout.js';

// Type definitions
interface McpToolResponse {
  content: Array<{
    type: string;
    text: string;
  }> | AsyncGenerator<{
    type: string;
    text: string;
  }>;
  isError?: boolean;
}

interface DockerError extends Error {
  statusCode?: number;
}

export interface ExecParams {
  id: string;
  cmd: string[];
  stdin?: string;
  user?: string;
  workdir?: string;
  env?: string[];
  stream?: boolean;
  tty?: boolean;
  timeoutMs?: number;
  chunkBytes?: number;
}

export interface LogsParams {
  id: string;
  since?: string;
  tail?: string;
  follow?: boolean;
  chunkBytes?: number;
}

export interface PsParams {
  all?: boolean;
  name?: string;
}

export interface InspectParams {
  kind: 'container' | 'image' | 'network' | 'volume';
  id: string;
}

export class DockerManager {
  private docker: Docker;
  private execSessions: Map<string, ExecSession> = new Map();
  private concurrencyLimit: ReturnType<typeof pLimit>;
  private circuitBreaker: CircuitBreaker;
  private sessionCleanupInterval?: NodeJS.Timeout;

  constructor(
    private config: Config,
    private logger: Logger,
    private metrics: MetricsCollector
  ) {
    // Initialize Docker client
    if (config.dockerHost) {
      this.docker = new Docker({ host: config.dockerHost });
    } else {
      this.docker = new Docker(); // Uses default socket
    }

    // Set up concurrency limit
    this.concurrencyLimit = pLimit(config.maxConcurrentExecs);

    // Set up circuit breaker
    this.circuitBreaker = new CircuitBreaker({
      name: 'docker',
      failureThreshold: 5,
      successThreshold: 2,
      timeout: 30000,
      resetTimeout: 60000,
    });

    // Periodic cleanup of stale sessions
    this.sessionCleanupInterval = setInterval(() => {
      void this.cleanupStaleSessions();
    }, 60000); // Every minute
  }

  private async cleanupStaleSessions(): Promise<void> {
    const now = Date.now();
    const staleThreshold = 5 * 60 * 1000; // 5 minutes

    for (const [sessionId, session] of this.execSessions) {
      try {
        // Check if session is stale
        const sessionAge = now - session.getStartTime();
        if (sessionAge > staleThreshold) {
          this.logger.warn('Cleaning up stale session', { sessionId, age: sessionAge });
          await session.abort();
          this.execSessions.delete(sessionId);
        }
      } catch (error) {
        this.logger.error('Error cleaning up session', { sessionId, error });
      }
    }
  }

  async exec(params: ExecParams, traceId: string): Promise<any> {
    const sessionId = nanoid();
    const startTime = Date.now();

    return this.concurrencyLimit(async () => {
      try {
        const container = this.docker.getContainer(params.id);

        // Create exec instance
        const exec = await container.exec({
          Cmd: params.cmd,
          AttachStdin: !!params.stdin,
          AttachStdout: true,
          AttachStderr: true,
          Tty: params.tty || false,
          User: params.user,
          WorkingDir: params.workdir,
          Env: params.env,
        });

        // Create session
        const session = new ExecSession(
          sessionId,
          exec as any,
          container,
          params,
          this.config,
          this.logger,
          this.metrics
        );
        this.execSessions.set(sessionId, session);

        try {
          // Start execution
          const result = await session.start(traceId);

          // Add duration and other metadata
          const duration = Date.now() - startTime;

          return {
            ...result,
            duration,
            sessionId,
            traceId,
          };
        } finally {
          this.execSessions.delete(sessionId);
        }
      } catch (error) {
        const duration = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error('Docker exec failed', {
          traceId,
          sessionId,
          error: errorMessage,
          duration,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  error: errorMessage,
                  code: (error as DockerError).statusCode,
                  duration,
                  sessionId,
                  traceId,
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }
    });
  }

  async logs(params: LogsParams, traceId: string): Promise<any> {
    const startTime = Date.now();

    try {
      const container = this.docker.getContainer(params.id);

      // Get log stream
      const logOptions = {
        stdout: true,
        stderr: true,
        follow: params.follow || false,
        since: params.since ? Math.floor(new Date(params.since).getTime() / 1000) : undefined,
        tail: params.tail ? parseInt(params.tail, 10) : undefined,
        timestamps: true,
      };
      
      let stream: Readable;
      if (params.follow) {
        stream = (await container.logs({ ...logOptions, follow: true })) as unknown as Readable;
      } else {
        const buffer = await container.logs({ ...logOptions, follow: false });
        const { Readable: ReadableConstructor } = await import('stream');
        stream = ReadableConstructor.from(buffer);
      }

      if (params.follow) {
        // Streaming mode
        return this.streamLogs(stream, params.chunkBytes || this.config.defaultChunkBytes, traceId);
      } else {
        // Buffered mode
        return this.bufferLogs(stream, traceId, startTime);
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('Docker logs failed', { traceId, error: errorMessage, duration });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                error: errorMessage,
                  code: (error as DockerError).statusCode,
                duration,
                traceId,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }

  private streamLogs(stream: Readable, chunkBytes: number, traceId: string): any {
    const demuxer = new StreamDemuxer();
    let totalBytes = 0;

    return {
      content: (async function* () {
        try {
          for await (const chunk of demuxer.demuxStream(stream, chunkBytes)) {
            totalBytes += chunk.data.length;

            yield {
              type: 'text',
              text: JSON.stringify({
                type: 'log_chunk',
                timestamp: chunk.timestamp,
                data: chunk.data,
                bytes: chunk.data.length,
                totalBytes,
              }),
            };
          }

          // Final message
          yield {
            type: 'text',
            text: JSON.stringify({
              type: 'log_complete',
              totalBytes,
              traceId,
            }),
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          yield {
            type: 'text',
            text: JSON.stringify({
              type: 'log_error',
              error: errorMessage,
              totalBytes,
              traceId,
            }),
          };
        }
      })(),
    };
  }

  private async bufferLogs(stream: Readable, traceId: string, startTime: number): Promise<any> {
    const demuxer = new StreamDemuxer();
    const logs: string[] = [];
    let totalBytes = 0;

    for await (const chunk of demuxer.demuxStream(stream, this.config.defaultChunkBytes)) {
      logs.push(chunk.data);
      totalBytes += chunk.data.length;

      // Enforce max bytes limit
      if (totalBytes > this.config.maxBytes) {
        logs.push(`\n[Output truncated at ${this.config.maxBytes} bytes]`);
        break;
      }
    }

    const duration = Date.now() - startTime;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              logs: logs.join(''),
              totalBytes,
              duration,
              traceId,
              truncated: totalBytes > this.config.maxBytes,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  async ps(params: PsParams): Promise<any> {
    try {
      const containers = await this.circuitBreaker.execute(async () =>
        withTimeout(
          this.docker.listContainers({
            all: params.all,
          }),
          5000,
          'Docker ps operation'
        )
      );

      // Filter by name if specified
      let filtered = containers;
      if (params.name) {
        filtered = containers.filter((c) => c.Names.some((n) => n.includes(params.name!)));
      }

      const result = filtered.map((c) => ({
        id: c.Id.substring(0, 12),
        names: c.Names.map((n) => n.replace(/^\//, '')),
        image: c.Image,
        command: c.Command,
        created: new Date(c.Created * 1000).toISOString(),
        state: c.State,
        status: c.Status,
        ports: c.Ports.map((p) => ({
          private: p.PrivatePort,
          public: p.PublicPort,
          type: p.Type,
        })),
      }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ containers: result }, null, 2),
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('Docker ps failed', { error: errorMessage });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: errorMessage }, null, 2),
          },
        ],
        isError: true,
      };
    }
  }

  async inspect(params: InspectParams): Promise<any> {
    try {
      let data: unknown;

      switch (params.kind) {
        case 'container': {
          const container = this.docker.getContainer(params.id);
          data = await this.circuitBreaker.execute(async () =>
            withTimeout(container.inspect(), 5000, 'Container inspect')
          );
          break;
        }
        case 'image': {
          const image = this.docker.getImage(params.id);
          data = await this.circuitBreaker.execute(async () =>
            withTimeout(image.inspect(), 5000, 'Image inspect')
          );
          break;
        }
        case 'network': {
          const network = this.docker.getNetwork(params.id);
          data = await this.circuitBreaker.execute(async () =>
            withTimeout(network.inspect(), 5000, 'Network inspect')
          );
          break;
        }
        case 'volume': {
          const volume = this.docker.getVolume(params.id);
          data = await this.circuitBreaker.execute(async () =>
            withTimeout(volume.inspect(), 5000, 'Volume inspect')
          );
          break;
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('Docker inspect failed', { error: errorMessage });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: errorMessage }, null, 2),
          },
        ],
        isError: true,
      };
    }
  }

  async health(): Promise<any> {
    try {
      const [info, version] = await Promise.all([
        this.circuitBreaker.execute(async () =>
          withTimeout(this.docker.info(), 5000, 'Docker info')
        ),
        this.circuitBreaker.execute(async () =>
          withTimeout(this.docker.version(), 5000, 'Docker version')
        ),
      ]);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'healthy',
                docker: {
                  version: version.Version,
                  apiVersion: version.ApiVersion,
                  os: info.OperatingSystem,
                  architecture: info.Architecture,
                  containers: info.Containers,
                  images: info.Images,
                },
                server: {
                  version: '1.0.0',
                  uptime: process.uptime(),
                  memory: process.memoryUsage(),
                  activeSessions: this.execSessions.size,
                },
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('Health check failed', { error: errorMessage });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'unhealthy',
                error: errorMessage,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }

  async cleanup(): Promise<void> {
    // Clear cleanup interval
    if (this.sessionCleanupInterval) {
      clearInterval(this.sessionCleanupInterval);
    }

    // Abort all active sessions
    const abortPromises: Promise<void>[] = [];
    for (const [sessionId, session] of this.execSessions) {
      this.logger.info('Aborting session on cleanup', { sessionId });
      abortPromises.push(
        session
          .abort()
          .catch((err) => this.logger.error('Failed to abort session', { sessionId, error: err }))
      );
    }

    await Promise.all(abortPromises);
    this.execSessions.clear();
  }
}
