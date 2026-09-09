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

mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/Library/Logs/CMM-Subscription-Router"

if ! sed -e "s#__REPO_DIR__#${REPO_DIR}#g" -e "s#__HOME__#${HOME}#g" \
  "$TEMPLATE" > "$DEST"; then
  echo "error: failed to render plist to $DEST" >&2
  exit 1
fi

echo "Installed $DEST"
echo "Load with: launchctl load \"$DEST\""
