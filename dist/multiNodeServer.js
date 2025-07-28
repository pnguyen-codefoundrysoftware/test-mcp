"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const node_crypto_1 = require("node:crypto");
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const sse_js_1 = require("@modelcontextprotocol/sdk/server/sse.js");
const zod_1 = require("zod");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const redis_1 = require("redis");
const cors_1 = __importDefault(require("cors"));
const redisEventStore_js_1 = require("./redisEventStore.js");
const sessionManager_js_1 = require("./sessionManager.js");
/**
 * Multi-node compatible MCP server that uses Redis for session management
 * and event store persistence. Any node can handle any request.
 */
// Environment configuration
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const NODE_ID = process.env.NODE_ID || `node-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
const PORT = parseInt(process.env.PORT || '3000');
// Node registry for proxying requests
const NODE_REGISTRY = {
    'server-1': process.env.SERVER_1_URL || 'http://mcp-server-1:3000',
    'server-2': process.env.SERVER_2_URL || 'http://mcp-server-2:3000',
    'server-3': process.env.SERVER_3_URL || 'http://mcp-server-3:3000',
};
// Global instances
let redis;
let sessionManager;
let redisEventStore;
/**
 * Proxy a request to another node
 */
async function proxyRequest(req, res, targetNodeId, path) {
    const targetUrl = NODE_REGISTRY[targetNodeId];
    if (!targetUrl) {
        console.error(`No URL found for node ${targetNodeId}`);
        res.status(500).json({
            jsonrpc: '2.0',
            error: {
                code: -32603,
                message: `No URL configured for node ${targetNodeId}`,
            },
            id: null,
        });
        return;
    }
    try {
        console.log(`[${NODE_ID}] Proxying ${req.method} request to ${targetNodeId} at ${targetUrl}${path}`);
        const url = `${targetUrl}${path}${req.url.includes('?') ? '?' + req.url.split('?')[1] : ''}`;
        // Prepare headers, excluding host to avoid conflicts
        const headers = {};
        Object.entries(req.headers).forEach(([key, value]) => {
            if (key.toLowerCase() !== 'host' && typeof value === 'string') {
                headers[key] = value;
            }
        });
        const proxyReq = await fetch(url, {
            method: req.method,
            headers,
            body: req.method !== 'GET' && req.method !== 'HEAD' ? JSON.stringify(req.body) : undefined,
        });
        // Copy response headers
        proxyReq.headers.forEach((value, key) => {
            res.setHeader(key, value);
        });
        res.status(proxyReq.status);
        if (proxyReq.body) {
            const reader = proxyReq.body.getReader();
            const pump = async () => {
                const { done, value } = await reader.read();
                if (done) {
                    res.end();
                    return;
                }
                res.write(Buffer.from(value));
                pump();
            };
            pump();
        }
        else {
            res.end();
        }
    }
    catch (error) {
        console.error(`[${NODE_ID}] Error proxying request to ${targetNodeId}:`, error);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: {
                    code: -32603,
                    message: `Failed to proxy request to node ${targetNodeId}`,
                },
                id: null,
            });
        }
    }
}
const getServer = () => {
    const server = new mcp_js_1.McpServer({
        name: 'multi-node-mcp-server',
        version: '1.0.0',
    }, { capabilities: { logging: {} } });
    // Register the notification streaming tool
    server.tool('start-notification-stream', 'Starts sending periodic notifications for testing resumability', {
        interval: zod_1.z.number().describe('Interval in milliseconds between notifications').default(100),
        count: zod_1.z.number().describe('Number of notifications to send (0 for 100)').default(50),
    }, async ({ interval, count }, { sendNotification }) => {
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
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
    });
    return server;
};
// Initialize Redis and session manager
async function initializeRedis() {
    redis = (0, redis_1.createClient)({ url: REDIS_URL });
    redis.on('error', (err) => {
        console.error('Redis client error:', err);
    });
    redis.on('connect', () => {
        console.log(`Connected to Redis at ${REDIS_URL}`);
    });
    await redis.connect();
    sessionManager = new sessionManager_js_1.SessionManager(redis, NODE_ID);
    redisEventStore = new redisEventStore_js_1.RedisEventStore(redis);
    // Start periodic cleanup
    setInterval(() => {
        sessionManager.cleanupExpiredSessions().catch(console.error);
    }, 5 * 60 * 1000); // Every 5 minutes
}
// Create Express application
const app = (0, express_1.default)();
app.use(express_1.default.json());
// Configure CORS
app.use((0, cors_1.default)({
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
app.all('/mcp', async (req, res) => {
    console.log(`[${NODE_ID}] Received ${req.method} request to /mcp`);
    try {
        const sessionId = req.headers['mcp-session-id'];
        let transport;
        if (sessionId) {
            // Update session activity
            await sessionManager.updateSessionActivity(sessionId);
            // Check if session exists locally
            if (await sessionManager.isSessionLocal(sessionId)) {
                const existingTransport = sessionManager.getLocalTransport(sessionId);
                if (existingTransport instanceof streamableHttp_js_1.StreamableHTTPServerTransport) {
                    transport = existingTransport;
                }
                else {
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
            }
            else {
                // Session exists but not on this node, check Redis
                const sessionMetadata = await sessionManager.getSession(sessionId);
                if (sessionMetadata) {
                    // Forward the request to the correct node
                    await proxyRequest(req, res, sessionMetadata.nodeId, req.url);
                    return;
                }
                else {
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
            }
        }
        else if (!sessionId && req.method === 'POST' && (0, types_js_1.isInitializeRequest)(req.body)) {
            // Create new session
            transport = new streamableHttp_js_1.StreamableHTTPServerTransport({
                sessionIdGenerator: () => (0, node_crypto_1.randomUUID)(),
                eventStore: redisEventStore, // Use Redis-based event store
                onsessioninitialized: async (newSessionId) => {
                    console.log(`[${NODE_ID}] StreamableHTTP session initialized: ${newSessionId}`);
                    await sessionManager.registerSession(newSessionId, transport, 'streamable');
                }
            });
            // Connect to MCP server
            const server = getServer();
            await server.connect(transport);
        }
        else {
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
    }
    catch (error) {
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
// DEPRECATED HTTP+SSE TRANSPORT (PROTOCOL VERSION 2024-11-05)
//=============================================================================
app.get('/sse', async (req, res) => {
    console.log(`[${NODE_ID}] Received GET request to /sse (deprecated SSE transport)`);
    const transport = new sse_js_1.SSEServerTransport('/messages', res);
    await sessionManager.registerSession(transport.sessionId, transport, 'sse');
    const server = getServer();
    await server.connect(transport);
});
app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) {
        res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Missing sessionId parameter' },
            id: null,
        });
        return;
    }
    // Update session activity
    await sessionManager.updateSessionActivity(sessionId);
    // Check if session is local
    if (await sessionManager.isSessionLocal(sessionId)) {
        const transport = sessionManager.getLocalTransport(sessionId);
        if (transport instanceof sse_js_1.SSEServerTransport) {
            await transport.handlePostMessage(req, res, req.body);
        }
        else {
            res.status(400).json({
                jsonrpc: '2.0',
                error: {
                    code: -32000,
                    message: 'Session exists but uses a different transport protocol',
                },
                id: null,
            });
        }
    }
    else {
        // Check if session exists on another node
        const sessionMetadata = await sessionManager.getSession(sessionId);
        if (sessionMetadata) {
            // Forward the request to the correct node
            await proxyRequest(req, res, sessionMetadata.nodeId, req.path);
        }
        else {
            res.status(404).json({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Session not found' },
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
MULTI-NODE MCP SERVER STARTED
Node ID: ${NODE_ID}
Port: ${PORT}
Redis: ${REDIS_URL}

SUPPORTED TRANSPORT OPTIONS:

1. Streamable Http (Protocol version: 2025-03-26)
   Endpoint: /mcp
   Methods: GET, POST, DELETE

2. Http + SSE (Protocol version: 2024-11-05)
   Endpoints: /sse (GET) and /messages (POST)

Health Check: GET /health
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
    }
    catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}
startServer();
//# sourceMappingURL=multiNodeServer.js.map