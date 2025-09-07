import { z } from 'zod';

const ConfigSchema = z.object({
  // Docker configuration
  dockerHost: z.string().optional(),

  // Resource limits
  maxBytes: z.number().default(1048576), // 1 MiB default
  defaultChunkBytes: z.number().default(16384), // 16 KiB default
  maxConcurrentExecs: z.number().default(10),
  defaultTimeoutMs: z.number().optional(),

  // Security configuration
  security: z.object({
    enabled: z.boolean().default(true),
    defaultUser: z.string().optional(),
    allowRoot: z.boolean().default(false),
    commandPolicy: z.object({
      mode: z.enum(['allowlist', 'denylist', 'none']).default('none'),
      patterns: z.array(z.string()).default([]),
    }),
    pathPolicy: z.object({
      deniedPaths: z.array(z.string()).default(['/proc', '/sys', '/dev']),
    }),
    deniedFlags: z.array(z.string()).default(['--privileged', '--pid=host', '--net=host']),
  }),

  // Rate limiting
  rateLimits: z.object({
    enabled: z.boolean().default(true),
    execPerMinute: z.number().default(60),
    logsPerMinute: z.number().default(30),
  }),

  // Audit configuration
  audit: z.object({
    enabled: z.boolean().default(true),
    logFile: z.string().optional(),
    retentionDays: z.number().default(30),
    includeStdin: z.boolean().default(false),
  }),

  // Observability
  observability: z.object({
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    structuredLogs: z.boolean().default(true),
    metricsEnabled: z.boolean().default(true),
  }),

  // Dry run mode
  dryRun: z.boolean().default(false),
});

export type ConfigType = z.infer<typeof ConfigSchema>;

export class Config {
  private constructor(private config: ConfigType) {}

  static load(): Config {
    const raw = {
      // Docker settings
      dockerHost: process.env.DOCKER_HOST,

      // Resource limits
      maxBytes: process.env.MCP_DOCKER_MAX_BYTES
        ? parseInt(process.env.MCP_DOCKER_MAX_BYTES, 10)
        : undefined,
      defaultChunkBytes: process.env.MCP_DOCKER_CHUNK_BYTES
        ? parseInt(process.env.MCP_DOCKER_CHUNK_BYTES, 10)
        : undefined,
      maxConcurrentExecs: process.env.MCP_DOCKER_MAX_CONCURRENT
        ? parseInt(process.env.MCP_DOCKER_MAX_CONCURRENT, 10)
        : undefined,
      defaultTimeoutMs: process.env.MCP_DOCKER_TIMEOUT_MS
        ? parseInt(process.env.MCP_DOCKER_TIMEOUT_MS, 10)
        : undefined,

      // Security
      security: {
        enabled: process.env.MCP_DOCKER_SECURITY !== 'false',
        defaultUser: process.env.MCP_DOCKER_DEFAULT_USER,
        allowRoot: process.env.MCP_DOCKER_ALLOW_ROOT === 'true',
        commandPolicy: {
          mode: process.env.MCP_DOCKER_COMMAND_POLICY_MODE as any,
          patterns: process.env.MCP_DOCKER_COMMAND_PATTERNS
            ? process.env.MCP_DOCKER_COMMAND_PATTERNS.split(',')
            : undefined,
        },
        pathPolicy: {
          deniedPaths: process.env.MCP_DOCKER_DENIED_PATHS
            ? process.env.MCP_DOCKER_DENIED_PATHS.split(',')
            : undefined,
        },
        deniedFlags: process.env.MCP_DOCKER_DENIED_FLAGS
          ? process.env.MCP_DOCKER_DENIED_FLAGS.split(',')
          : undefined,
      },

      // Rate limits
      rateLimits: {
        enabled: process.env.MCP_DOCKER_RATE_LIMITS !== 'false',
        execPerMinute: process.env.MCP_DOCKER_EXEC_PER_MINUTE
          ? parseInt(process.env.MCP_DOCKER_EXEC_PER_MINUTE, 10)
          : undefined,
        logsPerMinute: process.env.MCP_DOCKER_LOGS_PER_MINUTE
          ? parseInt(process.env.MCP_DOCKER_LOGS_PER_MINUTE, 10)
          : undefined,
      },

      // Audit
      audit: {
        enabled: process.env.MCP_DOCKER_AUDIT !== 'false',
        logFile: process.env.MCP_DOCKER_AUDIT_FILE,
        retentionDays: process.env.MCP_DOCKER_AUDIT_RETENTION_DAYS
          ? parseInt(process.env.MCP_DOCKER_AUDIT_RETENTION_DAYS, 10)
          : undefined,
        includeStdin: process.env.MCP_DOCKER_AUDIT_INCLUDE_STDIN === 'true',
      },

      // Observability
      observability: {
        logLevel: process.env.MCP_DOCKER_LOG_LEVEL as any,
        structuredLogs: process.env.MCP_DOCKER_STRUCTURED_LOGS !== 'false',
        metricsEnabled: process.env.MCP_DOCKER_METRICS !== 'false',
      },

      // Dry run
      dryRun: process.env.MCP_DOCKER_DRY_RUN === 'true',
    };

    // Remove undefined values
    const cleanConfig = JSON.parse(JSON.stringify(raw));

    // Parse and validate
    const parsed = ConfigSchema.parse(cleanConfig);
    return new Config(parsed);
  }

  // Getters
  get dockerHost(): string | undefined {
    return this.config.dockerHost;
  }

  get maxBytes(): number {
    return this.config.maxBytes;
  }

  get defaultChunkBytes(): number {
    return this.config.defaultChunkBytes;
  }

  get maxConcurrentExecs(): number {
    return this.config.maxConcurrentExecs;
  }

  get defaultTimeoutMs(): number | undefined {
    return this.config.defaultTimeoutMs;
  }

  get security(): ConfigType['security'] {
    return this.config.security;
  }

  get rateLimits(): ConfigType['rateLimits'] {
    return this.config.rateLimits;
  }

  get audit(): ConfigType['audit'] {
    return this.config.audit;
  }

  get observability(): ConfigType['observability'] {
    return this.config.observability;
  }

  get dryRun(): boolean {
    return this.config.dryRun;
  }
}
