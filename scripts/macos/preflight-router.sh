#!/usr/bin/env bash
# Preflight wrapper for launchd-managed runs (safe, read-only).
set -u
exec bash "$(cd "$(dirname "$0")/.." && pwd)/scripts/preflight.sh"
