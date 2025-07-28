"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionManager = void 0;
/**
 * Redis-based session manager for multi-node MCP server deployment
 * Tracks active sessions and their metadata across nodes
 */
class SessionManager {
    redis;
    nodeId;
    localTransports = new Map();
    constructor(redis, nodeId = `node-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`) {
        this.redis = redis;
        this.nodeId = nodeId;
    }
    /**
     * Register a new session
     */
    async registerSession(sessionId, transport, transportType) {
        const metadata = {
            sessionId,
            transportType,
            nodeId: this.nodeId,
            createdAt: Date.now(),
            lastActive: Date.now()
        };
        // Store in Redis with TTL (30 minutes)
        await this.redis.hSet(`session:${sessionId}`, metadata);
        await this.redis.expire(`session:${sessionId}`, 30 * 60);
        // Store locally for direct access
        this.localTransports.set(sessionId, transport);
        // Set up cleanup handler
        transport.onclose = async () => {
            await this.unregisterSession(sessionId);
        };
        console.log(`Session ${sessionId} registered on node ${this.nodeId}`);
    }
    /**
     * Get session metadata
     */
    async getSession(sessionId) {
        const data = await this.redis.hGetAll(`session:${sessionId}`);
        if (!data || !data.sessionId) {
            return null;
        }
        return {
            sessionId: data.sessionId,
            transportType: data.transportType,
            nodeId: data.nodeId,
            createdAt: parseInt(data.createdAt),
            lastActive: parseInt(data.lastActive)
        };
    }
    /**
     * Check if session exists and is on this node
     */
    async isSessionLocal(sessionId) {
        const metadata = await this.getSession(sessionId);
        return metadata !== null && metadata.nodeId === this.nodeId && this.localTransports.has(sessionId);
    }
    /**
     * Get local transport if session is on this node
     */
    getLocalTransport(sessionId) {
        return this.localTransports.get(sessionId) || null;
    }
    /**
     * Update session last active time
     */
    async updateSessionActivity(sessionId) {
        const exists = await this.redis.exists(`session:${sessionId}`);
        if (exists) {
            await this.redis.hSet(`session:${sessionId}`, 'lastActive', Date.now().toString());
            await this.redis.expire(`session:${sessionId}`, 30 * 60); // Refresh TTL
        }
    }
    /**
     * Unregister a session
     */
    async unregisterSession(sessionId) {
        // Remove from Redis
        await this.redis.del(`session:${sessionId}`);
        // Remove from local storage
        this.localTransports.delete(sessionId);
        console.log(`Session ${sessionId} unregistered from node ${this.nodeId}`);
    }
    /**
     * Get all sessions on this node
     */
    getLocalSessions() {
        return Array.from(this.localTransports.keys());
    }
    /**
     * Clean up expired sessions (call periodically)
     */
    async cleanupExpiredSessions() {
        const localSessions = this.getLocalSessions();
        for (const sessionId of localSessions) {
            const metadata = await this.getSession(sessionId);
            if (!metadata) {
                // Session expired in Redis but still exists locally
                this.localTransports.delete(sessionId);
                console.log(`Cleaned up expired session ${sessionId} from local storage`);
            }
        }
    }
    /**
     * Graceful shutdown - close all local sessions
     */
    async shutdown() {
        console.log(`Shutting down session manager on node ${this.nodeId}...`);
        const localSessions = this.getLocalSessions();
        for (const sessionId of localSessions) {
            const transport = this.localTransports.get(sessionId);
            if (transport) {
                try {
                    await transport.close();
                }
                catch (error) {
                    console.error(`Error closing transport for session ${sessionId}:`, error);
                }
            }
        }
        this.localTransports.clear();
        console.log(`Session manager shutdown complete`);
    }
}
exports.SessionManager = SessionManager;
//# sourceMappingURL=sessionManager.js.map