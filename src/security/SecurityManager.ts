import { Config } from '../config/Config.js';
import { Logger } from '../observability/Logger.js';
import { ExecParams } from '../docker/DockerManager.js';
import { DistributedRateLimiter } from './DistributedRateLimiter.js';
import { ShellCommandParser } from './ShellCommandParser.js';

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
        
        // Use robust parser to extract all commands including those in substitutions
        const { commands, suspicious } = ShellCommandParser.parse(shellCommand);
        
        // Check for command substitution attempts
        if (suspicious.length > 0) {
          this.logger.warn('Command substitution detected', { 
            shellCommand, 
            suspicious 
          });
          return {
            allowed: false,
            reason: `Command substitution detected: ${suspicious.join(', ')}. This could be used to bypass security policies.`,
          };
        }
        
        // Check for dangerous patterns
        const { dangerous, patterns: dangerousPatterns } = ShellCommandParser.containsDangerousPatterns(shellCommand);
        if (dangerous) {
          return {
            allowed: false,
            reason: `Dangerous command pattern detected: ${dangerousPatterns.join(', ')}`,
          };
        }
        
        // Check each extracted command against policies
        for (const subCmd of commands) {
          const shellCheck = this.checkPatternMatch([subCmd], patterns, mode);
          if (!shellCheck.allowed) {
            return {
              allowed: false,
              reason: `Shell command blocked: ${shellCheck.reason}`,
            };
          }
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
    // Comprehensive homoglyph detection
    // Map of Latin characters to their homoglyph Unicode ranges
    const homoglyphMappings: { [key: string]: RegExp[] } = {
      // Latin lowercase
      'a': [/[\u0430\u0251\u0252\u03B1\u0433]/], // Cyrillic а, Latin alpha, Greek alpha, Cyrillic г
      'b': [/[\u0184\u0185\u03B2\u0432\u13CF\u15AF]/], // Various b-like characters
      'c': [/[\u0441\u03F2\u0188\u21BB]/], // Cyrillic с, Greek lunate sigma
      'd': [/[\u0501\u0256\u0257\u018C]/], // Various d-like characters
      'e': [/[\u0435\u0454\u04BD\u03B5]/], // Cyrillic е, є, Greek epsilon
      'g': [/[\u0261\u01E5\u0123]/], // Various g-like characters
      'h': [/[\u04BB\u04C2\u0570]/], // Cyrillic һ, Armenian հ
      'i': [/[\u0456\u04CF\u0269\u03B9]/], // Cyrillic і, Greek iota
      'j': [/[\u0458\u03F3\u0135]/], // Cyrillic ј
      'k': [/[\u03BA\u043A\u049B\u049D]/], // Greek kappa, Cyrillic к
      'l': [/[\u0049\u006C\u0031\u01C0\u04C0\u0399]/], // Various l/1/I confusables
      'm': [/[\u043C\u03BC\u0271]/], // Cyrillic м, Greek mu
      'n': [/[\u043F\u0578\u057C]/], // Cyrillic п (looks like n), Armenian ո, ռ
      'o': [/[\u043E\u03BF\u03C3\u0585\u05E1]/], // Cyrillic о, Greek omicron/sigma
      'p': [/[\u0440\u03C1\u0420\u2374]/], // Cyrillic р, Greek rho
      'r': [/[\u0433\u0491\u0280]/], // Cyrillic г, ґ
      's': [/[\u0455\u05E1]/], // Cyrillic ѕ, Hebrew samekh
      't': [/[\u03C4\u0442]/], // Greek tau, Cyrillic т
      'u': [/[\u03C5\u057D\u0446]/], // Greek upsilon, Armenian ս
      'v': [/[\u03BD\u0474\u05D8]/], // Greek nu, Cyrillic Ѵ
      'w': [/[\u03C9\u0448\u051C]/], // Greek omega, Cyrillic ш
      'x': [/[\u0445\u03C7\u04B3]/], // Cyrillic х, Greek chi
      'y': [/[\u0443\u04AF\u04B1]/], // Cyrillic у, ү, ұ
      'z': [/[\u0290\u0291]/], // Various z-like characters
      
      // Latin uppercase
      'A': [/[\u0391\u0410\u13AA]/], // Greek Alpha, Cyrillic А
      'B': [/[\u0392\u0412\u13F4]/], // Greek Beta, Cyrillic В
      'C': [/[\u0421\u03F9\u216D]/], // Cyrillic С, Greek Ϲ
      'E': [/[\u0395\u0415\u13AC]/], // Greek Epsilon, Cyrillic Е
      'H': [/[\u0397\u041D\u13BB]/], // Greek Eta, Cyrillic Н
      'I': [/[\u0406\u04C0\u0399]/], // Cyrillic І, Greek Iota
      'K': [/[\u039A\u041A\u13E6]/], // Greek Kappa, Cyrillic К
      'M': [/[\u039C\u041C\u13B7]/], // Greek Mu, Cyrillic М
      'N': [/[\u039D\u13C0]/], // Greek Nu
      'O': [/[\u039F\u041E\u13C1]/], // Greek Omicron, Cyrillic О
      'P': [/[\u03A1\u0420\u13E2]/], // Greek Rho, Cyrillic Р
      'T': [/[\u03A4\u0422\u13D9]/], // Greek Tau, Cyrillic Т
      'X': [/[\u03A7\u0425\u13B3]/], // Greek Chi, Cyrillic Х
      'Y': [/[\u03A5\u04AE]/], // Greek Upsilon, Cyrillic Ү
      
      // Numbers
      '0': [/[\u03BF\u043E\u0585\u06F0]/], // Greek omicron, Cyrillic о, Armenian օ, Arabic ۰
      '1': [/[\u0049\u006C\u0031\u01C0]/], // Latin I, l, pipe |
      '3': [/[\u0417\u04E0]/], // Cyrillic З, Ӡ
      '4': [/[\u13CE]/], // Cherokee Ꮞ
      '6': [/[\u13EE]/], // Cherokee Ꮾ
      '8': [/[\u0222\u0223]/], // Latin Ȣ, ȣ
    };

    // Check each character in the text
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const lowerChar = char.toLowerCase();
      
      // Check if this character has homoglyphs
      if (homoglyphMappings[lowerChar]) {
        const patterns = homoglyphMappings[lowerChar];
        for (const pattern of patterns) {
          if (pattern.test(text)) {
            return true;
          }
        }
      }
    }

    // Also check for mixed scripts which is often a sign of homoglyph attack
    const scripts = new Set<string>();
    const scriptRanges = [
      { name: 'latin', regex: /[a-zA-Z]/ },
      { name: 'cyrillic', regex: /[\u0400-\u04FF]/ },
      { name: 'greek', regex: /[\u0370-\u03FF]/ },
      { name: 'arabic', regex: /[\u0600-\u06FF]/ },
      { name: 'hebrew', regex: /[\u0590-\u05FF]/ },
      { name: 'armenian', regex: /[\u0530-\u058F]/ },
      { name: 'cherokee', regex: /[\u13A0-\u13FF]/ },
    ];

    for (const char of text) {
      for (const { name, regex } of scriptRanges) {
        if (regex.test(char)) {
          scripts.add(name);
          if (scripts.size > 1) {
            // Mixed scripts detected
            return true;
          }
        }
      }
    }

    return false;
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