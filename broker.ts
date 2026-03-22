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
} from "./shared/types.ts";

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
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

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

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, tty, summary, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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

  insertPeer.run(id, body.pid, body.cwd, body.git_root, body.tty, body.summary, now, now);
  return { id };
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

  insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString());
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
  return { ok: true, id: Number(result.lastInsertRowid) };
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
  return { id: Number(result.lastInsertRowid) };
}

function handleClaimSharedTask(body: ClaimSharedTaskRequest): { ok: boolean; error?: string } {
  const task = db.query("SELECT * FROM shared_tasks WHERE id = ?").get(body.task_id) as SharedTask | null;
  if (!task) {
    return { ok: false, error: `Task ${body.task_id} not found` };
  }
  if (task.status !== "open") {
    return { ok: false, error: `Task ${body.task_id} is already ${task.status}` };
  }
  db.run("UPDATE shared_tasks SET status = 'claimed', claimed_by = ?, updated_at = ? WHERE id = ?", [
    body.agent_id,
    new Date().toISOString(),
    body.task_id,
  ]);
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

    if (req.method !== "POST") {
      if (path === "/health") {
        const peerCount = (selectAllPeers.all() as Peer[]).length;
        const channelCount = (db.query("SELECT COUNT(*) as n FROM channels").get() as { n: number }).n;
        const agentCount = (db.query("SELECT COUNT(*) as n FROM agents").get() as { n: number }).n;
        return Response.json({ status: "ok", peers: peerCount, channels: channelCount, agents: agentCount });
      }
      return new Response("claude-peers broker", { status: 200 });
    }

    try {
      const body = await req.json();

      switch (path) {
        case "/register":
          return Response.json(handleRegister(body as RegisterRequest));
        case "/heartbeat":
          handleHeartbeat(body as HeartbeatRequest);
          return Response.json({ ok: true });
        case "/set-summary":
          handleSetSummary(body as SetSummaryRequest);
          return Response.json({ ok: true });
        case "/list-peers":
          return Response.json(handleListPeers(body as ListPeersRequest));
        case "/send-message":
          return Response.json(handleSendMessage(body as SendMessageRequest));
        case "/poll-messages":
          return Response.json(handlePollMessages(body as PollMessagesRequest));
        case "/peek-messages":
          return Response.json(handlePeekMessages(body as PollMessagesRequest));
        case "/unregister":
          handleUnregister(body as { id: string });
          return Response.json({ ok: true });

        // --- Collaboration endpoints ---
        case "/register-agent":
          return Response.json(handleRegisterAgent(body as RegisterAgentRequest));
        case "/unregister-agent":
          handleUnregisterAgent(body as UnregisterAgentRequest);
          return Response.json({ ok: true });
        case "/create-channel":
          return Response.json(handleCreateChannel(body as CreateChannelRequest));
        case "/join-channel":
          return Response.json(handleJoinChannel(body as JoinChannelRequest));
        case "/leave-channel":
          handleLeaveChannel(body as LeaveChannelRequest);
          return Response.json({ ok: true });
        case "/channel-broadcast":
          return Response.json(handleChannelBroadcast(body as ChannelBroadcastRequest));
        case "/channel-messages":
          return Response.json(handleChannelMessages(body as ChannelMessagesRequest));
        case "/channel-members":
          return Response.json(handleChannelMembers(body as ChannelMembersRequest));
        case "/create-task":
          return Response.json(handleCreateSharedTask(body as CreateSharedTaskRequest));
        case "/claim-task":
          return Response.json(handleClaimSharedTask(body as ClaimSharedTaskRequest));
        case "/update-task":
          return Response.json(handleUpdateSharedTask(body as UpdateSharedTaskRequest));
        case "/list-tasks":
          return Response.json(handleListSharedTasks(body as ListSharedTasksRequest));
        case "/list-channels":
          return Response.json(db.query("SELECT * FROM channels ORDER BY created_at DESC").all());

        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 500 });
    }
  },
});

console.error(`[claude-peers broker] listening on 127.0.0.1:${PORT} (db: ${DB_PATH})`);
