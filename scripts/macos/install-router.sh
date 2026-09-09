#!/usr/bin/env bash
# Install the CMM Subscription Router LaunchAgent (manual step, local only).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
LABEL="com.cmm.subscription-router"
DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
TEMPLATE="${REPO_DIR}/launchd/com.cmm.subscription-router.plist.template"
BUILT_ENTRYPOINT="${REPO_DIR}/dist/index.js"

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
if [ ! -f "${REPO_DIR}/config/shared.json" ]; then
  if [ ! -f "${REPO_DIR}/config/shared.example.json" ]; then
    echo "error: missing ${REPO_DIR}/config/shared.example.json, cannot bootstrap shared.json" >&2
    exit 1
  fi
  cp "${REPO_DIR}/config/shared.example.json" "${REPO_DIR}/config/shared.json"
  echo "Bootstrapped config/shared.json from shared.example.json"
fi

# Deterministic executable resolution for the LaunchAgent environment,
# which does not inherit interactive-shell PATH. Absolute paths are baked
# into the plist; provider agy path prefers effective config.
NODE_BIN="$(command -v node 2>/dev/null || echo node)"
if [ "$NODE_BIN" != "node" ]; then
  case "$NODE_BIN" in
    /*) : ;;
    *) NODE_BIN="$(cd "$(dirname "$NODE_BIN")" 2>/dev/null && pwd)/$(basename "$NODE_BIN")" || NODE_BIN="node" ;;
  esac
fi
CODEX_BIN="${CMM_ROUTER_CODEX_BIN:-$(command -v codex 2>/dev/null || echo codex)}"
AGY_BIN=""
if [ -f "${REPO_DIR}/config/shared.json" ] && command -v python3 >/dev/null 2>&1; then
  AGY_BIN=$(python3 -c "import json,sys; print((json.load(open('${REPO_DIR}/config/shared.json')).get('providers',{}).get('google',{}) or {}).get('agyPath',''))" 2>/dev/null || echo "")
fi
if [ -z "$AGY_BIN" ]; then
  AGY_BIN="${CMM_ROUTER_AGY_BIN:-$(command -v agy 2>/dev/null || echo "${HOME}/.local/bin/agy")}"
fi
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
echo "Load with: launchctl load \"$DEST\""
