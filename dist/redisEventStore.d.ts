import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { EventStore } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { createClient } from 'redis';
/**
 * Redis-based implementation of the EventStore interface for resumability
 * Enables multi-node deployment by persisting events in Redis
 */
export declare class RedisEventStore implements EventStore {
    private redis;
    constructor(redis: ReturnType<typeof createClient>);
    /**
     * Generates a unique event ID for a given stream ID
     */
    private generateEventId;
    /**
     * Extracts the stream ID from an event ID
     */
    private getStreamIdFromEventId;
    /**
     * Stores an event with a generated event ID in Redis
     * Uses sorted sets for chronological ordering
     */
    storeEvent(streamId: string, message: JSONRPCMessage): Promise<string>;
    /**
     * Replays events that occurred after a specific event ID
     * Uses Redis sorted sets for efficient range queries
     */
    replayEventsAfter(lastEventId: string, { send }: {
        send: (eventId: string, message: JSONRPCMessage) => Promise<void>;
    }): Promise<string>;
    /**
     * Clean up old events for a stream (optional maintenance)
     */
    cleanupOldEvents(streamId: string, olderThanMs: number): Promise<void>;
}
//# sourceMappingURL=redisEventStore.d.ts.map