#!/usr/bin/env bash
# Install the CMM Subscription Router LaunchAgent (manual step, local only).
set -u

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.cmm.subscription-router"
DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/Library/Logs/CMM-Subscription-Router"

sed -e "s#__REPO_DIR__#${REPO_DIR}#g" -e "s#__HOME__#${HOME}#g" \
  "${REPO_DIR}/launchd/com.cmm.subscription-router.plist.template" > "$DEST"

echo "Installed $DEST"
echo "Load with: launchctl load \"$DEST\""
