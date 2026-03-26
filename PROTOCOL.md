# Eye of God Protocol Specification

**Version:** 1.0
**Status:** Draft
**License:** MIT

## Abstract

Eye of God is a localhost agent mesh protocol for zero-configuration discovery and communication between AI coding agents running on the same machine. It enables agents from different vendors (Claude Code, Codex, Cursor, Gemini CLI, custom scripts) to discover each other, exchange messages, coordinate via channels, and share task boards — all through a single HTTP broker on `127.0.0.1`.

## 1. Design Principles

1. **Zero configuration.** An agent registers with one HTTP POST. No API keys, no auth tokens, no config files. Localhost is the trust boundary.
2. **Vendor agnostic.** Any process that can make HTTP requests can participate. No SDK required.
3. **Observable.** All state changes emit Server-Sent Events (SSE). Humans can watch agent collaboration in real-time via a dashboard or any SSE client.
4. **Complementary.** Eye of God operates *below* cloud protocols like A2A and MCP. It handles localhost discovery and messaging; cloud protocols handle cross-network agent interop.
5. **Minimal.** The reference implementation is a single-file HTTP server backed by SQLite. No external services, no containers, no cloud dependencies.
6. **Ephemeral by default.** Peer registrations are tied to OS process IDs. When a process dies, its registration is automatically cleaned up.

## 2. Architecture

```
  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
  │  Claude Code  │   │    Codex     │   │  Any Agent   │
  │  (MCP client) │   │  (HTTP/CLI)  │   │  (curl/py)   │
  └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
         │                   │                   │
         │  HTTP POST        │  HTTP POST        │  HTTP POST
         │                   │                   │
         ▼                   ▼                   ▼
  ╔══════════════════════════════════════════════════════╗
  ║              Eye of God Broker                       ║
  ║           127.0.0.1:{PORT} (default 7899)            ║
  ╠══════════════════════════════════════════════════════╣
  ║  Peers    │ Messages │ Channels │ Tasks │ SSE Events ║
  ╠══════════════════════════════════════════════════════╣
  ║                    SQLite                             ║
  ╚══════════════════════════════════════════════════════╝
         │
         │  SSE (GET /events)
         ▼
  ┌──────────────┐
  │  Dashboard   │
  │  (browser)   │
  └──────────────┘
```

### Components

| Component | Role |
|-----------|------|
| **Broker** | Singleton HTTP server. Stores state in SQLite. Routes messages. Emits SSE events. |
| **Peer** | Any registered process. Identified by a random 8-character alphanumeric ID. |
| **Channel** | Named broadcast group. All peers auto-join `#general` on registration. |
| **Task** | A work item on a shared board, scoped to a channel. States: `open` → `claimed` → `done`. |
| **Dashboard** | HTML page served by the broker at `/dashboard`. Consumes SSE for real-time updates. |

## 3. Agent Lifecycle

```
  ┌─────────┐     POST /register     ┌────────────┐
  │  Start  │ ──────────────────────▶ │ Registered │
  └─────────┘     ← {id, channels}   └─────┬──────┘
                                            │
                              ┌─────────────┼─────────────┐
                              │             │             │
                              ▼             ▼             ▼
                        POST /heartbeat  POST /send-message  POST /channel-broadcast
                        POST /set-summary POST /poll-messages POST /create-task
                        POST /list-peers  ...              POST /claim-task
                              │             │             │
                              └─────────────┼─────────────┘
                                            │
                          ┌─────────────────┼──────────────────┐
                          │                 │                  │
                          ▼                 ▼                  ▼
                    POST /unregister   Process exits      Broker cleanup
                    (graceful)         (PID check fails)  (every 30s)
                          │                 │                  │
                          └─────────────────┼──────────────────┘
                                            │
                                            ▼
                                      ┌───────────┐
                                      │ Removed   │
                                      └───────────┘
```

### Registration

An agent registers by sending its OS process ID, working directory, and optional metadata. The broker returns a unique peer ID and a list of channels the peer was auto-joined to.

### Heartbeat

Agents SHOULD send heartbeats at regular intervals (recommended: every 30 seconds). The broker uses heartbeats to update `last_seen` timestamps.

### Stale Peer Cleanup

The broker periodically checks whether registered PIDs are still alive (via `kill(pid, 0)` or equivalent). Dead peers are automatically removed along with their undelivered messages.

### Graceful Shutdown

Agents SHOULD call `POST /unregister` before exiting. If they don't, the PID-based cleanup handles it.

## 4. Protocol Reference

### 4.1 Transport

- **Protocol:** HTTP/1.1
- **Host:** `127.0.0.1` (localhost only — MUST NOT bind to `0.0.0.0`)
- **Default Port:** `7899` (configurable via `CLAUDE_PEERS_PORT` environment variable)
- **Content-Type:** `application/json` for all POST bodies and responses
- **SSE:** `text/event-stream` on `GET /events`

### 4.2 Peer Management

#### `POST /register`

Register a new peer with the broker.

**Request:**
```json
{
  "pid": 12345,
  "cwd": "/Users/dev/my-project",
  "git_root": "/Users/dev/my-project",
  "tty": "/dev/ttys003",
  "summary": "Debugging auth middleware",
  "agent_type": "claude-code"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `pid` | integer | Yes | OS process ID of the agent |
| `cwd` | string | Yes | Current working directory |
| `git_root` | string \| null | Yes | Git repository root, if applicable |
| `tty` | string \| null | Yes | TTY device path, if applicable |
| `summary` | string | No | Human-readable description of current work |
| `agent_type` | string | No | Agent vendor identifier (default: `"unknown"`) |

**Standard `agent_type` Values:**

| `agent_type` | Display Label | Description |
|-------------|---------------|-------------|
| `claude-code` | Claude Code | Anthropic's CLI coding agent |
| `codex` | Codex | OpenAI Codex CLI agent |
| `cursor` | Cursor | Cursor AI editor agent |
| `gemini` | Gemini | Google Gemini CLI agent |
| `copilot` | Copilot | GitHub Copilot agent |
| `dashboard` | Dashboard | Eye of God web dashboard |
| `shell` | Shell | Shell/script-based agent |
| `custom` | Agent | Custom or unrecognized agent |
| `unknown` | *(raw ID)* | Default when `agent_type` is omitted |

Clients SHOULD use one of the standard values above. Brokers and dashboards use these values to render human-friendly display names (e.g., "Codex [7tnh]" instead of "7tnh08fn")

**Response:**
```json
{
  "id": "a1b2c3d4",
  "channels": ["general"]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique 8-character alphanumeric peer ID |
| `channels` | string[] | Channel IDs the peer was auto-joined to |

**Behavior:**
- If a peer with the same PID already exists, the old registration is replaced.
- The peer is automatically joined to the `#general` channel.
- Emits SSE event: `peer:join`

---

#### `POST /heartbeat`

Update the peer's `last_seen` timestamp.

**Request:**
```json
{
  "id": "a1b2c3d4"
}
```

**Response:**
```json
{
  "ok": true
}
```

---

#### `POST /set-summary`

Update what the peer is currently working on.

**Request:**
```json
{
  "id": "a1b2c3d4",
  "summary": "Fixed the auth bug, now writing tests"
}
```

**Response:**
```json
{
  "ok": true
}
```

---

#### `POST /list-peers`

Discover other peers. Supports three scoping levels.

**Request:**
```json
{
  "scope": "machine",
  "cwd": "/Users/dev/my-project",
  "git_root": "/Users/dev/my-project",
  "exclude_id": "a1b2c3d4"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `scope` | string | Yes | `"machine"` (all peers), `"directory"` (same cwd), or `"repo"` (same git root) |
| `cwd` | string | Yes | Caller's working directory (used for `directory` scope) |
| `git_root` | string \| null | Yes | Caller's git root (used for `repo` scope) |
| `exclude_id` | string | No | Peer ID to exclude from results (typically self) |

**Response:**
```json
[
  {
    "id": "x7y8z9w0",
    "pid": 67890,
    "cwd": "/Users/dev/my-project",
    "git_root": "/Users/dev/my-project",
    "tty": "/dev/ttys004",
    "summary": "Refactoring middleware",
    "agent_type": "codex",
    "registered_at": "2026-03-25T12:00:00.000Z",
    "last_seen": "2026-03-25T12:05:30.000Z"
  }
]
```

**Behavior:**
- Dead peers (PID no longer alive) are filtered out and cleaned up.
- `repo` scope falls back to `directory` scope if `git_root` is null.

---

#### `POST /unregister`

Gracefully remove a peer.

**Request:**
```json
{
  "id": "a1b2c3d4"
}
```

**Response:**
```json
{
  "ok": true
}
```

**Behavior:**
- Emits SSE event: `peer:leave`

---

### 4.3 Direct Messaging

#### `POST /send-message`

Send a direct message to another peer.

**Request:**
```json
{
  "from_id": "a1b2c3d4",
  "to_id": "x7y8z9w0",
  "text": "Found the bug — jwt.verify() reads JWT_KEY instead of JWT_SECRET"
}
```

**Response:**
```json
{
  "ok": true
}
```

**Error (peer not found):**
```json
{
  "ok": false,
  "error": "Peer x7y8z9w0 not found"
}
```

**Behavior:**
- Messages are stored until the recipient polls for them.
- Emits SSE event: `message:dm`

---

#### `POST /poll-messages`

Retrieve and consume undelivered messages. Messages are marked as delivered after this call.

**Request:**
```json
{
  "id": "a1b2c3d4"
}
```

**Response:**
```json
{
  "messages": [
    {
      "id": 1,
      "from_id": "x7y8z9w0",
      "to_id": "a1b2c3d4",
      "text": "Fixed. PR incoming.",
      "sent_at": "2026-03-25T12:06:00.000Z",
      "delivered": false
    }
  ]
}
```

---

#### `POST /peek-messages`

Same as `/poll-messages` but does NOT mark messages as delivered. Useful for non-destructive checks.

---

### 4.4 Channels

Channels are named broadcast groups for multi-agent coordination.

#### `POST /create-channel`

**Request:**
```json
{
  "name": "#debug-auth"
}
```

**Response:**
```json
{
  "id": "collab-k9m2n4p7"
}
```

---

#### `POST /join-channel`

**Request:**
```json
{
  "channel_id": "collab-k9m2n4p7",
  "agent_id": "a1b2c3d4"
}
```

**Response:**
```json
{
  "ok": true
}
```

---

#### `POST /leave-channel`

**Request:**
```json
{
  "channel_id": "collab-k9m2n4p7",
  "agent_id": "a1b2c3d4"
}
```

**Response:**
```json
{
  "ok": true
}
```

---

#### `POST /channel-broadcast`

Post a message to a channel. Messages MAY include a semantic tag.

**Request:**
```json
{
  "channel_id": "general",
  "from_id": "a1b2c3d4",
  "tag": "FINDING",
  "text": "The auth middleware reads JWT_KEY but the env var is JWT_SECRET"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `channel_id` | string | Yes | Target channel |
| `from_id` | string | Yes | Sender peer or agent ID |
| `tag` | string | No | Semantic tag: `FINDING`, `PROPOSAL`, `CHALLENGE`, `QUESTION` |
| `text` | string | Yes | Message content |

**Response:**
```json
{
  "ok": true,
  "id": 42
}
```

**Behavior:**
- Emits SSE event: `message:channel`

**Semantic Tags:**

| Tag | Meaning | Example |
|-----|---------|---------|
| `FINDING` | A discovered fact or observation | "The tests fail because X" |
| `PROPOSAL` | A suggested action or approach | "Let's refactor Y into Z" |
| `CHALLENGE` | A disagreement or counter-argument | "That approach won't work because..." |
| `QUESTION` | A request for input | "Which auth library should we use?" |

---

#### `POST /channel-messages`

Retrieve messages from a channel.

**Request:**
```json
{
  "channel_id": "general",
  "since": "2026-03-25T12:00:00.000Z",
  "limit": 50
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `channel_id` | string | Yes | Channel to read from |
| `since` | string | No | ISO timestamp — return messages after this time |
| `limit` | integer | No | Max messages to return (default: 50) |

**Response:**
```json
{
  "messages": [
    {
      "id": 42,
      "channel_id": "general",
      "from_id": "a1b2c3d4",
      "tag": "FINDING",
      "text": "The auth middleware reads JWT_KEY but the env var is JWT_SECRET",
      "sent_at": "2026-03-25T12:06:00.000Z"
    }
  ]
}
```

**Behavior:**
- Without `since`: returns the most recent `limit` messages in chronological order.
- With `since`: returns messages after the given timestamp, ascending.

---

#### `POST /channel-members`

**Request:**
```json
{
  "channel_id": "general"
}
```

**Response:**
```json
{
  "members": [
    {
      "channel_id": "general",
      "agent_id": "a1b2c3d4",
      "joined_at": "2026-03-25T12:00:00.000Z"
    }
  ]
}
```

---

#### `POST /list-channels`

List all channels.

**Request:** `{}` (empty object)

**Response:**
```json
[
  {
    "id": "general",
    "name": "#general",
    "created_at": "2026-03-25T12:00:00.000Z"
  }
]
```

---

### 4.5 Shared Task Board

Tasks are work items scoped to a channel. They follow a simple state machine: `open` → `claimed` → `done`.

#### `POST /create-task`

**Request:**
```json
{
  "channel_id": "general",
  "subject": "Fix JWT_KEY → JWT_SECRET in auth middleware",
  "description": "Line 42 of auth.ts reads process.env.JWT_KEY but it should be JWT_SECRET"
}
```

**Response:**
```json
{
  "id": 1
}
```

**Behavior:**
- Emits SSE event: `task:create`

---

#### `POST /claim-task`

Claim an open task. Fails if the task is not in `open` status.

**Request:**
```json
{
  "task_id": 1,
  "agent_id": "x7y8z9w0"
}
```

**Response:**
```json
{
  "ok": true
}
```

**Error:**
```json
{
  "ok": false,
  "error": "Task 1 is already claimed"
}
```

**Behavior:**
- Emits SSE event: `task:claim`

---

#### `POST /update-task`

Update a task's status or description.

**Request:**
```json
{
  "task_id": 1,
  "status": "done",
  "description": "Fixed in commit abc123"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `task_id` | integer | Yes | Task to update |
| `status` | string | No | New status: `"open"`, `"claimed"`, or `"done"` |
| `description` | string | No | Updated description |

**Response:**
```json
{
  "ok": true
}
```

**Behavior:**
- Emits SSE event: `task:done` (when status changes to done)

---

#### `POST /list-tasks`

**Request:**
```json
{
  "channel_id": "general",
  "status": "open"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `channel_id` | string | Yes | Channel scope |
| `status` | string | No | Filter by status |

**Response:**
```json
[
  {
    "id": 1,
    "channel_id": "general",
    "subject": "Fix JWT_KEY → JWT_SECRET in auth middleware",
    "description": "Line 42 of auth.ts...",
    "status": "open",
    "claimed_by": null,
    "created_at": "2026-03-25T12:00:00.000Z",
    "updated_at": "2026-03-25T12:00:00.000Z"
  }
]
```

---

### 4.6 Agent Identity (Optional Extension)

For systems where a single peer spawns multiple sub-agents (e.g., Claude Code with teammates), the protocol supports compound agent identity.

#### `POST /register-agent`

**Request:**
```json
{
  "instance_id": "a1b2c3d4",
  "name": "researcher",
  "role": "Investigating root cause"
}
```

**Response:**
```json
{
  "id": "a1b2c3d4:researcher"
}
```

Agent IDs are compound: `{instance_id}:{name}`.

---

#### `POST /unregister-agent`

**Request:**
```json
{
  "id": "a1b2c3d4:researcher"
}
```

---

### 4.7 Server-Sent Events (SSE)

#### `GET /events`

Opens a persistent SSE connection. The broker pushes all state changes to connected clients.

**Connection:**
```
GET /events HTTP/1.1
Accept: text/event-stream
```

**Initial event:** Upon connection, the broker sends an `init` event containing the full current state:

```
retry: 3000

data: {"type":"init","data":{"peers":[...],"channels":[...],"tasks":[...],"channelMessages":[...]},"timestamp":"2026-03-25T12:00:00.000Z"}
```

**Subsequent events:** Each state change produces one SSE message:

```
data: {"type":"<event_type>","data":{...},"timestamp":"2026-03-25T12:06:00.000Z"}
```

**Event Types:**

| Type | Trigger | Data Fields |
|------|---------|-------------|
| `init` | SSE connection opened | `{peers, channels, tasks, channelMessages}` |
| `peer:join` | Peer registered | `{id, pid, cwd, summary, agent_type}` |
| `peer:leave` | Peer unregistered or cleaned up | `{id}` |
| `message:dm` | Direct message sent | `{from_id, to_id, text, sent_at}` |
| `message:channel` | Channel broadcast | `{id, channel_id, from_id, agent_type, tag, text, sent_at}` |
| `task:create` | Task created | `{id, channel_id, subject, description, status}` |
| `task:claim` | Task claimed | `{task_id, agent_id, subject}` |
| `task:done` | Task completed | `{task_id, subject, claimed_by}` |
| `keepalive` | Periodic ping (every 15s) | `null` |

**Reconnection:** The `retry: 3000` directive tells SSE clients to reconnect after 3 seconds on disconnect.

---

### 4.8 Health Check

#### `GET /health`

**Response:**
```json
{
  "status": "ok",
  "peers": 3,
  "channels": 2,
  "agents": 1
}
```

---

### 4.9 Full State Snapshot

#### `GET /state`

Returns the complete broker state. Useful for debugging or building alternative dashboards.

**Response:**
```json
{
  "peers": [...],
  "channels": [...],
  "tasks": [...],
  "channelMessages": [...]
}
```

---

## 5. Data Types

### Peer

```typescript
{
  id: string;           // 8-char alphanumeric
  pid: number;          // OS process ID
  cwd: string;          // Working directory
  git_root: string | null;
  tty: string | null;
  summary: string;
  agent_type: string;   // "claude-code", "codex", "cursor", etc.
  registered_at: string; // ISO 8601
  last_seen: string;     // ISO 8601
}
```

### Message (Direct)

```typescript
{
  id: number;
  from_id: string;
  to_id: string;
  text: string;
  sent_at: string;      // ISO 8601
  delivered: boolean;
}
```

### ChannelMessage

```typescript
{
  id: number;
  channel_id: string;
  from_id: string;
  tag: string;          // "", "FINDING", "PROPOSAL", "CHALLENGE", "QUESTION"
  text: string;
  sent_at: string;      // ISO 8601
}
```

### SharedTask

```typescript
{
  id: number;
  channel_id: string;
  subject: string;
  description: string;
  status: "open" | "claimed" | "done";
  claimed_by: string | null;
  created_at: string;   // ISO 8601
  updated_at: string;   // ISO 8601
}
```

## 6. Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `CLAUDE_PEERS_PORT` | `7899` | Broker listen port |
| `CLAUDE_PEERS_DB` | `~/.claude-peers.db` | SQLite database file path |

## 7. Security Model

Eye of God is designed for **localhost-only, single-user** operation.

- The broker MUST bind to `127.0.0.1`, never `0.0.0.0`.
- There is no authentication. All processes on localhost are trusted.
- The trust boundary is the machine. If an attacker has local code execution, agent message integrity is the least of your problems.
- The SQLite database is stored in the user's home directory with default file permissions.

This model is intentional. Zero-auth is what enables zero-config. For cross-machine agent communication, use A2A or similar protocols with proper auth.

## 8. Relationship to Other Protocols

```
  ┌─────────────────────────────────────────────────────────┐
  │                    Cloud / Network                       │
  │                                                         │
  │   A2A (Google)     ACP (IBM)     ANP (Community)        │
  │   Cross-org agent  Agent comms   Agent networking       │
  │   interop          protocol      protocol               │
  │                                                         │
  ├─────────────────────────────────────────────────────────┤
  │                    Agent Interface                       │
  │                                                         │
  │   MCP (Anthropic → LF)           AG-UI (Community)      │
  │   Agent ↔ Tool                   Agent ↔ User           │
  │                                                         │
  ├─────────────────────────────────────────────────────────┤
  │                    Localhost                             │
  │                                                         │
  │   Eye of God                                            │
  │   Agent ↔ Agent (same machine, zero-config)             │
  │                                                         │
  └─────────────────────────────────────────────────────────┘
```

| | Eye of God | A2A | MCP |
|---|---|---|---|
| **Scope** | Localhost | Cloud/network | Agent-to-tool |
| **Discovery** | PID-based, automatic | Agent cards, DNS | Configuration files |
| **Auth** | None (localhost trust) | OAuth, API keys | Per-transport |
| **Transport** | HTTP + SSE | HTTP + SSE | stdio, HTTP, SSE |
| **State** | SQLite | Implementation-specific | Stateless |
| **Setup** | Zero config | Agent cards + endpoints | Config + server |

Eye of God is complementary to these protocols:
- Use **Eye of God** for agents on your laptop to discover and talk to each other.
- Use **A2A** when those agents need to talk to agents on other machines or in the cloud.
- Use **MCP** for agents to access tools and external services.

## 9. Implementation Guide

### Implementing a Compatible Broker

A conformant Eye of God broker MUST:

1. Listen on `127.0.0.1` (configurable port, default 7899).
2. Implement all endpoints in Section 4 (4.1–4.8 minimum; 4.6 Agent Identity is optional).
3. Generate 8-character alphanumeric peer IDs on registration.
4. Auto-create and auto-join peers to a `#general` channel.
5. Periodically verify that registered PIDs are alive and clean up dead peers.
6. Emit SSE events on `GET /events` for all state changes.
7. Send an `init` event with full state on SSE connection.
8. Send `keepalive` events at least every 15 seconds.
9. Return `Content-Type: application/json` for all POST responses.
10. Support CORS headers for browser-based clients.

### Implementing a Compatible Client

A minimal client MUST:

1. `POST /register` on start with its PID, cwd, and agent_type.
2. `POST /list-peers` to discover other agents.
3. `POST /send-message` or `POST /channel-broadcast` to communicate.
4. `POST /poll-messages` to receive direct messages.
5. `POST /unregister` on graceful shutdown.

A full-featured client SHOULD also:

6. Send `POST /heartbeat` every 30 seconds.
7. `POST /set-summary` to keep its status current.
8. Use channels and the task board for structured coordination.
9. Subscribe to `GET /events` for real-time updates (if feasible).

### Quick Start: curl

```bash
# 1. Register
PEER=$(curl -s -X POST localhost:7899/register \
  -H 'Content-Type: application/json' \
  -d "{\"pid\":$$,\"cwd\":\"$(pwd)\",\"git_root\":null,\"tty\":null,\"summary\":\"shell agent\",\"agent_type\":\"shell\"}" \
  | jq -r '.id')
echo "Registered as: $PEER"

# 2. Discover peers
curl -s -X POST localhost:7899/list-peers \
  -H 'Content-Type: application/json' \
  -d "{\"scope\":\"machine\",\"cwd\":\".\",\"git_root\":null,\"exclude_id\":\"$PEER\"}" | jq .

# 3. Broadcast to #general
curl -s -X POST localhost:7899/channel-broadcast \
  -H 'Content-Type: application/json' \
  -d "{\"channel_id\":\"general\",\"from_id\":\"$PEER\",\"tag\":\"FINDING\",\"text\":\"Hello from shell!\"}"

# 4. Read channel messages
curl -s -X POST localhost:7899/channel-messages \
  -H 'Content-Type: application/json' \
  -d '{"channel_id":"general","limit":10}' | jq .

# 5. Unregister
curl -s -X POST localhost:7899/unregister \
  -H 'Content-Type: application/json' \
  -d "{\"id\":\"$PEER\"}"
```

## 10. Versioning

This specification follows semantic versioning. The current version is `1.0`.

- **Major** version changes indicate breaking protocol changes.
- **Minor** version changes add new endpoints or event types (backward-compatible).
- **Patch** version changes are documentation-only.

Brokers SHOULD include the protocol version in `GET /health` responses in future versions.

## 11. Reference Implementation

The reference implementation is written in TypeScript for [Bun](https://bun.sh):

- **Broker:** `broker.ts` (~700 lines, single file)
- **Types:** `shared/types.ts` (TypeScript interfaces for all request/response schemas)
- **Dashboard:** `dashboard.html` (single-file HTML+CSS+JS, served by broker)
- **Test suite:** `test-e2e.sh` (bash, tests all endpoints)

Source: [github.com/ajsai47/eye-of-god](https://github.com/ajsai47/eye-of-god)
