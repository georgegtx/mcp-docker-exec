/**
 * Robust shell command parser that handles quotes, escapes, and command substitution
 */
export class ShellCommandParser {
  /**
   * Parse a shell command string into individual commands and detect dangerous patterns
   */
  static parse(command: string): { commands: string[]; suspicious: string[] } {
    const commands: string[] = [];
    const suspicious: string[] = [];
    
    // Detect command substitution patterns
    const commandSubstitutionPatterns = [
      /\$\([^)]+\)/g,        // $(command)
      /`[^`]+`/g,            // `command`
      /\$\{[^}]+\}/g,        // ${command}
    ];
    
    for (const pattern of commandSubstitutionPatterns) {
      const matches = command.match(pattern);
      if (matches) {
        suspicious.push(...matches);
      }
    }
    
    // Extract all commands including those in substitutions
    const allCommands = this.extractAllCommands(command);
    commands.push(...allCommands);
    
    return { commands, suspicious };
  }
  
  /**
   * Extract all commands from a shell string, including nested ones
   */
  private static extractAllCommands(input: string): string[] {
    const commands: string[] = [];
    
    // First, extract command substitutions and process them recursively
    const substitutions = this.extractSubstitutions(input);
    for (const sub of substitutions) {
      commands.push(...this.extractAllCommands(sub));
    }
    
    // Then parse the main command
    const tokens = this.tokenize(input);
    const separatedCommands = this.separateCommands(tokens);
    
    for (const cmdTokens of separatedCommands) {
      const cmd = cmdTokens.join(' ').trim();
      if (cmd) {
        commands.push(cmd);
      }
    }
    
    return commands;
  }
  
  /**
   * Extract command substitutions from the input
   */
  private static extractSubstitutions(input: string): string[] {
    const substitutions: string[] = [];
    
    // $() substitution
    let match;
    const dollarParenRegex = /\$\(([^)]+)\)/g;
    while ((match = dollarParenRegex.exec(input)) !== null) {
      substitutions.push(match[1]);
    }
    
    // `` substitution
    const backtickRegex = /`([^`]+)`/g;
    while ((match = backtickRegex.exec(input)) !== null) {
      substitutions.push(match[1]);
    }
    
    // ${} when used for command substitution (not variable expansion)
    const dollarBraceRegex = /\$\{([^}]+)\}/g;
    while ((match = dollarBraceRegex.exec(input)) !== null) {
      // Check if it looks like a command rather than a variable
      const content = match[1];
      if (content.includes(' ') || content.includes(';') || content.includes('|')) {
        substitutions.push(content);
      }
    }
    
    return substitutions;
  }
  
  /**
   * Tokenize shell command respecting quotes and escapes
   */
  private static tokenize(input: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let escaped = false;
    
    for (let i = 0; i < input.length; i++) {
      const char = input[i];
      const nextChar = input[i + 1];
      
      if (escaped) {
        current += char;
        escaped = false;
        continue;
      }
      
      if (char === '\\' && !inSingleQuote) {
        if (nextChar === '\n') {
          // Line continuation
          i++; // Skip the newline
          continue;
        }
        escaped = true;
        current += char;
        continue;
      }
      
      if (char === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
        current += char;
        continue;
      }
      
      if (char === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
        current += char;
        continue;
      }
      
      // Handle separators only outside quotes
      if (!inSingleQuote && !inDoubleQuote) {
        if (char === ' ' || char === '\t' || char === '\n') {
          if (current) {
            tokens.push(current);
            current = '';
          }
          continue;
        }
        
        // Handle operators as separate tokens
        if (char === ';' || char === '|' || char === '&' || 
            char === '<' || char === '>' || char === '(' || char === ')') {
          if (current) {
            tokens.push(current);
            current = '';
          }
          
          // Handle multi-character operators
          if (char === '|' && nextChar === '|') {
            tokens.push('||');
            i++;
          } else if (char === '&' && nextChar === '&') {
            tokens.push('&&');
            i++;
          } else if (char === '>' && nextChar === '>') {
            tokens.push('>>');
            i++;
          } else if (char === '<' && nextChar === '<') {
            tokens.push('<<');
            i++;
          } else {
            tokens.push(char);
          }
          continue;
        }
      }
      
      current += char;
    }
    
    if (current) {
      tokens.push(current);
    }
    
    return tokens;
  }
  
  /**
   * Separate tokens into individual commands based on operators
   */
  private static separateCommands(tokens: string[]): string[][] {
    const commands: string[][] = [];
    let current: string[] = [];
    
    const separators = new Set([';', '|', '||', '&&', '&']);
    
    for (const token of tokens) {
      if (separators.has(token)) {
        if (current.length > 0) {
          commands.push(current);
          current = [];
        }
      } else {
        current.push(token);
      }
    }
    
    if (current.length > 0) {
      commands.push(current);
    }
    
    return commands;
  }
  
  /**
   * Check if a command contains dangerous patterns
   */
  static containsDangerousPatterns(command: string): { dangerous: boolean; patterns: string[] } {
    const patterns: string[] = [];
    
    // Check for various dangerous patterns
    const dangerousPatterns = [
      // File system operations
      { pattern: /\brm\s+-rf?\s+\//, name: 'rm -rf /' },
      { pattern: /\bdd\s+if=\/dev\/zero/, name: 'dd overwrite' },
      { pattern: /\bmkfs/, name: 'filesystem format' },
      
      // System operations
      { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, name: 'system shutdown' },
      { pattern: /\b(kill|killall)\s+-9\s+/, name: 'force kill' },
      
      // Network operations
      { pattern: /\bnc\s+-l/, name: 'netcat listener' },
      { pattern: /\bcurl\s+.*\|\s*sh/, name: 'curl pipe to shell' },
      { pattern: /\bwget\s+.*\|\s*sh/, name: 'wget pipe to shell' },
      
      // Privilege escalation
      { pattern: /\bsudo\s+/, name: 'sudo usage' },
      { pattern: /\bsu\s+/, name: 'su usage' },
      { pattern: /\bchmod\s+\+s/, name: 'setuid' },
      
      // Fork bombs
      { pattern: /:\(\)\{:|:\|:\&\}/, name: 'fork bomb' },
      
      // Device writes
      { pattern: />\s*\/dev\/(sda|hda|nvme)/, name: 'device write' },
    ];
    
    for (const { pattern, name } of dangerousPatterns) {
      if (pattern.test(command)) {
        patterns.push(name);
      }
    }
    
    return {
      dangerous: patterns.length > 0,
      patterns
    };
  }
}