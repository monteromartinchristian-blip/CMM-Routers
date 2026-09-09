#!/usr/bin/env bash
# Preflight wrapper for launchd-managed runs (safe, read-only).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PREFLIGHT="${REPO_DIR}/scripts/preflight.sh"

if [ ! -f "$PREFLIGHT" ]; then
  echo "error: missing preflight script $PREFLIGHT" >&2
  exit 1
fi

exec bash "$PREFLIGHT"
