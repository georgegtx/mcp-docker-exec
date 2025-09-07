import { Readable, Writable } from 'stream';
import { ExecParams } from './DockerManager.js';
import { StreamDemuxer } from './StreamDemuxer.js';
import { Config } from '../config/Config.js';
import { Logger } from '../observability/Logger.js';
import { MetricsCollector } from '../observability/MetricsCollector.js';

export class ExecSession {
  private abortController: AbortController;
  private stdout: string[] = [];
  private stderr: string[] = [];
  private outputBytes = 0;
  private exitCode: number | null = null;
  private startTime: number = 0;

  constructor(
    private sessionId: string,
    private exec: any, // Docker exec instance
    private params: ExecParams,
    private config: Config,
    private logger: Logger,
    private metrics: MetricsCollector
  ) {
    this.abortController = new AbortController();
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

    return {
      content: async function* (session: ExecSession) {
        try {
          // Yield chunks as they arrive
          for await (const chunk of demuxer.demuxStream(stream, chunkBytes)) {
            lastActivity = Date.now();
            session.outputBytes += chunk.data.length;
            
            // Update metrics
            session.metrics.recordOutputBytes(chunk.data.length);

            // Store for exit code retrieval
            if (chunk.channel === 'stdout') {
              session.stdout.push(chunk.data);
            } else {
              session.stderr.push(chunk.data);
            }

            yield {
              type: 'text',
              text: JSON.stringify({
                type: 'exec_chunk',
                channel: chunk.channel,
                data: chunk.data,
                timestamp: chunk.timestamp,
                bytes: chunk.data.length,
                totalBytes: session.outputBytes,
                sessionId: session.sessionId,
              }),
            };
          }

          // Get exit code
          const inspectResult = await session.exec.inspect();
          session.exitCode = inspectResult.ExitCode;

          // Clear timeout
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }

          // Final message with exit code
          yield {
            type: 'text',
            text: JSON.stringify({
              type: 'exec_complete',
              exitCode: session.exitCode,
              totalBytes: session.outputBytes,
              duration: Date.now() - session.startTime,
              sessionId: session.sessionId,
              traceId,
            }),
          };
        } catch (error: any) {
          if (error.name === 'AbortError') {
            yield {
              type: 'text',
              text: JSON.stringify({
                type: 'exec_cancelled',
                reason: session.params.timeoutMs ? 'timeout' : 'client_cancel',
                totalBytes: session.outputBytes,
                duration: Date.now() - session.startTime,
                sessionId: session.sessionId,
                traceId,
              }),
            };
          } else {
            yield {
              type: 'text',
              text: JSON.stringify({
                type: 'exec_error',
                error: error.message,
                totalBytes: session.outputBytes,
                duration: Date.now() - session.startTime,
                sessionId: session.sessionId,
                traceId,
              }),
            };
          }
        } finally {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
        }
      }(this),
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
          this.stdout.push(chunk.data);
        } else {
          this.stderr.push(chunk.data);
        }
        
        this.outputBytes += chunk.data.length;

        // Enforce max bytes limit in buffered mode
        if (this.outputBytes > this.config.maxBytes) {
          this.stdout.push(`\n[stdout truncated at ${this.config.maxBytes} bytes]`);
          this.stderr.push(`\n[stderr truncated at ${this.config.maxBytes} bytes]`);
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
        content: [{
          type: 'text',
          text: JSON.stringify({
            stdout: this.stdout.join(''),
            stderr: this.stderr.join(''),
            exitCode: this.exitCode,
            outputBytes: this.outputBytes,
            duration,
            sessionId: this.sessionId,
            traceId,
            truncated: this.outputBytes > this.config.maxBytes,
          }, null, 2),
        }],
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
      content: [{
        type: 'text',
        text: JSON.stringify({
          cancelled: true,
          reason: this.params.timeoutMs ? 'timeout' : 'client_cancel',
          stdout: this.stdout.join(''),
          stderr: this.stderr.join(''),
          outputBytes: this.outputBytes,
          duration,
          sessionId: this.sessionId,
          traceId,
        }, null, 2),
      }],
    };
  }

  abort(): void {
    this.abortController.abort();
  }
}