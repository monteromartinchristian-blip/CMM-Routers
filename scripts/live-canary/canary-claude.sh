#!/usr/bin/env bash
# Live canary for the Claude subscription route (PREPARED, NOT RUN).
#
# Usage (human only, after the independent re-audit PASS):
#   CMM_LIVE_CANARY_CONFIRM=yes-i-accept-subscription-quota-spend \
#   CMM_QODER_TOKEN=<qoder-bearer> \
#   CMM_LIVE_CANARY_MODEL=<exact router model id> \
#   bash scripts/live-canary/canary-claude.sh
#
# Two minimal requests: declare canary_echo, submit the synthetic tool result,
# require the final reply to be derived from it. No repo mutation.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=canary-lib.sh
. "$here/canary-lib.sh"
canary_run claude
