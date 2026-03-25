#!/usr/bin/env bun
/**
 * claude-peers MCP server
 *
 * Spawned by Claude Code as a stdio MCP server (one per instance).
 * Connects to the shared broker daemon for peer discovery and messaging.
 * Declares claude/channel capability to push inbound messages immediately.
 *
 * Usage:
 *   claude --dangerously-load-development-channels server:claude-peers
 *
 * With .mcp.json:
 *   { "claude-peers": { "command": "bun", "args": ["./server.ts"] } }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  PeerId,
  Peer,
  RegisterResponse,
  PollMessagesResponse,
  Message,
  CreateChannelResponse,
  ChannelMessagesResponse,
  ChannelMembersResponse,
  CreateSharedTaskResponse,
  SharedTask,
  Channel,
} from "./shared/types.ts";
import {
  generateSummary,
  getGitBranch,
  getRecentFiles,
} from "./shared/summarize.ts";

// --- Configuration ---

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;
const AGENT_TYPE = process.env.AGENT_TYPE ?? "claude-code";

// --- Broker communication ---

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) {
    log("Broker already running");
    return;
  }

  log("Starting broker daemon...");
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    stdio: ["ignore", "ignore", "inherit"],
    // Detach so the broker survives if this MCP server exits
    // On macOS/Linux, the broker will keep running
  });

  // Unref so this process can exit without waiting for the broker
  proc.unref();

  // Wait for it to come up
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isBrokerAlive()) {
      log("Broker started");
      return;
    }
  }
  throw new Error("Failed to start broker daemon after 6 seconds");
}

// --- Utility ---

function log(msg: string) {
  // MCP stdio servers must only use stderr for logging (stdout is the MCP protocol)
  console.error(`[claude-peers] ${msg}`);
}

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) {
      return text.trim();
    }
  } catch {
    // not a git repo
  }
  return null;
}

function getTty(): string | null {
  try {
    // Try to get the parent's tty from the process tree
    const ppid = process.ppid;
    if (ppid) {
      const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(ppid)]);
      const tty = new TextDecoder().decode(proc.stdout).trim();
      if (tty && tty !== "?" && tty !== "??") {
        return tty;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// --- State ---

let myId: PeerId | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;

// Track message IDs already pushed via channel to avoid duplicate notifications.
// Messages are NOT marked as delivered in DB by the poll loop — only by check_messages.
// Pruned to last 1000 entries to prevent unbounded growth.
const channelPushedIds = new Set<number>();
const MAX_PUSHED_IDS = 1000;

function trackPushedId(id: number) {
  channelPushedIds.add(id);
  if (channelPushedIds.size > MAX_PUSHED_IDS) {
    // Delete oldest entries (Set iterates in insertion order)
    const excess = channelPushedIds.size - MAX_PUSHED_IDS;
    let i = 0;
    for (const old of channelPushedIds) {
      if (i++ >= excess) break;
      channelPushedIds.delete(old);
    }
  }
}

// --- MCP Server ---

const mcp = new Server(
  { name: "claude-peers", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to the claude-peers network. Other Claude Code instances on this machine can see you and send you messages.

IMPORTANT: When you receive a <channel source="claude-peers" ...> message, RESPOND IMMEDIATELY. Do not wait until your current task is finished. Pause what you are doing, reply to the message using send_message, then resume your work. Treat incoming peer messages like a coworker tapping you on the shoulder — answer right away, even if you're in the middle of something.

Read the from_id, from_summary, and from_cwd attributes to understand who sent the message. Reply by calling send_message with their from_id.

Available tools:
- list_peers: Discover other Claude Code instances (scope: machine/directory/repo)
- send_message: Send a message to another instance by ID
- set_summary: Set a 1-2 sentence summary of what you're working on (visible to other peers)
- check_messages: Manually check for new messages

Collaboration tools:
- create_channel: Create a named collaboration channel for multi-instance work
- join_channel: Join a channel to receive broadcasts and see shared tasks
- broadcast: Post a tagged message ([FINDING], [PROPOSAL], [CHALLENGE], [QUESTION]) to a channel
- channel_messages: Read recent messages from a channel
- channel_members: List who's in a channel
- create_shared_task: Post a task to the channel's shared board
- claim_shared_task: Claim an open task
- update_shared_task: Update task status (open/claimed/done) or description
- list_shared_tasks: See all tasks on the board

When you start, proactively call set_summary to describe what you're working on. This helps other instances understand your context.`,
  }
);

// --- Tool definitions ---

const TOOLS = [
  {
    name: "list_peers",
    description:
      "List other Claude Code instances running on this machine. Returns their ID, working directory, git repo, and summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo"],
          description:
            'Scope of peer discovery. "machine" = all instances on this computer. "directory" = same working directory. "repo" = same git repository (including worktrees or subdirectories).',
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to another Claude Code instance by peer ID. The message will be pushed into their session immediately via channel notification.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: {
          type: "string" as const,
          description: "The peer ID of the target Claude Code instance (from list_peers)",
        },
        message: {
          type: "string" as const,
          description: "The message to send",
        },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "set_summary",
    description:
      "Set a brief summary (1-2 sentences) of what you are currently working on. This is visible to other Claude Code instances when they list peers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string" as const,
          description: "A 1-2 sentence summary of your current work",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "check_messages",
    description:
      "Manually check for new messages from other Claude Code instances. Messages are normally pushed automatically via channel notifications, but you can use this as a fallback.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "debug_info",
    description:
      "Show diagnostic information about this MCP server's identity, including myId, process PID, and broker state. Useful for debugging peer communication issues.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  // --- Collaboration tools ---
  {
    name: "create_channel",
    description:
      "Create a collaboration channel for multi-instance work. Returns a channel ID that other instances can join.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string" as const,
          description: 'Human-readable channel name, e.g. "debug-auth-bug" or "feature-search"',
        },
      },
      required: ["name"],
    },
  },
  {
    name: "join_channel",
    description:
      "Join a collaboration channel to receive broadcasts and access the shared task board.",
    inputSchema: {
      type: "object" as const,
      properties: {
        channel_id: {
          type: "string" as const,
          description: "The channel ID to join (from create_channel or shared by another peer)",
        },
      },
      required: ["channel_id"],
    },
  },
  {
    name: "broadcast",
    description:
      'Post a tagged message to a collaboration channel. All channel members can see it. Use tags like [FINDING], [PROPOSAL], [CHALLENGE], [QUESTION] to categorize.',
    inputSchema: {
      type: "object" as const,
      properties: {
        channel_id: {
          type: "string" as const,
          description: "The channel ID to broadcast to",
        },
        tag: {
          type: "string" as const,
          description: "Message tag: FINDING, PROPOSAL, CHALLENGE, QUESTION, or custom",
        },
        message: {
          type: "string" as const,
          description: "The message to broadcast",
        },
      },
      required: ["channel_id", "message"],
    },
  },
  {
    name: "channel_messages",
    description:
      "Read recent messages from a collaboration channel. Use 'since' for polling new messages.",
    inputSchema: {
      type: "object" as const,
      properties: {
        channel_id: {
          type: "string" as const,
          description: "The channel ID to read from",
        },
        since: {
          type: "string" as const,
          description: "ISO timestamp — only return messages after this time (for polling)",
        },
        limit: {
          type: "number" as const,
          description: "Max messages to return (default 50)",
        },
      },
      required: ["channel_id"],
    },
  },
  {
    name: "channel_members",
    description: "List all agents/instances currently in a collaboration channel.",
    inputSchema: {
      type: "object" as const,
      properties: {
        channel_id: {
          type: "string" as const,
          description: "The channel ID",
        },
      },
      required: ["channel_id"],
    },
  },
  {
    name: "create_shared_task",
    description:
      "Post a task to a channel's shared task board. Other agents can claim and work on it.",
    inputSchema: {
      type: "object" as const,
      properties: {
        channel_id: {
          type: "string" as const,
          description: "The channel ID for the task board",
        },
        subject: {
          type: "string" as const,
          description: "Brief task title",
        },
        description: {
          type: "string" as const,
          description: "Detailed task description",
        },
      },
      required: ["channel_id", "subject"],
    },
  },
  {
    name: "claim_shared_task",
    description: "Claim an open task from the shared board. Only open tasks can be claimed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: {
          type: "number" as const,
          description: "The task ID to claim",
        },
      },
      required: ["task_id"],
    },
  },
  {
    name: "update_shared_task",
    description:
      'Update a shared task\'s status (open/claimed/done) or description.',
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: {
          type: "number" as const,
          description: "The task ID to update",
        },
        status: {
          type: "string" as const,
          enum: ["open", "claimed", "done"],
          description: "New status",
        },
        description: {
          type: "string" as const,
          description: "Updated description or notes",
        },
      },
      required: ["task_id"],
    },
  },
  {
    name: "list_shared_tasks",
    description: "List all tasks on a channel's shared board, optionally filtered by status.",
    inputSchema: {
      type: "object" as const,
      properties: {
        channel_id: {
          type: "string" as const,
          description: "The channel ID",
        },
        status: {
          type: "string" as const,
          enum: ["open", "claimed", "done"],
          description: "Filter by status (optional — omit for all tasks)",
        },
      },
      required: ["channel_id"],
    },
  },
];

// --- Tool handlers ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "list_peers": {
      const scope = (args as { scope: string }).scope as "machine" | "directory" | "repo";
      try {
        log(`list_peers called: myId=${myId}, scope=${scope}`);
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope,
          cwd: myCwd,
          git_root: myGitRoot,
          exclude_id: myId,
        });
        log(`list_peers returned ${peers.length} peers: ${peers.map(p => p.id).join(', ')}`);

        if (peers.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No other Claude Code instances found (scope: ${scope}).`,
              },
            ],
          };
        }

        const lines = peers.map((p) => {
          const parts = [
            `ID: ${p.id}`,
            `Type: ${p.agent_type ?? "unknown"}`,
            `PID: ${p.pid}`,
            `CWD: ${p.cwd}`,
          ];
          if (p.git_root) parts.push(`Repo: ${p.git_root}`);
          if (p.tty) parts.push(`TTY: ${p.tty}`);
          if (p.summary) parts.push(`Summary: ${p.summary}`);
          parts.push(`Last seen: ${p.last_seen}`);
          return parts.join("\n  ");
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${peers.length} peer(s) (scope: ${scope}):\n\n${lines.join("\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing peers: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "send_message": {
      const { to_id, message } = args as { to_id: string; message: string };
      log(`send_message called: myId=${myId}, to_id=${to_id}, args=${JSON.stringify(args)}`);
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        log(`send_message sending: from_id=${myId}, to_id=${to_id}`);
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
          from_id: myId,
          to_id,
          text: message,
        });
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed to send: ${result.error}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `Message sent to peer ${to_id}` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error sending message: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        await brokerFetch("/set-summary", { id: myId, summary });
        return {
          content: [{ type: "text" as const, text: `Summary updated: "${summary}"` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error setting summary: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "check_messages": {
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
        // Clear from channelPushedIds since they're now consumed via poll
        for (const msg of result.messages) {
          channelPushedIds.delete(msg.id);
        }
        if (result.messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No new messages." }],
          };
        }
        const lines = result.messages.map(
          (m) => `From ${m.from_id} (${m.sent_at}):\n${m.text}`
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `${result.messages.length} new message(s):\n\n${lines.join("\n\n---\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error checking messages: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "debug_info": {
      try {
        const allPeers = await brokerFetch<Peer[]>("/list-peers", {
          scope: "machine",
          cwd: myCwd,
          git_root: myGitRoot,
        });
        const self = allPeers.find((p) => p.pid === process.pid);
        const lines = [
          `MCP Server Identity:`,
          `  myId (in-memory): ${myId}`,
          `  process.pid: ${process.pid}`,
          `  process.ppid: ${process.ppid}`,
          `  myCwd: ${myCwd}`,
          ``,
          `Broker State:`,
          ...allPeers.map(
            (p) =>
              `  ${p.id} → PID ${p.pid} (${p.tty ?? "?"}) ${p.id === myId ? "← myId" : ""} ${p.pid === process.pid ? "← my PID" : ""}`
          ),
          ``,
          `Identity Check: ${
            self
              ? self.id === myId
                ? "OK — myId matches PID mapping"
                : `MISMATCH — myId=${myId} but PID ${process.pid} maps to ${self.id}`
              : `WARNING — PID ${process.pid} not found in broker`
          }`,
        ];
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error getting debug info: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    // --- Collaboration tool handlers ---

    case "create_channel": {
      const { name: channelName } = args as { name: string };
      try {
        const result = await brokerFetch<CreateChannelResponse>("/create-channel", { name: channelName });
        // Auto-join the creating instance
        if (myId) {
          await brokerFetch("/join-channel", { channel_id: result.id, agent_id: myId });
        }
        return {
          content: [{
            type: "text" as const,
            text: `Channel created: ${result.id} ("${channelName}")\nShare this ID with other instances to collaborate.`,
          }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error creating channel: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "join_channel": {
      const { channel_id } = args as { channel_id: string };
      if (!myId) {
        return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      }
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/join-channel", {
          channel_id,
          agent_id: myId,
        });
        if (!result.ok) {
          return { content: [{ type: "text" as const, text: `Failed to join: ${result.error}` }], isError: true };
        }
        return { content: [{ type: "text" as const, text: `Joined channel ${channel_id}` }] };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error joining channel: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "broadcast": {
      const { channel_id, tag, message } = args as { channel_id: string; tag?: string; message: string };
      const fromId = myId ?? "unknown";
      try {
        await brokerFetch("/channel-broadcast", {
          channel_id,
          from_id: fromId,
          tag: tag ?? "",
          text: message,
        });
        const tagStr = tag ? `[${tag}] ` : "";
        return { content: [{ type: "text" as const, text: `Broadcast to ${channel_id}: ${tagStr}${message.slice(0, 100)}${message.length > 100 ? "..." : ""}` }] };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error broadcasting: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "channel_messages": {
      const { channel_id, since, limit } = args as { channel_id: string; since?: string; limit?: number };
      try {
        const result = await brokerFetch<ChannelMessagesResponse>("/channel-messages", {
          channel_id,
          since,
          limit,
        });
        if (result.messages.length === 0) {
          return { content: [{ type: "text" as const, text: `No${since ? " new" : ""} messages in channel ${channel_id}.` }] };
        }
        const lines = result.messages.map((m) => {
          const tagStr = m.tag ? `[${m.tag}] ` : "";
          return `${m.from_id} (${m.sent_at}): ${tagStr}${m.text}`;
        });
        return {
          content: [{
            type: "text" as const,
            text: `${result.messages.length} message(s) in ${channel_id}:\n\n${lines.join("\n\n")}`,
          }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error reading channel: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "channel_members": {
      const { channel_id } = args as { channel_id: string };
      try {
        const result = await brokerFetch<ChannelMembersResponse>("/channel-members", { channel_id });
        if (result.members.length === 0) {
          return { content: [{ type: "text" as const, text: `No members in channel ${channel_id}.` }] };
        }
        const lines = result.members.map((m) => `  ${m.agent_id} (joined ${m.joined_at})`);
        return {
          content: [{
            type: "text" as const,
            text: `${result.members.length} member(s) in ${channel_id}:\n${lines.join("\n")}`,
          }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error listing members: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "create_shared_task": {
      const { channel_id, subject, description } = args as { channel_id: string; subject: string; description?: string };
      try {
        const result = await brokerFetch<CreateSharedTaskResponse>("/create-task", {
          channel_id,
          subject,
          description: description ?? "",
        });
        return { content: [{ type: "text" as const, text: `Task #${result.id} created: "${subject}"` }] };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error creating task: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "claim_shared_task": {
      const { task_id } = args as { task_id: number };
      const agentId = myId ?? "unknown";
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/claim-task", {
          task_id,
          agent_id: agentId,
        });
        if (!result.ok) {
          return { content: [{ type: "text" as const, text: `Failed to claim: ${result.error}` }], isError: true };
        }
        return { content: [{ type: "text" as const, text: `Claimed task #${task_id}` }] };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error claiming task: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "update_shared_task": {
      const { task_id, status, description } = args as { task_id: number; status?: string; description?: string };
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/update-task", {
          task_id,
          status,
          description,
        });
        if (!result.ok) {
          return { content: [{ type: "text" as const, text: `Failed to update: ${result.error}` }], isError: true };
        }
        return { content: [{ type: "text" as const, text: `Task #${task_id} updated${status ? ` → ${status}` : ""}` }] };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error updating task: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "list_shared_tasks": {
      const { channel_id, status } = args as { channel_id: string; status?: string };
      try {
        const tasks = await brokerFetch<SharedTask[]>("/list-tasks", {
          channel_id,
          status,
        });
        if (tasks.length === 0) {
          return { content: [{ type: "text" as const, text: `No${status ? ` ${status}` : ""} tasks in ${channel_id}.` }] };
        }
        const lines = tasks.map((t) => {
          const claimed = t.claimed_by ? ` (claimed by ${t.claimed_by})` : "";
          return `  #${t.id} [${t.status}]${claimed} ${t.subject}${t.description ? `\n    ${t.description.slice(0, 120)}` : ""}`;
        });
        return {
          content: [{
            type: "text" as const,
            text: `${tasks.length} task(s) in ${channel_id}:\n${lines.join("\n")}`,
          }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error listing tasks: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// --- Polling loop for inbound messages ---

async function pollAndPushMessages() {
  if (!myId) return;

  try {
    // Peek at undelivered messages WITHOUT marking them as delivered.
    // Only check_messages marks messages as delivered (via /poll-messages).
    const result = await brokerFetch<PollMessagesResponse>("/peek-messages", { id: myId });

    for (const msg of result.messages) {
      // Skip messages already pushed via channel
      if (channelPushedIds.has(msg.id)) continue;

      // Look up the sender's info for context
      let fromSummary = "";
      let fromCwd = "";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope: "machine",
          cwd: myCwd,
          git_root: myGitRoot,
        });
        const sender = peers.find((p) => p.id === msg.from_id);
        if (sender) {
          fromSummary = sender.summary;
          fromCwd = sender.cwd;
        }
      } catch {
        // Non-critical, proceed without sender info
      }

      // Push as channel notification (best-effort — only works with
      // --dangerously-load-development-channels, silently dropped otherwise)
      try {
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: msg.text,
            meta: {
              from_id: msg.from_id,
              from_summary: fromSummary,
              from_cwd: fromCwd,
              sent_at: msg.sent_at,
            },
          },
        });
        trackPushedId(msg.id);
        log(`Pushed message from ${msg.from_id}: ${msg.text.slice(0, 80)}`);
      } catch {
        // Channel push failed — leave message for check_messages to pick up.
        // Do NOT add to channelPushedIds so the message stays visible.
        log(`Channel push failed for msg ${msg.id}, will be available via check_messages`);
      }
    }
  } catch (e) {
    // Broker might be down temporarily, don't crash
    log(`Poll error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- Startup ---

async function main() {
  // 1. Ensure broker is running
  await ensureBroker();

  // 2. Gather context
  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  const tty = getTty();

  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);
  log(`TTY: ${tty ?? "(unknown)"}`);

  // 3. Generate initial summary via gpt-5.4-nano (non-blocking, best-effort)
  let initialSummary = "";
  const summaryPromise = (async () => {
    try {
      const branch = await getGitBranch(myCwd);
      const recentFiles = await getRecentFiles(myCwd);
      const summary = await generateSummary({
        cwd: myCwd,
        git_root: myGitRoot,
        git_branch: branch,
        recent_files: recentFiles,
      });
      if (summary) {
        initialSummary = summary;
        log(`Auto-summary: ${summary}`);
      }
    } catch (e) {
      log(`Auto-summary failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
    }
  })();

  // Wait briefly for summary, but don't block startup
  await Promise.race([summaryPromise, new Promise((r) => setTimeout(r, 3000))]);

  // 4. Register with broker
  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: process.pid,
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    summary: initialSummary,
    agent_type: AGENT_TYPE,
  });
  myId = reg.id;
  log(`Registered as peer ${myId} (PID ${process.pid})`);
  if (reg.channels?.length) {
    log(`Auto-joined channels: ${reg.channels.join(', ')}`);
  }

  // 4b. Fetch scrollback from #general
  try {
    const scrollback = await brokerFetch<ChannelMessagesResponse>("/channel-messages", {
      channel_id: "general",
      limit: 20,
    });
    if (scrollback.messages.length > 0) {
      log(`Scrollback: ${scrollback.messages.length} recent messages in #general`);
      const summary = scrollback.messages.map((m) => {
        const tag = m.tag ? `[${m.tag}] ` : "";
        return `${tag}${m.from_id}: ${m.text.slice(0, 200)}`;
      }).join("\n");
      try {
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: `Recent messages from #general:\n${summary}`,
            meta: { type: "scrollback", channel: "general" },
          },
        });
      } catch {
        // Channel push not available — scrollback accessible via channel_messages tool
      }
    }
  } catch {
    log("Scrollback fetch failed (non-critical)");
  }

  // 4c. Verify identity — ensure our ID actually maps to our PID in the broker.
  // This catches any registration race conditions or ID assignment bugs.
  try {
    const allPeers = await brokerFetch<Peer[]>("/list-peers", {
      scope: "machine",
      cwd: myCwd,
      git_root: myGitRoot,
    });
    const self = allPeers.find((p) => p.pid === process.pid);
    if (self && self.id !== myId) {
      log(`Identity mismatch! Registration returned ${myId} but broker maps PID ${process.pid} to ${self.id}. Correcting.`);
      myId = self.id;
    } else if (!self) {
      log(`Warning: PID ${process.pid} not found in broker peer list after registration`);
    } else {
      log(`Identity verified: ${myId} → PID ${process.pid}`);
    }
  } catch (e) {
    log(`Identity verification failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
  }

  // If summary generation is still running, update it when done
  if (!initialSummary) {
    summaryPromise.then(async () => {
      if (initialSummary && myId) {
        try {
          await brokerFetch("/set-summary", { id: myId, summary: initialSummary });
          log(`Late auto-summary applied: ${initialSummary}`);
        } catch {
          // Non-critical
        }
      }
    });
  }

  // 5. Connect MCP over stdio
  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  // 6. Start polling for inbound messages
  const pollTimer = setInterval(pollAndPushMessages, POLL_INTERVAL_MS);

  // 7. Start heartbeat (with periodic identity verification)
  const heartbeatTimer = setInterval(async () => {
    if (myId) {
      try {
        await brokerFetch("/heartbeat", { id: myId });

        // Periodically verify identity hasn't drifted
        const allPeers = await brokerFetch<Peer[]>("/list-peers", {
          scope: "machine",
          cwd: myCwd,
          git_root: myGitRoot,
        });
        const self = allPeers.find((p) => p.pid === process.pid);
        if (self && self.id !== myId) {
          log(`Identity drift detected! myId=${myId} but PID ${process.pid} maps to ${self.id}. Correcting.`);
          myId = self.id;
        }
      } catch {
        // Non-critical
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  // 8. Clean up on exit
  const cleanup = async () => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    if (myId) {
      try {
        await brokerFetch("/unregister", { id: myId });
        log("Unregistered from broker");
      } catch {
        // Best effort
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
