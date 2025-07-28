# Stateless MCP Server Deployment Guide

This guide explains how to deploy the stateless MCP server in an autoscaling environment where nodes are not known in advance.

## Architecture Overview

The stateless MCP server design eliminates the need for hardcoded node registries and enables true horizontal scaling:

- **No Node Affinity**: Sessions aren't tied to specific nodes
- **Redis State Store**: All session state stored in Redis with TTL
- **Transport Restoration**: Any node can handle any session by recreating transports from Redis state
- **Graceful Degradation**: Clear error messages when connections are lost

## Key Features

✅ **Autoscaling Ready**: Add/remove nodes dynamically without configuration  
✅ **Load Balancer Friendly**: Round-robin or any routing strategy works  
✅ **Session Persistence**: Sessions survive node failures and restarts  
✅ **Fault Tolerant**: Graceful handling of node failures  
✅ **Cloud Native**: Designed for containerized environments  

## Quick Start with Docker Compose

```bash
# Start with auto-scaling support
docker-compose -f docker-compose.autoscale.yml up -d

# Scale to 3 nodes
docker-compose -f docker-compose.autoscale.yml up -d --scale mcp-server=3

# Scale to 5 nodes
docker-compose -f docker-compose.autoscale.yml up -d --scale mcp-server=5

# Scale down to 2 nodes
docker-compose -f docker-compose.autoscale.yml up -d --scale mcp-server=2
```

## Environment Configuration

### Required Environment Variables

```bash
REDIS_URL=redis://your-redis-host:6379
PORT=3000
```

### Optional Environment Variables

```bash
NODE_ID=custom-node-identifier  # Auto-generated if not provided
```

## Cloud Deployment Examples

### AWS ECS with Application Load Balancer

```yaml
# task-definition.json
{
  "family": "mcp-server",
  "taskRoleArn": "arn:aws:iam::account:role/ecsTaskRole",
  "executionRoleArn": "arn:aws:iam::account:role/ecsTaskExecutionRole",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "containerDefinitions": [
    {
      "name": "mcp-server",
      "image": "your-registry/mcp-server:latest",
      "environment": [
        {
          "name": "REDIS_URL",
          "value": "redis://your-elasticache-cluster:6379"
        },
        {
          "name": "PORT",
          "value": "3000"
        }
      ],
      "portMappings": [
        {
          "containerPort": 3000,
          "protocol": "tcp"
        }
      ],
      "healthCheck": {
        "command": ["CMD-SHELL", "curl -f http://localhost:3000/health || exit 1"],
        "interval": 30,
        "timeout": 5,
        "retries": 3
      }
    }
  ]
}
```

### Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mcp-server
spec:
  replicas: 3  # Auto-scaled by HPA
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
        - name: PORT
          value: "3000"
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 5
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
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: mcp-server-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: mcp-server
  minReplicas: 2
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

## Load Balancer Configuration

### Session Handling

The stateless design works with any load balancing strategy:

- **Round Robin**: Default and recommended
- **Least Connections**: Good for varying request patterns
- **IP Hash**: Can be used but not required

### Special Considerations for SSE

For SSE connections, consider:

1. **Connection Stickiness**: While not required, can improve performance
2. **Timeout Settings**: Configure longer timeouts for SSE endpoints
3. **Health Checks**: Use `/health` endpoint for node health

### Example ALB Configuration (AWS)

```yaml
# Application Load Balancer Target Group
HealthCheckPath: /health
HealthCheckIntervalSeconds: 30
HealthyThresholdCount: 2
UnhealthyThresholdCount: 3
TargetGroupAttributes:
  - Key: deregistration_delay.timeout_seconds
    Value: 30
  - Key: load_balancing.algorithm.type
    Value: round_robin
```

## Monitoring and Observability

### Health Check Endpoint

```bash
curl http://your-server/health
```

Response:
```json
{
  "status": "healthy",
  "nodeId": "node-1640995200000-abc123",
  "activeSessions": 5,
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### Key Metrics to Monitor

- **Active Sessions**: Number of sessions handled by each node
- **Redis Connection**: Redis connectivity and latency
- **Session Cleanup**: Expired session cleanup frequency
- **Transport Restoration**: How often transports are recreated

## Client Behavior

### Streamable HTTP Transport
- **Transparent**: No changes needed in client code
- **Automatic**: Sessions automatically restored across nodes
- **Resilient**: Survives node failures seamlessly

### SSE Transport
- **Reconnection Required**: If SSE connection lost, client gets HTTP 410
- **Session Preservation**: Reconnect with existing session ID
- **Example**: `GET /sse?sessionId=existing-session-id`

## Troubleshooting

### Common Issues

1. **Redis Connection Failures**
   - Check Redis connectivity from all nodes
   - Verify Redis URL configuration
   - Monitor Redis memory usage

2. **Session Not Found Errors**
   - Check Redis TTL settings (default 30 minutes)
   - Verify session cleanup intervals
   - Monitor Redis key expiration

3. **SSE Connection Lost**
   - Expected behavior when nodes restart
   - Client should reconnect to `/sse` endpoint
   - Use existing session ID in query parameter

### Debug Commands

```bash
# Check Redis session data
redis-cli KEYS "session:*"
redis-cli HGETALL "session:your-session-id"

# Monitor Redis operations
redis-cli MONITOR

# Check node health
curl http://node-url/health
```

## Production Checklist

- [ ] Redis cluster with high availability
- [ ] Load balancer with health checks
- [ ] Proper TTL settings for sessions
- [ ] Monitoring and alerting setup
- [ ] SSL/TLS termination
- [ ] Rate limiting configuration
- [ ] Log aggregation
- [ ] Backup and disaster recovery

## Security Considerations

- Use Redis AUTH and SSL in production
- Implement proper network security groups
- Configure rate limiting and DDoS protection
- Use secure session ID generation
- Monitor for suspicious session patterns 