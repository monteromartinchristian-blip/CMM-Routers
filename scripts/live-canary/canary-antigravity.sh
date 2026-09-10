#!/usr/bin/env bash
# Live canary for the Antigravity/Google subscription route (PREPARED, NOT RUN).
#
# Usage (human only, after the independent re-audit PASS):
#   CMM_LIVE_CANARY_CONFIRM=yes-i-accept-subscription-quota-spend \
#   CMM_QODER_TOKEN=<qoder-bearer> \
#   CMM_LIVE_CANARY_MODEL=<exact router model id> \
#   bash scripts/live-canary/canary-antigravity.sh
#
# The account-only settings gate must already be satisfied (modelProvider != gemini,
# useG1Credits != true) or the router fails closed before spending quota.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=canary-lib.sh
. "$here/canary-lib.sh"
canary_run google
