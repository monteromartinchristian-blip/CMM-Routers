#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
POLICY="$SCRIPT_DIR/lib/policy.mjs"

fail() {
  echo "PUBLICATION_VERIFY_ERROR=$1" >&2
  exit 1
}

REMOTE=""
EXPECTED_HEAD=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --remote)
      [ "$#" -ge 2 ] || fail "missing-remote-value"
      REMOTE="$2"
      shift 2
      ;;
    --expected-head)
      [ "$#" -ge 2 ] || fail "missing-expected-head-value"
      EXPECTED_HEAD="$2"
      shift 2
      ;;
    *)
      fail "unknown-argument:$1"
      ;;
  esac
done

[ -n "$REMOTE" ] || fail "remote-required"
[[ "$EXPECTED_HEAD" =~ ^[0-9a-f]{40}$ ]] ||
  fail "expected-head-must-be-full-sha"
[ -f "$POLICY" ] || fail "policy-module-missing"

REMOTE_HEAD_BEFORE="$(
  git ls-remote --heads "$REMOTE" refs/heads/main 2>/dev/null |
    awk 'NR==1 {print $1}'
)"
[ -n "$REMOTE_HEAD_BEFORE" ] || fail "remote-main-missing"
[ "$REMOTE_HEAD_BEFORE" = "$EXPECTED_HEAD" ] || fail "remote-head-mismatch"

echo "PUBLIC_REMOTE_HEAD=$REMOTE_HEAD_BEFORE"
echo "PUBLIC_REMOTE_HEAD_MATCH=PASS"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/cmm-publication-verify.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM

CLONE="$TMP/clone"
SCAN_TREE="$TMP/scan-tree"

git clone --quiet --no-tags --branch main "$REMOTE" "$CLONE"

CLONE_HEAD="$(git -C "$CLONE" rev-parse HEAD)"
[ "$CLONE_HEAD" = "$EXPECTED_HEAD" ] || fail "fresh-clone-head-mismatch"
[ "$(git -C "$CLONE" branch --show-current)" = "main" ] ||
  fail "fresh-clone-branch-not-main"

ROOT_COUNT="$(
  git -C "$CLONE" rev-list --max-parents=0 HEAD |
    awk 'END {print NR+0}'
)"
[ "$ROOT_COUNT" = "1" ] || fail "public-history-root-count-not-one"

MERGE_COUNT="$(
  git -C "$CLONE" rev-list --min-parents=2 HEAD |
    awk 'END {print NR+0}'
)"
[ "$MERGE_COUNT" = "0" ] || fail "public-history-not-linear"

BAD_META="$(
  git -C "$CLONE" log --format='%ae%n%ce' |
    awk 'NF && $0 !~ /@users\.noreply\.github\.com$/ {print; exit}'
)"
[ -z "$BAD_META" ] || fail "public-history-non-noreply-metadata"

echo "PUBLIC_HISTORY_LINEAR=PASS"
echo "PUBLIC_HISTORY_SINGLE_ROOT=PASS"
echo "PUBLIC_HISTORY_NOREPLY_METADATA=PASS"

mkdir -p "$SCAN_TREE"
rsync -a --delete \
  --exclude '.git' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  "$CLONE/" "$SCAN_TREE/"

node "$POLICY" scan-tree "$SCAN_TREE"
echo "PUBLIC_FRESH_CLONE_PRIVACY_SCAN=PASS"

(
  cd "$CLONE"

  npm ci
  echo "PUBLIC_FRESH_CLONE_NPM_CI=PASS"

  npm run build
  echo "PUBLIC_FRESH_CLONE_BUILD=PASS"

  CMM_ROUTERS_PUBLICATION_FRESH_CLONE_VERIFY=1 npx vitest run
  echo "PUBLIC_FRESH_CLONE_TESTS=PASS"

  npm run typecheck
  echo "PUBLIC_FRESH_CLONE_TYPECHECK=PASS"

  bash scripts/security-audit.sh
  echo "PUBLIC_FRESH_CLONE_SECURITY_AUDIT=PASS"
)

[ -z "$(git -C "$CLONE" status --porcelain)" ] ||
  fail "fresh-clone-worktree-dirty-after-verification"

echo "PUBLIC_FRESH_CLONE_WORKTREE=CLEAN"

REMOTE_HEAD_AFTER="$(
  git ls-remote --heads "$REMOTE" refs/heads/main 2>/dev/null |
    awk 'NR==1 {print $1}'
)"
[ -n "$REMOTE_HEAD_AFTER" ] || fail "remote-main-missing-after-verification"
[ "$REMOTE_HEAD_AFTER" = "$EXPECTED_HEAD" ] ||
  fail "remote-changed-during-verification"

echo "PUBLIC_REMOTE_RECHECK_HEAD=$REMOTE_HEAD_AFTER"
echo "PUBLIC_REMOTE_STABLE_DURING_VERIFICATION=PASS"

EVIDENCE_DIR="${CMM_ROUTERS_EVIDENCE_DIR:-$HOME/.cmm-routers/publication-evidence}"
mkdir -p "$EVIDENCE_DIR"
REPORT="$EVIDENCE_DIR/CMM-Routers-publication-verify-${EXPECTED_HEAD:0:7}.txt"

{
  echo "PUBLIC_EXPECTED_HEAD=$EXPECTED_HEAD"
  echo "PUBLIC_REMOTE_HEAD_BEFORE=$REMOTE_HEAD_BEFORE"
  echo "PUBLIC_FRESH_CLONE_HEAD=$CLONE_HEAD"
  echo "PUBLIC_REMOTE_HEAD_AFTER=$REMOTE_HEAD_AFTER"
  echo "PUBLIC_HISTORY_LINEAR=PASS"
  echo "PUBLIC_HISTORY_SINGLE_ROOT=PASS"
  echo "PUBLIC_HISTORY_NOREPLY_METADATA=PASS"
  echo "PUBLIC_FRESH_CLONE_PRIVACY_SCAN=PASS"
  echo "PUBLIC_FRESH_CLONE_NPM_CI=PASS"
  echo "PUBLIC_FRESH_CLONE_BUILD=PASS"
  echo "PUBLIC_FRESH_CLONE_TESTS=PASS"
  echo "PUBLIC_FRESH_CLONE_TYPECHECK=PASS"
  echo "PUBLIC_FRESH_CLONE_SECURITY_AUDIT=PASS"
  echo "PUBLIC_FRESH_CLONE_WORKTREE=CLEAN"
  echo "PUBLIC_REMOTE_STABLE_DURING_VERIFICATION=PASS"
  echo "PUBLIC_FRESH_CLONE_VERIFICATION=CLOSED_PASS"
  echo "PUBLIC_RELEASE_REPRODUCIBLE=YES"
} > "$REPORT"

shasum -a 256 "$REPORT" > "$REPORT.sha256"

cat "$REPORT"
echo "VERIFY_EVIDENCE_REPORT=$REPORT"
echo "VERIFY_EVIDENCE_SHA256=$(awk '{print $1}' "$REPORT.sha256")"
