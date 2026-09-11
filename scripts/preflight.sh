#!/usr/bin/env bash
# CMM Routers — safe provider authentication preflight.
# Prints only boolean/status lines. Never prints secret values.
#
# Provider-aware fail-closed semantics:
# - UNSAFE spending state (any PAYG var, unsafe Antigravity settings) -> rc 1
# - ENABLED provider missing binary/auth -> rc 1
# - DISABLED provider missing binary/auth -> SKIPPED_DISABLED, rc 0
# - READY / SKIPPED_DISABLED only -> rc 0 / PREFLIGHT=PASS
#
# Inputs (all optional):
#   CMM_CONFIG_DIR              shared-config dir (default: ./config)
#   CMM_PREFLIGHT_STRICT_BINARIES=1  require enabled-provider binaries even
#                                   when PATH probes are restricted in tests
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_DIR="${CMM_CONFIG_DIR:-$REPO_DIR/config}"
SHARED_JSON="${CONFIG_DIR}/shared.json"
VALIDATOR="$REPO_DIR/scripts/validate-config.mjs"

UNSAFE=0
BLOCKING=0
CONFIG_INVALID=0

# Config validation is delegated to the single authoritative Node entrypoint,
# which imports the SAME Zod schema production loadConfig() uses. No schema
# constraints are re-implemented here. Exit codes: 0 valid, 1 invalid,
# 2 unavailable (fail closed), 3 missing (documented bootstrap defaults).
CONFIG_STATUS=2
VALIDATOR_OUT=""
if command -v node >/dev/null 2>&1; then
  if VALIDATOR_OUT="$(CMM_CONFIG_DIR="$CONFIG_DIR" node "$VALIDATOR" 2>/dev/null)"; then
    CONFIG_STATUS=0
  else
    CONFIG_STATUS=$?
  fi
fi

config_field() {
  printf '%s\n' "$VALIDATOR_OUT" | sed -n "s/^$1=//p" | head -n 1
}

# Effective options default to the documented bootstrap values and are
# overwritten from validated config when one is present.
CHATGPT_ENABLED=1
CLAUDE_ENABLED=1
GOOGLE_ENABLED=1
COMMAND_CODE_ENABLED=0
CLAUDE_PROFILE_DIR=""
AGY_PATH_CONFIG=""
COMMAND_CODE_SECRET_ENV="COMMAND_CODE_SECRET"

case "$CONFIG_STATUS" in
  0)
    echo "CONFIG=VALID"
    CHATGPT_ENABLED="$(config_field CHATGPT_ENABLED)"; CHATGPT_ENABLED="${CHATGPT_ENABLED:-1}"
    CLAUDE_ENABLED="$(config_field CLAUDE_ENABLED)"; CLAUDE_ENABLED="${CLAUDE_ENABLED:-1}"
    GOOGLE_ENABLED="$(config_field GOOGLE_ENABLED)"; GOOGLE_ENABLED="${GOOGLE_ENABLED:-1}"
    COMMAND_CODE_ENABLED="$(config_field COMMAND_CODE_ENABLED)"; COMMAND_CODE_ENABLED="${COMMAND_CODE_ENABLED:-0}"
    CLAUDE_PROFILE_DIR="$(config_field CLAUDE_PROFILE_DIR)"
    AGY_PATH_CONFIG="$(config_field AGY_PATH)"
    COMMAND_CODE_SECRET_ENV="$(config_field COMMAND_CODE_SECRET_ENV)"
    [ -z "$COMMAND_CODE_SECRET_ENV" ] && COMMAND_CODE_SECRET_ENV="COMMAND_CODE_SECRET"
    ;;
  3)
    # No shared.json: documented bootstrap defaults apply (unchanged behavior).
    echo "CONFIG=MISSING"
    ;;
  1)
    echo "CONFIG=INVALID"
    CONFIG_ERROR_DETAIL="$(config_field CONFIG_ERROR)"
    [ -n "$CONFIG_ERROR_DETAIL" ] && echo "CONFIG_ERROR=$CONFIG_ERROR_DETAIL"
    CONFIG_INVALID=1
    ;;
  *)
    echo "CONFIG=UNAVAILABLE"
    CONFIG_ERROR_DETAIL="$(config_field CONFIG_ERROR)"
    [ -n "$CONFIG_ERROR_DETAIL" ] && echo "CONFIG_ERROR=$CONFIG_ERROR_DETAIL"
    CONFIG_INVALID=1
    ;;
esac

enabled_label() {
  if [ "$1" = "1" ]; then echo "ENABLED"; else echo "DISABLED"; fi
}

NODE_BIN=0
if command -v node >/dev/null 2>&1; then
  echo "NODE=PASS"
else
  echo "NODE=FAIL"
  NODE_BIN=1
fi

# --- chatgpt / codex ---
echo "CHATGPT_PROVIDER=$(enabled_label "$CHATGPT_ENABLED")"
if [ "$CHATGPT_ENABLED" = "1" ]; then
  if command -v codex >/dev/null 2>&1; then
    echo "CODEX_BINARY=PASS"
    if codex login status 2>&1 | grep -qi "logged in"; then
      echo "CODEX_CHATGPT_AUTH=READY"
    else
      echo "CODEX_CHATGPT_AUTH=AUTH_REQUIRED"
      BLOCKING=1
    fi
  else
    echo "CODEX_BINARY=UNAVAILABLE"
    echo "CODEX_CHATGPT_AUTH=UNAVAILABLE"
    BLOCKING=1
  fi
else
  echo "CODEX_BINARY=SKIPPED_DISABLED"
  echo "CODEX_CHATGPT_AUTH=SKIPPED_DISABLED"
fi

# --- claude ---
echo "CLAUDE_PROVIDER=$(enabled_label "$CLAUDE_ENABLED")"
if command -v claude >/dev/null 2>&1; then
  echo "CLAUDE_BINARY=PASS"
else
  echo "CLAUDE_BINARY=FAIL"
  if [ "$CLAUDE_ENABLED" = "1" ]; then
    echo "CLAUDE_BINARY_STATE=UNAVAILABLE"
    BLOCKING=1
  else
    echo "CLAUDE_BINARY_STATE=SKIPPED_DISABLED"
  fi
fi

DEFAULT_ROUTER_PROFILE="${HOME}/Library/Application Support/CMM/SubscriptionRouter/Claude"
if [ -n "$CLAUDE_PROFILE_DIR" ]; then
  ROUTER_PROFILE="$CLAUDE_PROFILE_DIR"
else
  ROUTER_PROFILE="$DEFAULT_ROUTER_PROFILE"
fi
echo "CLAUDE_PROFILE_DIR_CONFIG=${CLAUDE_PROFILE_DIR:-DEFAULT}"
if [ -d "$ROUTER_PROFILE" ]; then
  echo "CLAUDE_ROUTER_PROFILE=PASS"
else
  echo "CLAUDE_ROUTER_PROFILE=MISSING"
  if [ "$CLAUDE_ENABLED" = "1" ]; then
    BLOCKING=1
  fi
fi

if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${ANTHROPIC_BASE_URL:-}" ] && [ -z "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
  echo "CLAUDE_PAYG_ENV=UNSET"
else
  echo "CLAUDE_PAYG_ENV=UNSAFE"
  UNSAFE=1
fi

# --- google / agy ---
echo "GOOGLE_PROVIDER=$(enabled_label "$GOOGLE_ENABLED")"
echo "AGY_PATH_CONFIG=${AGY_PATH_CONFIG:-DEFAULT}"
AGY_FOUND=0
if [ -n "$AGY_PATH_CONFIG" ]; then
  # Configured path is authoritative: production spawns exactly this binary.
  if [ -x "$AGY_PATH_CONFIG" ]; then
    AGY_FOUND=1
  else
    AGY_FOUND=0
  fi
elif command -v agy >/dev/null 2>&1 || [ -x "${HOME}/.local/bin/agy" ]; then
  AGY_FOUND=1
fi
if [ "$AGY_FOUND" = "1" ]; then
  echo "AGY_BINARY=PASS"
else
  echo "AGY_BINARY=FAIL"
  if [ "$GOOGLE_ENABLED" = "1" ]; then
    echo "AGY_BINARY_STATE=UNAVAILABLE"
    BLOCKING=1
  else
    echo "AGY_BINARY_STATE=SKIPPED_DISABLED"
  fi
fi

if [ -z "${GEMINI_API_KEY:-}" ] && [ -z "${GOOGLE_API_KEY:-}" ] && [ -z "${GOOGLE_GEMINI_BASE_URL:-}" ]; then
  echo "GOOGLE_PAYG_ENV=UNSET"
else
  echo "GOOGLE_PAYG_ENV=UNSAFE"
  UNSAFE=1
fi

# --- OpenAI PAYG (no provider may consume it; always unsafe when set) ---
if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "OPENAI_PAYG_ENV=UNSET"
else
  echo "OPENAI_PAYG_ENV=UNSAFE"
  UNSAFE=1
fi

# --- command-code ---
echo "COMMAND_CODE_PROVIDER=$(enabled_label "$COMMAND_CODE_ENABLED")"
echo "COMMAND_CODE_SECRET_ENV=$COMMAND_CODE_SECRET_ENV"
if [ -n "${!COMMAND_CODE_SECRET_ENV:-}" ]; then
  echo "COMMAND_CODE_SECRET=SET"
else
  echo "COMMAND_CODE_SECRET=ABSENT"
  if [ "$COMMAND_CODE_ENABLED" = "1" ]; then
    echo "COMMAND_CODE_STATE=AUTH_REQUIRED"
    BLOCKING=1
  else
    echo "COMMAND_CODE_STATE=SKIPPED_DISABLED"
  fi
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

if [ "$CONFIG_INVALID" != "0" ]; then
  echo "PREFLIGHT=FAIL"
  exit 1
fi
if [ "$UNSAFE" != "0" ]; then
  echo "PREFLIGHT=FAIL"
  exit 1
fi
if [ "$BLOCKING" != "0" ]; then
  echo "PREFLIGHT=FAIL"
  exit 1
fi
if [ "$NODE_BIN" != "0" ]; then
  echo "PREFLIGHT=FAIL"
  exit 1
fi
echo "PREFLIGHT=PASS"
