# Multi-Node Deployment Guide

This guide explains how to deploy your MCP server in a multi-node environment using Redis for session persistence.

## Architecture Overview

```
Load Balancer (Nginx) 
        ↓
┌─────────────────────┐
│   Round Robin to    │
│   Multiple Nodes    │
└─────────────────────┘
        ↓
┌─────────────────────────────────────┐
│  Node 1    Node 2    Node 3        │
│  :3000     :3000     :3000         │
└─────────────────────────────────────┘
        ↓
┌─────────────────────┐
│    Redis Store      │
│  (Sessions + Events)│
└─────────────────────┘
```

## Key Changes from Single-Node

### 1. Session Management
- **Before**: In-memory `transports` map
- **After**: Redis-based `SessionManager` with local cache

### 2. Event Store
- **Before**: `InMemoryEventStore`
- **After**: `RedisEventStore` with persistence

### 3. Session Handling
- Sessions can exist on any node
- Cross-node session validation
- Automatic cleanup and TTL management

## Deployment Options

### Option A: Docker Compose (Development/Testing)

```bash
# Start all services
docker-compose up -d

# Scale nodes
docker-compose up -d --scale mcp-server-1=2 --scale mcp-server-2=2

# Check health
curl http://localhost/health
```

### Option B: Kubernetes (Production)

```yaml
# redis-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
spec:
  replicas: 1
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
    spec:
      containers:
      - name: redis
        image: redis:7-alpine
        ports:
        - containerPort: 6379
        command: ["redis-server", "--appendonly", "yes"]

---
apiVersion: v1
kind: Service
metadata:
  name: redis-service
spec:
  selector:
    app: redis
  ports:
  - port: 6379
    targetPort: 6379

---
# mcp-server-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mcp-server
spec:
  replicas: 3
  selector:
    matchLabels:
      app: mcp-server
  template:
    metadata:
      labels:
        app: mcp-server
    spec:
      containers:
      - name: mcp-server
        image: your-registry/mcp-server:latest
        ports:
        - containerPort: 3000
        env:
        - name: REDIS_URL
          value: "redis://redis-service:6379"
        - name: NODE_ID
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10

---
apiVersion: v1
kind: Service
metadata:
  name: mcp-server-service
spec:
  selector:
    app: mcp-server
  ports:
  - port: 80
    targetPort: 3000
  type: LoadBalancer
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ID` | Unique identifier for this node | Auto-generated |
| `PORT` | Server port | 3000 |
| `REDIS_URL` | Redis connection string | redis://localhost:6379 |

### Redis Configuration

For production, configure Redis with:
- **Persistence**: Enable AOF and RDB
- **Memory Management**: Set maxmemory policies
- **Security**: Enable AUTH and TLS
- **High Availability**: Use Redis Sentinel or Cluster

```redis
# redis.conf
appendonly yes
save 900 1
save 300 10
save 60 10000
maxmemory 2gb
maxmemory-policy allkeys-lru
requirepass your-strong-password
```

## Monitoring and Observability

### Health Checks
Each node exposes `/health` endpoint:
```json
{
  "status": "healthy",
  "nodeId": "server-1",
  "activeSessions": 5,
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### Key Metrics to Monitor
- Active sessions per node
- Redis connection health
- Session distribution across nodes
- Event store performance
- Memory usage per node

### Logging
Each log entry includes the node ID:
```
[server-1] Session abc123 registered on node server-1
[server-2] Session exists on different node: server-1
```

## Troubleshooting

### Common Issues

1. **Session Conflicts**
   - **Error**: "Session exists on different node"
   - **Cause**: Client routing to wrong node
   - **Solution**: Check load balancer configuration

2. **Redis Connection Failures**
   - **Error**: Redis client error
   - **Cause**: Network issues or Redis down
   - **Solution**: Implement Redis failover

3. **Memory Leaks**
   - **Cause**: Sessions not cleaned up
   - **Solution**: Check TTL settings and cleanup intervals

### Testing Multi-Node Setup

```bash
# Test session persistence
curl -X POST http://localhost/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize",...}'

# Note the Mcp-Session-Id header, then test on different nodes
curl -X GET http://localhost/mcp \
  -H "Mcp-Session-Id: your-session-id"
```

## Performance Considerations

### Redis Optimization
- Use Redis pipelining for bulk operations
- Monitor Redis memory usage
- Consider Redis clustering for large deployments

### Node Optimization
- Set appropriate session TTL (30 minutes default)
- Tune cleanup intervals based on load
- Monitor Node.js memory usage

### Load Balancer
- Use least connections instead of round-robin for better distribution
- Enable session affinity if experiencing issues
- Configure appropriate timeouts for SSE connections

## Security

### Network Security
- Use Redis AUTH and TLS
- Implement proper firewall rules
- Use private networks for inter-service communication

### Session Security
- Validate session IDs
- Implement rate limiting
- Monitor for session abuse

## Migration from Single-Node

1. **Test in Development**
   ```bash
   npm run dev:multi
   ```

2. **Update Dependencies**
   - Ensure Redis is available
   - Update deployment scripts

3. **Gradual Rollout**
   - Deploy alongside existing single-node
   - Gradually shift traffic
   - Monitor metrics during transition

4. **Rollback Plan**
   - Keep single-node version available
   - Have database backups ready
   - Document rollback procedures