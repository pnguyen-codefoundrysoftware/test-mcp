import express, { Request, Response } from 'express';
import { randomUUID } from "node:crypto";
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { CallToolResult, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createClient } from 'redis';
import cors from 'cors';
import { RedisEventStore } from './redisEventStore.js';
import { SessionManager } from './sessionManager.js';

/**
 * Stateless multi-node compatible MCP server that uses Redis for session management
 * and event store persistence. Any node can handle any request for any session.
 */

// Environment configuration
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const NODE_ID = process.env.NODE_ID || `node-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
const PORT = parseInt(process.env.PORT || '3000');

// Global instances
let redis: ReturnType<typeof createClient>;
let sessionManager: SessionManager;
let redisEventStore: RedisEventStore;

const getServer = () => {
  const server = new McpServer({
    name: 'multi-node-mcp-server',
    version: '1.0.0',
  }, { capabilities: { logging: {} } });

  // Register the notification streaming tool
  server.tool(
    'start-notification-stream',
    'Starts sending periodic notifications for testing resumability',
    {
      interval: z.number().describe('Interval in milliseconds between notifications').default(100),
      count: z.number().describe('Number of notifications to send (0 for 100)').default(50),
    },
    async ({ interval, count }, { sendNotification }): Promise<CallToolResult> => {
      const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
      let counter = 0;

      while (count === 0 || counter < count) {
        counter++;
        try {
          await sendNotification({
            method: "notifications/message",
            params: {
              level: "info",
              data: `Periodic notification #${counter} from ${NODE_ID} at ${new Date().toISOString()}`
            }
          });
        }
        catch (error) {
          console.error("Error sending notification:", error);
        }
        await sleep(interval);
      }

      return {
        content: [
          {
            type: 'text',
            text: `Started sending periodic notifications every ${interval}ms from node ${NODE_ID}`,
          }
        ],
      };
    }
  );
  return server;
};

// Initialize Redis and session manager
async function initializeRedis() {
  redis = createClient({ url: REDIS_URL });
  
  redis.on('error', (err) => {
    console.error('Redis client error:', err);
  });

  redis.on('connect', () => {
    console.log(`Connected to Redis at ${REDIS_URL}`);
  });

  await redis.connect();
  
  sessionManager = new SessionManager(redis, NODE_ID);
  redisEventStore = new RedisEventStore(redis);
  
  // Start periodic cleanup
  setInterval(() => {
    sessionManager.cleanupExpiredSessions().catch(console.error);
  }, 5 * 60 * 1000); // Every 5 minutes
}

// Create Express application
const app = express();
app.use(express.json());

// Configure CORS
app.use(cors({
  origin: '*',
  exposedHeaders: ['Mcp-Session-Id']
}));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    nodeId: NODE_ID,
    activeSessions: sessionManager?.getLocalSessions().length || 0,
    timestamp: new Date().toISOString()
  });
});

//=============================================================================
// STREAMABLE HTTP TRANSPORT (PROTOCOL VERSION 2025-03-26)
//=============================================================================

app.all('/mcp', async (req: Request, res: Response) => {
  console.log(`[${NODE_ID}] Received ${req.method} request to /mcp`);

  try {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId) {
      // Update session activity
      await sessionManager.updateSessionActivity(sessionId);
      
      // Check if session exists
      if (await sessionManager.sessionExists(sessionId)) {
        // Try to get local transport first
        const existingTransport = sessionManager.getLocalTransport(sessionId);
        if (existingTransport instanceof StreamableHTTPServerTransport) {
          transport = existingTransport;
        } else {
          // Session exists but not locally available, or wrong transport type
          const sessionMetadata = await sessionManager.getSession(sessionId);
          if (sessionMetadata?.transportType === 'streamable') {
            // Create a new transport instance for this session using Redis event store
            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => sessionId, // Use existing session ID
              eventStore: redisEventStore,
            });
            
            // Connect to MCP server
            const server = getServer();
            await server.connect(transport);
            
            console.log(`[${NODE_ID}] Restored streamable transport for session ${sessionId}`);
          } else {
            res.status(400).json({
              jsonrpc: '2.0',
              error: {
                code: -32000,
                message: 'Session exists but uses a different transport protocol',
              },
              id: null,
            });
            return;
          }
        }
      } else {
        res.status(404).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Session not found',
          },
          id: null,
        });
        return;
      }
    } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
      // Create new session
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        eventStore: redisEventStore, // Use Redis-based event store
        onsessioninitialized: async (newSessionId) => {
          console.log(`[${NODE_ID}] StreamableHTTP session initialized: ${newSessionId}`);
          await sessionManager.registerSession(newSessionId, transport, 'streamable');
        }
      });

      // Connect to MCP server
      const server = getServer();
      await server.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: No valid session ID provided or invalid initialization request',
        },
        id: null,
      });
      return;
    }

    // Handle the request
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error(`[${NODE_ID}] Error handling MCP request:`, error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      });
    }
  }
});

//=============================================================================
// STATELESS SSE TRANSPORT (PROTOCOL VERSION 2024-11-05)
//=============================================================================

app.get('/sse', async (req: Request, res: Response) => {
  console.log(`[${NODE_ID}] Received GET request to /sse`);
  
  const sessionId = req.query.sessionId as string | undefined;
  let transport: SSEServerTransport;

  if (sessionId) {
    // Existing session - try to restore or create new SSE connection
    if (await sessionManager.sessionExists(sessionId)) {
      const existingTransport = await sessionManager.getOrCreateSSETransport(sessionId, res);
      if (existingTransport) {
        transport = existingTransport;
        console.log(`[${NODE_ID}] Restored SSE connection for session ${sessionId}`);
      } else {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Failed to restore SSE connection' },
          id: null,
        });
        return;
      }
    } else {
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Session not found' },
        id: null,
      });
      return;
    }
  } else {
    // New session
    transport = new SSEServerTransport('/messages', res);
    await sessionManager.registerSession(transport.sessionId, transport, 'sse');
    console.log(`[${NODE_ID}] Created new SSE session: ${transport.sessionId}`);
  }
  
  const server = getServer();
  await server.connect(transport);
});

app.post("/messages", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  
  if (!sessionId) {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Missing sessionId parameter' },
      id: null,
    });
    return;
  }

  try {
    // Update session activity
    await sessionManager.updateSessionActivity(sessionId);

    // Check if session exists
    if (await sessionManager.sessionExists(sessionId)) {
      // Try to get local transport
      const transport = sessionManager.getLocalTransport(sessionId);
      if (transport instanceof SSEServerTransport) {
        await transport.handlePostMessage(req, res, req.body);
      } else {
        // Session exists but no local SSE transport
        // This means the SSE connection was lost (node went down)
        res.status(410).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'SSE connection lost. Client should reconnect to /sse endpoint.',
          },
          id: null,
        });
      }
    } else {
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Session not found' },
        id: null,
      });
    }
  } catch (error) {
    console.error(`[${NODE_ID}] Error handling SSE message:`, error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

// Start the server
async function startServer() {
  try {
    // Initialize Redis first
    await initializeRedis();
    
    app.listen(PORT, () => {
      console.log(`
==============================================
STATELESS MULTI-NODE MCP SERVER STARTED
Node ID: ${NODE_ID}
Port: ${PORT}
Redis: ${REDIS_URL}

SUPPORTED TRANSPORT OPTIONS:

1. Streamable Http (Protocol version: 2025-03-26)
   Endpoint: /mcp
   Methods: GET, POST, DELETE
   - Fully stateless: any node can handle any session

2. Http + SSE (Protocol version: 2024-11-05)
   Endpoints: /sse (GET) and /messages (POST)
   - Session state stored in Redis
   - SSE connections can be restored on any node
   - If connection is lost, client should reconnect

Health Check: GET /health

STATELESS ARCHITECTURE:
- No hardcoded node registry
- All session state stored in Redis
- Any node can handle any session
- Automatic cleanup of expired sessions
==============================================
`);
    });

    // Graceful shutdown
    process.on('SIGINT', async () => {
      console.log('Shutting down server...');
      await sessionManager.shutdown();
      await redis.quit();
      process.exit(0);
    });

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();