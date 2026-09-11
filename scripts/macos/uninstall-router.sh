#!/usr/bin/env bash
# Uninstall the CMM Routers LaunchAgent.
set -euo pipefail

LABEL="com.cmm.subscription-router"
DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

launchctl unload "$DEST" 2>/dev/null || true
rm -f "$DEST"
echo "Removed $DEST"
