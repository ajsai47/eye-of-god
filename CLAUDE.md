# Eye of God

Cross-instance agent collaboration for Claude Code. Peer discovery, messaging, shared channels, task boards, and compound intelligence.

## Architecture

- `broker.ts` — Singleton HTTP daemon on localhost:7899 + SQLite. The core of the system. All communication goes through this.
- `server.ts` — MCP stdio server (legacy, has dual-PID registration bug). Use the broker API directly instead.
- `shared/types.ts` — Shared TypeScript types for broker API.
- `shared/summarize.ts` — Optional auto-summary generation (requires OPENAI_API_KEY).
- `cli.ts` — CLI utility for inspecting broker state.
- `collab.sh` — Shell helper for subagents to participate via bash.
- `test-e2e.sh` — End-to-end test suite (39 tests).

## Quick Start

```bash
# Start the broker
bun broker.ts &

# Check health
curl -s http://localhost:7899/health

# Run E2E tests
bash test-e2e.sh

# CLI
bun cli.ts status
bun cli.ts peers
bun cli.ts send <peer-id> <message>
bun cli.ts kill-broker
```

## How Claude Code Instances Communicate

Instances talk to the broker via HTTP POST. No MCP server needed. See README.md for the full API reference, or use the `/claude-chat` skill.

## Runtime

Uses Bun. `bun install` for dependencies, `bun broker.ts` to start, `bun test` to run tests.
