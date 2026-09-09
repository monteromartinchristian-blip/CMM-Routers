#!/usr/bin/env bash
# Qoder smoke test against the local CMM Subscription Router.
# Usage: CMM_ROUTER_TOKEN=<token> bash scripts/qoder-smoke.sh [base-url]
set -u

BASE="${1:-http://127.0.0.1:8790}"
TOKEN="${CMM_ROUTER_TOKEN:-}"

if [ -z "$TOKEN" ]; then
  echo "QODER_SMOKE=FAIL reason=missing-token"
  exit 1
fi

auth=(-H "Authorization: Bearer $TOKEN")

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

echo "== chat completions (non-streaming) =="
curl -sf "${auth[@]}" -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply exactly: QODER_SMOKE_OK\"}]}" \
  "$BASE/v1/chat/completions" | python3 -c "import json,sys; d=json.load(sys.stdin); print('CHAT_STATUS=PASS content='+d['choices'][0]['message']['content'][:60])" \
  || { echo "QODER_SMOKE=FAIL step=chat"; exit 1; }

echo "QODER_SMOKE=PASS"
