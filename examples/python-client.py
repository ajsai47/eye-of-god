#!/usr/bin/env python3
"""
Eye of God — Python Client Example

A minimal Python client that registers with the broker,
discovers peers, broadcasts a message, and polls for replies.

Usage:
    python3 python-client.py

Requires: Python 3.7+ (only stdlib, no pip install needed)
"""

import json
import os
import urllib.error
import urllib.request
import time

BROKER = os.environ.get("CLAUDE_PEERS_BROKER", "http://127.0.0.1:7899")


def post(endpoint: str, data: dict) -> dict:
    """POST JSON to the broker and return parsed response."""
    body = json.dumps(data).encode()
    req = urllib.request.Request(
        f"{BROKER}{endpoint}",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.URLError as e:
        print(f"Error: Cannot connect to broker at {BROKER}")
        print(f"  Make sure the broker is running: bun broker.ts")
        raise SystemExit(1) from e


def main():
    # 1. Register
    pid = os.getpid()
    cwd = os.getcwd()
    result = post("/register", {
        "pid": pid,
        "cwd": cwd,
        "git_root": None,
        "tty": None,
        "summary": "Python example agent",
        "agent_type": "custom",
    })
    peer_id = result["id"]
    channels = result.get("channels", [])
    print(f"Registered as: {peer_id}")
    print(f"Auto-joined channels: {channels}")

    # 2. Discover peers
    peers = post("/list-peers", {
        "scope": "machine",
        "cwd": cwd,
        "git_root": None,
        "exclude_id": peer_id,
    })
    print(f"\nOnline peers ({len(peers)}):")
    for p in peers:
        print(f"  {p['id']} [{p.get('agent_type', '?')}] — {p.get('summary', '')}")

    # 3. Broadcast to #general
    post("/channel-broadcast", {
        "channel_id": "general",
        "from_id": peer_id,
        "tag": "FINDING",
        "text": "Hello from Python! PID=" + str(pid),
    })
    print("\nBroadcast sent to #general")

    # 4. Read channel history
    history = post("/channel-messages", {
        "channel_id": "general",
        "limit": 5,
    })
    print(f"\nRecent messages in #general ({len(history['messages'])}):")
    for m in history["messages"]:
        tag = f" [{m['tag']}]" if m.get("tag") else ""
        print(f"  {m['from_id']}{tag}: {m['text'][:80]}")

    # 5. Send DM to first peer (if any)
    if peers:
        target = peers[0]
        post("/send-message", {
            "from_id": peer_id,
            "to_id": target["id"],
            "text": f"Hey {target['id']}, what are you working on?",
        })
        print(f"\nSent DM to {target['id']}")

    # 6. Poll for DMs
    incoming = post("/poll-messages", {"id": peer_id})
    if incoming["messages"]:
        print(f"\nIncoming DMs ({len(incoming['messages'])}):")
        for m in incoming["messages"]:
            print(f"  From {m['from_id']}: {m['text'][:80]}")
    else:
        print("\nNo DMs waiting")

    # 7. Create a task
    task = post("/create-task", {
        "channel_id": "general",
        "subject": "Review Python client example",
        "description": "Verify the example works end-to-end",
    })
    print(f"\nCreated task EOG-{task['id']}")

    # 8. Heartbeat (in a real client, do this every 30s)
    post("/heartbeat", {"id": peer_id})

    # 9. Clean up
    input("\nPress Enter to unregister and exit...")
    post("/unregister", {"id": peer_id})
    print("Unregistered. Goodbye!")


if __name__ == "__main__":
    main()
