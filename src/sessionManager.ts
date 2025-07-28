import type { createClient } from 'redis';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

export interface SessionMetadata {
  sessionId: string;
  transportType: 'streamable' | 'sse';
  createdAt: number;
  lastActive: number;
  // For SSE sessions, store additional state
  sseState?: {
    isConnected: boolean;
    lastEventId?: string;
  };
}

/**
 * Redis-based session manager for stateless multi-node MCP server deployment
 * All session state is stored in Redis, allowing any node to handle any session
 */
export class SessionManager {
  private redis: ReturnType<typeof createClient>;
  private nodeId: string;
  private localTransports: Map<string, StreamableHTTPServerTransport | SSEServerTransport> = new Map();

  constructor(redis: ReturnType<typeof createClient>, nodeId: string = `node-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`) {
    this.redis = redis;
    this.nodeId = nodeId;
  }

  /**
   * Register a new session with all state stored in Redis
   */
  async registerSession(
    sessionId: string, 
    transport: StreamableHTTPServerTransport | SSEServerTransport,
    transportType: 'streamable' | 'sse'
  ): Promise<void> {
    const metadata: SessionMetadata = {
      sessionId,
      transportType,
      createdAt: Date.now(),
      lastActive: Date.now(),
      ...(transportType === 'sse' && {
        sseState: {
          isConnected: true,
          lastEventId: undefined
        }
      })
    };

    // Store in Redis with TTL (30 minutes)
    await this.redis.hSet(`session:${sessionId}`, this.serializeMetadata(metadata));
    await this.redis.expire(`session:${sessionId}`, 30 * 60);

    // Store locally for direct access while this node handles the connection
    this.localTransports.set(sessionId, transport);

    // Set up cleanup handler
    transport.onclose = async () => {
      await this.markSessionDisconnected(sessionId);
      this.localTransports.delete(sessionId);
    };

    console.log(`[${this.nodeId}] Session ${sessionId} registered (type: ${transportType})`);
  }

  /**
   * Get session metadata from Redis
   */
  async getSession(sessionId: string): Promise<SessionMetadata | null> {
    const data = await this.redis.hGetAll(`session:${sessionId}`);
    if (!data || !data.sessionId) {
      return null;
    }

    return this.deserializeMetadata(data);
  }

  /**
   * Check if session exists (in Redis) regardless of which node handles it
   */
  async sessionExists(sessionId: string): Promise<boolean> {
    const exists = await this.redis.exists(`session:${sessionId}`);
    return exists === 1;
  }

  /**
   * Get local transport if available on this node
   */
  getLocalTransport(sessionId: string): StreamableHTTPServerTransport | SSEServerTransport | null {
    return this.localTransports.get(sessionId) || null;
  }

  /**
   * Update session last active time
   */
  async updateSessionActivity(sessionId: string): Promise<void> {
    const exists = await this.redis.exists(`session:${sessionId}`);
    if (exists) {
      await this.redis.hSet(`session:${sessionId}`, 'lastActive', Date.now().toString());
      await this.redis.expire(`session:${sessionId}`, 30 * 60); // Refresh TTL
    }
  }

  /**
   * Mark SSE session as disconnected (for when a node goes down)
   */
  async markSessionDisconnected(sessionId: string): Promise<void> {
    const metadata = await this.getSession(sessionId);
    if (metadata && metadata.transportType === 'sse' && metadata.sseState) {
      metadata.sseState.isConnected = false;
      metadata.lastActive = Date.now();
      
      await this.redis.hSet(`session:${sessionId}`, this.serializeMetadata(metadata));
      console.log(`[${this.nodeId}] SSE session ${sessionId} marked as disconnected`);
    }
  }

  /**
   * Check if SSE session is connected
   */
  async isSSEConnected(sessionId: string): Promise<boolean> {
    const metadata = await this.getSession(sessionId);
    return metadata?.transportType === 'sse' && metadata.sseState?.isConnected === true;
  }

  /**
   * Create or restore SSE transport for a session
   */
  async getOrCreateSSETransport(sessionId: string, res?: any): Promise<SSEServerTransport | null> {
    const metadata = await this.getSession(sessionId);
    if (!metadata || metadata.transportType !== 'sse') {
      return null;
    }

    // If we have a local transport, return it
    const localTransport = this.localTransports.get(sessionId);
    if (localTransport instanceof SSEServerTransport) {
      return localTransport;
    }

    // If we have a response object, we can create a new SSE connection
    if (res) {
      const transport = new SSEServerTransport('/messages', res);
      // Override the sessionId to match the existing session
      (transport as any).sessionId = sessionId;
      
      // Register this transport locally
      this.localTransports.set(sessionId, transport);
      
      // Update metadata to mark as connected
      if (metadata.sseState) {
        metadata.sseState.isConnected = true;
      }
      await this.redis.hSet(`session:${sessionId}`, this.serializeMetadata(metadata));
      
      console.log(`[${this.nodeId}] SSE transport restored for session ${sessionId}`);
      return transport;
    }

    return null;
  }

  /**
   * Remove a session completely
   */
  async removeSession(sessionId: string): Promise<void> {
    // Remove from Redis
    await this.redis.del(`session:${sessionId}`);
    
    // Remove from local storage
    this.localTransports.delete(sessionId);
    
    console.log(`[${this.nodeId}] Session ${sessionId} removed`);
  }

  /**
   * Get all sessions on this node
   */
  getLocalSessions(): string[] {
    return Array.from(this.localTransports.keys());
  }

  /**
   * Clean up expired sessions (call periodically)
   */
  async cleanupExpiredSessions(): Promise<void> {
    const localSessions = this.getLocalSessions();
    
    for (const sessionId of localSessions) {
      const metadata = await this.getSession(sessionId);
      if (!metadata) {
        // Session expired in Redis but still exists locally
        this.localTransports.delete(sessionId);
        console.log(`[${this.nodeId}] Cleaned up expired session ${sessionId} from local storage`);
      }
    }
  }

  /**
   * Graceful shutdown - close all local sessions
   */
  async shutdown(): Promise<void> {
    console.log(`[${this.nodeId}] Shutting down session manager...`);
    
    const localSessions = this.getLocalSessions();
    for (const sessionId of localSessions) {
      const transport = this.localTransports.get(sessionId);
      if (transport) {
        try {
          // Mark SSE sessions as disconnected but keep them in Redis
          if (transport instanceof SSEServerTransport) {
            await this.markSessionDisconnected(sessionId);
          }
          await transport.close();
        } catch (error) {
          console.error(`Error closing transport for session ${sessionId}:`, error);
        }
      }
    }
    
    this.localTransports.clear();
    console.log(`[${this.nodeId}] Session manager shutdown complete`);
  }

  /**
   * Serialize metadata for Redis storage
   */
  private serializeMetadata(metadata: SessionMetadata): Record<string, string> {
    const serialized: Record<string, string> = {
      sessionId: metadata.sessionId,
      transportType: metadata.transportType,
      createdAt: metadata.createdAt.toString(),
      lastActive: metadata.lastActive.toString(),
    };

    if (metadata.sseState) {
      serialized.sseState = JSON.stringify(metadata.sseState);
    }

    return serialized;
  }

  /**
   * Deserialize metadata from Redis
   */
  private deserializeMetadata(data: Record<string, string>): SessionMetadata {
    const metadata: SessionMetadata = {
      sessionId: data.sessionId,
      transportType: data.transportType as 'streamable' | 'sse',
      createdAt: parseInt(data.createdAt),
      lastActive: parseInt(data.lastActive)
    };

    if (data.sseState) {
      try {
        metadata.sseState = JSON.parse(data.sseState);
      } catch (error) {
        console.error('Failed to parse SSE state:', error);
      }
    }

    return metadata;
  }
}