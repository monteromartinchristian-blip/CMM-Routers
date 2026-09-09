#!/usr/bin/env bash
# CMM Subscription Router — safe provider authentication preflight.
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

CONFIG_DIR="${CMM_CONFIG_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/config}"
SHARED_JSON="${CONFIG_DIR}/shared.json"
EXAMPLE_JSON="${CONFIG_DIR}/shared.example.json"

UNSAFE=0
BLOCKING=0
CONFIG_INVALID=0

# Validate shared.json with the same strictness as production loadConfig:
# well-formed JSON, mode/host present, host loopback-locked, no unknown
# top-level keys. A present-but-invalid file must FAIL, never fall back
# to defaults silently.
if [ -f "$SHARED_JSON" ]; then
  if command -v python3 >/dev/null 2>&1; then
    if ! python3 - "$SHARED_JSON" 2>/dev/null <<'PY'; then
import json, sys
raw = json.load(open(sys.argv[1]))
if not isinstance(raw, dict):
    raise ValueError("top-level object required")
allowed = {"mode", "host", "port", "bearerSecretEnv", "providers"}
unknown = set(raw.keys()) - allowed
if unknown:
    raise ValueError(f"unknown keys: {sorted(unknown)}")
if raw.get("mode", "standalone") != "standalone":
    raise ValueError("mode must be standalone")
if "host" in raw and raw["host"] != "127.0.0.1":
    raise ValueError("host must be 127.0.0.1")
PY
      echo "CONFIG=INVALID"
      CONFIG_INVALID=1
    else
      echo "CONFIG=VALID"
    fi
  fi
fi

# --- provider enablement + effective options (same source of truth as production) ---
CHATGPT_ENABLED=1
CLAUDE_ENABLED=1
GOOGLE_ENABLED=1
COMMAND_CODE_ENABLED=0
# Effective configured values (empty = production default).
CLAUDE_PROFILE_DIR=""
AGY_PATH_CONFIG=""
COMMAND_CODE_SECRET_ENV="COMMAND_CODE_SECRET"

if [ -f "$SHARED_JSON" ] && command -v python3 >/dev/null 2>&1; then
  READ_ENABLED=$(python3 - "$SHARED_JSON" 2>/dev/null <<'PY' || echo "PARSE_FAIL"
import json, sys
try:
    cfg = json.load(open(sys.argv[1]))
    providers = cfg.get("providers", {})
    def enabled(name, default):
        entry = providers.get(name)
        if not isinstance(entry, dict):
            return default
        return "1" if entry.get("enabled", default == "1") else "0"
    def opt(name, key):
        entry = providers.get(name)
        if not isinstance(entry, dict):
            return ""
        value = entry.get(key, "")
        return value if isinstance(value, str) else ""
    print(" ".join([
        enabled("chatgpt", "1"),
        enabled("claude", "1"),
        enabled("google", "1"),
        enabled("command-code", "0"),
    ]))
    print("\t".join([
        opt("claude", "profileDir"),
        opt("google", "agyPath"),
        opt("command-code", "secretEnv") or "COMMAND_CODE_SECRET",
    ]))
except Exception:
    print("PARSE_FAIL")
PY
)
  if [ "$READ_ENABLED" != "PARSE_FAIL" ] && [ -n "$READ_ENABLED" ]; then
    FIRST_LINE=$(printf '%s' "$READ_ENABLED" | head -n 1)
    OPTS_LINE=$(printf '%s' "$READ_ENABLED" | tail -n 1)
    # shellcheck disable=SC2086
    set -- $FIRST_LINE
    CHATGPT_ENABLED="${1:-1}"
    CLAUDE_ENABLED="${2:-1}"
    GOOGLE_ENABLED="${3:-1}"
    COMMAND_CODE_ENABLED="${4:-0}"
    CLAUDE_PROFILE_DIR=$(printf '%s' "$OPTS_LINE" | cut -d'	' -f1)
    AGY_PATH_CONFIG=$(printf '%s' "$OPTS_LINE" | cut -d'	' -f2)
    COMMAND_CODE_SECRET_ENV=$(printf '%s' "$OPTS_LINE" | cut -d'	' -f3)
    [ -z "$COMMAND_CODE_SECRET_ENV" ] && COMMAND_CODE_SECRET_ENV="COMMAND_CODE_SECRET"
  fi
elif [ -f "$EXAMPLE_JSON" ] && [ ! -f "$SHARED_JSON" ]; then
  : # fresh clone without shared.json: fall back to documented defaults above
fi

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
    if codex login status 2>/dev/null | grep -qi "logged in"; then
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
