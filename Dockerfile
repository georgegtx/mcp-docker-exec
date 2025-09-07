# Multi-stage build for MCP Docker Exec server
FROM node:20-alpine AS builder

# Install build dependencies
RUN apk add --no-cache python3 make g++

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY src/ ./src/

# Build the application
RUN npm run build

# Production stage
FROM node:20-alpine

# Install runtime dependencies
RUN apk add --no-cache tini

# Create non-root user
RUN addgroup -g 1000 mcp && \
    adduser -u 1000 -G mcp -s /bin/sh -D mcp

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev && npm cache clean --force

# Copy built application
COPY --from=builder /app/dist ./dist

# Create log directory
RUN mkdir -p /var/log/mcp-docker && \
    chown -R mcp:mcp /var/log/mcp-docker

# Switch to non-root user
USER mcp

# Use tini for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]

# Start the MCP server
CMD ["node", "dist/index.js"]

# Labels
LABEL org.opencontainers.image.title="MCP Docker Exec Server"
LABEL org.opencontainers.image.description="Model Context Protocol server for Docker container execution"
LABEL org.opencontainers.image.version="1.0.0"
LABEL org.opencontainers.image.vendor="Your Organization"
LABEL org.opencontainers.image.source="https://github.com/your-org/mcp-docker-exec"