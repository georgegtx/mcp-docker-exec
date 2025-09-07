#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { DockerManager } from './docker/DockerManager.js';
import { SecurityManager } from './security/SecurityManager.js';
import { Logger } from './observability/Logger.js';
import { MetricsCollector } from './observability/MetricsCollector.js';
import { Config } from './config/Config.js';
import { AuditLogger } from './security/AuditLogger.js';

const logger = new Logger('mcp-docker-exec');
const config = Config.load();
const metrics = new MetricsCollector();

// Show security warning if using local Docker socket
if (config.dockerHost === '/var/run/docker.sock' || !config.dockerHost) {
  logger.warn('⚠️  WARNING: Using local Docker socket. Container access grants significant privileges!');
  logger.warn('⚠️  See security documentation: https://github.com/your-org/mcp-docker-exec#security');
}

// Initialize components (will be set in main())
let dockerManager: DockerManager;
let securityManager: SecurityManager;
let auditLogger: AuditLogger;

// Create MCP server
const server = new Server(
  {
    name: 'mcp-docker-exec',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool schemas
const DockerExecSchema = z.object({
  id: z.string().describe('Container ID or name'),
  cmd: z.array(z.string()).describe('Command and arguments to execute'),
  stdin: z.string().optional().describe('Input to send to the command'),
  user: z.string().optional().describe('User to run the command as'),
  workdir: z.string().optional().describe('Working directory'),
  env: z.array(z.string()).optional().describe('Environment variables (KEY=VALUE format)'),
  stream: z.boolean().optional().default(false).describe('Stream output incrementally'),
  tty: z.boolean().optional().default(false).describe('Allocate a pseudo-TTY'),
  timeoutMs: z.number().optional().describe('Timeout in milliseconds'),
  chunkBytes: z.number().optional().default(16384).describe('Chunk size for streaming (default 16KB)'),
});

const DockerLogsSchema = z.object({
  id: z.string().describe('Container ID or name'),
  since: z.string().optional().describe('Only logs since this time (RFC3339)'),
  tail: z.string().optional().describe('Number of lines to show from the end'),
  follow: z.boolean().optional().default(false).describe('Follow log output'),
  chunkBytes: z.number().optional().default(16384).describe('Chunk size for streaming'),
});

const DockerPsSchema = z.object({
  all: z.boolean().optional().default(false).describe('Show all containers (default shows just running)'),
  name: z.string().optional().describe('Filter by container name'),
});

const DockerInspectSchema = z.object({
  kind: z.enum(['container', 'image', 'network', 'volume']).describe('Type of object to inspect'),
  id: z.string().describe('Object ID or name'),
});

// Handle list tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'docker_exec',
        description: 'Execute a command in a running Docker container',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Container ID or name' },
            cmd: { type: 'array', items: { type: 'string' }, description: 'Command and arguments' },
            stdin: { type: 'string', description: 'Input to send to the command' },
            user: { type: 'string', description: 'User to run the command as' },
            workdir: { type: 'string', description: 'Working directory' },
            env: { type: 'array', items: { type: 'string' }, description: 'Environment variables (KEY=VALUE)' },
            stream: { type: 'boolean', description: 'Stream output incrementally', default: false },
            tty: { type: 'boolean', description: 'Allocate a pseudo-TTY', default: false },
            timeoutMs: { type: 'number', description: 'Timeout in milliseconds' },
            chunkBytes: { type: 'number', description: 'Chunk size for streaming', default: 16384 },
          },
          required: ['id', 'cmd'],
        },
      },
      {
        name: 'docker_logs',
        description: 'Get logs from a Docker container',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Container ID or name' },
            since: { type: 'string', description: 'Only logs since this time (RFC3339)' },
            tail: { type: 'string', description: 'Number of lines to show from the end' },
            follow: { type: 'boolean', description: 'Follow log output', default: false },
            chunkBytes: { type: 'number', description: 'Chunk size for streaming', default: 16384 },
          },
          required: ['id'],
        },
      },
      {
        name: 'docker_ps',
        description: 'List Docker containers',
        inputSchema: {
          type: 'object',
          properties: {
            all: { type: 'boolean', description: 'Show all containers', default: false },
            name: { type: 'string', description: 'Filter by container name' },
          },
        },
      },
      {
        name: 'docker_inspect',
        description: 'Inspect Docker objects',
        inputSchema: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['container', 'image', 'network', 'volume'], description: 'Type of object' },
            id: { type: 'string', description: 'Object ID or name' },
          },
          required: ['kind', 'id'],
        },
      },
      {
        name: 'health',
        description: 'Check server health and Docker connectivity',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const traceId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  logger.info('Tool call received', { tool: name, traceId, args: { ...args, stdin: args?.stdin ? '[REDACTED]' : undefined } });
  metrics.incrementToolCall(name);

  try {
    switch (name) {
      case 'docker_exec': {
        const params = DockerExecSchema.parse(args);
        
        // Security check
        const securityCheck = await securityManager.checkCommand(params.cmd, params);
        if (!securityCheck.allowed) {
          auditLogger.logExec({
            traceId,
            containerId: params.id,
            command: params.cmd,
            user: params.user,
            blocked: true,
            reason: securityCheck.reason,
          });
          throw new Error(`Command blocked by security policy: ${securityCheck.reason}`);
        }

        // Execute command
        const result = await dockerManager.exec(params, traceId);
        
        auditLogger.logExec({
          traceId,
          containerId: params.id,
          command: params.cmd,
          user: params.user,
          exitCode: result.exitCode,
          duration: result.duration,
          outputBytes: result.outputBytes,
        });

        return result;
      }

      case 'docker_logs': {
        const params = DockerLogsSchema.parse(args);
        return await dockerManager.logs(params, traceId);
      }

      case 'docker_ps': {
        const params = DockerPsSchema.parse(args);
        return await dockerManager.ps(params);
      }

      case 'docker_inspect': {
        const params = DockerInspectSchema.parse(args);
        return await dockerManager.inspect(params);
      }

      case 'health': {
        return await dockerManager.health();
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    logger.error('Tool call failed', { tool: name, traceId, error });
    metrics.incrementToolError(name);
    throw error;
  }
});

// Start server
async function main() {
  // Initialize components that require async setup
  dockerManager = new DockerManager(config, logger, metrics);
  securityManager = await SecurityManager.create(config, logger);
  auditLogger = new AuditLogger(config, logger);
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('MCP Docker Exec server started', { 
    version: '1.0.0',
    config: {
      dockerHost: config.dockerHost || 'local socket',
      maxBytes: config.maxBytes,
      chunkBytes: config.defaultChunkBytes,
      securityEnabled: config.security.enabled,
    }
  });
}

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  
  try {
    // Stop accepting new requests
    server.close();
    
    // Clean up Docker manager
    await dockerManager.cleanup();
    
    // Close audit logger
    await auditLogger.close();
    
    // Close security manager
    await securityManager.close();
    
    logger.info('Shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown', { error });
    process.exit(1);
  }
}

// Handle shutdown signals
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error });
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection', { reason, promise });
  shutdown('unhandledRejection');
});

main().catch((error) => {
  logger.error('Failed to start server', { error });
  process.exit(1);
});