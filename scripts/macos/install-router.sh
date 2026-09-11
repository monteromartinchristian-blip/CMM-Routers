#!/usr/bin/env bash
# Install the CMM Routers LaunchAgent (manual step, local only).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
LABEL="com.cmm.subscription-router"
DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
TEMPLATE="${REPO_DIR}/launchd/com.cmm.subscription-router.plist.template"
BUILT_ENTRYPOINT="${REPO_DIR}/dist/index.js"
CONFIG_DIR="${CMM_CONFIG_DIR:-${REPO_DIR}/config}"

if [ ! -f "$TEMPLATE" ]; then
  echo "error: missing template $TEMPLATE" >&2
  exit 1
fi
if [ ! -f "$BUILT_ENTRYPOINT" ]; then
  echo "error: missing built entrypoint $BUILT_ENTRYPOINT (run: npm run build)" >&2
  exit 1
fi

# Fresh-clone bootstrap: install config/shared.json from the shipped
# example when absent. Never overwrites, never writes secrets.
if [ ! -f "${CONFIG_DIR}/shared.json" ]; then
  if [ ! -f "${CONFIG_DIR}/shared.example.json" ]; then
    echo "error: missing ${CONFIG_DIR}/shared.example.json, cannot bootstrap shared.json" >&2
    exit 1
  fi
  cp "${CONFIG_DIR}/shared.example.json" "${CONFIG_DIR}/shared.json"
  echo "Bootstrapped config/shared.json from shared.example.json"
fi

# Deterministic executable resolution for the LaunchAgent environment, which
# does not inherit interactive-shell PATH. Enabled providers whose runtime
# cannot be resolved to an EXECUTABLE ABSOLUTE PATH abort the install: never
# write a plist that will predictably fail later, never fall back to a bare
# command name. Enablement comes from the shared production validator.
VALIDATOR="${REPO_DIR}/scripts/validate-config.mjs"
VALIDATOR_OUT=""
VALIDATOR_STATUS=2
if command -v node >/dev/null 2>&1; then
  if VALIDATOR_OUT="$(CMM_CONFIG_DIR="$CONFIG_DIR" node "$VALIDATOR" 2>/dev/null)"; then
    VALIDATOR_STATUS=0
  else
    VALIDATOR_STATUS=$?
  fi
fi
config_field() {
  printf '%s\n' "$VALIDATOR_OUT" | sed -n "s/^$1=//p" | head -n 1
}
if [ "$VALIDATOR_STATUS" != "0" ]; then
  echo "error: shared config validation failed (status $VALIDATOR_STATUS); refusing to install" >&2
  exit 1
fi

CHATGPT_ENABLED="$(config_field CHATGPT_ENABLED)"
GOOGLE_ENABLED="$(config_field GOOGLE_ENABLED)"
AGY_PATH_CONFIG="$(config_field AGY_PATH)"

# Resolve a command name or path to an executable absolute path.
# Prints the path on success; returns non-zero when unresolvable.
resolve_executable() {
  local candidate="$1"
  [ -n "$candidate" ] || return 1
  local resolved="$candidate"
  case "$resolved" in
    /*) : ;;
    *) resolved="$(command -v "$candidate" 2>/dev/null || true)" ;;
  esac
  [ -n "$resolved" ] || return 1
  case "$resolved" in
    /*) : ;;
    *) resolved="$(cd "$(dirname "$resolved")" 2>/dev/null && pwd)/$(basename "$resolved")" ;;
  esac
  [ -x "$resolved" ] || return 1
  printf '%s' "$resolved"
}

NODE_BIN="$(resolve_executable "${CMM_ROUTER_NODE_BIN:-node}")" || {
  echo "error: node runtime is not resolvable to an executable absolute path; refusing to install" >&2
  exit 1
}

CODEX_BIN=""
if [ "$CHATGPT_ENABLED" = "1" ]; then
  CODEX_BIN="$(resolve_executable "${CMM_ROUTER_CODEX_BIN:-codex}")" || {
    echo "error: ChatGPT provider is enabled but the codex binary is not resolvable; refusing to install" >&2
    exit 1
  }
fi

AGY_BIN=""
if [ "$GOOGLE_ENABLED" = "1" ]; then
  if [ -n "$AGY_PATH_CONFIG" ]; then
    # Configured path is authoritative: never substitute another agy.
    AGY_BIN="$(resolve_executable "$AGY_PATH_CONFIG")" || {
      echo "error: Google provider is enabled but configured agyPath is not executable; refusing to install" >&2
      exit 1
    }
  elif [ -n "${CMM_ROUTER_AGY_BIN:-}" ]; then
    AGY_BIN="$(resolve_executable "$CMM_ROUTER_AGY_BIN")" || {
      echo "error: Google provider is enabled but CMM_ROUTER_AGY_BIN is not executable; refusing to install" >&2
      exit 1
    }
  else
    AGY_BIN="$(resolve_executable agy)" || AGY_BIN="$(resolve_executable "${HOME}/.local/bin/agy")" || {
      echo "error: Google provider is enabled but the agy binary is not resolvable; refusing to install" >&2
      exit 1
    }
  fi
fi

# Command Code is HTTP-based (baseUrl + secretEnv); it has no local runtime
# binary, so the installer must not require one for it.
SAFE_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
for dir in "$(dirname "$NODE_BIN")" "$(dirname "$CODEX_BIN")" "$(dirname "$AGY_BIN")"; do
  case "$dir" in
    ""|"."|"node"|"codex") : ;;
    *) SAFE_PATH="${SAFE_PATH}:$dir" ;;
  esac
done
# Deduplicate PATH entries while preserving order.
SAFE_PATH=$(printf '%s' "$SAFE_PATH" | awk -v RS=: '!seen[$0]++' | paste -sd: -)

mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/Library/Logs/CMM-Subscription-Router"

if ! sed -e "s#__REPO_DIR__#${REPO_DIR}#g" -e "s#__HOME__#${HOME}#g" \
  -e "s#__NODE_BIN__#${NODE_BIN}#g" -e "s#__CODEX_BIN__#${CODEX_BIN}#g" \
  -e "s#__AGY_BIN__#${AGY_BIN}#g" -e "s#__SAFE_PATH__#${SAFE_PATH}#g" \
  "$TEMPLATE" > "$DEST"; then
  echo "error: failed to render plist to $DEST" >&2
  exit 1
fi

echo "Installed $DEST"
echo "node: $NODE_BIN"
echo "codex: $CODEX_BIN"
echo "agy: $AGY_BIN"

# Qoder bearer provisioning (optional consumer). The runtime wrapper already
# reads service=cmm-subscription-router account=qoder-bearer from Keychain; a
# fresh machine needs the item created intentionally. Idempotent: an existing
# item is left untouched, and the value is never printed.
QODER_SERVICE="${CMM_QODER_KEYCHAIN_SERVICE:-cmm-subscription-router}"
QODER_ACCOUNT="${CMM_QODER_KEYCHAIN_ACCOUNT:-qoder-bearer}"
if security find-generic-password -s "$QODER_SERVICE" -a "$QODER_ACCOUNT" >/dev/null 2>&1; then
  echo "qoder-bearer: already provisioned in Keychain ($QODER_SERVICE/$QODER_ACCOUNT)"
else
  echo "qoder-bearer not provisioned. To enable the Qoder consumer on this Mac:"
  echo "  security add-generic-password -s $QODER_SERVICE -a $QODER_ACCOUNT -w"
  echo "(prompts for the token without echoing it; never stored in the repo)"
fi

echo "Load with: launchctl load \"$DEST\""
