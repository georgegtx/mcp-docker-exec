#!/usr/bin/env node

/**
 * Basic usage examples for MCP Docker Exec server
 * 
 * These examples demonstrate how to use the MCP protocol to interact
 * with Docker containers through the MCP server.
 */

// Example 1: Simple command execution
const simpleExec = {
  jsonrpc: "2.0",
  method: "tools/call",
  params: {
    name: "docker_exec",
    arguments: {
      id: "my-app-container",
      cmd: ["echo", "Hello from Docker!"]
    }
  },
  id: 1
};

// Example 2: Streaming output for long-running command
const streamingExec = {
  jsonrpc: "2.0",
  method: "tools/call",
  params: {
    name: "docker_exec",
    arguments: {
      id: "my-app-container",
      cmd: ["tail", "-f", "/var/log/app.log"],
      stream: true,
      timeoutMs: 30000 // 30 seconds
    }
  },
  id: 2
};

// Example 3: Execute with stdin input
const execWithStdin = {
  jsonrpc: "2.0",
  method: "tools/call",
  params: {
    name: "docker_exec",
    arguments: {
      id: "my-app-container",
      cmd: ["sh", "-c", "cat > /tmp/config.json"],
      stdin: JSON.stringify({ key: "value" }, null, 2)
    }
  },
  id: 3
};

// Example 4: Execute as specific user with environment
const execWithUserAndEnv = {
  jsonrpc: "2.0",
  method: "tools/call",
  params: {
    name: "docker_exec",
    arguments: {
      id: "my-app-container",
      cmd: ["node", "script.js"],
      user: "node",
      workdir: "/app",
      env: ["NODE_ENV=production", "DEBUG=app:*"]
    }
  },
  id: 4
};

// Example 5: Get container logs with following
const followLogs = {
  jsonrpc: "2.0",
  method: "tools/call",
  params: {
    name: "docker_logs",
    arguments: {
      id: "my-app-container",
      follow: true,
      tail: "50",
      since: new Date(Date.now() - 3600000).toISOString() // Last hour
    }
  },
  id: 5
};

// Example 6: List all containers
const listContainers = {
  jsonrpc: "2.0",
  method: "tools/call",
  params: {
    name: "docker_ps",
    arguments: {
      all: true
    }
  },
  id: 6
};

// Example 7: Inspect container details
const inspectContainer = {
  jsonrpc: "2.0",
  method: "tools/call",
  params: {
    name: "docker_inspect",
    arguments: {
      kind: "container",
      id: "my-app-container"
    }
  },
  id: 7
};

// Example 8: Health check
const healthCheck = {
  jsonrpc: "2.0",
  method: "tools/call",
  params: {
    name: "health",
    arguments: {}
  },
  id: 8
};

// Print examples
console.log("MCP Docker Exec - Example Commands\n");
console.log("1. Simple execution:");
console.log(JSON.stringify(simpleExec, null, 2));
console.log("\n2. Streaming execution:");
console.log(JSON.stringify(streamingExec, null, 2));
console.log("\n3. Execution with stdin:");
console.log(JSON.stringify(execWithStdin, null, 2));
console.log("\n4. Execution with user and environment:");
console.log(JSON.stringify(execWithUserAndEnv, null, 2));
console.log("\n5. Follow logs:");
console.log(JSON.stringify(followLogs, null, 2));
console.log("\n6. List containers:");
console.log(JSON.stringify(listContainers, null, 2));
console.log("\n7. Inspect container:");
console.log(JSON.stringify(inspectContainer, null, 2));
console.log("\n8. Health check:");
console.log(JSON.stringify(healthCheck, null, 2));