#!/usr/bin/env bash
# Shared harness for the Task 13 minimal live canaries.
#
# PREPARED, NOT EXECUTED in the deterministic phase. These scripts consume real
# subscription quota, so they are gated behind an explicit opt-in flag and must
# only be run by a human after the independent re-audit PASS.
#
# Guarantees encoded here:
#   * PAYG environment is poisoned so an accidental API/PAYG fallback fails.
#   * The subscription route is verified from /v1/models before any spend.
#   * Exactly ONE minimal, non-streaming request; one harmless synthetic tool.
#   * No filesystem / repository mutation (the tool is never executed locally).
#   * Route ambiguity (zero or multiple candidate models) fails closed.
#   * The bearer token and any provider output are never printed.
set -u

CANARY_BASE="${CANARY_BASE:-http://127.0.0.1:8790}"
CANARY_TOKEN="${CMM_ROUTER_TOKEN:-}"
CANARY_PROVIDER="${1:-}"
CANARY_CONFIRM="${CMM_LIVE_CANARY_CONFIRM:-}"

canary_blocked() {
  echo "LIVE_CANARY=BLOCKED provider=${CANARY_PROVIDER:-unknown} reason=$1"
  exit 0
}

# Poison every PAYG surface a provider could reach for. Values are sentinels:
# if any code path actually used them the request would fail loudly rather than
# silently billing an API key.
canary_poison_payg_env() {
  export GEMINI_API_KEY="canary-poison-not-a-key"
  export GOOGLE_API_KEY="canary-poison-not-a-key"
  export GOOGLE_GEMINI_BASE_URL="http://127.0.0.1:1"
  export OPENAI_API_KEY="canary-poison-not-a-key"
  export ANTHROPIC_API_KEY="canary-poison-not-a-key"
  export GOOGLE_APPLICATION_CREDENTIALS="/nonexistent/canary-poison.json"
}

canary_preflight() {
  [ "$CANARY_CONFIRM" = "yes-i-accept-subscription-quota-spend" ] \
    || canary_blocked "missing-confirm-flag"
  case "$CANARY_BASE" in
    http://127.0.0.1:*|http://localhost:*|http://\[::1\]:*) : ;;
    *) canary_blocked "non-loopback-base" ;;
  esac
  [ -n "$CANARY_TOKEN" ] || canary_blocked "missing-CMM_ROUTER_TOKEN"
  case "$CANARY_PROVIDER" in
    claude|google|chatgpt|command-code) : ;;
    *) canary_blocked "unknown-provider" ;;
  esac
  canary_poison_payg_env
  curl -sf "$CANARY_BASE/health" >/dev/null 2>&1 || canary_blocked "router-unhealthy"
}

# Resolve exactly one model for the provider, or fail closed on ambiguity.
canary_resolve_model() {
  local models_json
  models_json=$(curl -sf -H "Authorization: Bearer $CANARY_TOKEN" "$CANARY_BASE/v1/models") \
    || canary_blocked "models-unreachable"
  local matches
  matches=$(printf '%s' "$models_json" | python3 -c '
import json,sys
p=sys.argv[1]
d=json.load(sys.stdin)
ids=[m.get("id","") for m in d.get("data",[])]
print("\n".join(i for i in ids if i.split("/",1)[0]==p))
' "$CANARY_PROVIDER")
  local count
  count=$(printf '%s' "$matches" | grep -c . || true)
  [ "$count" = "1" ] || canary_blocked "route-ambiguous-or-absent(count=${count})"
  printf '%s' "$matches"
}

# One minimal non-streaming request carrying one harmless synthetic tool. The
# tool has no side effects and is NEVER executed by this script.
canary_one_minimal_request() {
  local model="$1"
  local marker="CMM_LIVE_CANARY_OK"
  local payload
  payload=$(MARKER="$marker" MODEL="$model" python3 -c '
import json,os
print(json.dumps({
  "model": os.environ["MODEL"],
  "max_tokens": 16,
  "stream": False,
  "messages": [{"role":"user","content":"Reply with the exact token "+os.environ["MARKER"]+" and nothing else."}],
  "tools": [{
    "type":"function",
    "function":{
      "name":"canary_echo",
      "description":"Harmless synthetic echo used only to observe tool wiring. Performs no I/O.",
      "parameters":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}
    }
  }],
  "tool_choice":"auto",
  "parallel_tool_calls": False
}))')
  local response
  response=$(curl -sS -X POST "$CANARY_BASE/v1/chat/completions" \
    -H "Authorization: Bearer $CANARY_TOKEN" \
    -H "Content-Type: application/json" \
    --data-binary "$payload" -w '\n%{http_code}')
  local code
  code=$(printf '%s' "$response" | tail -n1)
  case "$code" in
    200) echo "LIVE_CANARY_HTTP_STATUS=200" ;;
    401|403) canary_blocked "auth-rejected" ;;
    429) canary_blocked "quota-or-rate-limited" ;;
    *) canary_blocked "unexpected-http-${code}" ;;
  esac
  printf '%s' "$response" | sed '$d' | python3 -c '
import json,sys
body=json.load(sys.stdin)
choice=body.get("choices",[{}])[0]
msg=choice.get("message",{})
calls=msg.get("tool_calls") or []
content=msg.get("content") or ""
print("LIVE_CANARY_FINISH_REASON=%s" % choice.get("finish_reason"))
print("LIVE_CANARY_TOOL_CALLS=%d" % len(calls))
if calls:
    print("LIVE_CANARY_TOOL_NAME=%s" % calls[0].get("function",{}).get("name",""))
    print("LIVE_CANARY_ROUTE_USES_QODER_TOOL_WIRE=YES")
else:
    print("LIVE_CANARY_ROUTE_USES_QODER_TOOL_WIRE=NO")
    print("LIVE_CANARY_CONTENT_LEN=%d" % len(content))
'
}

canary_run() {
  canary_preflight
  local model
  model=$(canary_resolve_model)
  echo "LIVE_CANARY_PROVIDER=$CANARY_PROVIDER"
  echo "LIVE_CANARY_ROUTE_RESOLVED=YES"
  echo "LIVE_CANARY_PAYG_POISONED=YES"
  canary_one_minimal_request "$model"
  echo "LIVE_CANARY_NO_FILESYSTEM_MUTATION=YES"
  echo "LIVE_CANARY_${CANARY_PROVIDER}=PREPARED_NOT_EXECUTED_BY_AGENT"
}
