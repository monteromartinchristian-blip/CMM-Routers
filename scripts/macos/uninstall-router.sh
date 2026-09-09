#!/usr/bin/env bash
# Uninstall the CMM Subscription Router LaunchAgent.
set -u

LABEL="com.cmm.subscription-router"
DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

launchctl unload "$DEST" 2>/dev/null || true
rm -f "$DEST"
echo "Removed $DEST"
