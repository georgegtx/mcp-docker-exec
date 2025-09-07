import { describe, it, expect, beforeEach } from 'vitest';
import { SecurityManager } from '../../src/security/SecurityManager.js';
import { Config } from '../../src/config/Config.js';
import { Logger } from '../../src/observability/Logger.js';

describe('SecurityManager', () => {
  let config: Config;
  let logger: Logger;
  let securityManager: SecurityManager;

  beforeEach(async () => {
    // Create config with custom settings
    process.env.MCP_DOCKER_SECURITY = 'true';
    process.env.MCP_DOCKER_ALLOW_ROOT = 'false';
    process.env.MCP_DOCKER_COMMAND_POLICY_MODE = 'denylist';
    process.env.MCP_DOCKER_COMMAND_PATTERNS = 'rm -rf,dd if=';
    process.env.MCP_DOCKER_DENIED_FLAGS = '--privileged,--pid=host';
    
    config = Config.load();
    logger = new Logger('test');
    securityManager = await SecurityManager.create(config, logger);
  });

  describe('checkCommand', () => {
    it('should allow safe commands', async () => {
      const result = await securityManager.checkCommand(
        ['ls', '-la', '/app'],
        { id: 'test', cmd: ['ls', '-la', '/app'], user: 'nobody' }
      );
      
      expect(result.allowed).toBe(true);
    });

    it('should block root execution when not allowed', async () => {
      const result = await securityManager.checkCommand(
        ['whoami'],
        { id: 'test', cmd: ['whoami'], user: 'root' }
      );
      
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Root user execution not allowed');
    });

    it('should block commands matching denylist', async () => {
      const result = await securityManager.checkCommand(
        ['rm', '-rf', '/'],
        { id: 'test', cmd: ['rm', '-rf', '/'], user: 'nobody' }
      );
      
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('matches denylist');
    });

    it('should block dangerous flags', async () => {
      const result = await securityManager.checkCommand(
        ['docker', 'run', '--privileged', 'alpine'],
        { id: 'test', cmd: ['docker', 'run', '--privileged', 'alpine'], user: 'nobody' }
      );
      
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Dangerous flag detected: --privileged');
    });

    it('should block write access to restricted paths', async () => {
      const result = await securityManager.checkCommand(
        ['echo', 'test', '>', '/proc/sys/kernel/panic'],
        { id: 'test', cmd: ['echo', 'test', '>', '/proc/sys/kernel/panic'], user: 'nobody' }
      );
      
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Access to /proc is restricted');
    });

    it('should allow read access to restricted paths', async () => {
      const result = await securityManager.checkCommand(
        ['cat', '/proc/cpuinfo'],
        { id: 'test', cmd: ['cat', '/proc/cpuinfo'], user: 'nobody' }
      );
      
      expect(result.allowed).toBe(true);
    });

    it('should enforce rate limits', async () => {
      // Set very low rate limit for testing
      process.env.MCP_DOCKER_EXEC_PER_MINUTE = '2';
      const newConfig = Config.load();
      const rateLimitedManager = await SecurityManager.create(newConfig, logger);

      // First two should pass
      const result1 = await rateLimitedManager.checkCommand(['ls'], { id: 'test', cmd: ['ls'], user: 'nobody' });
      expect(result1.allowed).toBe(true);

      const result2 = await rateLimitedManager.checkCommand(['ls'], { id: 'test', cmd: ['ls'], user: 'nobody' });
      expect(result2.allowed).toBe(true);

      // Third should fail
      const result3 = await rateLimitedManager.checkCommand(['ls'], { id: 'test', cmd: ['ls'], user: 'nobody' });
      expect(result3.allowed).toBe(false);
      expect(result3.reason).toContain('Rate limit exceeded');
    });
  });

  describe('allowlist mode', () => {
    beforeEach(async () => {
      process.env.MCP_DOCKER_COMMAND_POLICY_MODE = 'allowlist';
      process.env.MCP_DOCKER_COMMAND_PATTERNS = '^ls,^cat,^grep';
      
      config = Config.load();
      securityManager = await SecurityManager.create(config, logger);
    });

    it('should allow commands in allowlist', async () => {
      const result = await securityManager.checkCommand(
        ['ls', '-la'],
        { id: 'test', cmd: ['ls', '-la'], user: 'nobody' }
      );
      
      expect(result.allowed).toBe(true);
    });

    it('should block commands not in allowlist', async () => {
      const result = await securityManager.checkCommand(
        ['rm', 'file.txt'],
        { id: 'test', cmd: ['rm', 'file.txt'], user: 'nobody' }
      );
      
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not in allowlist');
    });
  });

  describe('disabled security', () => {
    beforeEach(async () => {
      process.env.MCP_DOCKER_SECURITY = 'false';
      
      config = Config.load();
      securityManager = await SecurityManager.create(config, logger);
    });

    it('should allow all commands when security is disabled', async () => {
      const result = await securityManager.checkCommand(
        ['rm', '-rf', '/'],
        { id: 'test', cmd: ['rm', '-rf', '/'], user: 'root' }
      );
      
      expect(result.allowed).toBe(true);
    });
  });
});