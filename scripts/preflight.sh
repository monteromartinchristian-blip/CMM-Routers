#!/usr/bin/env bash
# CMM Subscription Router — safe provider authentication preflight.
# Prints only boolean/status lines. Never prints secret values.
# Fail-closed: exits non-zero when any unsafe spending state is detected.
set -u

UNSAFE=0

pass_fail() {
  if [ "$1" = "0" ]; then echo "PASS"; else echo "FAIL"; fi
}

echo "NODE=$([ -n "$(command -v node)" ] && echo PASS || echo FAIL)"

if command -v codex >/dev/null 2>&1; then
  echo "CODEX_BINARY=PASS"
  if codex login status 2>/dev/null | grep -qi "logged in"; then
    echo "CODEX_CHATGPT_AUTH=PASS"
  else
    echo "CODEX_CHATGPT_AUTH=AUTH_REQUIRED"
  fi
else
  echo "CODEX_BINARY=FAIL"
  echo "CODEX_CHATGPT_AUTH=UNAVAILABLE"
fi

if command -v claude >/dev/null 2>&1; then
  echo "CLAUDE_BINARY=PASS"
else
  echo "CLAUDE_BINARY=FAIL"
fi

ROUTER_PROFILE="${HOME}/Library/Application Support/CMM/SubscriptionRouter/Claude"
if [ -d "$ROUTER_PROFILE" ]; then
  echo "CLAUDE_ROUTER_PROFILE=PASS"
else
  echo "CLAUDE_ROUTER_PROFILE=MISSING"
fi

if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${ANTHROPIC_BASE_URL:-}" ] && [ -z "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
  echo "CLAUDE_PAYG_ENV=UNSET"
else
  echo "CLAUDE_PAYG_ENV=UNSAFE"
  UNSAFE=1
fi

if command -v agy >/dev/null 2>&1 || [ -x "${HOME}/.local/bin/agy" ]; then
  echo "AGY_BINARY=PASS"
else
  echo "AGY_BINARY=FAIL"
fi

if [ -z "${GEMINI_API_KEY:-}" ] && [ -z "${GOOGLE_API_KEY:-}" ] && [ -z "${GOOGLE_GEMINI_BASE_URL:-}" ]; then
  echo "GOOGLE_PAYG_ENV=UNSET"
else
  echo "GOOGLE_PAYG_ENV=UNSAFE"
  UNSAFE=1
fi

if [ -n "${COMMAND_CODE_SECRET:-}" ]; then
  echo "COMMAND_CODE_SECRET=SET"
else
  echo "COMMAND_CODE_SECRET=ABSENT"
fi

SETTINGS="${HOME}/.gemini/antigravity-cli/settings.json"
if [ -f "$SETTINGS" ]; then
  MODEL_PROVIDER=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('modelProvider','ABSENT'))" "$SETTINGS" 2>/dev/null || echo UNKNOWN)
  G1=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('useG1Credits','ABSENT'))" "$SETTINGS" 2>/dev/null || echo UNKNOWN)
  echo "MODEL_PROVIDER=${MODEL_PROVIDER}"
  echo "USE_G1_CREDITS=${G1}"
  if [ "$MODEL_PROVIDER" = "gemini" ] || [ "$G1" = "True" ] || [ "$G1" = "true" ]; then
    echo "ANTIGRAVITY_SETTINGS=UNSAFE"
    UNSAFE=1
  else
    echo "ANTIGRAVITY_SETTINGS=SAFE"
  fi
else
  echo "MODEL_PROVIDER=ABSENT"
  echo "USE_G1_CREDITS=ABSENT"
  echo "ANTIGRAVITY_SETTINGS=SAFE"
fi

if [ "$UNSAFE" != "0" ]; then
  echo "PREFLIGHT=FAIL"
  exit 1
fi
echo "PREFLIGHT=PASS"
