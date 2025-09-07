#!/bin/bash

# Example security configurations for MCP Docker Exec server

echo "=== MCP Docker Exec Security Configuration Examples ==="
echo

echo "1. Development Mode (Relaxed Security):"
echo "export MCP_DOCKER_ALLOW_ROOT=true"
echo "export MCP_DOCKER_SECURITY=true"
echo "export MCP_DOCKER_COMMAND_POLICY_MODE=none"
echo "export MCP_DOCKER_RATE_LIMITS=false"
echo

echo "2. Production Mode (Strict Security):"
echo "export MCP_DOCKER_ALLOW_ROOT=false"
echo "export MCP_DOCKER_DEFAULT_USER=nobody"
echo "export MCP_DOCKER_SECURITY=true"
echo "export MCP_DOCKER_COMMAND_POLICY_MODE=allowlist"
echo "export MCP_DOCKER_COMMAND_PATTERNS='^ls,^cat,^grep,^echo,^head,^tail,^wc'"
echo "export MCP_DOCKER_DENIED_FLAGS='--privileged,--pid=host,--net=host,--cap-add'"
echo "export MCP_DOCKER_DENIED_PATHS='/etc,/root,/var/lib,/proc/sys'"
echo "export MCP_DOCKER_RATE_LIMITS=true"
echo "export MCP_DOCKER_EXEC_PER_MINUTE=30"
echo "export MCP_DOCKER_AUDIT=true"
echo "export MCP_DOCKER_AUDIT_FILE=/var/log/mcp-docker/audit.jsonl"
echo

echo "3. Read-Only Mode (Investigation/Debugging):"
echo "export MCP_DOCKER_ALLOW_ROOT=false"
echo "export MCP_DOCKER_COMMAND_POLICY_MODE=allowlist"
echo "export MCP_DOCKER_COMMAND_PATTERNS='^ls,^cat,^head,^tail,^grep,^find,^ps,^top,^df,^du'"
echo "export MCP_DOCKER_DRY_RUN=false"
echo

echo "4. Remote Docker Host (SSH):"
echo "export DOCKER_HOST=ssh://user@remote-docker-host"
echo "export MCP_DOCKER_SECURITY=true"
echo "export MCP_DOCKER_AUDIT=true"
echo

echo "5. High-Performance Mode (Large Outputs):"
echo "export MCP_DOCKER_MAX_BYTES=104857600  # 100MB"
echo "export MCP_DOCKER_CHUNK_BYTES=65536     # 64KB chunks"
echo "export MCP_DOCKER_MAX_CONCURRENT=20"
echo

echo "6. Dry Run Mode (Policy Testing):"
echo "export MCP_DOCKER_DRY_RUN=true"
echo "export MCP_DOCKER_LOG_LEVEL=debug"
echo "export MCP_DOCKER_STRUCTURED_LOGS=true"