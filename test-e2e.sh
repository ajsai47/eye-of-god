#!/bin/bash
# Eye of God — End-to-End Broker API Test
# Simulates two peers: registration, messaging, channels, tasks, scrollback, cleanup

BROKER="http://127.0.0.1:7899"
PASS=0
FAIL=0
TOTAL=0

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# Spawn background processes to get valid PIDs for the broker's liveness check
sleep 3600 &
PID_A=$!
sleep 3600 &
PID_B=$!
sleep 3600 &
PID_C=$!

cleanup() {
  kill $PID_A $PID_B $PID_C 2>/dev/null
  wait $PID_A $PID_B $PID_C 2>/dev/null
}
trap cleanup EXIT

api() {
  local endpoint="$1"
  local payload="$2"
  python3 -c "
import json, urllib.request, sys
data = '''$payload'''.encode()
req = urllib.request.Request('$BROKER$endpoint', data=data, headers={'Content-Type': 'application/json'})
try:
    resp = urllib.request.urlopen(req)
    print(resp.read().decode())
except urllib.error.HTTPError as e:
    body = e.read().decode()
    print(body)
" 2>/dev/null
}

api_get() {
  curl -s "$BROKER$1" 2>/dev/null
}

assert_contains() {
  local label="$1"
  local actual="$2"
  local expected="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$actual" | grep -F -q "$expected"; then
    PASS=$((PASS + 1))
    echo -e "  ${GREEN}PASS${NC} $label"
  else
    FAIL=$((FAIL + 1))
    echo -e "  ${RED}FAIL${NC} $label"
    echo -e "       ${DIM}expected to contain: $expected${NC}"
    echo -e "       ${DIM}got: $(echo "$actual" | head -1)${NC}"
  fi
}

assert_not_contains() {
  local label="$1"
  local actual="$2"
  local unexpected="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$actual" | grep -F -q "$unexpected"; then
    FAIL=$((FAIL + 1))
    echo -e "  ${RED}FAIL${NC} $label"
    echo -e "       ${DIM}should NOT contain: $unexpected${NC}"
  else
    PASS=$((PASS + 1))
    echo -e "  ${GREEN}PASS${NC} $label"
  fi
}

echo ""
echo -e "${BOLD}Eye of God — E2E Test Suite${NC}"
echo "════════════════════════════════════════"
echo ""

# ── Health ──
echo -e "${BOLD}1. Broker Health${NC}"
HEALTH=$(api_get "/health")
assert_contains "broker is healthy" "$HEALTH" '"status":"ok"'

# ── Registration ──
echo ""
echo -e "${BOLD}2. Peer Registration${NC}"

REG_A=$(api "/register" "{\"pid\":$PID_A,\"cwd\":\"/tmp/project-a\",\"git_root\":null,\"tty\":\"test-a\",\"summary\":\"Peer A — fixing auth\",\"agent_type\":\"claude-code\"}")
PEER_A=$(echo "$REG_A" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
assert_contains "peer A registered" "$REG_A" '"id"'
assert_contains "peer A auto-joined #general" "$REG_A" '"general"'

REG_B=$(api "/register" "{\"pid\":$PID_B,\"cwd\":\"/tmp/project-b\",\"git_root\":\"/tmp/project-b\",\"tty\":\"test-b\",\"summary\":\"Peer B — writing tests\",\"agent_type\":\"codex\"}")
PEER_B=$(echo "$REG_B" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
assert_contains "peer B registered" "$REG_B" '"id"'
assert_contains "peer B auto-joined #general" "$REG_B" '"general"'

echo -e "       ${DIM}Peer A: $PEER_A (claude-code) | Peer B: $PEER_B (codex)${NC}"

# ── List Peers ──
echo ""
echo -e "${BOLD}3. Peer Discovery${NC}"

PEERS=$(api "/list-peers" '{"scope":"machine","cwd":".","git_root":null}')
assert_contains "peer A visible" "$PEERS" "$PEER_A"
assert_contains "peer B visible" "$PEERS" "$PEER_B"

PEERS_EXCL=$(api "/list-peers" "{\"scope\":\"machine\",\"cwd\":\".\",\"git_root\":null,\"exclude_id\":\"$PEER_A\"}")
assert_not_contains "exclude_id filters peer A" "$PEERS_EXCL" "$PEER_A"
assert_contains "peer B still visible after exclude" "$PEERS_EXCL" "$PEER_B"

# ── Set Summary ──
echo ""
echo -e "${BOLD}4. Set Summary${NC}"

api "/set-summary" "{\"id\":\"$PEER_A\",\"summary\":\"Found the auth bug in jwt.ts\"}" > /dev/null
PEERS_AFTER=$(api "/list-peers" '{"scope":"machine","cwd":".","git_root":null}')
assert_contains "summary updated" "$PEERS_AFTER" "Found the auth bug"

# ── Direct Messaging ──
echo ""
echo -e "${BOLD}5. Direct Messaging${NC}"

SEND=$(api "/send-message" "{\"from_id\":\"$PEER_A\",\"to_id\":\"$PEER_B\",\"text\":\"Hey B, check middleware.ts:42\"}")
assert_contains "message sent" "$SEND" '"ok":true'

# Peek (non-destructive)
PEEK=$(api "/peek-messages" "{\"id\":\"$PEER_B\"}")
assert_contains "peek shows message" "$PEEK" "middleware.ts:42"

# Peek again (should still be there)
PEEK2=$(api "/peek-messages" "{\"id\":\"$PEER_B\"}")
assert_contains "peek is non-destructive" "$PEEK2" "middleware.ts:42"

# Poll (destructive)
POLL=$(api "/poll-messages" "{\"id\":\"$PEER_B\"}")
assert_contains "poll returns message" "$POLL" "middleware.ts:42"

# Poll again (should be empty)
POLL2=$(api "/poll-messages" "{\"id\":\"$PEER_B\"}")
assert_contains "poll marks delivered" "$POLL2" '"messages":[]'

# Send to non-existent peer
SEND_BAD=$(api "/send-message" "{\"from_id\":\"$PEER_A\",\"to_id\":\"nonexistent\",\"text\":\"hello\"}")
assert_contains "rejects unknown peer" "$SEND_BAD" '"ok":false'

# ── Channels ──
echo ""
echo -e "${BOLD}6. Channels${NC}"

# #general already exists from auto-join
MEMBERS=$(api "/channel-members" '{"channel_id":"general"}')
assert_contains "peer A in #general" "$MEMBERS" "$PEER_A"
assert_contains "peer B in #general" "$MEMBERS" "$PEER_B"

# Create custom channel
CH=$(api "/create-channel" '{"name":"debug-session"}')
CH_ID=$(echo "$CH" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
assert_contains "channel created" "$CH" '"id"'
echo -e "       ${DIM}Channel: $CH_ID${NC}"

# Join channel
JOIN=$(api "/join-channel" "{\"channel_id\":\"$CH_ID\",\"agent_id\":\"$PEER_A\"}")
assert_contains "peer A joined channel" "$JOIN" '"ok":true'

api "/join-channel" "{\"channel_id\":\"$CH_ID\",\"agent_id\":\"$PEER_B\"}" > /dev/null

# Broadcast
BC=$(api "/channel-broadcast" "{\"channel_id\":\"$CH_ID\",\"from_id\":\"$PEER_A\",\"tag\":\"FINDING\",\"text\":\"The bug is a race condition in session refresh\"}")
assert_contains "broadcast sent" "$BC" '"ok":true'

api "/channel-broadcast" "{\"channel_id\":\"$CH_ID\",\"from_id\":\"$PEER_B\",\"tag\":\"PROPOSAL\",\"text\":\"Add a mutex around the refresh call\"}" > /dev/null

# Read messages
MSGS=$(api "/channel-messages" "{\"channel_id\":\"$CH_ID\",\"limit\":10}")
assert_contains "messages include FINDING" "$MSGS" "race condition"
assert_contains "messages include PROPOSAL" "$MSGS" "mutex"

# List channels
CHANNELS=$(api_get "/health")
assert_contains "channels count increased" "$CHANNELS" '"channels"'

# ── Shared Tasks ──
echo ""
echo -e "${BOLD}7. Shared Task Board${NC}"

T1=$(api "/create-task" "{\"channel_id\":\"$CH_ID\",\"subject\":\"Write failing test for race condition\",\"description\":\"Reproduce the session refresh race\"}")
T1_ID=$(echo "$T1" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
assert_contains "task created" "$T1" '"id"'

T2=$(api "/create-task" "{\"channel_id\":\"$CH_ID\",\"subject\":\"Add mutex to session refresh\",\"description\":\"Fix the root cause\"}")
T2_ID=$(echo "$T2" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

# List tasks
TASKS=$(api "/list-tasks" "{\"channel_id\":\"$CH_ID\"}")
assert_contains "task 1 listed" "$TASKS" "failing test"
assert_contains "task 2 listed" "$TASKS" "mutex"

# Claim task
CLAIM=$(api "/claim-task" "{\"task_id\":$T1_ID,\"agent_id\":\"$PEER_B\"}")
assert_contains "task claimed" "$CLAIM" '"ok":true'

# Can't claim already-claimed task
CLAIM2=$(api "/claim-task" "{\"task_id\":$T1_ID,\"agent_id\":\"$PEER_A\"}")
assert_contains "double-claim rejected" "$CLAIM2" '"ok":false'

# Update task to done
DONE=$(api "/update-task" "{\"task_id\":$T1_ID,\"status\":\"done\",\"description\":\"Test added in auth.test.ts\"}")
assert_contains "task marked done" "$DONE" '"ok":true'

# Filter by status
OPEN=$(api "/list-tasks" "{\"channel_id\":\"$CH_ID\",\"status\":\"open\"}")
assert_contains "open filter works" "$OPEN" "mutex"
assert_not_contains "done task filtered out" "$OPEN" "failing test"

# ── Scrollback ──
echo ""
echo -e "${BOLD}8. Scrollback (Channel History)${NC}"

# Post to #general
api "/channel-broadcast" "{\"channel_id\":\"general\",\"from_id\":\"$PEER_A\",\"tag\":\"FINDING\",\"text\":\"E2E test scrollback message alpha\"}" > /dev/null
api "/channel-broadcast" "{\"channel_id\":\"general\",\"from_id\":\"$PEER_B\",\"tag\":\"\",\"text\":\"E2E test scrollback message beta\"}" > /dev/null

# New peer registers and fetches scrollback
REG_C=$(api "/register" "{\"pid\":$PID_C,\"cwd\":\"/tmp/project-c\",\"git_root\":null,\"tty\":\"test-c\",\"summary\":\"Peer C — late joiner\"}")
PEER_C=$(echo "$REG_C" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
assert_contains "peer C auto-joined #general" "$REG_C" '"general"'

SCROLLBACK=$(api "/channel-messages" '{"channel_id":"general","limit":20}')
assert_contains "scrollback has alpha message" "$SCROLLBACK" "alpha"
assert_contains "scrollback has beta message" "$SCROLLBACK" "beta"

# ── Heartbeat ──
echo ""
echo -e "${BOLD}9. Heartbeat${NC}"

HB=$(api "/heartbeat" "{\"id\":\"$PEER_A\"}")
assert_contains "heartbeat accepted" "$HB" '"ok":true'

# ── Cross-Agent Identity ──
echo ""
echo -e "${BOLD}10. Cross-Agent Identity${NC}"

# Verify agent_type shows up in peer listings
PEERS_TYPED=$(api "/list-peers" '{"scope":"machine","cwd":".","git_root":null}')
assert_contains "peer A has agent_type claude-code" "$PEERS_TYPED" '"agent_type":"claude-code"'
assert_contains "peer B has agent_type codex" "$PEERS_TYPED" '"agent_type":"codex"'

# Register a peer without agent_type — should default to "unknown"
sleep 3600 &
PID_D=$!
REG_D=$(api "/register" "{\"pid\":$PID_D,\"cwd\":\"/tmp/project-d\",\"git_root\":null,\"tty\":null,\"summary\":\"Peer D — no type\"}")
PEER_D=$(echo "$REG_D" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
PEERS_D=$(api "/list-peers" '{"scope":"machine","cwd":".","git_root":null}')
assert_contains "default agent_type is unknown" "$PEERS_D" '"agent_type":"unknown"'

# Cross-agent messaging: codex → claude-code
XMSG=$(api "/send-message" "{\"from_id\":\"$PEER_B\",\"to_id\":\"$PEER_A\",\"text\":\"Cross-agent msg from codex to claude-code\"}")
assert_contains "cross-agent send works" "$XMSG" '"ok":true'

XPOLL=$(api "/poll-messages" "{\"id\":\"$PEER_A\"}")
assert_contains "cross-agent receive works" "$XPOLL" "Cross-agent msg from codex"

# Cross-agent task: codex creates, claude-code claims
XCH=$(api "/create-channel" '{"name":"cross-agent-test"}')
XCH_ID=$(echo "$XCH" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
api "/join-channel" "{\"channel_id\":\"$XCH_ID\",\"agent_id\":\"$PEER_A\"}" > /dev/null
api "/join-channel" "{\"channel_id\":\"$XCH_ID\",\"agent_id\":\"$PEER_B\"}" > /dev/null

XT=$(api "/create-task" "{\"channel_id\":\"$XCH_ID\",\"subject\":\"Cross-agent task from codex\"}")
XT_ID=$(echo "$XT" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

XCLAIM=$(api "/claim-task" "{\"task_id\":$XT_ID,\"agent_id\":\"$PEER_A\"}")
assert_contains "claude-code claims codex task" "$XCLAIM" '"ok":true'

XDONE=$(api "/update-task" "{\"task_id\":$XT_ID,\"status\":\"done\",\"description\":\"Completed by claude-code\"}")
assert_contains "claude-code completes codex task" "$XDONE" '"ok":true'

# Cleanup extra peer
api "/unregister" "{\"id\":\"$PEER_D\"}" > /dev/null
kill $PID_D 2>/dev/null
wait $PID_D 2>/dev/null

# ── Cleanup ──
echo ""
echo -e "${BOLD}11. Cleanup${NC}"

api "/unregister" "{\"id\":\"$PEER_A\"}" > /dev/null
api "/unregister" "{\"id\":\"$PEER_B\"}" > /dev/null
api "/unregister" "{\"id\":\"$PEER_C\"}" > /dev/null

PEERS_AFTER=$(api "/list-peers" '{"scope":"machine","cwd":".","git_root":null}')
assert_not_contains "peer A unregistered" "$PEERS_AFTER" "$PEER_A"
assert_not_contains "peer B unregistered" "$PEERS_AFTER" "$PEER_B"
assert_not_contains "peer C unregistered" "$PEERS_AFTER" "$PEER_C"

# ── Results ──
echo ""
echo "════════════════════════════════════════"
if [ $FAIL -eq 0 ]; then
  echo -e "${GREEN}${BOLD}ALL $TOTAL TESTS PASSED${NC}"
else
  echo -e "${RED}${BOLD}$FAIL/$TOTAL TESTS FAILED${NC} (${GREEN}$PASS passed${NC})"
fi
echo ""

exit $FAIL
