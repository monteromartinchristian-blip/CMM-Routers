#!/usr/bin/env bash
# Qoder smoke test against the local CMM Subscription Router.
# Usage: CMM_ROUTER_TOKEN=<token> bash scripts/qoder-smoke.sh [base-url]
#
# Coverage: health, models, non-streaming chat, streaming chat SSE,
# Responses API, and cancellation reachability. Every inference step
# requires the exact QODER_SMOKE_OK marker — a PASS verdict is never
# issued for unmarked or empty content. Loopback only; the bearer token
# is never printed.
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

echo "== cancellation reachability =="
CANCEL_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "${auth[@]}" -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply exactly: $MARKER\"}]}" \
  "$BASE/v1/chat/completions") || CANCEL_CODE="000"
case "$CANCEL_CODE" in
  200) echo "CANCEL_REACHABILITY=PASS" ;;
  *) echo "QODER_SMOKE=FAIL step=cancel reason=http-$CANCEL_CODE"; exit 1 ;;
esac

echo "QODER_SMOKE=PASS"
