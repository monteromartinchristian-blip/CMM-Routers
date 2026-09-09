#!/usr/bin/env bash
# Router launch wrapper: resolves secrets from macOS Keychain at startup.
# Never echoes secret values. Never writes them to disk.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_DIR"

ROUTER_SERVICE="${CMM_ROUTER_KEYCHAIN_SERVICE:-cmm-subscription-router}"
ROUTER_ACCOUNT="${CMM_ROUTER_KEYCHAIN_ACCOUNT:-router-bearer}"
CC_SERVICE="${COMMAND_CODE_KEYCHAIN_SERVICE:-cmm-subscription-router}"
CC_ACCOUNT="${COMMAND_CODE_KEYCHAIN_ACCOUNT:-command-code-secret}"

if [ -z "${CMM_ROUTER_TOKEN:-}" ]; then
  TOKEN="$(security find-generic-password -s "$ROUTER_SERVICE" -a "$ROUTER_ACCOUNT" -w 2>/dev/null || true)"
  if [ -n "$TOKEN" ]; then
    export CMM_ROUTER_TOKEN="$TOKEN"
  fi
fi

if [ -z "${COMMAND_CODE_SECRET:-}" ]; then
  CC_SECRET="$(security find-generic-password -s "$CC_SERVICE" -a "$CC_ACCOUNT" -w 2>/dev/null || true)"
  if [ -n "$CC_SECRET" ]; then
    export COMMAND_CODE_SECRET="$CC_SECRET"
  fi
fi

if [ -z "${CMM_ROUTER_TOKEN:-}" ]; then
  echo "router bearer token unavailable (Keychain or CMM_ROUTER_TOKEN)" >&2
  exit 1
fi

exec node "$REPO_DIR/dist/index.js"
