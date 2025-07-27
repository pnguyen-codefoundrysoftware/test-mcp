# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an MCP (Model Context Protocol) server implementation that provides backwards compatibility between two protocol versions:
- **Streamable HTTP Transport** (protocol version 2025-03-26) - modern implementation
- **HTTP+SSE Transport** (protocol version 2024-11-05) - deprecated but maintained for compatibility

The server is built with Express.js and TypeScript, providing MCP capabilities through multiple transport mechanisms.

## Development Commands

```bash
# Build the project
npm run build

# Start production server (requires build first)
npm start

# Start development server with hot reload
npm run dev

# Lint the codebase
npm run lint

# Type check without emitting files
npm run typecheck
```

## Architecture

### Core Components

**src/server.ts** - Main Express server that:
- Exposes `/mcp` endpoint for Streamable HTTP transport (GET/POST/DELETE)
- Exposes `/sse` and `/messages` endpoints for deprecated HTTP+SSE transport
- Manages session-based transport instances with automatic cleanup
- Provides a demo tool `start-notification-stream` for testing resumability

**src/inMemoryEventStore.ts** - EventStore implementation that:
- Enables resumability for Streamable HTTP transport
- Stores events in memory with generated event IDs
- Supports event replay after connection drops
- Not suitable for production (use persistent storage instead)

### Transport Management

The server maintains a session-based transport registry (`transports` map) where:
- Each session gets a unique UUID-based session ID
- Transport cleanup happens automatically on connection close
- Cross-transport protocol validation prevents session conflicts

### Protocol Endpoints

**Streamable HTTP (2025-03-26):**
- `POST /mcp` - Initialize session
- `GET /mcp` - Establish SSE stream  
- `POST /mcp` - Send requests
- `DELETE /mcp` - Terminate session

**HTTP+SSE (2024-11-05):**
- `GET /sse` - Establish SSE stream
- `POST /messages?sessionId=<id>` - Send requests

## Server Configuration

- **Port**: 3000 (hardcoded)
- **CORS**: Allows all origins with exposed `Mcp-Session-Id` header
- **Node Version**: >=18.0.0
- **TypeScript**: ES2022 target with CommonJS modules

## MCP Tool Implementation

The server implements one demonstration tool:
- `start-notification-stream`: Sends periodic notifications for testing resumability features
- Parameters: `interval` (ms between notifications), `count` (number to send)