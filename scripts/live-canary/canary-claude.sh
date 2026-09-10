#!/usr/bin/env bash
# Minimal live canary for the Claude subscription route (PREPARED, NOT RUN).
#
# Usage (human only, after the independent re-audit PASS):
#   CMM_LIVE_CANARY_CONFIRM=yes-i-accept-subscription-quota-spend \
#   CMM_ROUTER_TOKEN=<router-bearer> bash scripts/live-canary/canary-claude.sh
#
# One non-streaming request, one harmless synthetic tool, no repo mutation.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=canary-lib.sh
. "$here/canary-lib.sh"
canary_run claude
