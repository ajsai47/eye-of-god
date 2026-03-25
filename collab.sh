#!/usr/bin/env bash
# collab.sh — Shell helper for subagents to interact with the claude-peers broker
#
# Usage from any subagent:
#   source /path/to/eye-of-god/collab.sh
#   collab_register "researcher" "Deep code analysis"
#   collab_broadcast "collab-abc123" "FINDING" "The auth bug is in middleware.ts:42"
#   collab_messages "collab-abc123"
#   collab_tasks "collab-abc123"
#   collab_claim "collab-abc123" 3
#   collab_done 3 "Fixed the issue"
#   collab_create_task "collab-abc123" "Review the fix"
#   collab_members "collab-abc123"
#   collab_unregister

COLLAB_BROKER="${CLAUDE_PEERS_BROKER_URL:-http://127.0.0.1:7899}"
COLLAB_AGENT_ID=""
COLLAB_INSTANCE_ID="${COLLAB_INSTANCE_ID:-unknown}"
COLLAB_AGENT_TYPE="${COLLAB_AGENT_TYPE:-shell}"

_collab_curl="${COLLAB_CURL:-$(command -v curl 2>/dev/null || echo /usr/bin/curl)}"

_collab_post() {
  local path="$1"
  local data="$2"
  "$_collab_curl" -s -X POST "${COLLAB_BROKER}${path}" \
    -H "Content-Type: application/json" \
    -d "$data" 2>/dev/null
}

# Register as a peer (top-level agent) with the broker
# Usage: collab_register_peer [summary]
collab_register_peer() {
  local summary="${1:-}"
  local safe_summary safe_type
  safe_summary=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$summary")
  safe_type=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$COLLAB_AGENT_TYPE")
  local result
  result=$(_collab_post "/register" \
    "{\"pid\":$$,\"cwd\":\"$(pwd)\",\"git_root\":null,\"tty\":null,\"summary\":${safe_summary},\"agent_type\":${safe_type}}")
  COLLAB_INSTANCE_ID=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
  COLLAB_AGENT_ID="$COLLAB_INSTANCE_ID"
  echo "Registered peer: ${COLLAB_INSTANCE_ID} (type: ${COLLAB_AGENT_TYPE})"
}

# Register this subagent with the broker
# Usage: collab_register <name> [role]
collab_register() {
  local name="$1"
  local role="${2:-}"
  local safe_name safe_role
  safe_name=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$name")
  safe_role=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$role")
  local result
  result=$(_collab_post "/register-agent" \
    "{\"instance_id\":\"${COLLAB_INSTANCE_ID}\",\"name\":${safe_name},\"role\":${safe_role}}")
  COLLAB_AGENT_ID=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
  echo "Registered as: ${COLLAB_AGENT_ID}"
}

# Unregister this subagent
collab_unregister() {
  if [ -n "$COLLAB_AGENT_ID" ]; then
    _collab_post "/unregister-agent" "{\"id\":\"${COLLAB_AGENT_ID}\"}" > /dev/null
    echo "Unregistered: ${COLLAB_AGENT_ID}"
    COLLAB_AGENT_ID=""
  fi
}

# Join a channel
# Usage: collab_join <channel_id>
collab_join() {
  local channel_id="$1"
  local agent="${COLLAB_AGENT_ID:-${COLLAB_INSTANCE_ID}}"
  _collab_post "/join-channel" "{\"channel_id\":\"${channel_id}\",\"agent_id\":\"${agent}\"}"
}

# Broadcast a tagged message to a channel
# Usage: collab_broadcast <channel_id> <tag> <message>
collab_broadcast() {
  local channel_id="$1"
  local tag="$2"
  local text="$3"
  local from="${COLLAB_AGENT_ID:-${COLLAB_INSTANCE_ID}}"
  # Escape the text for JSON
  local escaped_text
  escaped_text=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$text" 2>/dev/null)
  _collab_post "/channel-broadcast" \
    "{\"channel_id\":\"${channel_id}\",\"from_id\":\"${from}\",\"tag\":\"${tag}\",\"text\":${escaped_text}}"
}

# Read recent channel messages
# Usage: collab_messages <channel_id> [since_timestamp]
collab_messages() {
  local channel_id="$1"
  local since="${2:-}"
  local data="{\"channel_id\":\"${channel_id}\",\"limit\":20"
  if [ -n "$since" ]; then
    data="${data},\"since\":\"${since}\""
  fi
  data="${data}}"
  local result
  result=$(_collab_post "/channel-messages" "$data")
  echo "$result" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for m in data.get('messages', []):
    tag = f'[{m[\"tag\"]}] ' if m.get('tag') else ''
    print(f'{m[\"from_id\"]} ({m[\"sent_at\"]}): {tag}{m[\"text\"]}')
if not data.get('messages'):
    print('No messages.')
" 2>/dev/null
}

# List channel members
# Usage: collab_members <channel_id>
collab_members() {
  local channel_id="$1"
  local result
  result=$(_collab_post "/channel-members" "{\"channel_id\":\"${channel_id}\"}")
  echo "$result" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for m in data.get('members', []):
    print(f'  {m[\"agent_id\"]} (joined {m[\"joined_at\"]})')
if not data.get('members'):
    print('No members.')
" 2>/dev/null
}

# List shared tasks for a channel
# Usage: collab_tasks <channel_id> [status_filter]
collab_tasks() {
  local channel_id="$1"
  local filter_status="${2:-}"
  local data="{\"channel_id\":\"${channel_id}\""
  if [ -n "$filter_status" ]; then
    data="${data},\"status\":\"${filter_status}\""
  fi
  data="${data}}"
  local result
  result=$(_collab_post "/list-tasks" "$data")
  echo "$result" | python3 -c "
import sys, json
tasks = json.load(sys.stdin)
for t in tasks:
    claimed = f' -> {t[\"claimed_by\"]}' if t.get('claimed_by') else ''
    print(f'  #{t[\"id\"]} [{t[\"status\"]}]{claimed} {t[\"subject\"]}')
if not tasks:
    print('No tasks.')
" 2>/dev/null
}

# Create a shared task
# Usage: collab_create_task <channel_id> <subject> [description]
collab_create_task() {
  local channel_id="$1"
  local subject="$2"
  local description="${3:-}"
  local escaped_subject escaped_desc
  escaped_subject=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$subject" 2>/dev/null)
  escaped_desc=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$description" 2>/dev/null)
  local result
  result=$(_collab_post "/create-task" \
    "{\"channel_id\":\"${channel_id}\",\"subject\":${escaped_subject},\"description\":${escaped_desc}}")
  echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Task #{d[\"id\"]} created')" 2>/dev/null
}

# Claim an open task
# Usage: collab_claim <task_id>
collab_claim() {
  local task_id="$1"
  local agent="${COLLAB_AGENT_ID:-${COLLAB_INSTANCE_ID}}"
  _collab_post "/claim-task" "{\"task_id\":${task_id},\"agent_id\":\"${agent}\"}"
}

# Mark a task as done with optional notes
# Usage: collab_done <task_id> [notes]
collab_done() {
  local task_id="$1"
  local notes="${2:-}"
  local data="{\"task_id\":${task_id},\"status\":\"done\""
  if [ -n "$notes" ]; then
    local escaped_notes
    escaped_notes=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$notes" 2>/dev/null)
    data="${data},\"description\":${escaped_notes}"
  fi
  data="${data}}"
  _collab_post "/update-task" "$data"
}
