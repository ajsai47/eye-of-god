# Eye of God

Cross-instance agent collaboration for Claude Code. Peer discovery, messaging, shared channels, task boards, and compound intelligence.

## Architecture

- `broker.ts` — Singleton HTTP daemon on localhost:7899 + SQLite. All communication goes through this.
- `server.ts` — MCP stdio server. Connects to the broker for peer discovery and messaging.
- `shared/types.ts` — Shared TypeScript types for broker API.
- `shared/summarize.ts` — Optional auto-summary generation (requires OPENAI_API_KEY).

## How It Works

1. SessionStart hook runs `smart-install.sh` to ensure Bun + dependencies
2. MCP server starts via `bun server.ts`
3. Server auto-starts broker if not running (`ensureBroker()`)
4. Peer registers with broker and auto-joins #general channel
5. 14 MCP tools become available for cross-instance collaboration

## Runtime

Uses Bun. Broker listens on localhost:7899. SQLite database at `~/.claude-peers.db`.
