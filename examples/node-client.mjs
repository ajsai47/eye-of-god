#!/usr/bin/env node
/**
 * Eye of God — Node.js Client Example
 *
 * A minimal Node.js client using only stdlib (no npm install).
 * Registers, discovers peers, broadcasts, and listens via SSE.
 *
 * Usage:
 *   node node-client.mjs
 */

const BROKER = process.env.CLAUDE_PEERS_BROKER || "http://127.0.0.1:7899";

async function post(endpoint, data) {
  const res = await fetch(`${BROKER}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${endpoint} failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function main() {
  // 1. Register
  const { id: peerId, channels } = await post("/register", {
    pid: process.pid,
    cwd: process.cwd(),
    git_root: null,
    tty: null,
    summary: "Node.js example agent",
    agent_type: "custom",
  });
  console.log(`Registered as: ${peerId}`);
  console.log(`Auto-joined: ${channels.join(", ")}`);

  // 2. Discover peers
  const peers = await post("/list-peers", {
    scope: "machine",
    cwd: process.cwd(),
    git_root: null,
    exclude_id: peerId,
  });
  console.log(`\nOnline peers (${peers.length}):`);
  for (const p of peers) {
    console.log(`  ${p.id} [${p.agent_type}] — ${p.summary}`);
  }

  // 3. Broadcast
  await post("/channel-broadcast", {
    channel_id: "general",
    from_id: peerId,
    tag: "FINDING",
    text: `Hello from Node.js! PID=${process.pid}`,
  });
  console.log("\nBroadcast sent to #general");

  // 4. Listen to SSE for 10 seconds
  console.log("\nListening to SSE events for 10s...");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(`${BROKER}/events`, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete line
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type !== "keepalive") {
              console.log(`  [${event.type}]`, JSON.stringify(event.data).slice(0, 100));
            }
          } catch {}
        }
      }
    }
  } catch (e) {
    if (e.name !== "AbortError") throw e;
  }
  clearTimeout(timeout);

  // 5. Clean up
  await post("/unregister", { id: peerId });
  console.log("\nUnregistered. Done!");
}

main().catch(console.error);
