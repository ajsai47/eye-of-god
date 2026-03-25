#!/usr/bin/env bun
/**
 * claude-peers broker daemon
 *
 * A singleton HTTP server on localhost:7899 backed by SQLite.
 * Tracks all registered Claude Code peers and routes messages between them.
 *
 * Auto-launched by the MCP server if not already running.
 * Run directly: bun broker.ts
 */

import { Database } from "bun:sqlite";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  Peer,
  Message,
  RegisterAgentRequest,
  RegisterAgentResponse,
  UnregisterAgentRequest,
  CreateChannelRequest,
  CreateChannelResponse,
  JoinChannelRequest,
  LeaveChannelRequest,
  ChannelBroadcastRequest,
  ChannelMessagesRequest,
  ChannelMessagesResponse,
  ChannelMembersRequest,
  ChannelMembersResponse,
  CreateSharedTaskRequest,
  CreateSharedTaskResponse,
  ClaimSharedTaskRequest,
  UpdateSharedTaskRequest,
  ListSharedTasksRequest,
  Agent,
  ChannelMessage,
  ChannelMember,
  SharedTask,
  BrokerEvent,
} from "./shared/types.ts";
import { join } from "path";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    agent_type TEXT NOT NULL DEFAULT 'unknown',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

// Migration: add agent_type column if missing (existing DBs)
try {
  db.run("ALTER TABLE peers ADD COLUMN agent_type TEXT NOT NULL DEFAULT 'unknown'");
} catch {
  // Column already exists — expected on fresh DBs
}

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (from_id) REFERENCES peers(id),
    FOREIGN KEY (to_id) REFERENCES peers(id)
  )
`);

// --- Collaboration tables ---

db.run(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT DEFAULT '',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    FOREIGN KEY (instance_id) REFERENCES peers(id)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS channel_members (
    channel_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    joined_at TEXT NOT NULL,
    PRIMARY KEY (channel_id, agent_id),
    FOREIGN KEY (channel_id) REFERENCES channels(id)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS channel_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    from_id TEXT NOT NULL,
    tag TEXT DEFAULT '',
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    FOREIGN KEY (channel_id) REFERENCES channels(id)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS shared_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'open',
    claimed_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (channel_id) REFERENCES channels(id)
  )
`);

// Ensure default #general channel exists
db.run(`INSERT OR IGNORE INTO channels (id, name, created_at) VALUES ('general', '#general', ?)`,
  [new Date().toISOString()]);

// Clean up stale peers (PIDs that no longer exist) on startup
function cleanStalePeers() {
  const peers = db.query("SELECT id, pid FROM peers").all() as { id: string; pid: number }[];
  for (const peer of peers) {
    try {
      // Check if process is still alive (signal 0 doesn't kill, just checks)
      process.kill(peer.pid, 0);
    } catch {
      // Process doesn't exist, remove it
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
    }
  }
}

cleanStalePeers();

// Periodically clean stale peers (every 30s)
setInterval(cleanStalePeers, 30_000);

// --- SSE Event Bus ---

const sseClients = new Set<ReadableStreamDefaultController>();
const encoder = new TextEncoder();

function emitEvent(type: BrokerEvent["type"], data: unknown) {
  const event: BrokerEvent = {
    type,
    data,
    timestamp: new Date().toISOString(),
  };
  const payload = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
  for (const controller of sseClients) {
    try {
      controller.enqueue(payload);
    } catch {
      sseClients.delete(controller);
    }
  }
}

// Keepalive ping every 15s to prevent connection drops
setInterval(() => {
  emitEvent("keepalive", null);
}, 15_000);

function getFullState() {
  const peers = selectAllPeers.all() as Peer[];
  const channels = db.query("SELECT * FROM channels ORDER BY created_at DESC").all();
  const tasks = db.query("SELECT * FROM shared_tasks ORDER BY id ASC").all();
  const channelMessages = db.query("SELECT * FROM channel_messages ORDER BY sent_at DESC LIMIT 100").all();
  return { peers, channels, tasks, channelMessages };
}

// --- CORS helper ---

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function corsJson(data: unknown, status = 200) {
  return Response.json(data, { status, headers: CORS_HEADERS });
}

// Dashboard HTML path (served as static file)
const DASHBOARD_PATH = join(import.meta.dir, "dashboard.html");

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, tty, summary, agent_type, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateLastSeen = db.prepare(`
  UPDATE peers SET last_seen = ? WHERE id = ?
`);

const updateSummary = db.prepare(`
  UPDATE peers SET summary = ? WHERE id = ?
`);

const deletePeer = db.prepare(`
  DELETE FROM peers WHERE id = ?
`);

const selectAllPeers = db.prepare(`
  SELECT * FROM peers
`);

const selectPeersByDirectory = db.prepare(`
  SELECT * FROM peers WHERE cwd = ?
`);

const selectPeersByGitRoot = db.prepare(`
  SELECT * FROM peers WHERE git_root = ?
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered)
  VALUES (?, ?, ?, ?, 0)
`);

const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);

const markDelivered = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ?
`);

// --- Collaboration prepared statements ---

const insertAgent = db.prepare(`
  INSERT INTO agents (id, instance_id, name, role, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const deleteAgent = db.prepare(`
  DELETE FROM agents WHERE id = ?
`);

const insertChannel = db.prepare(`
  INSERT INTO channels (id, name, created_at) VALUES (?, ?, ?)
`);

const insertChannelMember = db.prepare(`
  INSERT OR IGNORE INTO channel_members (channel_id, agent_id, joined_at) VALUES (?, ?, ?)
`);

const deleteChannelMember = db.prepare(`
  DELETE FROM channel_members WHERE channel_id = ? AND agent_id = ?
`);

const insertChannelMessage = db.prepare(`
  INSERT INTO channel_messages (channel_id, from_id, tag, text, sent_at)
  VALUES (?, ?, ?, ?, ?)
`);

const selectChannelMessagesSince = db.prepare(`
  SELECT * FROM channel_messages WHERE channel_id = ? AND sent_at > ? ORDER BY sent_at ASC LIMIT ?
`);

const selectChannelMessagesAll = db.prepare(`
  SELECT * FROM channel_messages WHERE channel_id = ? ORDER BY sent_at DESC LIMIT ?
`);

const selectChannelMembers = db.prepare(`
  SELECT * FROM channel_members WHERE channel_id = ?
`);

const insertSharedTask = db.prepare(`
  INSERT INTO shared_tasks (channel_id, subject, description, status, created_at, updated_at)
  VALUES (?, ?, ?, 'open', ?, ?)
`);

const selectSharedTasks = db.prepare(`
  SELECT * FROM shared_tasks WHERE channel_id = ? ORDER BY id ASC
`);

const selectSharedTasksByStatus = db.prepare(`
  SELECT * FROM shared_tasks WHERE channel_id = ? AND status = ? ORDER BY id ASC
`);

// --- Generate peer ID ---

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// --- Request handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const now = new Date().toISOString();

  // Remove any existing registration for this PID (re-registration)
  const existing = db.query("SELECT id FROM peers WHERE pid = ?").get(body.pid) as { id: string } | null;
  if (existing) {
    deletePeer.run(existing.id);
  }

  insertPeer.run(id, body.pid, body.cwd, body.git_root, body.tty, body.summary ?? "", body.agent_type ?? "unknown", now, now);

  // Auto-join #general channel
  const channels: string[] = [];
  try {
    insertChannelMember.run('general', id, now);
    channels.push('general');
  } catch {
    // Channel might not exist yet in edge cases
  }

  emitEvent("peer:join", { id, pid: body.pid, cwd: body.cwd, summary: body.summary ?? "", agent_type: body.agent_type ?? "unknown" });

  return { id, channels };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  updateLastSeen.run(new Date().toISOString(), body.id);
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.id);
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let peers: Peer[];

  switch (body.scope) {
    case "machine":
      peers = selectAllPeers.all() as Peer[];
      break;
    case "directory":
      peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      break;
    case "repo":
      if (body.git_root) {
        peers = selectPeersByGitRoot.all(body.git_root) as Peer[];
      } else {
        // No git root, fall back to directory
        peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      }
      break;
    default:
      peers = selectAllPeers.all() as Peer[];
  }

  // Exclude the requesting peer
  if (body.exclude_id) {
    peers = peers.filter((p) => p.id !== body.exclude_id);
  }

  // Verify each peer's process is still alive
  return peers.filter((p) => {
    try {
      process.kill(p.pid, 0);
      return true;
    } catch {
      // Clean up dead peer
      deletePeer.run(p.id);
      return false;
    }
  });
}

function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string } {
  // Verify target exists
  const target = db.query("SELECT id FROM peers WHERE id = ?").get(body.to_id) as { id: string } | null;
  if (!target) {
    return { ok: false, error: `Peer ${body.to_id} not found` };
  }

  const sentAt = new Date().toISOString();
  insertMessage.run(body.from_id, body.to_id, body.text, sentAt);
  emitEvent("message:dm", { from_id: body.from_id, to_id: body.to_id, text: body.text, sent_at: sentAt });
  return { ok: true };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = selectUndelivered.all(body.id) as Message[];

  // Mark them as delivered
  for (const msg of messages) {
    markDelivered.run(msg.id);
  }

  return { messages };
}

function handlePeekMessages(body: PollMessagesRequest): PollMessagesResponse {
  // Same as poll but does NOT mark as delivered — used by the channel push loop
  const messages = selectUndelivered.all(body.id) as Message[];
  return { messages };
}

function handleUnregister(body: { id: string }): void {
  deletePeer.run(body.id);
  emitEvent("peer:leave", { id: body.id });
}

// --- Collaboration handlers ---

function handleRegisterAgent(body: RegisterAgentRequest): RegisterAgentResponse {
  const id = `${body.instance_id}:${body.name}`;
  const now = new Date().toISOString();

  // Remove existing registration for this compound ID (re-registration)
  deleteAgent.run(id);
  insertAgent.run(id, body.instance_id, body.name, body.role ?? "", now, now);
  return { id };
}

function handleUnregisterAgent(body: UnregisterAgentRequest): void {
  // Remove from all channels
  db.run("DELETE FROM channel_members WHERE agent_id = ?", [body.id]);
  deleteAgent.run(body.id);
}

function handleCreateChannel(body: CreateChannelRequest): CreateChannelResponse {
  const id = `collab-${generateId()}`;
  const now = new Date().toISOString();
  insertChannel.run(id, body.name, now);
  return { id };
}

function handleJoinChannel(body: JoinChannelRequest): { ok: boolean; error?: string } {
  const channel = db.query("SELECT id FROM channels WHERE id = ?").get(body.channel_id) as { id: string } | null;
  if (!channel) {
    return { ok: false, error: `Channel ${body.channel_id} not found` };
  }
  insertChannelMember.run(body.channel_id, body.agent_id, new Date().toISOString());
  return { ok: true };
}

function handleLeaveChannel(body: LeaveChannelRequest): void {
  deleteChannelMember.run(body.channel_id, body.agent_id);
}

function handleChannelBroadcast(body: ChannelBroadcastRequest): { ok: boolean; id: number } {
  const now = new Date().toISOString();
  const result = insertChannelMessage.run(body.channel_id, body.from_id, body.tag ?? "", body.text, now);
  const msgId = Number(result.lastInsertRowid);
  emitEvent("message:channel", { id: msgId, channel_id: body.channel_id, from_id: body.from_id, tag: body.tag ?? "", text: body.text, sent_at: now });
  return { ok: true, id: msgId };
}

function handleChannelMessages(body: ChannelMessagesRequest): ChannelMessagesResponse {
  const limit = body.limit ?? 50;
  let messages: ChannelMessage[];
  if (body.since) {
    messages = selectChannelMessagesSince.all(body.channel_id, body.since, limit) as ChannelMessage[];
  } else {
    // Without `since`, return most recent (desc), then reverse to chronological order
    messages = (selectChannelMessagesAll.all(body.channel_id, limit) as ChannelMessage[]).reverse();
  }
  return { messages };
}

function handleChannelMembers(body: ChannelMembersRequest): ChannelMembersResponse {
  const members = selectChannelMembers.all(body.channel_id) as ChannelMember[];
  return { members };
}

function handleCreateSharedTask(body: CreateSharedTaskRequest): CreateSharedTaskResponse {
  const now = new Date().toISOString();
  const result = insertSharedTask.run(body.channel_id, body.subject, body.description ?? "", now, now);
  const taskId = Number(result.lastInsertRowid);
  emitEvent("task:create", { id: taskId, channel_id: body.channel_id, subject: body.subject, description: body.description ?? "", status: "open" });
  return { id: taskId };
}

function handleClaimSharedTask(body: ClaimSharedTaskRequest): { ok: boolean; error?: string } {
  const task = db.query("SELECT * FROM shared_tasks WHERE id = ?").get(body.task_id) as SharedTask | null;
  if (!task) {
    return { ok: false, error: `Task ${body.task_id} not found` };
  }
  if (task.status !== "open") {
    return { ok: false, error: `Task ${body.task_id} is already ${task.status}` };
  }
  const claimedAt = new Date().toISOString();
  db.run("UPDATE shared_tasks SET status = 'claimed', claimed_by = ?, updated_at = ? WHERE id = ?", [
    body.agent_id,
    claimedAt,
    body.task_id,
  ]);
  emitEvent("task:claim", { task_id: body.task_id, agent_id: body.agent_id, subject: task.subject });
  return { ok: true };
}

function handleUpdateSharedTask(body: UpdateSharedTaskRequest): { ok: boolean; error?: string } {
  const task = db.query("SELECT * FROM shared_tasks WHERE id = ?").get(body.task_id) as SharedTask | null;
  if (!task) {
    return { ok: false, error: `Task ${body.task_id} not found` };
  }
  const now = new Date().toISOString();
  if (body.status) {
    db.run("UPDATE shared_tasks SET status = ?, updated_at = ? WHERE id = ?", [body.status, now, body.task_id]);
    if (body.status === "done") {
      emitEvent("task:done", { task_id: body.task_id, subject: task.subject, claimed_by: task.claimed_by });
    }
  }
  if (body.description !== undefined) {
    db.run("UPDATE shared_tasks SET description = ?, updated_at = ? WHERE id = ?", [body.description, now, body.task_id]);
  }
  return { ok: true };
}

function handleListSharedTasks(body: ListSharedTasksRequest): SharedTask[] {
  if (body.status) {
    return selectSharedTasksByStatus.all(body.channel_id, body.status) as SharedTask[];
  }
  return selectSharedTasks.all(body.channel_id) as SharedTask[];
}

// --- HTTP Server ---

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (req.method === "GET") {
      switch (path) {
        case "/health": {
          const peerCount = (selectAllPeers.all() as Peer[]).length;
          const channelCount = (db.query("SELECT COUNT(*) as n FROM channels").get() as { n: number }).n;
          const agentCount = (db.query("SELECT COUNT(*) as n FROM agents").get() as { n: number }).n;
          return corsJson({ status: "ok", peers: peerCount, channels: channelCount, agents: agentCount });
        }

        case "/dashboard": {
          const file = Bun.file(DASHBOARD_PATH);
          return new Response(file, {
            headers: { "Content-Type": "text/html; charset=utf-8", ...CORS_HEADERS },
          });
        }

        case "/events": {
          let sseController: ReadableStreamDefaultController;
          const stream = new ReadableStream({
            start(controller) {
              sseController = controller;
              sseClients.add(controller);

              // Send init event with full state
              const initEvent: BrokerEvent = {
                type: "init",
                data: getFullState(),
                timestamp: new Date().toISOString(),
              };
              controller.enqueue(encoder.encode(`retry: 3000\n\n`));
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(initEvent)}\n\n`));
            },
            cancel() {
              sseClients.delete(sseController);
            },
          });

          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
              ...CORS_HEADERS,
            },
          });
        }

        case "/state":
          return corsJson(getFullState());

        default:
          return new Response("claude-peers broker", { status: 200, headers: CORS_HEADERS });
      }
    }

    if (req.method !== "POST") {
      return new Response("claude-peers broker", { status: 200, headers: CORS_HEADERS });
    }

    try {
      const body = await req.json();

      switch (path) {
        case "/register":
          return corsJson(handleRegister(body as RegisterRequest));
        case "/heartbeat":
          handleHeartbeat(body as HeartbeatRequest);
          return corsJson({ ok: true });
        case "/set-summary":
          handleSetSummary(body as SetSummaryRequest);
          return corsJson({ ok: true });
        case "/list-peers":
          return corsJson(handleListPeers(body as ListPeersRequest));
        case "/send-message":
          return corsJson(handleSendMessage(body as SendMessageRequest));
        case "/poll-messages":
          return corsJson(handlePollMessages(body as PollMessagesRequest));
        case "/peek-messages":
          return corsJson(handlePeekMessages(body as PollMessagesRequest));
        case "/unregister":
          handleUnregister(body as { id: string });
          return corsJson({ ok: true });

        // --- Collaboration endpoints ---
        case "/register-agent":
          return corsJson(handleRegisterAgent(body as RegisterAgentRequest));
        case "/unregister-agent":
          handleUnregisterAgent(body as UnregisterAgentRequest);
          return corsJson({ ok: true });
        case "/create-channel":
          return corsJson(handleCreateChannel(body as CreateChannelRequest));
        case "/join-channel":
          return corsJson(handleJoinChannel(body as JoinChannelRequest));
        case "/leave-channel":
          handleLeaveChannel(body as LeaveChannelRequest);
          return corsJson({ ok: true });
        case "/channel-broadcast":
          return corsJson(handleChannelBroadcast(body as ChannelBroadcastRequest));
        case "/channel-messages":
          return corsJson(handleChannelMessages(body as ChannelMessagesRequest));
        case "/channel-members":
          return corsJson(handleChannelMembers(body as ChannelMembersRequest));
        case "/create-task":
          return corsJson(handleCreateSharedTask(body as CreateSharedTaskRequest));
        case "/claim-task":
          return corsJson(handleClaimSharedTask(body as ClaimSharedTaskRequest));
        case "/update-task":
          return corsJson(handleUpdateSharedTask(body as UpdateSharedTaskRequest));
        case "/list-tasks":
          return corsJson(handleListSharedTasks(body as ListSharedTasksRequest));
        case "/list-channels":
          return corsJson(db.query("SELECT * FROM channels ORDER BY created_at DESC").all());

        default:
          return corsJson({ error: "not found" }, 404);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return corsJson({ error: msg }, 500);
    }
  },
});

console.error(`[claude-peers broker] listening on 127.0.0.1:${PORT} (db: ${DB_PATH})`);
console.error(`[claude-peers broker] dashboard: http://127.0.0.1:${PORT}/dashboard`);
