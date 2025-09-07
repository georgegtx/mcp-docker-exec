import { createWriteStream, existsSync, mkdirSync, WriteStream } from 'fs';
import { dirname } from 'path';
import { promisify } from 'util';
import { pipeline } from 'stream';
import { Config } from '../config/Config.js';
import { Logger } from '../observability/Logger.js';

const pipelineAsync = promisify(pipeline);

export interface AuditEntry {
  timestamp: string;
  traceId: string;
  operation: 'exec' | 'logs';
  containerId: string;
  command?: string[];
  user?: string;
  exitCode?: number | null;
  duration?: number;
  outputBytes?: number;
  blocked?: boolean;
  reason?: string;
  clientInfo?: {
    user?: string;
    ip?: string;
  };
}

export class AuditLogger {
  private logFile?: string;
  private writeStream?: WriteStream;
  private writeQueue: string[] = [];
  private isWriting = false;
  private flushInterval?: NodeJS.Timeout;
  private closed = false;

  constructor(
    private config: Config,
    private logger: Logger
  ) {
    if (config.audit.enabled && config.audit.logFile) {
      this.logFile = config.audit.logFile;
      this.initializeStream();
      
      // Flush queue periodically
      this.flushInterval = setInterval(() => {
        this.flushQueue().catch(err => 
          this.logger.error('Failed to flush audit queue', { error: err })
        );
      }, 1000);
    }
  }

  private initializeStream(): void {
    if (!this.logFile) return;

    const dir = dirname(this.logFile);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.writeStream = createWriteStream(this.logFile, { 
      flags: 'a',
      encoding: 'utf8',
      highWaterMark: 64 * 1024 // 64KB buffer
    });

    this.writeStream.on('error', (error) => {
      this.logger.error('Audit write stream error', { error, file: this.logFile });
    });
  }

  logExec(params: {
    traceId: string;
    containerId: string;
    command: string[];
    user?: string;
    exitCode?: number | null;
    duration?: number;
    outputBytes?: number;
    blocked?: boolean;
    reason?: string;
    stdin?: string;
  }): void {
    if (!this.config.audit.enabled) return;

    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      traceId: params.traceId,
      operation: 'exec',
      containerId: params.containerId,
      command: params.command,
      user: params.user,
      exitCode: params.exitCode,
      duration: params.duration,
      outputBytes: params.outputBytes,
      blocked: params.blocked,
      reason: params.reason,
    };

    this.writeEntry(entry);

    // Also log stdin if configured (be careful with sensitive data)
    if (this.config.audit.includeStdin && params.stdin) {
      this.logger.debug('Exec stdin audit', {
        traceId: params.traceId,
        stdinLength: params.stdin.length,
        stdinPreview: params.stdin.substring(0, 100),
      });
    }
  }

  logLogs(params: {
    traceId: string;
    containerId: string;
    follow: boolean;
    duration?: number;
    bytesRead?: number;
  }): void {
    if (!this.config.audit.enabled) return;

    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      traceId: params.traceId,
      operation: 'logs',
      containerId: params.containerId,
      duration: params.duration,
      outputBytes: params.bytesRead,
    };

    this.writeEntry(entry);
  }

  private writeEntry(entry: AuditEntry): void {
    if (this.closed) {
      this.logger.warn('Attempted to write to closed audit logger');
      return;
    }

    const line = JSON.stringify(entry) + '\n';
    
    // Add to queue
    this.writeQueue.push(line);
    
    // Also log to standard logger
    this.logger.info('Audit', entry);
    
    // Trigger flush if queue is getting large
    if (this.writeQueue.length > 100) {
      this.flushQueue().catch(err => 
        this.logger.error('Failed to flush audit queue', { error: err })
      );
    }
  }

  private async flushQueue(): Promise<void> {
    if (this.isWriting || this.writeQueue.length === 0 || !this.writeStream) {
      return;
    }

    this.isWriting = true;
    const toWrite = [...this.writeQueue];
    this.writeQueue = [];

    try {
      const chunk = toWrite.join('');
      
      // Write with backpressure handling
      if (!this.writeStream.write(chunk)) {
        // Wait for drain event
        await new Promise<void>((resolve) => {
          this.writeStream!.once('drain', resolve);
        });
      }
    } catch (error) {
      this.logger.error('Failed to write audit entries', { 
        error, 
        entriesLost: toWrite.length 
      });
      
      // Re-queue failed entries at the front
      this.writeQueue.unshift(...toWrite);
    } finally {
      this.isWriting = false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }
    
    // Final flush
    await this.flushQueue();
    
    // Close stream
    if (this.writeStream) {
      await new Promise<void>((resolve, reject) => {
        this.writeStream!.end((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }

  // Cleanup old audit logs based on retention policy
  async cleanupOldLogs(): Promise<void> {
    if (!this.config.audit.enabled || !this.logFile) return;

    // Implementation would read the log file, filter out old entries,
    // and rewrite the file. For production, consider using log rotation
    // tools like logrotate instead.
    this.logger.debug('Audit log cleanup not yet implemented');
  }
}