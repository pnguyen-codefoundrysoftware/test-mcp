import express, { Request, Response } from 'express';
import { randomUUID } from "node:crypto";
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { CallToolResult, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryEventStore } from './inMemoryEventStore.js';
import cors from 'cors';

/**
 * This example server demonstrates backwards compatibility with both:
 * 1. The deprecated HTTP+SSE transport (protocol version 2024-11-05)
 * 2. The Streamable HTTP transport (protocol version 2025-03-26)
 * 
 * It maintains a single MCP server instance but exposes two transport options:
 * - /mcp: The new Streamable HTTP endpoint (supports GET/POST/DELETE)
 * - /sse: The deprecated SSE endpoint for older clients (GET to establish stream)
 * - /messages: The deprecated POST endpoint for older clients (POST to send messages)
 */

const getServer = () => {
  const server = new McpServer({
    name: 'backwards-compatible-server',
    version: '1.0.0',
  }, { capabilities: { logging: {} } });

  // Register a simple tool that sends notifications over time
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
              data: `Periodic notification #${counter} at ${new Date().toISOString()}`
            }
          });
        }
        catch (error) {
          console.error("Error sending notification:", error);
        }
        // Wait for the specified interval
        await sleep(interval);
      }

      return {
        content: [
          {
            type: 'text',
            text: `Started sending periodic notifications every ${interval}ms`,
          }
        ],
      };
    }
  );
  return server;
};

// Create Express application
const app = express();
app.use(express.json());

// Configure CORS to expose Mcp-Session-Id header for browser-based clients
app.use(cors({
  origin: '*', // Allow all origins - adjust as needed for production
  exposedHeaders: ['Mcp-Session-Id']
}));

// Store transports by session ID
const transports: Record<string, StreamableHTTPServerTransport | SSEServerTransport> = {};

//=============================================================================
// STREAMABLE HTTP TRANSPORT (PROTOCOL VERSION 2025-03-26)
//=============================================================================

// Handle all MCP Streamable HTTP requests (GET, POST, DELETE) on a single endpoint
app.all('/mcp', async (req: Request, res: Response) => {
  console.log(`Received ${req.method} request to /mcp`);

  try {
    // Check for existing session ID
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      // Check if the transport is of the correct type
      const existingTransport = transports[sessionId];
      if (existingTransport instanceof StreamableHTTPServerTransport) {
        // Reuse existing transport
        transport = existingTransport;
      } else {
        // Transport exists but is not a StreamableHTTPServerTransport (could be SSEServerTransport)
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: Session exists but uses a different transport protocol',
          },
          id: null,
        });
        return;
      }
    } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
      const eventStore = new InMemoryEventStore();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        eventStore, // Enable resumability
        onsessioninitialized: (sessionId) => {
          // Store the transport by session ID when session is initialized
          console.log(`StreamableHTTP session initialized with ID: ${sessionId}`);
          transports[sessionId] = transport;
        }
      });

      // Set up onclose handler to clean up transport when closed
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          console.log(`Transport closed for session ${sid}, removing from transports map`);
          delete transports[sid];
        }
      };

      // Connect the transport to the MCP server
      const server = getServer();
      await server.connect(transport);
    } else {
      // Invalid request - no session ID or not initialization request
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: No valid session ID provided',
        },
        id: null,
      });
      return;
    }

    // Handle the request with the transport
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error handling MCP request:', error);
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
// DEPRECATED HTTP+SSE TRANSPORT (PROTOCOL VERSION 2024-11-05)
//=============================================================================

app.get('/sse', async (req: Request, res: Response) => {
  console.log('Received GET request to /sse (deprecated SSE transport)');
  const transport = new SSEServerTransport('/messages', res);
  transports[transport.sessionId] = transport;
  res.on("close", () => {
    delete transports[transport.sessionId];
  });
  const server = getServer();
  await server.connect(transport);
});

app.post("/messages", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  let transport: SSEServerTransport;
  const existingTransport = transports[sessionId];
  if (existingTransport instanceof SSEServerTransport) {
    // Reuse existing transport
    transport = existingTransport;
  } else {
    // Transport exists but is not a SSEServerTransport (could be StreamableHTTPServerTransport)
    res.status(400).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Bad Request: Session exists but uses a different transport protocol',
      },
      id: null,
    });
    return;
  }
  if (transport) {
    await transport.handlePostMessage(req, res, req.body);
  } else {
    res.status(400).send('No transport found for sessionId');
  }
});


// Start the server
const PORT = 3000;
app.listen(PORT, (error) => {
  if (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
  console.log(`Backwards compatible MCP server listening on port ${PORT}`);
  console.log(`
==============================================
SUPPORTED TRANSPORT OPTIONS:

1. Streamable Http(Protocol version: 2025-03-26)
   Endpoint: /mcp
   Methods: GET, POST, DELETE
   Usage: 
     - Initialize with POST to /mcp
     - Establish SSE stream with GET to /mcp
     - Send requests with POST to /mcp
     - Terminate session with DELETE to /mcp

2. Http + SSE (Protocol version: 2024-11-05)
   Endpoints: /sse (GET) and /messages (POST)
   Usage:
     - Establish SSE stream with GET to /sse
     - Send requests with POST to /messages?sessionId=<id>
==============================================
`);
});

// Handle server shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down server...');

  // Close all active transports to properly clean up resources
  for (const sessionId in transports) {
    try {
      console.log(`Closing transport for session ${sessionId}`);
      await transports[sessionId].close();
      delete transports[sessionId];
    } catch (error) {
      console.error(`Error closing transport for session ${sessionId}:`, error);
    }
  }
  console.log('Server shutdown complete');
  process.exit(0);
});