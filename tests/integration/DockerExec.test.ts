import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Docker from 'dockerode';
import { DockerManager } from '../../src/docker/DockerManager.js';
import { Config } from '../../src/config/Config.js';
import { Logger } from '../../src/observability/Logger.js';
import { MetricsCollector } from '../../src/observability/MetricsCollector.js';

describe('DockerExec Integration Tests', () => {
  let docker: Docker;
  let dockerManager: DockerManager;
  let testContainer: Docker.Container;
  let config: Config;
  let logger: Logger;
  let metrics: MetricsCollector;

  beforeAll(async () => {
    // Set up test configuration
    process.env.MCP_DOCKER_ALLOW_ROOT = 'true'; // For testing
    config = Config.load();
    logger = new Logger('test');
    metrics = new MetricsCollector();
    
    docker = new Docker();
    dockerManager = new DockerManager(config, logger, metrics);

    // Pull alpine image if not present
    try {
      await docker.getImage('alpine:latest').inspect();
    } catch {
      console.log('Pulling alpine:latest...');
      const stream = await docker.pull('alpine:latest');
      await new Promise((resolve, reject) => {
        docker.modem.followProgress(stream, (err, res) => err ? reject(err) : resolve(res));
      });
    }

    // Create test container
    testContainer = await docker.createContainer({
      Image: 'alpine:latest',
      name: `mcp-test-${Date.now()}`,
      Cmd: ['sh', '-c', 'while true; do sleep 1; done'],
      HostConfig: {
        AutoRemove: true,
      },
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

  describe('exec', () => {
    it('should execute simple command in buffered mode', async () => {
      const result = await dockerManager.exec({
        id: testContainer.id,
        cmd: ['echo', 'Hello, World!'],
      }, 'test-trace-1');

      const content = JSON.parse(result.content[0].text);
      expect(content.stdout).toBe('Hello, World!\n');
      expect(content.stderr).toBe('');
      expect(content.exitCode).toBe(0);
    });

    it('should handle stderr output', async () => {
      const result = await dockerManager.exec({
        id: testContainer.id,
        cmd: ['sh', '-c', 'echo "Error!" >&2'],
      }, 'test-trace-2');

      const content = JSON.parse(result.content[0].text);
      expect(content.stdout).toBe('');
      expect(content.stderr).toBe('Error!\n');
      expect(content.exitCode).toBe(0);
    });

    it('should handle non-zero exit codes', async () => {
      const result = await dockerManager.exec({
        id: testContainer.id,
        cmd: ['sh', '-c', 'exit 42'],
      }, 'test-trace-3');

      const content = JSON.parse(result.content[0].text);
      expect(content.exitCode).toBe(42);
    });

    it('should handle stdin input', async () => {
      const result = await dockerManager.exec({
        id: testContainer.id,
        cmd: ['sh', '-c', 'read input && echo "Got: $input"'],
        stdin: 'test input\n',
      }, 'test-trace-4');

      const content = JSON.parse(result.content[0].text);
      expect(content.stdout).toBe('Got: test input\n');
      expect(content.exitCode).toBe(0);
    });

    it('should respect working directory', async () => {
      const result = await dockerManager.exec({
        id: testContainer.id,
        cmd: ['pwd'],
        workdir: '/tmp',
      }, 'test-trace-5');

      const content = JSON.parse(result.content[0].text);
      expect(content.stdout.trim()).toBe('/tmp');
    });

    it('should set environment variables', async () => {
      const result = await dockerManager.exec({
        id: testContainer.id,
        cmd: ['sh', '-c', 'echo $TEST_VAR'],
        env: ['TEST_VAR=test_value'],
      }, 'test-trace-6');

      const content = JSON.parse(result.content[0].text);
      expect(content.stdout.trim()).toBe('test_value');
    });

    it('should handle streaming mode', async () => {
      const result = await dockerManager.exec({
        id: testContainer.id,
        cmd: ['sh', '-c', 'for i in 1 2 3; do echo "Line $i"; sleep 0.1; done'],
        stream: true,
      }, 'test-trace-7');

      const chunks: any[] = [];
      for await (const chunk of result.content) {
        const parsed = JSON.parse(chunk.text);
        chunks.push(parsed);
      }

      // Should have multiple chunks plus completion message
      expect(chunks.length).toBeGreaterThan(1);
      
      const dataChunks = chunks.filter(c => c.type === 'exec_chunk');
      const output = dataChunks.map(c => c.data).join('');
      expect(output).toContain('Line 1');
      expect(output).toContain('Line 2');
      expect(output).toContain('Line 3');

      const completion = chunks.find(c => c.type === 'exec_complete');
      expect(completion).toBeDefined();
      expect(completion.exitCode).toBe(0);
    });

    it('should handle timeout', async () => {
      const result = await dockerManager.exec({
        id: testContainer.id,
        cmd: ['sleep', '10'],
        timeoutMs: 100,
      }, 'test-trace-8');

      const content = JSON.parse(result.content[0].text);
      expect(content.cancelled).toBe(true);
      expect(content.reason).toBe('timeout');
    });

    it('should enforce output size limit in buffered mode', async () => {
      // Generate large output
      const result = await dockerManager.exec({
        id: testContainer.id,
        cmd: ['sh', '-c', 'for i in $(seq 1 100000); do echo "Line $i"; done'],
      }, 'test-trace-9');

      const content = JSON.parse(result.content[0].text);
      expect(content.truncated).toBe(true);
      expect(content.outputBytes).toBeLessThanOrEqual(config.maxBytes);
    });

    it('should handle missing container', async () => {
      const result = await dockerManager.exec({
        id: 'non-existent-container',
        cmd: ['echo', 'test'],
      }, 'test-trace-10');

      expect(result.isError).toBe(true);
      const content = JSON.parse(result.content[0].text);
      expect(content.error).toContain('No such container');
    });
  });

  describe('logs', () => {
    it('should retrieve container logs', async () => {
      // Generate some logs
      await dockerManager.exec({
        id: testContainer.id,
        cmd: ['sh', '-c', 'echo "Log line 1"; echo "Log line 2"'],
      }, 'test-trace-logs-1');

      const result = await dockerManager.logs({
        id: testContainer.id,
        tail: '10',
      }, 'test-trace-logs-2');

      const content = JSON.parse(result.content[0].text);
      expect(content.logs).toContain('Log line 1');
      expect(content.logs).toContain('Log line 2');
    });

    it('should follow logs in streaming mode', async () => {
      // Start a command that generates logs
      dockerManager.exec({
        id: testContainer.id,
        cmd: ['sh', '-c', 'for i in 1 2 3; do echo "Follow $i"; sleep 0.5; done'],
      }, 'test-trace-logs-3');

      const result = await dockerManager.logs({
        id: testContainer.id,
        follow: true,
        tail: '0',
      }, 'test-trace-logs-4');

      const chunks: any[] = [];
      const timeout = setTimeout(() => {}, 3000); // Max wait time

      for await (const chunk of result.content) {
        const parsed = JSON.parse(chunk.text);
        chunks.push(parsed);
        
        // Stop after getting some follow data
        if (chunks.filter(c => c.type === 'log_chunk' && c.data.includes('Follow')).length >= 2) {
          break;
        }
      }

      clearTimeout(timeout);

      const dataChunks = chunks.filter(c => c.type === 'log_chunk');
      expect(dataChunks.length).toBeGreaterThan(0);
    });
  });

  describe('ps', () => {
    it('should list running containers', async () => {
      const result = await dockerManager.ps({ all: false });
      
      const content = JSON.parse(result.content[0].text);
      expect(content.containers).toBeDefined();
      expect(Array.isArray(content.containers)).toBe(true);
      
      // Our test container should be in the list
      const testCtr = content.containers.find((c: any) => 
        c.names.some((n: string) => n.includes('mcp-test'))
      );
      expect(testCtr).toBeDefined();
    });

    it('should filter by name', async () => {
      const result = await dockerManager.ps({ 
        all: false,
        name: 'mcp-test',
      });
      
      const content = JSON.parse(result.content[0].text);
      expect(content.containers.length).toBeGreaterThan(0);
      expect(content.containers.every((c: any) => 
        c.names.some((n: string) => n.includes('mcp-test'))
      )).toBe(true);
    });
  });

  describe('inspect', () => {
    it('should inspect container', async () => {
      const result = await dockerManager.inspect({
        kind: 'container',
        id: testContainer.id,
      });
      
      const content = JSON.parse(result.content[0].text);
      expect(content.Id).toBe(testContainer.id);
      expect(content.Config).toBeDefined();
      expect(content.State).toBeDefined();
    });

    it('should inspect image', async () => {
      const result = await dockerManager.inspect({
        kind: 'image',
        id: 'alpine:latest',
      });
      
      const content = JSON.parse(result.content[0].text);
      expect(content.RepoTags).toContain('alpine:latest');
    });
  });

  describe('health', () => {
    it('should return health status', async () => {
      const result = await dockerManager.health();
      
      const content = JSON.parse(result.content[0].text);
      expect(content.status).toBe('healthy');
      expect(content.docker).toBeDefined();
      expect(content.server).toBeDefined();
    });
  });
});