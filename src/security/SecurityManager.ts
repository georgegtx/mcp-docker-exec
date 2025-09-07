import { Config } from '../config/Config.js';
import { Logger } from '../observability/Logger.js';
import { ExecParams } from '../docker/DockerManager.js';

export interface SecurityCheckResult {
  allowed: boolean;
  reason?: string;
}

export class SecurityManager {
  private execCounts: Map<string, number[]> = new Map();

  constructor(
    private config: Config,
    private logger: Logger
  ) {}

  async checkCommand(cmd: string[], params: ExecParams): Promise<SecurityCheckResult> {
    if (!this.config.security.enabled) {
      return { allowed: true };
    }

    // Check rate limits
    const rateCheck = this.checkRateLimit('exec');
    if (!rateCheck.allowed) {
      return rateCheck;
    }

    // Check user permissions
    const userCheck = this.checkUser(params.user);
    if (!userCheck.allowed) {
      return userCheck;
    }

    // Check command against policy
    const commandCheck = this.checkCommandPolicy(cmd);
    if (!commandCheck.allowed) {
      return commandCheck;
    }

    // Check for dangerous flags
    const flagCheck = this.checkDangerousFlags(cmd);
    if (!flagCheck.allowed) {
      return flagCheck;
    }

    // Check paths
    const pathCheck = this.checkPaths(cmd);
    if (!pathCheck.allowed) {
      return pathCheck;
    }

    return { allowed: true };
  }

  private checkRateLimit(operation: string): SecurityCheckResult {
    if (!this.config.rateLimits.enabled) {
      return { allowed: true };
    }

    const now = Date.now();
    const minute = Math.floor(now / 60000);
    const key = `${operation}-${minute}`;

    // Clean old entries
    for (const [k, _] of this.execCounts) {
      const [_, m] = k.split('-');
      if (parseInt(m) < minute - 1) {
        this.execCounts.delete(k);
      }
    }

    // Get current count
    const counts = this.execCounts.get(key) || [];
    const limit = operation === 'exec' 
      ? this.config.rateLimits.execPerMinute 
      : this.config.rateLimits.logsPerMinute;

    if (counts.length >= limit) {
      return {
        allowed: false,
        reason: `Rate limit exceeded: ${counts.length}/${limit} ${operation}s per minute`,
      };
    }

    // Update count
    counts.push(now);
    this.execCounts.set(key, counts);

    return { allowed: true };
  }

  private checkUser(user?: string): SecurityCheckResult {
    if (!user && this.config.security.defaultUser) {
      // Will use default user, which is fine
      return { allowed: true };
    }

    if ((user === 'root' || user === '0' || !user) && !this.config.security.allowRoot) {
      return {
        allowed: false,
        reason: 'Root user execution not allowed. Set MCP_DOCKER_ALLOW_ROOT=true to enable.',
      };
    }

    return { allowed: true };
  }

  private checkCommandPolicy(cmd: string[]): SecurityCheckResult {
    const mode = this.config.security.commandPolicy.mode;
    const patterns = this.config.security.commandPolicy.patterns;

    if (mode === 'none' || patterns.length === 0) {
      return { allowed: true };
    }

    const fullCommand = cmd.join(' ');
    const matches = patterns.some(pattern => {
      try {
        const regex = new RegExp(pattern);
        return regex.test(fullCommand);
      } catch {
        // Treat as literal string match if not valid regex
        return fullCommand.includes(pattern);
      }
    });

    if (mode === 'allowlist') {
      return matches 
        ? { allowed: true }
        : { allowed: false, reason: `Command not in allowlist: ${cmd[0]}` };
    } else { // denylist
      return matches
        ? { allowed: false, reason: `Command matches denylist: ${cmd[0]}` }
        : { allowed: true };
    }
  }

  private checkDangerousFlags(cmd: string[]): SecurityCheckResult {
    const cmdString = cmd.join(' ');
    
    for (const flag of this.config.security.deniedFlags) {
      if (cmdString.includes(flag)) {
        return {
          allowed: false,
          reason: `Dangerous flag detected: ${flag}`,
        };
      }
    }

    return { allowed: true };
  }

  private checkPaths(cmd: string[]): SecurityCheckResult {
    const cmdString = cmd.join(' ');
    
    for (const path of this.config.security.pathPolicy.deniedPaths) {
      // Check if command references denied path
      if (cmdString.includes(path)) {
        // Allow read-only operations like ls, cat, but block write operations
        const isReadOnly = cmd[0] && ['ls', 'cat', 'head', 'tail', 'grep', 'find'].includes(cmd[0]);
        if (!isReadOnly) {
          return {
            allowed: false,
            reason: `Access to ${path} is restricted`,
          };
        }
      }
    }

    return { allowed: true };
  }

  checkLogsAccess(containerId: string): SecurityCheckResult {
    if (!this.config.security.enabled) {
      return { allowed: true };
    }

    return this.checkRateLimit('logs');
  }
}