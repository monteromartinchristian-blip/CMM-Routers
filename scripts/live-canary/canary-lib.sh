#!/usr/bin/env bash
# Shared launcher for the Task 13 live canaries.
#
# PREPARED, NOT EXECUTED in the deterministic pass: these canaries consume real
# subscription quota and are gated behind an explicit operator opt-in.
#
# All canary logic (Qoder bearer resolution, exact model selection, provider
# policy, the two-request canary_echo round-trip and the exit codes) lives in
# canary-driver.ts, where it is covered by deterministic fake-Router tests. This
# launcher only locates the driver and executes it under Node; it never prints a
# secret and never reads CMM_ROUTER_TOKEN (that bearer is CMMChat/CHAT_ONLY).
set -u

canary_run() {
  local provider="${1:-}"
  if [ -z "$provider" ]; then
    echo "LIVE_CANARY=BLOCKED provider=unknown reason=missing-provider"
    echo "LIVE_CANARY_BLOCKED_EXIT=2"
    exit 2
  fi
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local driver="$here/canary-driver.ts"
  if [ ! -f "$driver" ]; then
    echo "LIVE_CANARY=BLOCKED provider=$provider reason=driver-missing"
    echo "LIVE_CANARY_BLOCKED_EXIT=2"
    exit 2
  fi
  exec "${NODE:-node}" "$driver" "$provider"
}
