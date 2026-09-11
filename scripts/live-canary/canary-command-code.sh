#!/usr/bin/env bash
# Live canary for the Command Code subscription route (PREPARED, NOT RUN).
#
# Usage (human only, after the independent re-audit PASS):
#   CMM_LIVE_CANARY_CONFIRM=yes-i-accept-subscription-quota-spend \
#   CMM_QODER_TOKEN=<qoder-bearer> \
#   CMM_LIVE_CANARY_MODEL=<exact router model id> \
#   bash scripts/live-canary/canary-command-code.sh
#
# The spend guard must already have a human GOAT attestation or the router
# refuses to register Command Code (on-demand / auto-top-up stay disabled).
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=canary-lib.sh
. "$here/canary-lib.sh"
canary_run command-code
