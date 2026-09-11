#!/usr/bin/env bash
# Qoder smoke test against the local CMM Routers.
# Usage: CMM_ROUTER_TOKEN=<token> bash scripts/qoder-smoke.sh [base-url]
#
# Coverage: health, models, non-streaming chat, streaming chat SSE,
# Responses API, and REAL cancellation. Every inference step requires the
# exact QODER_SMOKE_OK marker — a PASS verdict is never issued for unmarked
# or empty content. Loopback only; the bearer token is never printed.
#
# Cancellation is proven, not assumed: a streaming request is opened, the
# first SSE data frame is awaited, the client socket is destroyed, and the
# router must record the kill in /v1/cmm/usage (cancelledEvents increments
# and activeRequests drains to zero). A merely-fast 200 is NOT accepted.
set -u

BASE="${1:-http://127.0.0.1:8790}"
TOKEN="${CMM_ROUTER_TOKEN:-}"

if [ -z "$TOKEN" ]; then
  echo "QODER_SMOKE=BLOCKED reason=missing-token"
  echo "REQUIRED_ENV=CMM_ROUTER_TOKEN"
  echo "HINT=export CMM_ROUTER_TOKEN='<router-bearer>' (value never printed)"
  exit 0
fi

auth=(-H "Authorization: Bearer $TOKEN")
MARKER="QODER_SMOKE_OK"

echo "== /health =="
curl -sf "$BASE/health" || { echo "QODER_SMOKE=FAIL step=health"; exit 1; }
echo

echo "== /v1/models =="
MODELS_JSON=$(curl -sf "${auth[@]}" "$BASE/v1/models") || { echo "QODER_SMOKE=FAIL step=models"; exit 1; }
echo "$MODELS_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print('MODELS_COUNT='+str(len(d.get('data',[]))))"

MODEL=$(echo "$MODELS_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); ms=[m['id'] for m in d.get('data',[]) if '/' in m.get('id','')]; print(ms[0] if ms else '')")

if [ -z "$MODEL" ]; then
  echo "QODER_SMOKE=BLOCKED_EXTERNAL_PRECONDITION reason=no-models"
  exit 0
fi

echo "SMOKE_MODEL=$MODEL"

require_marker() {
  local step="$1"
  local content="$2"
  case "$content" in
    *"$MARKER"*) echo "${step}_STATUS=PASS" ;;
    *) echo "QODER_SMOKE=FAIL step=${step} reason=marker-missing"; exit 1 ;;
  esac
}

echo "== chat completions (non-streaming) =="
CHAT_CONTENT=$(curl -sf "${auth[@]}" -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply exactly: $MARKER\"}]}" \
  "$BASE/v1/chat/completions" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['choices'][0]['message']['content'])") \
  || { echo "QODER_SMOKE=FAIL step=chat"; exit 1; }
require_marker "CHAT" "$CHAT_CONTENT"

echo "== chat completions (streaming SSE) =="
STREAM_BODY=$(curl -sfN "${auth[@]}" -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply exactly: $MARKER\"}],\"stream\":true}" \
  "$BASE/v1/chat/completions") \
  || { echo "QODER_SMOKE=FAIL step=stream"; exit 1; }
echo "$STREAM_BODY" | grep -q "data: \[DONE\]" || { echo "QODER_SMOKE=FAIL step=stream reason=missing-done"; exit 1; }
require_marker "STREAM" "$STREAM_BODY"

echo "== responses API =="
RESP_CONTENT=$(curl -sf "${auth[@]}" -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"input\":\"Reply exactly: $MARKER\"}" \
  "$BASE/v1/responses" | python3 -c "import json,sys; d=json.load(sys.stdin); outs=d.get('output',[]); texts=[]; [texts.extend([c.get('text','') for c in o.get('content',[])]) for o in outs if o.get('type')=='message']; print(''.join(texts))") \
  || { echo "QODER_SMOKE=FAIL step=responses"; exit 1; }
require_marker "RESPONSES" "$RESP_CONTENT"

echo "== real cancellation (abort mid-stream, observe router books) =="
USAGE_BEFORE=$(curl -sf "${auth[@]}" "$BASE/v1/cmm/usage") || { echo "QODER_SMOKE=FAIL step=cancel reason=usage-unavailable"; exit 1; }
CANCELLED_BEFORE=$(echo "$USAGE_BEFORE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('cancelledEvents',0))")
SUCCESS_BEFORE=$(echo "$USAGE_BEFORE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('successCount',0))")
# Open a streaming request in the background to a temp file, wait for the
# first SSE data frame, then SIGKILL the client. All waits are bounded;
# no FIFOs, no blocking reads.
TMPFILE=$(mktemp)
curl -sN "${auth[@]}" -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply exactly: $MARKER\"}],\"stream\":true}" \
  "$BASE/v1/chat/completions" > "$TMPFILE" 2>/dev/null &
CURL_PID=$!
GOT_FRAME=0
END=$((SECONDS + 20))
while [ $SECONDS -lt $END ]; do
  if grep -q "^data:" "$TMPFILE" 2>/dev/null; then
    GOT_FRAME=1
    break
  fi
  sleep 0.2
done
kill -9 "$CURL_PID" 2>/dev/null || true
wait "$CURL_PID" 2>/dev/null || true
rm -f "$TMPFILE"
if [ "$GOT_FRAME" != "1" ]; then
  echo "QODER_SMOKE=BLOCKED_EXTERNAL_PRECONDITION reason=no-stream-frame model=$MODEL"
  exit 0
fi
# Poll the router books: the killed request must surface as cancelled and
# no request may remain active. A request that finished before the kill is
# reported as BLOCKED (too fast to cancel), never as PASS.
END=$((SECONDS + 15))
CANCEL_OK=0
FINISHED_FIRST=0
while [ $SECONDS -lt $END ]; do
  USAGE_AFTER=$(curl -sf "${auth[@]}" "$BASE/v1/cmm/usage" 2>/dev/null || echo "")
  [ -z "$USAGE_AFTER" ] && sleep 1 && continue
  CANCELLED_AFTER=$(echo "$USAGE_AFTER" | python3 -c "import json,sys; print(json.load(sys.stdin).get('cancelledEvents',0))")
  ACTIVE_AFTER=$(echo "$USAGE_AFTER" | python3 -c "import json,sys; print(json.load(sys.stdin).get('activeRequests',0))")
  SUCCESS_AFTER=$(echo "$USAGE_AFTER" | python3 -c "import json,sys; print(json.load(sys.stdin).get('successCount',0))")
  if [ "$CANCELLED_AFTER" -gt "$CANCELLED_BEFORE" ] && [ "$ACTIVE_AFTER" = "0" ]; then
    CANCEL_OK=1
    break
  fi
  if [ "$SUCCESS_AFTER" -gt "$SUCCESS_BEFORE" ]; then
    FINISHED_FIRST=1
  fi
  sleep 1
done
if [ "$CANCEL_OK" = "1" ]; then
  echo "QODER_SMOKE_CANCELLATION=PASS cancelledDelta=$((CANCELLED_AFTER - CANCELLED_BEFORE))"
elif [ "$FINISHED_FIRST" = "1" ]; then
  echo "QODER_SMOKE=BLOCKED_EXTERNAL_PRECONDITION reason=request-finished-before-cancel model=$MODEL"
  exit 0
else
  echo "QODER_SMOKE=FAIL step=cancel reason=router-books-unchanged cancelledBefore=$CANCELLED_BEFORE"
  exit 1
fi

echo "QODER_SMOKE=PASS"
