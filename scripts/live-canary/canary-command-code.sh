#!/usr/bin/env bash
# Minimal live canary for the Command Code subscription route (PREPARED, NOT RUN).
#
# Usage (human only, after the independent re-audit PASS):
#   CMM_LIVE_CANARY_CONFIRM=yes-i-accept-subscription-quota-spend \
#   CMM_ROUTER_TOKEN=<router-bearer> bash scripts/live-canary/canary-command-code.sh
#
# One non-streaming request, one harmless synthetic tool, no repo mutation.
# The spend guard must already have a human GOAT attestation or the router
# refuses to register Command Code (on-demand / auto-top-up stay disabled).
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=canary-lib.sh
. "$here/canary-lib.sh"
canary_run command-code
