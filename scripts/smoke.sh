#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${SMOKE_PORT:-8791}"
MOCK_PORT="${SMOKE_MOCK_PORT:-9999}"
TMP="$(mktemp -d)"
JEV_PID=""
MOCK_PID=""

cleanup() {
  if [ -n "$JEV_PID" ]; then kill "$JEV_PID" 2>/dev/null || true; wait "$JEV_PID" 2>/dev/null || true; fi
  if [ -n "$MOCK_PID" ]; then kill "$MOCK_PID" 2>/dev/null || true; wait "$MOCK_PID" 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; exit 1; }

check_headers() {
  local file="$1" pattern="$2" label="$3"
  if grep -qi "$pattern" "$file"; then pass "$label"; else fail "$label"; fi
}

cd "$ROOT"

echo "building..."
vp pack >/dev/null
vp -C web build >/dev/null

cat > "$TMP/config.json" <<JSON
{
  "listen": { "host": "127.0.0.1", "port": $PORT },
  "defaultProvider": "mock",
  "providers": [
    {
      "name": "mock",
      "type": "openai",
      "baseUrl": "http://127.0.0.1:$MOCK_PORT/v1",
      "apiKey": "test",
      "models": ["claude-fable-5-1", "deepseek-v4.1-flash"]
    },
    {
      "name": "mock-anthropic",
      "type": "anthropic",
      "baseUrl": "http://127.0.0.1:$MOCK_PORT/v1",
      "apiKey": "test",
      "models": ["claude-fable-5-1"]
    },
    {
      "name": "mock-responses",
      "type": "responses",
      "baseUrl": "http://127.0.0.1:$MOCK_PORT/v1",
      "apiKey": "test",
      "billing": "subscription",
      "models": ["gpt-5.6-codex"]
    },
    {
      "name": "mock-both",
      "type": "both",
      "baseUrl": "http://127.0.0.1:$MOCK_PORT/v1",
      "apiKey": "test",
      "models": ["both-model", "claude-mock-1"]
    },
    {
      "name": "mock-gemini",
      "type": "gemini",
      "baseUrl": "http://127.0.0.1:$MOCK_PORT",
      "apiKey": "test",
      "billing": "subscription",
      "models": ["gemini-3-flash"]
    }
  ],
  "routing": {
    "mode": "auto",
    "tiers": {
      "plan": ["claude-fable-5-1"],
      "execute": ["deepseek-v4.1-flash"],
      "utility": ["deepseek-v4.1-flash"],
      "chat": ["deepseek-v4.1-flash"]
    },
    "sessionTtlMinutes": 720,
    "baselineModel": "claude-fable-5-1"
  }
}
JSON

export JEVONIAN_CONFIG="$TMP/config.json"
export JEVONIAN_LEDGER="$TMP/ledger.jsonl"
export JEVONIAN_DATA_DIR="$TMP/data"
export JEVONIAN_CREDENTIALS="$TMP/credentials.json"

node "$ROOT/scripts/mock-upstream.mjs" > "$TMP/mock.log" 2>&1 &
MOCK_PID=$!
node "$ROOT/dist/cli.mjs" serve > "$TMP/server.log" 2>&1 &
JEV_PID=$!
sleep 1

echo "no-brain guard..."
status="$(curl -s -o "$TMP/nobrain.json" -w '%{http_code}' "http://127.0.0.1:$PORT/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"design a cache layer"}]}')"
if [ "$status" = "400" ]; then pass "virtual routing refused without a brain"; else fail "virtual routing refused without a brain (got $status)"; fi
if grep -q "No Jev brain is configured" "$TMP/nobrain.json"; then pass "no-brain error explains the fix"; else fail "no-brain error explains the fix"; fi

curl -s -X POST "http://127.0.0.1:$PORT/api/brains" -H 'content-type: application/json' \
  -d '{"channel":"custom","baseUrl":"http://127.0.0.1:1/v1/systemone","model":"jev-latest","apiKey":"test"}' > /dev/null
curl -s -X POST "http://127.0.0.1:$PORT/api/brains" -H 'content-type: application/json' \
  -d '{"channel":"custom","baseUrl":"http://127.0.0.1:'"$MOCK_PORT"'/v1/systemone","model":"jev-latest","apiKey":"test"}' > /dev/null

echo "routing..."
curl -s -D "$TMP/h1" -o /dev/null "http://127.0.0.1:$PORT/v1/chat/completions" \
  -H 'content-type: application/json' -H 'x-session-id: smoke-1' \
  -d '{"model":"auto","messages":[{"role":"user","content":"design a cache layer"}]}'
check_headers "$TMP/h1" "x-jevonian-phase: plan" "new session routes to plan"
check_headers "$TMP/h1" "x-jevonian-model: claude-fable-5-1" "brain picks the frontier model to start"
check_headers "$TMP/h1" "x-jevonian-brain: jev" "brain is reported as the decider"

curl -s -D "$TMP/h2" -o /dev/null "http://127.0.0.1:$PORT/v1/chat/completions" \
  -H 'content-type: application/json' -H 'x-session-id: smoke-1' \
  -d '{"model":"auto","messages":[{"role":"user","content":"design a cache layer"},{"role":"assistant","content":"","tool_calls":[{"id":"1","type":"function","function":{"name":"edit","arguments":"{}"}}]},{"role":"tool","tool_call_id":"1","content":"wrote 3 lines"}]}'
check_headers "$TMP/h2" "x-jevonian-phase: execute" "first tool result switches to execute"
check_headers "$TMP/h2" "x-jevonian-model: deepseek-v4.1-flash" "brain drops to the cheap model"

curl -s -D "$TMP/h3" -o /dev/null "http://127.0.0.1:$PORT/v1/chat/completions" \
  -H 'content-type: application/json' -H 'x-session-id: smoke-1' \
  -d '{"model":"auto","messages":[{"role":"user","content":"design a cache layer"},{"role":"assistant","content":"","tool_calls":[{"id":"1","type":"function","function":{"name":"edit","arguments":"{}"}}]},{"role":"tool","tool_call_id":"1","content":"Error: tests failed"},{"role":"tool","tool_call_id":"2","content":"FAIL src/a.test.ts"}]}'
check_headers "$TMP/h3" "x-jevonian-reason: brain:plan" "brain reason names the chosen routing"
check_headers "$TMP/h3" "x-jevonian-model: claude-fable-5-1" "repeated failures bring the frontier model back"

echo "chat tier..."
curl -s -D "$TMP/h7" -o /dev/null "http://127.0.0.1:$PORT/v1/chat/completions" \
  -H 'content-type: application/json' -H 'x-session-id: smoke-chat' \
  -d '{"model":"jevonian/auto","messages":[{"role":"user","content":"hi"}]}'
check_headers "$TMP/h7" "x-jevonian-brain: jev" "greeting still consults the brain"
check_headers "$TMP/h7" "x-jevonian-model: claude-fable-5-1" "brain answers with a listed candidate"

curl -s -D "$TMP/h8" -o /dev/null "http://127.0.0.1:$PORT/v1/chat/completions" \
  -H 'content-type: application/json' -H 'x-session-id: smoke-cursor' \
  -d '{"model":"jevonian/auto","messages":[{"role":"user","content":"<user_info>\nOS Version: darwin\nWorkspace: /tmp\n</user_info>"},{"role":"assistant","content":"ok"},{"role":"user","content":"<user_query>hi</user_query>"}]}'
check_headers "$TMP/h8" "x-jevonian-model: claude-fable-5-1" "cursor-wrapped request still routes"

echo "streaming..."
stream="$(curl -sN "http://127.0.0.1:$PORT/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d '{"model":"jevonian/auto","stream":true,"messages":[{"role":"user","content":"hi"}]}')"
if printf '%s' "$stream" | grep -q "\[DONE\]"; then pass "streaming passthrough"; else fail "streaming passthrough"; fi

echo "anthropic..."
curl -s -D "$TMP/h4" -o /dev/null "http://127.0.0.1:$PORT/v1/messages" \
  -H 'content-type: application/json' -H 'x-session-id: smoke-2' \
  -d '{"model":"auto","messages":[{"role":"user","content":"discuss architecture"}]}'
check_headers "$TMP/h4" "x-jevonian-phase: plan" "anthropic endpoint routes"

echo "dual wire..."
curl -s -o "$TMP/r8" "http://127.0.0.1:$PORT/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d '{"model":"both-model","messages":[{"role":"user","content":"hi"}]}'
if grep -q '"content":"hello"' "$TMP/r8"; then pass "both provider serves chat/completions"; else fail "both provider serves chat/completions"; fi

curl -s -o "$TMP/r9" "http://127.0.0.1:$PORT/v1/messages" \
  -H 'content-type: application/json' \
  -d '{"model":"both-model","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'
if grep -q '"type":"message"' "$TMP/r9"; then pass "both provider serves messages"; else fail "both provider serves messages"; fi

echo "anthropic bridge..."
curl -s -o "$TMP/r11" "http://127.0.0.1:$PORT/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d '{"model":"claude-mock-1","messages":[{"role":"user","content":"hi"}]}'
if grep -q '"object":"chat.completion"' "$TMP/r11"; then pass "claude model served over the anthropic wire"; else fail "claude model served over the anthropic wire"; fi
if grep -q '"prompt_tokens":900' "$TMP/r11"; then pass "anthropic usage mapped to chat usage"; else fail "anthropic usage mapped to chat usage"; fi
if grep -q '"content":"hello"' "$TMP/r11"; then pass "anthropic content mapped to chat content"; else fail "anthropic content mapped to chat content"; fi

echo "gemini wire..."
curl -s -o "$TMP/r10" "http://127.0.0.1:$PORT/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d '{"model":"gemini-3-flash","messages":[{"role":"user","content":"hi"}]}'
if grep -q '"hello from gemini"' "$TMP/r10"; then pass "gemini provider serves chat/completions"; else fail "gemini provider serves chat/completions"; fi
if grep -q '"object":"chat.completion"' "$TMP/r10"; then pass "gemini response uses the chat shape"; else fail "gemini response uses the chat shape"; fi

gemini_stream="$(curl -sN "http://127.0.0.1:$PORT/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d '{"model":"gemini-3-flash","stream":true,"messages":[{"role":"user","content":"hi"}]}')"
if printf '%s' "$gemini_stream" | grep -q "hello "; then pass "gemini streaming deltas"; else fail "gemini streaming deltas"; fi
if printf '%s' "$gemini_stream" | grep -q "\[DONE\]"; then pass "gemini streaming terminator"; else fail "gemini streaming terminator"; fi

echo "responses passthrough..."
curl -s -D "$TMP/h6" -o "$TMP/r6" "http://127.0.0.1:$PORT/v1/responses" \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-5.6-codex","input":"hi","stream":true}'
check_headers "$TMP/h6" "x-jevonian-model: gpt-5.6-codex" "responses pinned model"
if grep -q "response.completed" "$TMP/r6"; then pass "responses stream passed through"; else fail "responses stream passed through"; fi

echo "responses translation..."
curl -s -o "$TMP/r7" "http://127.0.0.1:$PORT/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-5.6-codex","messages":[{"role":"user","content":"hi"}]}'
if grep -q "hello from responses" "$TMP/r7"; then pass "chat completions translated to responses"; else fail "chat completions translated to responses"; fi
if grep -q '"object":"chat.completion"' "$TMP/r7"; then pass "translated response uses the chat shape"; else fail "translated response uses the chat shape"; fi

echo "ledger..."
sleep 0.3
records="$(wc -l < "$TMP/ledger.jsonl" | tr -d ' ')"
if [ "$records" -ge 7 ]; then pass "ledger captured $records requests"; else fail "ledger captured only $records requests"; fi
if grep -q '"brain":"' "$TMP/ledger.jsonl"; then pass "brain decider recorded"; else fail "brain decider recorded"; fi
if grep -q '"costUsd":' "$TMP/ledger.jsonl"; then pass "cost recorded"; else fail "cost recorded"; fi
if grep -q '"billing":"subscription"' "$TMP/ledger.jsonl"; then pass "subscription billing recorded"; else fail "subscription billing recorded"; fi

echo "quota..."
if curl -s "http://127.0.0.1:$PORT/api/quota" | grep -q '"quotas"'; then pass "quota api"; else fail "quota api"; fi

echo "web ui..."
if curl -s "http://127.0.0.1:$PORT/" | grep -q 'id="root"'; then pass "web ui served"; else fail "web ui served"; fi
if curl -s "http://127.0.0.1:$PORT/api/state" | grep -q '"providers"'; then pass "admin api"; else fail "admin api"; fi
if curl -s "http://127.0.0.1:$PORT/api/state" | grep -q '"brains"'; then pass "state exposes brains"; else fail "state exposes brains"; fi

echo "api keys..."
key_json="$(curl -s -X POST "http://127.0.0.1:$PORT/api/keys" -H 'content-type: application/json' -d '{"name":"smoke"}')"
key="$(printf '%s' "$key_json" | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')"
if [ -n "$key" ]; then pass "key created"; else fail "key created"; fi

status="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/v1/chat/completions" -H 'content-type: application/json' -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}')"
if [ "$status" = "401" ]; then pass "unauthenticated request rejected"; else fail "unauthenticated request rejected (got $status)"; fi

status="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/v1/chat/completions" -H "authorization: Bearer $key" -H 'content-type: application/json' -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}')"
if [ "$status" = "200" ]; then pass "authenticated request accepted"; else fail "authenticated request accepted (got $status)"; fi

if curl -s "http://127.0.0.1:$PORT/api/logs" | grep -q '"logs"'; then pass "logs api"; else fail "logs api"; fi

echo "logs pagination & stream..."
page1="$(curl -s "http://127.0.0.1:$PORT/api/logs?limit=3")"
if printf '%s' "$page1" | grep -q '"nextBefore"'; then pass "logs page returns a cursor"; else fail "logs page returns a cursor"; fi
if printf '%s' "$page1" | grep -q '"total"'; then pass "logs page reports a total"; else fail "logs page reports a total"; fi
cursor="$(printf '%s' "$page1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.nextBefore===null?'':j.nextBefore)})")"
if [ -n "$cursor" ]; then
  page2="$(curl -s "http://127.0.0.1:$PORT/api/logs?limit=3&before=$cursor")"
  first_id="$(printf '%s' "$page1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.logs.at(-1).id)})")"
  if printf '%s' "$page2" | grep -q "$first_id"; then fail "pagination pages must not overlap"; else pass "pagination cursor is exclusive"; fi
else
  fail "expected more than one page of logs"
fi
if curl -s "http://127.0.0.1:$PORT/api/logs?phase=execute" | grep -q '"logs"'; then pass "logs filter still works"; else fail "logs filter still works"; fi
if curl -s "http://127.0.0.1:$PORT/api/logs/series?minutes=60&buckets=12" | grep -q '"buckets"'; then pass "log chart series"; else fail "log chart series"; fi
if curl -s "http://127.0.0.1:$PORT/api/logs/series?minutes=60&buckets=12" | grep -q '"avgLatencyMs"'; then pass "chart series carries latency"; else fail "chart series carries latency"; fi

# The live stream must deliver a record appended after the connection opens.
# Use the same authenticated `auto` path that already passed above — a pinned
# model is a different code path and not what this assertion is testing.
stream_out="$TMP/logstream.txt"
# Write straight to the file (not through a shell redirect) so curl's -N
# unbuffered mode is the only buffer between the socket and the disk.
curl -sN --max-time 5 -o "$stream_out" "http://127.0.0.1:$PORT/api/logs/stream" &
STREAM_PID=$!
sleep 0.6
probe_status="$(curl -s -o "$TMP/stream-probe.json" -w '%{http_code}' "http://127.0.0.1:$PORT/v1/chat/completions" \
  -H "authorization: Bearer $key" -H 'content-type: application/json' -H 'x-session-id: smoke-stream' \
  -d '{"model":"auto","messages":[{"role":"user","content":"stream probe"}]}')"
if [ "$probe_status" != "200" ]; then fail "stream probe request accepted (got $probe_status)"; fi
# Wait for the ledger append to wake the stream and flush through curl.
sleep 1.2
kill "$STREAM_PID" 2>/dev/null || true
wait "$STREAM_PID" 2>/dev/null || true
if grep -q "event: ready" "$stream_out"; then pass "log stream opens"; else fail "log stream opens"; fi
if grep -q "event: log" "$stream_out"; then pass "log stream pushes new records"; else fail "log stream pushes new records"; fi
# The streamed payload is the ledger record — assert against a field that is
# actually on the record, not the prompt body (which lives in bodies/, not here).
if grep -q '"session":"smoke-stream"' "$stream_out"; then pass "streamed record matches the live request"; else fail "streamed record matches the live request"; fi

echo "jev brain..."
if curl -s -X POST "http://127.0.0.1:$PORT/api/brain/test" -H 'content-type: application/json' \
  -d '{"channel":"custom","baseUrl":"http://127.0.0.1:'"$MOCK_PORT"'/v1/systemone","model":"jev-latest","apiKey":"test"}' | grep -q '"ok":true'; then pass "brain test"; else fail "brain test"; fi
curl -s -X PUT "http://127.0.0.1:$PORT/api/routing" -H 'content-type: application/json' \
  -d '{"mode":"auto","tiers":{"plan":["claude-fable-5-1"],"execute":["deepseek-v4.1-flash"],"utility":["deepseek-v4.1-flash"]}}' > /dev/null
if grep -q '"channel": *"custom"' "$JEVONIAN_CONFIG"; then pass "routing save keeps the brain"; else fail "routing save keeps the brain"; fi
curl -s -D "$TMP/h5" -o /dev/null "http://127.0.0.1:$PORT/v1/chat/completions" \
  -H "authorization: Bearer $key" -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"jev check"}]}'
check_headers "$TMP/h5" "x-jevonian-brain: jev" "brain fallback consulted"
check_headers "$TMP/h5" "x-jevonian-brain-channel: custom" "brain channel reported"
check_headers "$TMP/h5" "x-jevonian-model: claude-fable-5-1" "brain chose a listed candidate"
if grep -q '"status":502' "$TMP/ledger.jsonl"; then pass "failed brain call recorded"; else fail "failed brain call recorded"; fi
sleep 0.3
if grep -q '"kind":"brain"' "$TMP/ledger.jsonl"; then pass "brain usage recorded"; else fail "brain usage recorded"; fi

echo "log detail..."
log_id="$(curl -s "http://127.0.0.1:$PORT/api/logs?limit=10" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const logs=JSON.parse(d).logs;const hit=logs.find((l)=>l.kind!=='brain'&&l.id);console.log(hit?hit.id:'')})")"
if [ -n "$log_id" ]; then pass "log records carry ids"; else fail "log records carry ids"; fi
detail="$(curl -s "http://127.0.0.1:$PORT/api/logs/$log_id")"
if printf '%s' "$detail" | grep -q '"brainCalls"'; then pass "log detail includes brain calls"; else fail "log detail includes brain calls"; fi
if printf '%s' "$detail" | grep -q 'jev check'; then pass "log detail includes the prompt"; else fail "log detail includes the prompt"; fi
if printf '%s' "$detail" | grep -q '"verdict"'; then pass "brain detail includes the verdict"; else fail "brain detail includes the verdict"; fi

echo "report..."
if node "$ROOT/dist/cli.mjs" report | grep -q "savings"; then pass "report computes savings"; else fail "report computes savings"; fi
if node "$ROOT/dist/cli.mjs" doctor | grep -q "plan:"; then pass "doctor shows tiers"; else fail "doctor shows tiers"; fi

echo ""
echo "all checks passed"
