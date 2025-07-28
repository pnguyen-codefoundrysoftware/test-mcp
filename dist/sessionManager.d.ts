import type { createClient } from 'redis';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
export interface SessionMetadata {
    sessionId: string;
    transportType: 'streamable' | 'sse';
    nodeId: string;
    createdAt: number;
    lastActive: number;
}
/**
 * Redis-based session manager for multi-node MCP server deployment
 * Tracks active sessions and their metadata across nodes
 */
export declare class SessionManager {
    private redis;
    private nodeId;
    private localTransports;
    constructor(redis: ReturnType<typeof createClient>, nodeId?: string);
    /**
     * Register a new session
     */
    registerSession(sessionId: string, transport: StreamableHTTPServerTransport | SSEServerTransport, transportType: 'streamable' | 'sse'): Promise<void>;
    /**
     * Get session metadata
     */
    getSession(sessionId: string): Promise<SessionMetadata | null>;
    /**
     * Check if session exists and is on this node
     */
    isSessionLocal(sessionId: string): Promise<boolean>;
    /**
     * Get local transport if session is on this node
     */
    getLocalTransport(sessionId: string): StreamableHTTPServerTransport | SSEServerTransport | null;
    /**
     * Update session last active time
     */
    updateSessionActivity(sessionId: string): Promise<void>;
    /**
     * Unregister a session
     */
    unregisterSession(sessionId: string): Promise<void>;
    /**
     * Get all sessions on this node
     */
    getLocalSessions(): string[];
    /**
     * Clean up expired sessions (call periodically)
     */
    cleanupExpiredSessions(): Promise<void>;
    /**
     * Graceful shutdown - close all local sessions
     */
    shutdown(): Promise<void>;
}
//# sourceMappingURL=sessionManager.d.ts.map