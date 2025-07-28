"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisEventStore = void 0;
/**
 * Redis-based implementation of the EventStore interface for resumability
 * Enables multi-node deployment by persisting events in Redis
 */
class RedisEventStore {
    redis;
    constructor(redis) {
        this.redis = redis;
    }
    /**
     * Generates a unique event ID for a given stream ID
     */
    generateEventId(streamId) {
        return `${streamId}_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    }
    /**
     * Extracts the stream ID from an event ID
     */
    getStreamIdFromEventId(eventId) {
        const parts = eventId.split('_');
        return parts.length > 0 ? parts[0] : '';
    }
    /**
     * Stores an event with a generated event ID in Redis
     * Uses sorted sets for chronological ordering
     */
    async storeEvent(streamId, message) {
        const eventId = this.generateEventId(streamId);
        const timestamp = Date.now();
        // Store the event data
        await this.redis.hSet(`event:${eventId}`, {
            streamId,
            message: JSON.stringify(message),
            timestamp: timestamp.toString()
        });
        // Add to sorted set for chronological ordering
        await this.redis.zAdd(`stream:${streamId}`, {
            score: timestamp,
            value: eventId
        });
        // Set TTL for cleanup (24 hours)
        await this.redis.expire(`event:${eventId}`, 24 * 60 * 60);
        await this.redis.expire(`stream:${streamId}`, 24 * 60 * 60);
        return eventId;
    }
    /**
     * Replays events that occurred after a specific event ID
     * Uses Redis sorted sets for efficient range queries
     */
    async replayEventsAfter(lastEventId, { send }) {
        if (!lastEventId) {
            return '';
        }
        // Extract the stream ID from the event ID
        const streamId = this.getStreamIdFromEventId(lastEventId);
        if (!streamId) {
            return '';
        }
        // Get the timestamp of the last event
        const lastEventData = await this.redis.hGetAll(`event:${lastEventId}`);
        if (!lastEventData || !lastEventData.timestamp) {
            return '';
        }
        const lastTimestamp = parseInt(lastEventData.timestamp);
        // Get all events after the last timestamp
        const eventIds = await this.redis.zRangeByScore(`stream:${streamId}`, lastTimestamp + 1, '+inf');
        // Send each event in chronological order
        for (const eventId of eventIds) {
            const eventData = await this.redis.hGetAll(`event:${eventId}`);
            if (eventData && eventData.message) {
                try {
                    const message = JSON.parse(eventData.message);
                    await send(eventId, message);
                }
                catch (error) {
                    console.error(`Error parsing event ${eventId}:`, error);
                }
            }
        }
        return streamId;
    }
    /**
     * Clean up old events for a stream (optional maintenance)
     */
    async cleanupOldEvents(streamId, olderThanMs) {
        const cutoffTime = Date.now() - olderThanMs;
        // Get old event IDs
        const oldEventIds = await this.redis.zRangeByScore(`stream:${streamId}`, '-inf', cutoffTime);
        // Remove old events
        for (const eventId of oldEventIds) {
            await this.redis.del(`event:${eventId}`);
        }
        // Remove from sorted set
        await this.redis.zRemRangeByScore(`stream:${streamId}`, '-inf', cutoffTime);
    }
}
exports.RedisEventStore = RedisEventStore;
//# sourceMappingURL=redisEventStore.js.map