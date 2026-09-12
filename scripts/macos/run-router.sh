#!/usr/bin/env bash
# Router launch wrapper: resolves secrets from macOS Keychain at startup.
# Never echoes secret values. Never writes them to disk.
#
# Deterministic runtime: uses absolute executable paths resolved at install
# time ( baked into the plist environment by install-router.sh ), so the
# LaunchAgent never depends on interactive-shell PATH resolution.
# Configured secret env NAMES (bearerSecretEnv, command-code.secretEnv) are
# read from shared config; Keychain VALUES are exported under those exact
# names — never hard-coded variable names, never values in tracked files.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_DIR"

NODE_BIN="${CMM_ROUTER_NODE_BIN:-node}"
CONFIG_DIR="${CMM_CONFIG_DIR:-$REPO_DIR/config}"
SHARED_JSON="$CONFIG_DIR/shared.json"

# Resolve configured secret env names from shared config (production source
# of truth). Fall back to historical defaults when unreadable.
BEARER_ENV="CMM_ROUTER_TOKEN"
CC_ENV="COMMAND_CODE_SECRET"
CAVOTI_ENV="CAVOTI_API_KEY"
CAVOTI_ENABLED="0"
if [ -f "$SHARED_JSON" ] && command -v python3 >/dev/null 2>&1; then
  PARSED=$(python3 - "$SHARED_JSON" 2>/dev/null <<'PYCFG' || echo "PARSE_FAIL"
import json, sys
try:
    cfg = json.load(open(sys.argv[1]))
    print((cfg.get("bearerSecretEnv") or "CMM_ROUTER_TOKEN"))
    providers = cfg.get("providers", {})
    cc = providers.get("command-code", {})
    cavoti = providers.get("cavoti", {})
    print((cc.get("secretEnv") if isinstance(cc, dict) else None) or "COMMAND_CODE_SECRET")
    print((cavoti.get("secretEnv") if isinstance(cavoti, dict) else None) or "CAVOTI_API_KEY")
    print("1" if isinstance(cavoti, dict) and cavoti.get("enabled") is True else "0")
except Exception:
    print("PARSE_FAIL")
PYCFG
)
  if [ "$PARSED" != "PARSE_FAIL" ] && [ -n "$PARSED" ]; then
    BEARER_ENV=$(printf '%s\n' "$PARSED" | sed -n '1p')
    CC_ENV=$(printf '%s\n' "$PARSED" | sed -n '2p')
    CAVOTI_ENV=$(printf '%s\n' "$PARSED" | sed -n '3p')
    CAVOTI_ENABLED=$(printf '%s\n' "$PARSED" | sed -n '4p')
    [ -z "$BEARER_ENV" ] && BEARER_ENV="CMM_ROUTER_TOKEN"
    [ -z "$CC_ENV" ] && CC_ENV="COMMAND_CODE_SECRET"
    [ -z "$CAVOTI_ENV" ] && CAVOTI_ENV="CAVOTI_API_KEY"
    [ "$CAVOTI_ENABLED" = "1" ] || CAVOTI_ENABLED="0"
  fi
fi

ROUTER_SERVICE="${CMM_ROUTER_KEYCHAIN_SERVICE:-cmm-subscription-router}"
ROUTER_ACCOUNT="${CMM_ROUTER_KEYCHAIN_ACCOUNT:-router-bearer}"
CC_SERVICE="${COMMAND_CODE_KEYCHAIN_SERVICE:-cmm-subscription-router}"
CC_ACCOUNT="${COMMAND_CODE_KEYCHAIN_ACCOUNT:-command-code-secret}"
CAVOTI_SERVICE="${CAVOTI_KEYCHAIN_SERVICE:-cmm-subscription-router}"
CAVOTI_ACCOUNT="${CAVOTI_KEYCHAIN_ACCOUNT:-cavoti-api-key}"
QODER_SERVICE="${CMM_QODER_KEYCHAIN_SERVICE:-cmm-subscription-router}"
QODER_ACCOUNT="${CMM_QODER_KEYCHAIN_ACCOUNT:-qoder-bearer}"

# Indirect expansion against the CONFIGURED names (never hard-coded).
if [ -z "${!BEARER_ENV:-}" ]; then
  TOKEN="$(security find-generic-password -s "$ROUTER_SERVICE" -a "$ROUTER_ACCOUNT" -w 2>/dev/null || true)"
  if [ -n "$TOKEN" ]; then
    export "$BEARER_ENV"="$TOKEN"
  fi
fi

if [ -z "${!CC_ENV:-}" ]; then
  CC_SECRET="$(security find-generic-password -s "$CC_SERVICE" -a "$CC_ACCOUNT" -w 2>/dev/null || true)"
  if [ -n "$CC_SECRET" ]; then
    export "$CC_ENV"="$CC_SECRET"
  fi
fi

# Cavoti is explicit PAYG and therefore stricter than an ordinary optional
# HTTP provider: when enabled, both its dedicated secret and the exact
# machine-local acknowledgement must be present before the Router starts.
if [ "$CAVOTI_ENABLED" = "1" ]; then
  if [ -z "${!CAVOTI_ENV:-}" ]; then
    CAVOTI_SECRET="$(security find-generic-password -s "$CAVOTI_SERVICE" -a "$CAVOTI_ACCOUNT" -w 2>/dev/null || true)"
    if [ -n "$CAVOTI_SECRET" ]; then
      export "$CAVOTI_ENV"="$CAVOTI_SECRET"
    fi
  fi

  if [ -z "${!CAVOTI_ENV:-}" ]; then
    echo "Cavoti secret unavailable (Keychain or $CAVOTI_ENV)" >&2
    exit 1
  fi

  CAVOTI_ACK_PATH="${CMM_CAVOTI_ACK_PATH:-${HOME}/Library/Application Support/CMM/SubscriptionRouter/cavoti-payg-ack.json}"
  if ! command -v python3 >/dev/null 2>&1; then
    echo "Cavoti PAYG acknowledgement invalid or missing" >&2
    exit 1
  fi
  if ! python3 - "$CAVOTI_ACK_PATH" >/dev/null 2>&1 <<'PYACK'
import json, sys
path = sys.argv[1]
expected = {
    "version": 1,
    "provider": "cavoti",
    "billing": "PAYG",
    "model": "deepseek-v4.1-flash",
    "automaticFallback": False,
}
try:
    with open(path, "r", encoding="utf-8") as fh:
        value = json.load(fh)
except Exception:
    raise SystemExit(1)
raise SystemExit(0 if value == expected else 1)
PYACK
  then
    echo "Cavoti PAYG acknowledgement invalid or missing" >&2
    exit 1
  fi
fi

# Optional Qoder consumer token: when absent there is simply no Qoder
# consumer (every client is CMMChat, CHAT_ONLY). Never fatal, never logged.
if [ -z "${CMM_QODER_TOKEN:-}" ]; then
  QODER_TOKEN="$(security find-generic-password -s "$QODER_SERVICE" -a "$QODER_ACCOUNT" -w 2>/dev/null || true)"
  if [ -n "$QODER_TOKEN" ]; then
    export CMM_QODER_TOKEN="$QODER_TOKEN"
  fi
fi

if [ -z "${!BEARER_ENV:-}" ]; then
  echo "router bearer token unavailable (Keychain or $BEARER_ENV)" >&2
  exit 1
fi

exec "$NODE_BIN" "$REPO_DIR/dist/index.js"
