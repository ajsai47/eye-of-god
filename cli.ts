#!/usr/bin/env bun
/**
 * claude-peers CLI
 *
 * Utility commands for managing the broker, inspecting peers, and collaboration.
 *
 * Usage:
 *   bun cli.ts status                        — Show broker status and all peers
 *   bun cli.ts peers                         — List all peers
 *   bun cli.ts send <id> <msg>               — Send a message to a peer
 *   bun cli.ts channels                      — List all channels
 *   bun cli.ts create-channel <name>         — Create a collaboration channel
 *   bun cli.ts join-channel <channel> <agent> — Join a channel
 *   bun cli.ts broadcast <channel> <tag> <msg> — Broadcast to a channel
 *   bun cli.ts messages <channel>            — Read channel messages
 *   bun cli.ts tasks <channel>               — List shared tasks
 *   bun cli.ts create-task <channel> <subject> — Create a shared task
 *   bun cli.ts claim-task <task-id> <agent>  — Claim a task
 *   bun cli.ts kill-broker                   — Stop the broker daemon
 */

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;

async function brokerFetch<T>(path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = body
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    : {};
  const res = await fetch(`${BROKER_URL}${path}`, {
    ...opts,
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

const cmd = process.argv[2];

switch (cmd) {
  case "status": {
    try {
      const health = await brokerFetch<{ status: string; peers: number; channels?: number; agents?: number }>("/health");
      console.log(`Broker: ${health.status} (${health.peers} peer(s), ${health.channels ?? 0} channel(s), ${health.agents ?? 0} agent(s))`);
      console.log(`URL: ${BROKER_URL}`);

      if (health.peers > 0) {
        const peers = await brokerFetch<
          Array<{
            id: string;
            pid: number;
            cwd: string;
            git_root: string | null;
            tty: string | null;
            summary: string;
            last_seen: string;
          }>
        >("/list-peers", {
          scope: "machine",
          cwd: "/",
          git_root: null,
        });

        console.log("\nPeers:");
        for (const p of peers) {
          console.log(`  ${p.id}  PID:${p.pid}  ${p.cwd}`);
          if (p.summary) console.log(`         ${p.summary}`);
          if (p.tty) console.log(`         TTY: ${p.tty}`);
          console.log(`         Last seen: ${p.last_seen}`);
        }
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "peers": {
    try {
      const peers = await brokerFetch<
        Array<{
          id: string;
          pid: number;
          cwd: string;
          git_root: string | null;
          tty: string | null;
          summary: string;
          last_seen: string;
        }>
      >("/list-peers", {
        scope: "machine",
        cwd: "/",
        git_root: null,
      });

      if (peers.length === 0) {
        console.log("No peers registered.");
      } else {
        for (const p of peers) {
          const parts = [`${p.id}  PID:${p.pid}  ${p.cwd}`];
          if (p.summary) parts.push(`  Summary: ${p.summary}`);
          console.log(parts.join("\n"));
        }
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "send": {
    const toId = process.argv[3];
    const msg = process.argv.slice(4).join(" ");
    if (!toId || !msg) {
      console.error("Usage: bun cli.ts send <peer-id> <message>");
      process.exit(1);
    }
    try {
      const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
        from_id: "cli",
        to_id: toId,
        text: msg,
      });
      if (result.ok) {
        console.log(`Message sent to ${toId}`);
      } else {
        console.error(`Failed: ${result.error}`);
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    break;
  }

  case "channels": {
    try {
      const channels = await brokerFetch<Array<{ id: string; name: string; created_at: string }>>("/list-channels", {});
      if (channels.length === 0) {
        console.log("No channels.");
      } else {
        console.log("Channels:");
        for (const ch of channels) {
          const members = await brokerFetch<{ members: Array<{ agent_id: string }> }>("/channel-members", { channel_id: ch.id });
          console.log(`  ${ch.id}  "${ch.name}"  (${members.members.length} members)  Created: ${ch.created_at}`);
        }
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "create-channel": {
    const channelName = process.argv[3];
    if (!channelName) {
      console.error("Usage: bun cli.ts create-channel <name>");
      process.exit(1);
    }
    try {
      const result = await brokerFetch<{ id: string }>("/create-channel", { name: channelName });
      console.log(`Channel created: ${result.id} ("${channelName}")`);
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    break;
  }

  case "join-channel": {
    const channelId = process.argv[3];
    const agentId = process.argv[4];
    if (!channelId || !agentId) {
      console.error("Usage: bun cli.ts join-channel <channel-id> <agent-id>");
      process.exit(1);
    }
    try {
      const result = await brokerFetch<{ ok: boolean; error?: string }>("/join-channel", {
        channel_id: channelId,
        agent_id: agentId,
      });
      if (result.ok) {
        console.log(`${agentId} joined ${channelId}`);
      } else {
        console.error(`Failed: ${result.error}`);
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    break;
  }

  case "broadcast": {
    const chId = process.argv[3];
    const tag = process.argv[4];
    const bMsg = process.argv.slice(5).join(" ");
    if (!chId || !tag || !bMsg) {
      console.error("Usage: bun cli.ts broadcast <channel-id> <tag> <message>");
      process.exit(1);
    }
    try {
      await brokerFetch("/channel-broadcast", {
        channel_id: chId,
        from_id: "cli",
        tag,
        text: bMsg,
      });
      console.log(`Broadcast [${tag}] to ${chId}`);
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    break;
  }

  case "messages": {
    const mChId = process.argv[3];
    if (!mChId) {
      console.error("Usage: bun cli.ts messages <channel-id>");
      process.exit(1);
    }
    try {
      const result = await brokerFetch<{ messages: Array<{ id: number; from_id: string; tag: string; text: string; sent_at: string }> }>(
        "/channel-messages",
        { channel_id: mChId, limit: 20 }
      );
      if (result.messages.length === 0) {
        console.log("No messages.");
      } else {
        for (const m of result.messages) {
          const tagStr = m.tag ? `[${m.tag}] ` : "";
          console.log(`  ${m.from_id} (${m.sent_at}): ${tagStr}${m.text}`);
        }
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    break;
  }

  case "tasks": {
    const tChId = process.argv[3];
    if (!tChId) {
      console.error("Usage: bun cli.ts tasks <channel-id>");
      process.exit(1);
    }
    try {
      const tasks = await brokerFetch<Array<{ id: number; subject: string; status: string; claimed_by: string | null; description: string }>>(
        "/list-tasks",
        { channel_id: tChId }
      );
      if (tasks.length === 0) {
        console.log("No tasks.");
      } else {
        console.log("Shared Tasks:");
        for (const t of tasks) {
          const claimed = t.claimed_by ? ` → ${t.claimed_by}` : "";
          console.log(`  #${t.id} [${t.status}]${claimed} ${t.subject}`);
          if (t.description) console.log(`     ${t.description.slice(0, 100)}`);
        }
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    break;
  }

  case "create-task": {
    const ctChId = process.argv[3];
    const ctSubject = process.argv.slice(4).join(" ");
    if (!ctChId || !ctSubject) {
      console.error("Usage: bun cli.ts create-task <channel-id> <subject>");
      process.exit(1);
    }
    try {
      const result = await brokerFetch<{ id: number }>("/create-task", {
        channel_id: ctChId,
        subject: ctSubject,
      });
      console.log(`Task #${result.id} created: "${ctSubject}"`);
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    break;
  }

  case "claim-task": {
    const taskId = parseInt(process.argv[3]);
    const claimAgent = process.argv[4];
    if (!taskId || !claimAgent) {
      console.error("Usage: bun cli.ts claim-task <task-id> <agent-id>");
      process.exit(1);
    }
    try {
      const result = await brokerFetch<{ ok: boolean; error?: string }>("/claim-task", {
        task_id: taskId,
        agent_id: claimAgent,
      });
      if (result.ok) {
        console.log(`Task #${taskId} claimed by ${claimAgent}`);
      } else {
        console.error(`Failed: ${result.error}`);
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    break;
  }

  case "kill-broker": {
    try {
      const health = await brokerFetch<{ status: string; peers: number }>("/health");
      console.log(`Broker has ${health.peers} peer(s). Shutting down...`);
      // Find and kill the broker process on the port
      const proc = Bun.spawnSync(["lsof", "-ti", `:${BROKER_PORT}`]);
      const pids = new TextDecoder()
        .decode(proc.stdout)
        .trim()
        .split("\n")
        .filter((p) => p);
      for (const pid of pids) {
        process.kill(parseInt(pid), "SIGTERM");
      }
      console.log("Broker stopped.");
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  default:
    console.log(`claude-peers CLI

Usage:
  bun cli.ts status                          Show broker status, peers, channels
  bun cli.ts peers                           List all peers
  bun cli.ts send <id> <msg>                 Send a message to a peer

Collaboration:
  bun cli.ts channels                        List all channels
  bun cli.ts create-channel <name>           Create a collaboration channel
  bun cli.ts join-channel <channel> <agent>  Join a channel
  bun cli.ts broadcast <channel> <tag> <msg> Broadcast to a channel
  bun cli.ts messages <channel>              Read channel messages
  bun cli.ts tasks <channel>                 List shared tasks
  bun cli.ts create-task <channel> <subject> Create a shared task
  bun cli.ts claim-task <task-id> <agent>    Claim a task

Admin:
  bun cli.ts kill-broker                     Stop the broker daemon`);
}
