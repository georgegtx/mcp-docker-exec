import { writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { Config } from '../config/Config.js';
import { Logger } from '../observability/Logger.js';

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

  constructor(
    private config: Config,
    private logger: Logger
  ) {
    if (config.audit.enabled && config.audit.logFile) {
      this.logFile = config.audit.logFile;
      this.ensureLogFile();
    }
  }

  private ensureLogFile(): void {
    if (!this.logFile) return;

    const dir = dirname(this.logFile);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    if (!existsSync(this.logFile)) {
      writeFileSync(this.logFile, '');
    }
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
    const line = JSON.stringify(entry) + '\n';

    if (this.logFile) {
      try {
        appendFileSync(this.logFile, line);
      } catch (error) {
        this.logger.error('Failed to write audit log', { error, file: this.logFile });
      }
    }

    // Also log to standard logger
    this.logger.info('Audit', entry);
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