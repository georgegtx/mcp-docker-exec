#!/bin/bash

# MCP Docker Exec Server Installation Script

set -e

echo "=== MCP Docker Exec Server Installation ==="
echo

# Check Node.js version
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed. Please install Node.js 18+ first."
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "Error: Node.js 18+ is required. Current version: $(node -v)"
    exit 1
fi

# Check Docker
if ! command -v docker &> /dev/null; then
    echo "Error: Docker is not installed. Please install Docker first."
    exit 1
fi

# Install dependencies
echo "Installing dependencies..."
npm install

# Build the project
echo "Building the project..."
npm run build

# Create directories
echo "Creating directories..."
mkdir -p logs

# Create systemd service (optional)
if [ "$1" == "--systemd" ]; then
    echo "Creating systemd service..."
    sudo tee /etc/systemd/system/mcp-docker-exec.service > /dev/null <<EOF
[Unit]
Description=MCP Docker Exec Server
After=docker.service
Requires=docker.service

[Service]
Type=simple
User=$USER
WorkingDirectory=$(pwd)
ExecStart=$(which node) $(pwd)/dist/index.js
Restart=on-failure
RestartSec=10

# Security
NoNewPrivileges=true
PrivateTmp=true

# Environment
Environment="MCP_DOCKER_ALLOW_ROOT=false"
Environment="MCP_DOCKER_SECURITY=true"
Environment="MCP_DOCKER_AUDIT=true"
Environment="MCP_DOCKER_AUDIT_FILE=$(pwd)/logs/audit.jsonl"

[Install]
WantedBy=multi-user.target
EOF

    sudo systemctl daemon-reload
    echo "Systemd service created. To enable: sudo systemctl enable mcp-docker-exec"
fi

# Create Cursor configuration
CURSOR_CONFIG_DIR="$HOME/.cursor/mcp"
if [ -d "$HOME/.cursor" ]; then
    echo "Setting up Cursor configuration..."
    mkdir -p "$CURSOR_CONFIG_DIR"
    
    cat > "$CURSOR_CONFIG_DIR/mcp-docker-exec.json" <<EOF
{
  "mcpServers": {
    "docker-exec": {
      "command": "$(pwd)/dist/index.js",
      "args": [],
      "env": {
        "MCP_DOCKER_ALLOW_ROOT": "false",
        "MCP_DOCKER_SECURITY": "true",
        "MCP_DOCKER_COMMAND_POLICY_MODE": "none",
        "MCP_DOCKER_MAX_BYTES": "10485760",
        "MCP_DOCKER_AUDIT": "true",
        "MCP_DOCKER_AUDIT_FILE": "$(pwd)/logs/audit.jsonl"
      }
    }
  }
}
EOF
    echo "Cursor configuration created at: $CURSOR_CONFIG_DIR/mcp-docker-exec.json"
fi

echo
echo "=== Installation Complete ==="
echo
echo "To start the server manually:"
echo "  npm start"
echo
echo "To run in development mode:"
echo "  npm run dev"
echo
echo "To run tests:"
echo "  npm test"
echo
echo "Security configuration:"
echo "  Edit environment variables in your shell or systemd service"
echo "  See SECURITY.md for detailed security guidelines"
echo
echo "For Cursor integration, restart Cursor after installation."