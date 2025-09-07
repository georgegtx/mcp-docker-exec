import { Readable, Writable } from 'stream';
import { ExecParams } from './DockerManager.js';
import { StreamDemuxer } from './StreamDemuxer.js';
import { Config } from '../config/Config.js';
import { Logger } from '../observability/Logger.js';
import { MetricsCollector } from '../observability/MetricsCollector.js';
import { CircularBuffer } from '../utils/CircularBuffer.js';

export class ExecSession {
  private abortController: AbortController;
  private stdoutBuffer: CircularBuffer;
  private stderrBuffer: CircularBuffer;
  private outputBytes = 0;
  private exitCode: number | null = null;
  private startTime: number = 0;
  private cleanupTimeouts: Set<NodeJS.Timeout> = new Set();

  constructor(
    private sessionId: string,
    private exec: any, // Docker exec instance
    private container: any, // Docker container instance
    private params: ExecParams,
    private config: Config,
    private logger: Logger,
    private metrics: MetricsCollector
  ) {
    this.abortController = new AbortController();

    // Initialize circular buffers with reasonable limits
    const maxBufferItems = this.params.stream ? 100 : 10000; // Less retention in streaming mode
    const maxBufferBytes = this.params.stream ? 1024 * 1024 : this.config.maxBytes; // 1MB in streaming, config max in buffered

    this.stdoutBuffer = new CircularBuffer(maxBufferItems, maxBufferBytes);
    this.stderrBuffer = new CircularBuffer(maxBufferItems, maxBufferBytes);
  }

  async start(traceId: string): Promise<any> {
    this.startTime = Date.now();

    try {
      // Start the exec
      const stream = await this.exec.start({
        stdin: !!this.params.stdin,
        Tty: this.params.tty || false,
        Detach: false,
        abortSignal: this.abortController.signal,
      });

      // Handle stdin if provided
      if (this.params.stdin) {
        await this.handleStdin(stream);
      }

      // Handle output based on mode
      if (this.params.stream) {
        return await this.handleStreaming(stream, traceId);
      } else {
        return await this.handleBuffered(stream, traceId);
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        return this.createCancelledResult(traceId);
      }
      throw error;
    }
  }

  private async handleStdin(stream: any): Promise<void> {
    const stdin = stream as Writable;
    return new Promise((resolve, reject) => {
      stdin.write(this.params.stdin!, (err) => {
        if (err) {
          reject(err);
        } else {
          stdin.end();
          resolve();
        }
      });
    });
  }

  private async handleStreaming(stream: Readable, traceId: string): Promise<any> {
    const demuxer = new StreamDemuxer();
    const chunkBytes = this.params.chunkBytes || this.config.defaultChunkBytes;
    let lastActivity = Date.now();

    // Set up timeout if specified
    let timeoutHandle: NodeJS.Timeout | null = null;
    if (this.params.timeoutMs) {
      timeoutHandle = setTimeout(() => {
        this.abort();
      }, this.params.timeoutMs);
    }

    const self = this;
    return {
      content: (async function* () {
        try {
          // Yield chunks as they arrive
          for await (const chunk of demuxer.demuxStream(stream, chunkBytes)) {
            lastActivity = Date.now();
            self.outputBytes += chunk.data.length;

            // Update metrics
            self.metrics.recordOutputBytes(chunk.data.length);

            // Store for exit code retrieval
            if (chunk.channel === 'stdout') {
              self.stdoutBuffer.push(chunk.data);
            } else {
              self.stderrBuffer.push(chunk.data);
            }

            yield {
              type: 'text',
              text: JSON.stringify({
                type: 'exec_chunk',
                channel: chunk.channel,
                data: chunk.data,
                timestamp: chunk.timestamp,
                bytes: chunk.data.length,
                totalBytes: self.outputBytes,
                sessionId: self.sessionId,
              }),
            };
          }

          // Get exit code
          const inspectResult = await self.exec.inspect();
          self.exitCode = inspectResult.ExitCode;

          // Clear timeout
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }

          // Final message with exit code
          yield {
            type: 'text',
            text: JSON.stringify({
              type: 'exec_complete',
              exitCode: self.exitCode,
              totalBytes: self.outputBytes,
              duration: Date.now() - self.startTime,
              sessionId: self.sessionId,
              traceId,
            }),
          };
        } catch (error: any) {
          if (error.name === 'AbortError') {
            yield {
              type: 'text',
              text: JSON.stringify({
                type: 'exec_cancelled',
                reason: self.params.timeoutMs ? 'timeout' : 'client_cancel',
                totalBytes: self.outputBytes,
                duration: Date.now() - self.startTime,
                sessionId: self.sessionId,
                traceId,
              }),
            };
          } else {
            yield {
              type: 'text',
              text: JSON.stringify({
                type: 'exec_error',
                error: error.message,
                totalBytes: self.outputBytes,
                duration: Date.now() - self.startTime,
                sessionId: self.sessionId,
                traceId,
              }),
            };
          }
        } finally {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
        }
      })(),
    };
  }

  private async handleBuffered(stream: Readable, traceId: string): Promise<any> {
    const demuxer = new StreamDemuxer();

    // Set up timeout if specified
    let timeoutHandle: NodeJS.Timeout | null = null;
    if (this.params.timeoutMs) {
      timeoutHandle = setTimeout(() => {
        this.abort();
      }, this.params.timeoutMs);
    }

    try {
      // Collect output
      for await (const chunk of demuxer.demuxStream(stream, this.config.defaultChunkBytes)) {
        if (chunk.channel === 'stdout') {
          this.stdoutBuffer.push(chunk.data);
        } else {
          this.stderrBuffer.push(chunk.data);
        }

        this.outputBytes += chunk.data.length;

        // Enforce max bytes limit in buffered mode
        if (this.outputBytes > this.config.maxBytes) {
          this.stdoutBuffer.push(`\n[stdout truncated at ${this.config.maxBytes} bytes]`);
          this.stderrBuffer.push(`\n[stderr truncated at ${this.config.maxBytes} bytes]`);
          break;
        }
      }

      // Get exit code
      const inspectResult = await this.exec.inspect();
      this.exitCode = inspectResult.ExitCode;

      // Clear timeout
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      const duration = Date.now() - this.startTime;

      // Return complete result
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                stdout: this.stdoutBuffer.getContents(),
                stderr: this.stderrBuffer.getContents(),
                exitCode: this.exitCode,
                outputBytes: this.outputBytes,
                duration,
                sessionId: this.sessionId,
                traceId,
                truncated: this.outputBytes > this.config.maxBytes,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      if (error.name === 'AbortError') {
        return this.createCancelledResult(traceId);
      }
      throw error;
    }
  }

  private createCancelledResult(traceId: string): any {
    const duration = Date.now() - this.startTime;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              cancelled: true,
              reason: this.params.timeoutMs ? 'timeout' : 'client_cancel',
              stdout: this.stdoutBuffer.getContents(),
              stderr: this.stderrBuffer.getContents(),
              outputBytes: this.outputBytes,
              duration,
              sessionId: this.sessionId,
              traceId,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  getStartTime(): number {
    return this.startTime;
  }

  private cleanupAllTimeouts(): void {
    for (const timeout of this.cleanupTimeouts) {
      clearTimeout(timeout);
    }
    this.cleanupTimeouts.clear();
  }

  async abort(): Promise<void> {
    this.abortController.abort();
    this.cleanupAllTimeouts();

    try {
      // Check if exec is still running
      const inspectResult = await this.exec.inspect();

      if (inspectResult.Running) {
        this.logger.info('Attempting to kill running exec', {
          sessionId: this.sessionId,
          pid: inspectResult.Pid,
        });

        // Docker doesn't provide a direct kill method for exec,
        // but we can use the resize trick to send SIGWINCH which often interrupts
        try {
          await this.exec.resize({ h: 0, w: 0 });
        } catch (e) {
          // Resize might fail if process already exited
          this.logger.debug('Resize failed during abort', { error: e });
        }

        // For containers with specific kill support, we could exec a kill command
        // This is a last resort and requires knowing the PID
        if (inspectResult.Pid && inspectResult.Pid > 0) {
          try {
            const killExec = await this.container.exec({
              Cmd: ['kill', '-TERM', String(inspectResult.Pid)],
              AttachStdout: false,
              AttachStderr: false,
            });
            await killExec.start({ Detach: true });

            // Give it a moment, then force kill if needed
            const forceKillTimeout = setTimeout(async () => {
              try {
                const checkResult = await this.exec.inspect();
                if (checkResult.Running) {
                  const forceKillExec = await this.container.exec({
                    Cmd: ['kill', '-KILL', String(inspectResult.Pid)],
                    AttachStdout: false,
                    AttachStderr: false,
                  });
                  await forceKillExec.start({ Detach: true });
                }
              } catch (err) {
                this.logger.error('Error during force kill in setTimeout', { error: err });
              } finally {
                this.cleanupTimeouts.delete(forceKillTimeout);
              }
            }, 2000);

            this.cleanupTimeouts.add(forceKillTimeout);
          } catch (e) {
            this.logger.warn('Failed to send kill signal', { error: e });
          }
        }
      }
    } catch (error) {
      this.logger.error('Error during exec abort', {
        sessionId: this.sessionId,
        error,
      });
    }
  }
}
