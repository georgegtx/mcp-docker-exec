# Security Guide for MCP Docker Exec Server

## Overview

The MCP Docker Exec server provides access to Docker containers, which can be equivalent to root access on the host system. This guide covers security best practices and configuration options.

## ⚠️ Critical Security Warning

**Access to the Docker daemon is equivalent to root access on the host machine.** 

Never expose this server to:
- Untrusted networks
- Untrusted clients
- Public internet

This server is designed for **local development use only** by trusted developers.

## Threat Model

### Primary Risks

1. **Container Escape**: Malicious commands could potentially escape container isolation
2. **Host System Access**: Docker socket access can be used to mount host filesystems
3. **Resource Exhaustion**: Uncontrolled execution could consume system resources
4. **Data Exfiltration**: Commands could access and transmit sensitive data
5. **Privilege Escalation**: Running as root in containers can lead to host compromise

### Mitigation Strategies

1. **Command Allowlisting**: Restrict executable commands
2. **User Restrictions**: Prevent root execution
3. **Path Restrictions**: Block access to sensitive directories
4. **Rate Limiting**: Prevent resource exhaustion
5. **Audit Logging**: Track all operations

## Security Configuration

### 1. Basic Hardening

```bash
# Disable root execution
export MCP_DOCKER_ALLOW_ROOT=false
export MCP_DOCKER_DEFAULT_USER=nobody

# Enable security features
export MCP_DOCKER_SECURITY=true

# Enable audit logging
export MCP_DOCKER_AUDIT=true
export MCP_DOCKER_AUDIT_FILE=/var/log/mcp-docker/audit.jsonl
```

### 2. Command Policies

#### Allowlist Mode (Recommended)

Only allow specific, safe commands:

```bash
export MCP_DOCKER_COMMAND_POLICY_MODE=allowlist
export MCP_DOCKER_COMMAND_PATTERNS='^ls,^cat,^grep,^echo,^head,^tail,^pwd,^env'
```

#### Denylist Mode

Block known dangerous commands:

```bash
export MCP_DOCKER_COMMAND_POLICY_MODE=denylist
export MCP_DOCKER_COMMAND_PATTERNS='rm -rf,dd if=,mkfs,mount,chmod 777,curl.*sh'
```

### 3. Path Restrictions

Block access to sensitive paths:

```bash
export MCP_DOCKER_DENIED_PATHS='/etc,/root,/var/lib,/proc/sys,/sys/kernel'
```

### 4. Flag Restrictions

Prevent dangerous Docker flags:

```bash
export MCP_DOCKER_DENIED_FLAGS='--privileged,--pid=host,--net=host,--cap-add,--security-opt'
```

### 5. Rate Limiting

Prevent abuse through rate limits:

```bash
export MCP_DOCKER_RATE_LIMITS=true
export MCP_DOCKER_EXEC_PER_MINUTE=30
export MCP_DOCKER_LOGS_PER_MINUTE=10
```

## Deployment Security

### Running in Docker (Recommended)

```yaml
services:
  mcp-docker-exec:
    image: mcp-docker-exec:latest
    volumes:
      # Read-only Docker socket
      - /var/run/docker.sock:/var/run/docker.sock:ro
    user: "1000:1000"  # Non-root user
    read_only: true     # Read-only root filesystem
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
```

### File Permissions

```bash
# Secure audit log directory
mkdir -p /var/log/mcp-docker
chmod 750 /var/log/mcp-docker
chown mcp:mcp /var/log/mcp-docker

# Restrict Docker socket access (if possible)
chmod 660 /var/run/docker.sock
```

### Network Security

1. **Never expose over network**: Always use stdio transport
2. **SSH tunneling**: For remote access, use SSH port forwarding
3. **TLS only**: If using TCP Docker daemon, always use TLS

## Security Policies

### Development Environment

Balanced security for development:

```bash
export MCP_DOCKER_ALLOW_ROOT=false
export MCP_DOCKER_COMMAND_POLICY_MODE=denylist
export MCP_DOCKER_COMMAND_PATTERNS='rm -rf /,dd if=/dev/zero'
export MCP_DOCKER_RATE_LIMITS=true
```

### Production Environment

Maximum security for production:

```bash
export MCP_DOCKER_ALLOW_ROOT=false
export MCP_DOCKER_DEFAULT_USER=nobody
export MCP_DOCKER_COMMAND_POLICY_MODE=allowlist
export MCP_DOCKER_COMMAND_PATTERNS='^(ls|cat|grep|head|tail|echo|env|pwd)(\s|$)'
export MCP_DOCKER_DENIED_PATHS='/etc,/root,/var,/proc,/sys,/dev'
export MCP_DOCKER_MAX_BYTES=1048576  # 1MB max output
export MCP_DOCKER_TIMEOUT_MS=30000   # 30s max execution
```

### Investigation/Debugging

Read-only access for troubleshooting:

```bash
export MCP_DOCKER_COMMAND_POLICY_MODE=allowlist
export MCP_DOCKER_COMMAND_PATTERNS='^(ls|cat|head|tail|grep|find|ps|top|df|du|netstat)(\s|$)'
export MCP_DOCKER_DRY_RUN=false
```

## Audit Log Analysis

### Log Format

```json
{
  "timestamp": "2024-01-01T12:00:00Z",
  "traceId": "abc123",
  "operation": "exec",
  "containerId": "webapp",
  "command": ["cat", "/etc/passwd"],
  "user": "nobody",
  "exitCode": 0,
  "duration": 45,
  "outputBytes": 1234
}
```

### Monitoring for Suspicious Activity

```bash
# Failed commands
jq 'select(.exitCode != 0)' audit.jsonl

# Root execution attempts
jq 'select(.user == "root" or .user == "0")' audit.jsonl

# Long-running commands
jq 'select(.duration > 60000)' audit.jsonl

# Large outputs
jq 'select(.outputBytes > 10485760)' audit.jsonl

# Blocked commands
jq 'select(.blocked == true)' audit.jsonl
```

### Automated Alerting

```bash
#!/bin/bash
# Watch for suspicious patterns

tail -f /var/log/mcp-docker/audit.jsonl | while read line; do
  # Check for root execution
  if echo "$line" | jq -e '.user == "root"' > /dev/null; then
    echo "ALERT: Root execution attempted" | mail -s "MCP Docker Security Alert" admin@example.com
  fi
  
  # Check for blocked commands
  if echo "$line" | jq -e '.blocked == true' > /dev/null; then
    echo "ALERT: Blocked command: $line" | mail -s "MCP Docker Security Alert" admin@example.com
  fi
done
```

## Security Checklist

- [ ] Docker socket mounted read-only
- [ ] Running as non-root user
- [ ] Command policy configured (allowlist preferred)
- [ ] Path restrictions enabled
- [ ] Rate limiting enabled
- [ ] Audit logging enabled and monitored
- [ ] Regular audit log rotation configured
- [ ] No network exposure
- [ ] Resource limits configured
- [ ] Security patches up to date

## Incident Response

If you suspect a security breach:

1. **Immediately stop the server**
   ```bash
   pkill -f mcp-docker-exec
   ```

2. **Preserve audit logs**
   ```bash
   cp /var/log/mcp-docker/audit.jsonl /secure/location/
   ```

3. **Review recent activity**
   ```bash
   tail -1000 /var/log/mcp-docker/audit.jsonl | jq .
   ```

4. **Check for container modifications**
   ```bash
   docker ps -a
   docker images
   ```

5. **Report the incident** to your security team

## Additional Resources

- [Docker Security Best Practices](https://docs.docker.com/engine/security/)
- [CIS Docker Benchmark](https://www.cisecurity.org/benchmark/docker)
- [NIST Container Security Guide](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-190.pdf)