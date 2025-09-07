import Docker from 'dockerode';
import { Readable } from 'stream';
import { nanoid } from 'nanoid';
import pLimit from 'p-limit';
import { Config } from '../config/Config.js';
import { Logger } from '../observability/Logger.js';
import { MetricsCollector } from '../observability/MetricsCollector.js';
import { StreamDemuxer } from './StreamDemuxer.js';
import { ExecSession } from './ExecSession.js';

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
          exec,
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
      } catch (error: any) {
        const duration = Date.now() - startTime;
        this.logger.error('Docker exec failed', { 
          traceId, 
          sessionId, 
          error: error.message,
          duration 
        });
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: error.message,
              code: error.statusCode,
              duration,
              sessionId,
              traceId,
            }, null, 2),
          }],
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
      const stream = await container.logs({
        stdout: true,
        stderr: true,
        follow: params.follow || false,
        since: params.since ? Math.floor(new Date(params.since).getTime() / 1000) : undefined,
        tail: params.tail,
        timestamps: true,
      });

      if (params.follow) {
        // Streaming mode
        return this.streamLogs(stream, params.chunkBytes || this.config.defaultChunkBytes, traceId);
      } else {
        // Buffered mode
        return this.bufferLogs(stream, traceId, startTime);
      }
    } catch (error: any) {
      const duration = Date.now() - startTime;
      this.logger.error('Docker logs failed', { traceId, error: error.message, duration });
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: error.message,
            code: error.statusCode,
            duration,
            traceId,
          }, null, 2),
        }],
        isError: true,
      };
    }
  }

  private async streamLogs(stream: Readable, chunkBytes: number, traceId: string): Promise<any> {
    const demuxer = new StreamDemuxer();
    let totalBytes = 0;

    return {
      content: async function* () {
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
        } catch (error: any) {
          yield {
            type: 'text',
            text: JSON.stringify({
              type: 'log_error',
              error: error.message,
              totalBytes,
              traceId,
            }),
          };
        }
      }(),
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
      content: [{
        type: 'text',
        text: JSON.stringify({
          logs: logs.join(''),
          totalBytes,
          duration,
          traceId,
          truncated: totalBytes > this.config.maxBytes,
        }, null, 2),
      }],
    };
  }

  async ps(params: PsParams): Promise<any> {
    try {
      const containers = await this.docker.listContainers({
        all: params.all,
      });

      // Filter by name if specified
      let filtered = containers;
      if (params.name) {
        filtered = containers.filter(c => 
          c.Names.some(n => n.includes(params.name!))
        );
      }

      const result = filtered.map(c => ({
        id: c.Id.substring(0, 12),
        names: c.Names.map(n => n.replace(/^\//, '')),
        image: c.Image,
        command: c.Command,
        created: new Date(c.Created * 1000).toISOString(),
        state: c.State,
        status: c.Status,
        ports: c.Ports.map(p => ({
          private: p.PrivatePort,
          public: p.PublicPort,
          type: p.Type,
        })),
      }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ containers: result }, null, 2),
        }],
      };
    } catch (error: any) {
      this.logger.error('Docker ps failed', { error: error.message });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: error.message }, null, 2),
        }],
        isError: true,
      };
    }
  }

  async inspect(params: InspectParams): Promise<any> {
    try {
      let data: any;

      switch (params.kind) {
        case 'container':
          const container = this.docker.getContainer(params.id);
          data = await container.inspect();
          break;
        case 'image':
          const image = this.docker.getImage(params.id);
          data = await image.inspect();
          break;
        case 'network':
          const network = this.docker.getNetwork(params.id);
          data = await network.inspect();
          break;
        case 'volume':
          const volume = this.docker.getVolume(params.id);
          data = await volume.inspect();
          break;
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data, null, 2),
        }],
      };
    } catch (error: any) {
      this.logger.error('Docker inspect failed', { error: error.message });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: error.message }, null, 2),
        }],
        isError: true,
      };
    }
  }

  async health(): Promise<any> {
    try {
      const info = await this.docker.info();
      const version = await this.docker.version();

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
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
          }, null, 2),
        }],
      };
    } catch (error: any) {
      this.logger.error('Health check failed', { error: error.message });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'unhealthy',
            error: error.message,
          }, null, 2),
        }],
        isError: true,
      };
    }
  }
}