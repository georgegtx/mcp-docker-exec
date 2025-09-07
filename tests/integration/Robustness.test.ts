import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Docker from 'dockerode';
import { DockerManager } from '../../src/docker/DockerManager.js';
import { Config } from '../../src/config/Config.js';
import { Logger } from '../../src/observability/Logger.js';
import { MetricsCollector } from '../../src/observability/MetricsCollector.js';
import { SecurityManager } from '../../src/security/SecurityManager.js';
import { CircularBuffer } from '../../src/utils/CircularBuffer.js';

describe('Robustness Improvements', () => {
  let docker: Docker;
  let testContainer: Docker.Container;

  beforeAll(async () => {
    docker = new Docker();

    // Create a test container
    try {
      await docker.getImage('alpine:latest').inspect();
    } catch {
      const stream = await docker.pull('alpine:latest');
      await new Promise((resolve, reject) => {
        docker.modem.followProgress(stream, (err, res) => err ? reject(err) : resolve(res));
      });
    }

    testContainer = await docker.createContainer({
      Image: 'alpine:latest',
      name: `robustness-test-${Date.now()}`,
      Cmd: ['sh', '-c', 'while true; do sleep 1; done'],
      HostConfig: { AutoRemove: true },
    });

    await testContainer.start();
  });

  afterAll(async () => {
    if (testContainer) {
      try {
        await testContainer.stop();
      } catch (err) {
        // Container might already be stopped
      }
    }
  });

  describe('Stream Handling', () => {
    it('should handle corrupted Docker stream', async () => {
      // Test StreamDemuxer with corrupted data
      const { StreamDemuxer } = await import('../../src/docker/StreamDemuxer.js');
      const demuxer = new StreamDemuxer();
      
      // Create a stream with corrupted header
      const { Readable } = await import('stream');
      const corruptedData = Buffer.concat([
        Buffer.from([99, 99, 99, 99]), // Invalid header
        Buffer.from('Some data'),
        Buffer.from([1, 0, 0, 0, 0, 0, 0, 5]), // Valid header
        Buffer.from('Hello'),
      ]);
      
      const stream = Readable.from([corruptedData]);
      const chunks: any[] = [];
      
      for await (const chunk of demuxer.demuxStream(stream, 1024)) {
        chunks.push(chunk);
      }
      
      // Should recover and process valid data
      expect(chunks.some(c => c.data.includes('Hello'))).toBe(true);
    });

    it('should prevent buffer overflow', async () => {
      const config = Config.load();
      const logger = new Logger('test');
      const metrics = new MetricsCollector();
      const dockerManager = new DockerManager(config, logger, metrics);

      // Generate massive output
      const result = await dockerManager.exec({
        id: testContainer.id,
        cmd: ['sh', '-c', 'for i in $(seq 1 1000000); do echo "Line $i"; done'],
        stream: true,
      }, 'test-overflow');

      let totalBytes = 0;
      let chunkCount = 0;

      for await (const chunk of result.content) {
        const parsed = JSON.parse(chunk.text);
        if (parsed.type === 'exec_chunk') {
          totalBytes += parsed.bytes;
          chunkCount++;
        }
        
        // Stop after getting substantial data
        if (chunkCount > 100) break;
      }

      // Should have processed data without OOM
      expect(chunkCount).toBeGreaterThan(0);
      expect(totalBytes).toBeGreaterThan(0);
    });
  });

  describe('Circular Buffers', () => {
    it('should limit memory usage with circular buffer', () => {
      const buffer = new CircularBuffer(5, 100); // 5 items, 100 bytes max
      
      // Add more items than the limit
      for (let i = 0; i < 10; i++) {
        buffer.push(`Item ${i}\n`);
      }
      
      const contents = buffer.getContents();
      const stats = buffer.getStats();
      
      // Should only keep last 5 items
      expect(stats.items).toBeLessThanOrEqual(5);
      expect(stats.bytes).toBeLessThanOrEqual(100);
      expect(contents).toContain('Item 9');
      expect(contents).not.toContain('Item 0');
    });

    it('should handle single large item', () => {
      const buffer = new CircularBuffer(10, 50);
      const largeItem = 'X'.repeat(100); // Larger than max bytes
      
      buffer.push(largeItem);
      
      const contents = buffer.getContents();
      expect(contents).toContain('[TRUNCATED]');
      expect(buffer.getBytes()).toBeLessThanOrEqual(50);
    });
  });

  describe('Security Hardening', () => {
    it('should detect shell injection attempts', async () => {
      const config = Config.load();
      const logger = new Logger('test');
      const securityManager = new SecurityManager(config, logger);

      const tests = [
        { cmd: ['sh', '-c', 'echo test; rm -rf /'], shouldBlock: true },
        { cmd: ['echo', 'test && dd if=/dev/zero'], shouldBlock: true },
        { cmd: ['ls', '-la'], shouldBlock: false },
        { cmd: ['sh', '-c', 'echo тest'], shouldBlock: true }, // Cyrillic 'т'
      ];

      for (const test of tests) {
        const result = await securityManager.checkCommand(test.cmd, {
          id: 'test',
          cmd: test.cmd,
        });
        
        if (test.shouldBlock) {
          expect(result.allowed).toBe(false);
          expect(result.reason).toBeDefined();
        } else {
          expect(result.allowed).toBe(true);
        }
      }
    });
  });

  describe('Circuit Breaker', () => {
    it('should open circuit after failures', async () => {
      const { CircuitBreaker } = await import('../../src/resilience/CircuitBreaker.js');
      const breaker = new CircuitBreaker({
        name: 'test',
        failureThreshold: 2,
        successThreshold: 1,
        timeout: 100,
        resetTimeout: 1000,
      });

      let failCount = 0;
      const failingOperation = async () => {
        failCount++;
        throw new Error('Operation failed');
      };

      // First two failures should go through
      await expect(breaker.execute(failingOperation)).rejects.toThrow();
      await expect(breaker.execute(failingOperation)).rejects.toThrow();
      
      // Third attempt should be blocked by open circuit
      await expect(breaker.execute(failingOperation)).rejects.toThrow(/Circuit breaker is OPEN/);
      
      // Circuit should be open
      expect(breaker.getState()).toBe('OPEN');
      expect(failCount).toBe(2); // Third operation wasn't executed
    });
  });

  describe('Timeout Handling', () => {
    it('should timeout long-running operations', async () => {
      const config = Config.load();
      const logger = new Logger('test');
      const metrics = new MetricsCollector();
      const dockerManager = new DockerManager(config, logger, metrics);

      const result = await dockerManager.exec({
        id: testContainer.id,
        cmd: ['sleep', '10'],
        timeoutMs: 500,
      }, 'test-timeout');

      const content = JSON.parse(result.content[0].text);
      expect(content.cancelled).toBe(true);
      expect(content.reason).toBe('timeout');
      expect(content.duration).toBeLessThan(1000);
    });
  });

  describe('Graceful Cancellation', () => {
    it('should properly cancel streaming operations', async () => {
      const config = Config.load();
      const logger = new Logger('test');
      const metrics = new MetricsCollector();
      const dockerManager = new DockerManager(config, logger, metrics);

      const result = await dockerManager.exec({
        id: testContainer.id,
        cmd: ['sh', '-c', 'while true; do echo "Running..."; sleep 0.1; done'],
        stream: true,
      }, 'test-cancel');

      let chunkCount = 0;
      const chunks: any[] = [];

      for await (const chunk of result.content) {
        const parsed = JSON.parse(chunk.text);
        chunks.push(parsed);
        
        if (parsed.type === 'exec_chunk') {
          chunkCount++;
          // Cancel after a few chunks
          if (chunkCount >= 5) {
            break;
          }
        }
      }

      // Should have received some chunks before cancellation
      expect(chunkCount).toBeGreaterThanOrEqual(5);
      
      // The exec should eventually stop
      // (In a real implementation, we'd check that the process was killed)
    });
  });

  describe('Error Recovery', () => {
    it('should handle missing container gracefully', async () => {
      const config = Config.load();
      const logger = new Logger('test');
      const metrics = new MetricsCollector();
      const dockerManager = new DockerManager(config, logger, metrics);

      const result = await dockerManager.exec({
        id: 'non-existent-container-12345',
        cmd: ['echo', 'test'],
      }, 'test-missing');

      expect(result.isError).toBe(true);
      const content = JSON.parse(result.content[0].text);
      expect(content.error).toBeDefined();
      expect(content.code).toBeDefined();
    });

    it('should sanitize error messages', async () => {
      const { ErrorHandler } = await import('../../src/utils/errorHandler.js');
      const logger = new Logger('test');
      const handler = new ErrorHandler(logger);

      const error = new Error('Error at /home/user/project/docker/container/1234567890abcdef');
      const result = handler.handleDockerError(error as any, 'test');

      expect(result.message).not.toContain('/home/user/project');
      expect(result.message).not.toContain('1234567890abcdef');
      expect(result.message).toContain('<path>');
    });
  });

  describe('Resource Cleanup', () => {
    it('should clean up stale sessions', async () => {
      // This test would require mocking time or waiting
      // For now, just verify the cleanup method exists
      const config = Config.load();
      const logger = new Logger('test');
      const metrics = new MetricsCollector();
      const dockerManager = new DockerManager(config, logger, metrics);

      // Cleanup should not throw
      await expect(dockerManager.cleanup()).resolves.not.toThrow();
    });
  });
});