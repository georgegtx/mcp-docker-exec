# MCP Docker Exec Server

A Model Context Protocol (MCP) server that provides secure Docker container execution with streaming support. Designed to work seamlessly with Cursor and other MCP-compatible clients.

## Features

- **Flexible Execution Modes**
  - Buffered mode (default): Returns complete output when command finishes
  - Streaming mode: Real-time output streaming for long-running commands
  - TTY support: Optional pseudo-TTY allocation (off by default)

- **Production-Ready Security**
  - Command allowlist/denylist policies
  - User permission controls (non-root by default)
  - Path access restrictions
  - Rate limiting
  - Comprehensive audit logging

- **Robust Resource Management**
  - Memory-safe streaming for arbitrarily large outputs
  - Configurable chunk sizes and buffer limits
  - Timeout support with graceful cancellation
  - Concurrent execution limits

- **Enterprise Observability**
  - Structured JSON logging
  - Metrics collection (latency, throughput, errors)
  - Trace ID correlation
  - Health checks

## Quick Start

### Installation

```bash
npm install -g mcp-docker-exec
```

### Usage with Cursor

Add to your Cursor MCP settings (`~/.cursor/mcp/settings.json`):

```json
{
  "mcpServers": {
    "docker-exec": {
      "command": "mcp-docker-exec",
      "args": [],
      "env": {
        "MCP_DOCKER_ALLOW_ROOT": "false",
        "MCP_DOCKER_MAX_BYTES": "10485760"
      }
    }
  }
}
```

## Available Tools

### docker_exec

Execute commands in running containers.

```json
{
  "name": "docker_exec",
  "arguments": {
    "id": "container_name_or_id",
    "cmd": ["sh", "-c", "ls -la"],
    "stream": false,
    "tty": false,
    "user": "appuser",
    "workdir": "/app",
    "env": ["NODE_ENV=production"],
    "timeoutMs": 30000,
    "chunkBytes": 16384
  }
}
```

### docker_logs

Retrieve container logs with optional following.

```json
{
  "name": "docker_logs",
  "arguments": {
    "id": "container_name_or_id",
    "tail": "100",
    "follow": true,
    "since": "2024-01-01T00:00:00Z",
    "chunkBytes": 16384
  }
}
```

### docker_ps

List containers with filtering options.

```json
{
  "name": "docker_ps",
  "arguments": {
    "all": true,
    "name": "web"
  }
}
```

### docker_inspect

Inspect Docker objects (containers, images, networks, volumes).

```json
{
  "name": "docker_inspect",
  "arguments": {
    "kind": "container",
    "id": "container_name_or_id"
  }
}
```

### health

Check server health and Docker connectivity.

```json
{
  "name": "health",
  "arguments": {}
}
```

## Configuration

All configuration is done via environment variables:

### Docker Connection
- `DOCKER_HOST`: Docker daemon socket/address (default: local socket)

### Resource Limits
- `MCP_DOCKER_MAX_BYTES`: Max output size in buffered mode (default: 1048576)
- `MCP_DOCKER_CHUNK_BYTES`: Streaming chunk size (default: 16384)
- `MCP_DOCKER_MAX_CONCURRENT`: Max concurrent executions (default: 10)
- `MCP_DOCKER_TIMEOUT_MS`: Default timeout for commands (optional)

### Security
- `MCP_DOCKER_SECURITY`: Enable security features (default: true)
- `MCP_DOCKER_DEFAULT_USER`: Default user for commands (optional)
- `MCP_DOCKER_ALLOW_ROOT`: Allow root execution (default: false)
- `MCP_DOCKER_COMMAND_POLICY_MODE`: "allowlist", "denylist", or "none"
- `MCP_DOCKER_COMMAND_PATTERNS`: Comma-separated regex patterns
- `MCP_DOCKER_DENIED_PATHS`: Comma-separated denied paths (default: /proc,/sys,/dev)
- `MCP_DOCKER_DENIED_FLAGS`: Comma-separated dangerous flags (default: --privileged,--pid=host,--net=host)

### Rate Limiting
- `MCP_DOCKER_RATE_LIMITS`: Enable rate limiting (default: true)
- `MCP_DOCKER_EXEC_PER_MINUTE`: Max execs per minute (default: 60)
- `MCP_DOCKER_LOGS_PER_MINUTE`: Max log requests per minute (default: 30)

### Audit & Observability
- `MCP_DOCKER_AUDIT`: Enable audit logging (default: true)
- `MCP_DOCKER_AUDIT_FILE`: Audit log file path (optional)
- `MCP_DOCKER_AUDIT_RETENTION_DAYS`: Log retention period (default: 30)
- `MCP_DOCKER_LOG_LEVEL`: Log level (debug/info/warn/error, default: info)
- `MCP_DOCKER_STRUCTURED_LOGS`: Use JSON logs (default: true)

### Other
- `MCP_DOCKER_DRY_RUN`: Log only, don't execute (default: false)

## Security Considerations

⚠️ **WARNING**: This server provides access to Docker containers, which can be equivalent to root access on the host system.

### Best Practices

1. **Never expose to untrusted clients**: This server is designed for local development use only.

2. **Use non-root by default**: Set a default non-root user:
   ```bash
   MCP_DOCKER_DEFAULT_USER=nobody
   ```

3. **Enable command policies**: Restrict available commands:
   ```bash
   MCP_DOCKER_COMMAND_POLICY_MODE=allowlist
   MCP_DOCKER_COMMAND_PATTERNS="^ls,^cat,^grep,^echo"
   ```

4. **Restrict paths**: Block access to sensitive directories:
   ```bash
   MCP_DOCKER_DENIED_PATHS="/etc,/root,/var/lib"
   ```

5. **Use read-only containers** when possible.

6. **Enable audit logging** for production use:
   ```bash
   MCP_DOCKER_AUDIT_FILE=/var/log/mcp-docker-exec/audit.jsonl
   ```

## Examples

### Basic Command Execution

```javascript
// List files in container
{
  "name": "docker_exec",
  "arguments": {
    "id": "my-app",
    "cmd": ["ls", "-la", "/app"]
  }
}
```

### Streaming Long-Running Command

```javascript
// Follow application logs
{
  "name": "docker_exec",
  "arguments": {
    "id": "my-app",
    "cmd": ["tail", "-f", "/var/log/app.log"],
    "stream": true
  }
}
```

### Execute with Input

```javascript
// Send data to command
{
  "name": "docker_exec",
  "arguments": {
    "id": "my-app",
    "cmd": ["sh", "-c", "cat > /tmp/data.txt"],
    "stdin": "Hello, World!"
  }
}
```

### Container Logs with Following

```javascript
// Stream container logs
{
  "name": "docker_logs",
  "arguments": {
    "id": "my-app",
    "follow": true,
    "tail": "50"
  }
}
```

## Remote Docker Support

Connect to remote Docker daemons:

```bash
# SSH connection (key-based auth only)
DOCKER_HOST=ssh://user@remote-host

# TCP connection (ensure TLS is configured)
DOCKER_HOST=tcp://remote-host:2376
```

## Troubleshooting

### Command Hangs
- Ensure `tty: false` (default) for non-interactive commands
- Use `stream: true` for long-running commands
- Set appropriate `timeoutMs`

### Permission Denied
- Check `MCP_DOCKER_ALLOW_ROOT` setting
- Verify user exists in container
- Review security policy settings

### Rate Limit Errors
- Adjust `MCP_DOCKER_EXEC_PER_MINUTE`
- Check audit logs for usage patterns

### Large Output Issues
- Use `stream: true` for commands with large output
- Adjust `MCP_DOCKER_CHUNK_BYTES` for network performance
- Monitor `MCP_DOCKER_MAX_BYTES` for buffered mode

## Development

### Building from Source

```bash
git clone https://github.com/your-org/mcp-docker-exec
cd mcp-docker-exec
npm install
npm run build
```

### Running Tests

```bash
npm test                    # Unit tests
npm run test:integration   # Integration tests
```

### Architecture

```
mcp-docker-exec/
├── src/
│   ├── index.ts           # MCP server entry point
│   ├── docker/
│   │   ├── DockerManager.ts    # Core Docker operations
│   │   ├── ExecSession.ts      # Execution session handling
│   │   └── StreamDemuxer.ts    # Stream demultiplexing
│   ├── security/
│   │   ├── SecurityManager.ts  # Command & access policies
│   │   └── AuditLogger.ts      # Audit trail
│   ├── observability/
│   │   ├── Logger.ts           # Structured logging
│   │   └── MetricsCollector.ts # Metrics collection
│   └── config/
│       └── Config.ts           # Configuration management
└── tests/
    ├── unit/              # Unit tests
    └── integration/       # Integration tests
```

## License

MIT License - see LICENSE file for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass
5. Submit a pull request

## Support

- Issues: https://github.com/your-org/mcp-docker-exec/issues
- Documentation: https://github.com/your-org/mcp-docker-exec/wiki
- Security: security@your-org.com