import { Config } from '../config/Config.js';
import { Logger } from '../observability/Logger.js';
import { ExecParams } from '../docker/DockerManager.js';
import { DistributedRateLimiter } from './DistributedRateLimiter.js';

export interface SecurityCheckResult {
  allowed: boolean;
  reason?: string;
}

export class SecurityManager {
  private rateLimiter: DistributedRateLimiter | null = null;

  constructor(
    private config: Config,
    private logger: Logger
  ) {
    // Rate limiter will be initialized asynchronously
  }

  static async create(config: Config, logger: Logger): Promise<SecurityManager> {
    const manager = new SecurityManager(config, logger);
    
    // Initialize distributed rate limiter
    const redisUrl = process.env.REDIS_URL || process.env.MCP_DOCKER_REDIS_URL;
    manager.rateLimiter = await DistributedRateLimiter.create(redisUrl);
    
    return manager;
  }

  async checkCommand(cmd: string[], params: ExecParams): Promise<SecurityCheckResult> {
    if (!this.config.security.enabled) {
      return { allowed: true };
    }

    // Check rate limits
    const rateCheck = await this.checkRateLimit('exec');
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

  private async checkRateLimit(operation: string, identifier?: string): Promise<SecurityCheckResult> {
    if (!this.config.rateLimits.enabled) {
      return { allowed: true };
    }

    if (!this.rateLimiter) {
      this.logger.warn('Rate limiter not initialized, allowing request');
      return { allowed: true };
    }

    // Use client identifier if available, otherwise use a default
    const clientId = identifier || 'default';
    
    const limit = operation === 'exec' 
      ? this.config.rateLimits.execPerMinute 
      : this.config.rateLimits.logsPerMinute;

    const result = await this.rateLimiter.checkLimit(
      clientId,
      operation,
      limit,
      60000 // 1 minute window
    );

    if (!result.allowed) {
      return {
        allowed: false,
        reason: `Rate limit exceeded: ${result.current}/${result.limit} ${operation}s per minute. Reset at ${new Date(result.resetAt).toISOString()}`,
      };
    }

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

    // Check for shell injection attempts
    const shellInjectionCheck = this.checkShellInjection(cmd);
    if (!shellInjectionCheck.allowed) {
      return shellInjectionCheck;
    }

    // Normalize command for comparison
    const fullCommand = cmd.join(' ');
    const commandBinary = cmd[0];
    
    // Check if it's a shell command that could execute arbitrary code
    const dangerousShells = ['sh', 'bash', 'zsh', 'ash', 'dash', 'ksh', 'csh', 'tcsh'];
    if (dangerousShells.includes(commandBinary) && cmd.includes('-c')) {
      // Extract the actual command being run
      const cIndex = cmd.indexOf('-c');
      if (cIndex !== -1 && cIndex + 1 < cmd.length) {
        const shellCommand = cmd[cIndex + 1];
        // Check the shell command against policies
        const shellCheck = this.checkPatternMatch([shellCommand], patterns, mode);
        if (!shellCheck.allowed) {
          return {
            allowed: false,
            reason: `Shell command blocked: ${shellCheck.reason}`,
          };
        }
      }
    }

    return this.checkPatternMatch(cmd, patterns, mode);
  }

  private checkPatternMatch(cmd: string[], patterns: string[], mode: string): SecurityCheckResult {
    const fullCommand = cmd.join(' ');
    
    const matches = patterns.some(pattern => {
      try {
        // Compile regex with case-insensitive flag for better matching
        const regex = new RegExp(pattern, 'i');
        return regex.test(fullCommand);
      } catch {
        // Treat as literal string match if not valid regex
        return fullCommand.toLowerCase().includes(pattern.toLowerCase());
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

  private checkShellInjection(cmd: string[]): SecurityCheckResult {
    // Common shell injection patterns
    const injectionPatterns = [
      /;\s*rm\s+-rf/i,
      /&&\s*rm\s+-rf/i,
      /\|\s*rm\s+-rf/i,
      /`[^`]*rm\s+-rf/i,
      /\$\([^)]*rm\s+-rf/i,
      /;\s*dd\s+if=/i,
      /&&\s*dd\s+if=/i,
      /\|\s*dd\s+if=/i,
      /;\s*mkfs/i,
      /&&\s*mkfs/i,
      />\s*\/dev\/[^\/\s]+/,
      /;\s*reboot/i,
      /;\s*shutdown/i,
      /;\s*halt/i,
      /;\s*poweroff/i,
    ];

    const cmdString = cmd.join(' ');
    
    for (const pattern of injectionPatterns) {
      if (pattern.test(cmdString)) {
        return {
          allowed: false,
          reason: 'Potential shell injection detected',
        };
      }
    }

    // Check for Unicode homoglyphs that could bypass filters
    if (this.containsHomoglyphs(cmdString)) {
      return {
        allowed: false,
        reason: 'Unicode homoglyphs detected in command',
      };
    }

    return { allowed: true };
  }

  private containsHomoglyphs(text: string): boolean {
    // Common homoglyphs that could be used to bypass filters
    const homoglyphPatterns = [
      /[\u0430\u043E\u0441\u0435\u0440\u043C]/i, // Cyrillic letters that look like Latin
      /[\u03BF\u03C1]/i, // Greek letters
      /[\u2010-\u2015\u2212]/i, // Various dashes that look like hyphens
    ];

    return homoglyphPatterns.some(pattern => pattern.test(text));
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

  async checkLogsAccess(containerId: string): Promise<SecurityCheckResult> {
    if (!this.config.security.enabled) {
      return { allowed: true };
    }

    return this.checkRateLimit('logs');
  }

  async close(): Promise<void> {
    if (this.rateLimiter) {
      await this.rateLimiter.close();
    }
  }
}