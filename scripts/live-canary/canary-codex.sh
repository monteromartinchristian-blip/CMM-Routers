#!/usr/bin/env bash
# Live canary for the ChatGPT/Codex subscription route (PREPARED, NOT RUN).
#
# Usage (human only, after the independent re-audit PASS):
#   CMM_LIVE_CANARY_CONFIRM=yes-i-accept-subscription-quota-spend \
#   CMM_QODER_TOKEN=<qoder-bearer> \
#   CMM_LIVE_CANARY_MODEL=<exact router model id> \
#   bash scripts/live-canary/canary-codex.sh
#
# Codex exposes no representable tool_choice/parallel_tool_calls control, so the
# canary sends the default (absent) policy and the prompt must force the call.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=canary-lib.sh
. "$here/canary-lib.sh"
canary_run chatgpt
