# MCP KoaJS Server

A multi-node compatible Server-Sent Events (SSE) and Streamable HTTP server implementation using the Model Context Protocol (MCP) TypeScript SDK and KoaJS.

## Features

- **Dual Transport Support**: Both SSE (legacy) and Streamable HTTP protocols
- **Multi-Node Deployment**: Horizontal scaling with Redis-based session management
- **Session Management**: Persistent sessions across server restarts and node failures
- **Load Balancing**: NGINX configuration for optimal request distribution
- **Health Monitoring**: Built-in health checks and monitoring endpoints

## Architecture

### Transport Protocols

1. **SSE Transport** (Protocol 2024-11-05)
   - Legacy support for existing clients
   - Real-time bidirectional communication
   - Session affinity for connection persistence

2. **Streamable HTTP** (Protocol 2025-03-26)
   - Modern HTTP-based transport
   - Chunked transfer encoding for large responses
   - Better scalability and caching support

### Multi-Node Deployment Strategies

The server supports three deployment strategies based on your scaling needs:

1. **Stateless Mode** (Default without Redis)
   - No persistent state between requests
   - Any server can handle any request
   - Simplest deployment model

2. **Persistent Storage Mode** (With Redis)
   - Session data stored in Redis
   - Any node can handle requests for any session
   - Enables horizontal scaling

3. **Session Affinity Mode** (NGINX + Redis)
   - Combines Redis storage with connection affinity
   - Optimal for streaming connections
   - Fault tolerance with graceful failover

## Quick Start

### Local Development

```bash
# Install dependencies
npm install

# Start in development mode
npm run dev

# Build for production
npm run build
npm start
```

### Multi-Node Deployment

```bash
# Start the full stack with Docker Compose
docker-compose up -d

# Scale specific services
docker-compose up -d --scale mcp-server-1=2 --scale mcp-server-2=2
```

## API Endpoints

### Health & Monitoring
- `GET /health` - Health check endpoint
- `GET /sessions` - List active sessions
- `DELETE /sessions/:sessionId` - Terminate session

### SSE Transport (Legacy)
- `GET /sse/:sessionId?` - Establish SSE connection

### Streamable HTTP Transport
- `POST /mcp/v1/init` - Initialize session
- `POST /mcp/v1/message` - Send message
- `GET /mcp/v1/stream/:sessionId` - Establish stream

## Configuration

### Environment Variables

- `NODE_ID` - Unique identifier for this node (auto-generated if not set)
- `REDIS_URL` - Redis connection URL for session storage
- `PORT` - Server port (default: 3000)
- `HOST` - Server host (default: 0.0.0.0)

### Redis Configuration

For multi-node deployments, configure Redis:

```bash
# Local Redis
REDIS_URL=redis://localhost:6379

# Remote Redis
REDIS_URL=redis://user:password@host:port/database
```

## MCP Tools & Resources

The server includes sample tools and resources:

### Tools
- `calculator` - Basic arithmetic operations
- `echo` - Echo back messages

### Resources
- `system://info` - System information
- `config://server` - Server configuration

## Load Balancing

The included NGINX configuration provides:

- **Round-robin** load balancing for HTTP requests
- **IP hash** session affinity for SSE/streaming connections
- **Health checks** with automatic failover
- **Request routing** based on endpoint patterns

## Monitoring

Monitor your deployment with:

```bash
# Check service status
docker-compose ps

# View logs
docker-compose logs -f mcp-server-1

# Monitor Redis
docker-compose exec redis redis-cli monitor
```

## Scaling Considerations

### Horizontal Scaling
- Add more server instances via Docker Compose
- Redis handles session distribution automatically
- NGINX provides load balancing and health checks

### Vertical Scaling
- Increase Node.js memory limits
- Tune Redis memory and persistence settings
- Optimize NGINX worker processes

### Session Management
- Sessions automatically expire after 24 hours
- Use Redis persistence for session durability
- Monitor Redis memory usage and eviction policies

## Development

### Project Structure
```
src/
├── server.ts              # Main Koa server
├── mcp-server.ts          # MCP server instance
├── session-manager.ts     # Multi-node session management
├── sse-handler.ts         # SSE transport implementation
└── streamable-http-handler.ts # Streamable HTTP transport
```

### Adding Custom Tools

```typescript
// In mcp-server.ts
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  switch (name) {
    case 'your-tool':
      // Implement your tool logic
      return { content: [{ type: 'text', text: 'Result' }] };
  }
});
```

### Adding Custom Resources

```typescript
// In mcp-server.ts
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  
  switch (uri) {
    case 'your://resource':
      // Implement your resource logic
      return { contents: [{ uri, mimeType: 'text/plain', text: 'Content' }] };
  }
});
```