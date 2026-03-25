#!/usr/bin/env bun
/**
 * codex-bridge.ts — Lightweight CLI bridge for Codex (and any non-MCP agent)
 *
 * NOT an MCP server. Just a simple CLI that Codex calls via exec/bash tool.
 * Registers with the broker as agent_type: "codex" and exposes subcommands.
 *
 * Usage:
 *   bun codex-bridge.ts register [summary]   — Register with broker, prints peer ID
 *   bun codex-bridge.ts peers                — List all peers (JSON)
 *   bun codex-bridge.ts send <id> <msg>      — Send a DM to a peer
 *   bun codex-bridge.ts check                — Check for new messages (marks delivered)
 *   bun codex-bridge.ts peek                 — Peek at messages (non-destructive)
 *   bun codex-bridge.ts channels             — List all channels
 *   bun codex-bridge.ts broadcast <ch> <tag> <msg> — Broadcast to a channel
 *   bun codex-bridge.ts messages <ch>        — Read channel messages
 *   bun codex-bridge.ts tasks <ch>           — List shared tasks
 *   bun codex-bridge.ts create-task <ch> <subject> [desc] — Create a task
 *   bun codex-bridge.ts claim <task-id>      — Claim a task
 *   bun codex-bridge.ts done <task-id> [notes] — Mark task done
 *   bun codex-bridge.ts unregister           — Unregister from broker
 *
 * Environment:
 *   CLAUDE_PEERS_PORT   — Broker port (default: 7899)
 *   CODEX_PEER_ID       — Reuse an existing peer ID instead of registering
 *   CODEX_AGENT_TYPE    — Agent type string (default: "codex")
 */

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const AGENT_TYPE = process.env.CODEX_AGENT_TYPE ?? "codex";

// Persistent peer ID file — so multiple invocations share the same identity
const STATE_FILE = `${process.env.HOME}/.codex-bridge-state.json`;

interface BridgeState {
  peer_id: string;
  pid: number;
  registered_at: string;
}

async function loadState(): Promise<BridgeState | null> {
  try {
    const file = Bun.file(STATE_FILE);
    if (await file.exists()) {
      return await file.json() as BridgeState;
    }
  } catch {
    // File doesn't exist or is corrupt
  }
  return null;
}

async function saveState(state: BridgeState): Promise<void> {
  await Bun.write(STATE_FILE, JSON.stringify(state, null, 2));
}

async function clearState(): Promise<void> {
  try {
    const { unlinkSync } = await import("node:fs");
    unlinkSync(STATE_FILE);
  } catch {
    // Already gone
  }
}

async function brokerPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker ${path}: ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

async function brokerGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`Broker ${path}: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function getPeerId(): Promise<string> {
  // Check env override first
  if (process.env.CODEX_PEER_ID) {
    return process.env.CODEX_PEER_ID;
  }
  // Check state file
  const state = await loadState();
  if (state) {
    return state.peer_id;
  }
  throw new Error("Not registered. Run: bun codex-bridge.ts register");
}

// --- Commands ---

const cmd = process.argv[2];

switch (cmd) {
  case "register": {
    const summary = process.argv.slice(3).join(" ") || "";

    // Check if already registered
    const existing = await loadState();
    if (existing) {
      // Re-register to refresh
      try {
        await brokerPost("/unregister", { id: existing.peer_id });
      } catch {
        // Old registration may be stale
      }
    }

    const result = await brokerPost<{ id: string; channels?: string[] }>("/register", {
      pid: process.pid,
      cwd: process.cwd(),
      git_root: null,
      tty: null,
      summary,
      agent_type: AGENT_TYPE,
    });

    await saveState({
      peer_id: result.id,
      pid: process.pid,
      registered_at: new Date().toISOString(),
    });

    console.log(JSON.stringify({
      ok: true,
      peer_id: result.id,
      agent_type: AGENT_TYPE,
      channels: result.channels ?? [],
    }));
    break;
  }

  case "peers": {
    const peers = await brokerPost<Array<{
      id: string;
      pid: number;
      cwd: string;
      agent_type: string;
      summary: string;
      last_seen: string;
    }>>("/list-peers", {
      scope: "machine",
      cwd: process.cwd(),
      git_root: null,
    });
    console.log(JSON.stringify(peers, null, 2));
    break;
  }

  case "send": {
    const toId = process.argv[3];
    const msg = process.argv.slice(4).join(" ");
    if (!toId || !msg) {
      console.error(JSON.stringify({ error: "Usage: send <peer-id> <message>" }));
      process.exit(1);
    }
    const myId = await getPeerId();
    const result = await brokerPost<{ ok: boolean; error?: string }>("/send-message", {
      from_id: myId,
      to_id: toId,
      text: msg,
    });
    console.log(JSON.stringify(result));
    break;
  }

  case "check": {
    const myId = await getPeerId();
    const result = await brokerPost<{ messages: Array<{ id: number; from_id: string; text: string; sent_at: string }> }>(
      "/poll-messages",
      { id: myId }
    );
    console.log(JSON.stringify(result, null, 2));
    break;
  }

  case "peek": {
    const myId = await getPeerId();
    const result = await brokerPost<{ messages: Array<{ id: number; from_id: string; text: string; sent_at: string }> }>(
      "/peek-messages",
      { id: myId }
    );
    console.log(JSON.stringify(result, null, 2));
    break;
  }

  case "channels": {
    const channels = await brokerPost<Array<{ id: string; name: string; created_at: string }>>(
      "/list-channels",
      {}
    );
    console.log(JSON.stringify(channels, null, 2));
    break;
  }

  case "broadcast": {
    const chId = process.argv[3];
    const tag = process.argv[4];
    const text = process.argv.slice(5).join(" ");
    if (!chId || !tag || !text) {
      console.error(JSON.stringify({ error: "Usage: broadcast <channel-id> <tag> <message>" }));
      process.exit(1);
    }
    const myId = await getPeerId();
    const result = await brokerPost<{ ok: boolean; id: number }>("/channel-broadcast", {
      channel_id: chId,
      from_id: myId,
      tag,
      text,
    });
    console.log(JSON.stringify(result));
    break;
  }

  case "messages": {
    const mChId = process.argv[3];
    const limit = parseInt(process.argv[4] ?? "20");
    if (!mChId) {
      console.error(JSON.stringify({ error: "Usage: messages <channel-id> [limit]" }));
      process.exit(1);
    }
    const result = await brokerPost<{ messages: unknown[] }>("/channel-messages", {
      channel_id: mChId,
      limit,
    });
    console.log(JSON.stringify(result, null, 2));
    break;
  }

  case "tasks": {
    const tChId = process.argv[3];
    const status = process.argv[4];
    if (!tChId) {
      console.error(JSON.stringify({ error: "Usage: tasks <channel-id> [status]" }));
      process.exit(1);
    }
    const body: { channel_id: string; status?: string } = { channel_id: tChId };
    if (status) body.status = status;
    const tasks = await brokerPost<unknown[]>("/list-tasks", body);
    console.log(JSON.stringify(tasks, null, 2));
    break;
  }

  case "create-task": {
    const ctChId = process.argv[3];
    const ctSubject = process.argv[4];
    const ctDesc = process.argv.slice(5).join(" ");
    if (!ctChId || !ctSubject) {
      console.error(JSON.stringify({ error: "Usage: create-task <channel-id> <subject> [description]" }));
      process.exit(1);
    }
    const result = await brokerPost<{ id: number }>("/create-task", {
      channel_id: ctChId,
      subject: ctSubject,
      description: ctDesc || "",
    });
    console.log(JSON.stringify(result));
    break;
  }

  case "claim": {
    const taskId = parseInt(process.argv[3]);
    if (!taskId) {
      console.error(JSON.stringify({ error: "Usage: claim <task-id>" }));
      process.exit(1);
    }
    const myId = await getPeerId();
    const result = await brokerPost<{ ok: boolean; error?: string }>("/claim-task", {
      task_id: taskId,
      agent_id: myId,
    });
    console.log(JSON.stringify(result));
    break;
  }

  case "done": {
    const doneId = parseInt(process.argv[3]);
    const notes = process.argv.slice(4).join(" ");
    if (!doneId) {
      console.error(JSON.stringify({ error: "Usage: done <task-id> [notes]" }));
      process.exit(1);
    }
    const body: { task_id: number; status: string; description?: string } = {
      task_id: doneId,
      status: "done",
    };
    if (notes) body.description = notes;
    const result = await brokerPost<{ ok: boolean; error?: string }>("/update-task", body);
    console.log(JSON.stringify(result));
    break;
  }

  case "summary": {
    const summaryText = process.argv.slice(3).join(" ");
    if (!summaryText) {
      console.error(JSON.stringify({ error: "Usage: summary <text>" }));
      process.exit(1);
    }
    const myId = await getPeerId();
    await brokerPost("/set-summary", { id: myId, summary: summaryText });
    console.log(JSON.stringify({ ok: true, summary: summaryText }));
    break;
  }

  case "join": {
    const joinChId = process.argv[3];
    if (!joinChId) {
      console.error(JSON.stringify({ error: "Usage: join <channel-id>" }));
      process.exit(1);
    }
    const myId = await getPeerId();
    const result = await brokerPost<{ ok: boolean; error?: string }>("/join-channel", {
      channel_id: joinChId,
      agent_id: myId,
    });
    console.log(JSON.stringify(result));
    break;
  }

  case "unregister": {
    const state = await loadState();
    if (state) {
      await brokerPost("/unregister", { id: state.peer_id });
      await clearState();
      console.log(JSON.stringify({ ok: true, peer_id: state.peer_id }));
    } else if (process.env.CODEX_PEER_ID) {
      await brokerPost("/unregister", { id: process.env.CODEX_PEER_ID });
      console.log(JSON.stringify({ ok: true, peer_id: process.env.CODEX_PEER_ID }));
    } else {
      console.log(JSON.stringify({ ok: false, error: "Not registered" }));
    }
    break;
  }

  case "health": {
    const health = await brokerGet<{ status: string; peers: number; channels: number; agents: number }>("/health");
    console.log(JSON.stringify(health));
    break;
  }

  default:
    console.log(`codex-bridge — Eye of God CLI for Codex and non-MCP agents

Commands:
  register [summary]              Register with broker (saves state for reuse)
  peers                           List all peers (JSON)
  send <id> <msg>                 Send DM to a peer
  check                           Poll messages (marks delivered)
  peek                            Peek messages (non-destructive)
  summary <text>                  Set your status summary
  channels                        List channels
  join <channel-id>               Join a channel
  broadcast <ch> <tag> <msg>      Broadcast to channel
  messages <ch> [limit]           Read channel messages
  tasks <ch> [status]             List shared tasks
  create-task <ch> <subject> [d]  Create a task
  claim <task-id>                 Claim a task
  done <task-id> [notes]          Mark task done
  unregister                      Unregister from broker
  health                          Check broker health

Environment:
  CLAUDE_PEERS_PORT=7899          Broker port
  CODEX_PEER_ID=<id>              Skip registration, reuse ID
  CODEX_AGENT_TYPE=codex          Agent type (default: codex)`);
}
