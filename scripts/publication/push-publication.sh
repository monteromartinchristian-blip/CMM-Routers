#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
POLICY="$SCRIPT_DIR/lib/policy.mjs"

fail() {
  echo "PUBLICATION_PUSH_ERROR=$1" >&2
  exit 1
}

PUBLIC=""
EXPECTED_HEAD=""
EXPECTED_PREDECESSOR=""
TRANSPORT="origin"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --public-staging)
      [ "$#" -ge 2 ] || fail "missing-public-staging-value"
      PUBLIC="$2"
      shift 2
      ;;
    --expected-head)
      [ "$#" -ge 2 ] || fail "missing-expected-head-value"
      EXPECTED_HEAD="$2"
      shift 2
      ;;
    --expected-remote-predecessor)
      [ "$#" -ge 2 ] || fail "missing-expected-remote-predecessor-value"
      EXPECTED_PREDECESSOR="$2"
      shift 2
      ;;
    --transport)
      [ "$#" -ge 2 ] || fail "missing-transport-value"
      TRANSPORT="$2"
      shift 2
      ;;
    *)
      fail "unknown-argument:$1"
      ;;
  esac
done

[ -n "$PUBLIC" ] || fail "public-staging-required"
[[ "$EXPECTED_HEAD" =~ ^[0-9a-f]{40}$ ]] || fail "expected-head-must-be-full-sha"
[[ "$EXPECTED_PREDECESSOR" =~ ^[0-9a-f]{40}$ ]] ||
  fail "expected-remote-predecessor-must-be-full-sha"

case "$TRANSPORT" in
  origin|ssh) ;;
  *) fail "unsupported-transport" ;;
esac

[ -d "$PUBLIC/.git" ] || fail "public-staging-missing"
[ -f "$POLICY" ] || fail "policy-module-missing"

PUBLIC="$(cd "$PUBLIC" && pwd -P)"

[ "$(git -C "$PUBLIC" branch --show-current)" = "main" ] ||
  fail "public-branch-not-main"

[ -z "$(git -C "$PUBLIC" status --porcelain)" ] ||
  fail "public-staging-dirty"

LOCAL_HEAD="$(git -C "$PUBLIC" rev-parse HEAD)"
[ "$LOCAL_HEAD" = "$EXPECTED_HEAD" ] || fail "local-head-mismatch"

ORIGIN_BEFORE="$(git -C "$PUBLIC" remote get-url origin 2>/dev/null || true)"
[ -n "$ORIGIN_BEFORE" ] || fail "public-origin-missing"

REMOTE_BEFORE="$(
  git ls-remote --heads "$ORIGIN_BEFORE" refs/heads/main 2>/dev/null |
    awk 'NR==1 {print $1}'
)"
[ -n "$REMOTE_BEFORE" ] || fail "remote-main-missing"
[ "$REMOTE_BEFORE" = "$EXPECTED_PREDECESSOR" ] ||
  fail "remote-predecessor-mismatch"

PARENT_COUNT="$(
  git -C "$PUBLIC" rev-list --parents -n 1 "$EXPECTED_HEAD" |
    awk '{print NF-1}'
)"
[ "$PARENT_COUNT" = "1" ] || fail "expected-head-parent-count-not-one"

LOCAL_PARENT="$(git -C "$PUBLIC" rev-parse "${EXPECTED_HEAD}^")"
[ "$LOCAL_PARENT" = "$EXPECTED_PREDECESSOR" ] ||
  fail "local-parent-not-expected-predecessor"

BAD_META="$(
  git -C "$PUBLIC" log --format='%ae%n%ce' |
    awk 'NF && $0 !~ /@users\.noreply\.github\.com$/ {print; exit}'
)"
[ -z "$BAD_META" ] || fail "public-history-non-noreply-metadata"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/cmm-publication-push.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM

PUBLIC_TREE="$TMP/public-tree"
mkdir -p "$PUBLIC_TREE"
rsync -a --delete --exclude '.git/' "$PUBLIC/" "$PUBLIC_TREE/"

node "$POLICY" scan-tree "$PUBLIC_TREE"

echo "PUBLIC_PREPUSH_PRIVACY_SCAN=PASS"

TARGET="$ORIGIN_BEFORE"
if [ "$TRANSPORT" = "ssh" ]; then
  case "$ORIGIN_BEFORE" in
    https://github.com/*)
      REPO_PATH="${ORIGIN_BEFORE#https://github.com/}"
      REPO_PATH="${REPO_PATH%.git}"
      case "$REPO_PATH" in
        */*) ;;
        *) fail "github-https-origin-not-owner-repo" ;;
      esac
      TARGET="git@github.com:${REPO_PATH}.git"
      ;;
    *)
      fail "ssh-transport-requires-exact-github-https-origin"
      ;;
  esac
fi

echo "PUBLIC_PUSH_EXPECTED_HEAD=$EXPECTED_HEAD"
echo "PUBLIC_PUSH_EXPECTED_REMOTE_PREDECESSOR=$EXPECTED_PREDECESSOR"
echo "PUBLIC_PUSH_TRANSPORT=$TRANSPORT"
echo "PUBLIC_PUSH_PRECHECK=PASS"
echo "FORCE_PUSH=NO"
echo "PUSH_RETRY=NO"

PUSH_LOG="$TMP/push.log"
set +e
(
  cd "$PUBLIC"
  git push "$TARGET" "$EXPECTED_HEAD:refs/heads/main"
) >"$PUSH_LOG" 2>&1
PUSH_RC=$?
set -e

REMOTE_AFTER="$(
  git ls-remote --heads "$ORIGIN_BEFORE" refs/heads/main 2>/dev/null |
    awk 'NR==1 {print $1}'
)"

[ -n "$REMOTE_AFTER" ] || fail "remote-main-missing-after-push"

if [ "$PUSH_RC" -ne 0 ]; then
  echo "PUBLIC_PUSH_COMMAND_EXIT=$PUSH_RC"

  if [ "$REMOTE_AFTER" = "$EXPECTED_HEAD" ]; then
    echo "PUBLIC_PUSH_COMMAND_ERROR_REMOTE_CONFIRMED=YES"
  else
    [ "$REMOTE_AFTER" = "$EXPECTED_PREDECESSOR" ] ||
      fail "push-command-failed-remote-unexpected-state"
    fail "push-command-failed-remote-not-updated"
  fi
else
  echo "PUBLIC_PUSH_COMMAND_EXIT=0"
  [ "$REMOTE_AFTER" = "$EXPECTED_HEAD" ] ||
    fail "push-command-succeeded-but-remote-head-mismatch"
fi

ORIGIN_AFTER="$(git -C "$PUBLIC" remote get-url origin)"
[ "$ORIGIN_AFTER" = "$ORIGIN_BEFORE" ] || fail "origin-mutated"

[ -z "$(git -C "$PUBLIC" status --porcelain)" ] ||
  fail "public-staging-dirty-after-push"

EVIDENCE_DIR="${CMM_ROUTERS_EVIDENCE_DIR:-$HOME/.cmm-routers/publication-evidence}"
mkdir -p "$EVIDENCE_DIR"
REPORT="$EVIDENCE_DIR/CMM-Routers-publication-push-${EXPECTED_HEAD:0:7}.txt"

{
  echo "PUBLIC_PREDECESSOR_SHA=$EXPECTED_PREDECESSOR"
  echo "PUBLIC_PUSHED_SHA=$EXPECTED_HEAD"
  echo "PUBLIC_REMOTE_HEAD=$REMOTE_AFTER"
  echo "PUBLIC_PUSH_TRANSPORT=$TRANSPORT"
  echo "PUBLIC_ORIGIN_MUTATED=NO"
  echo "FORCE_PUSH=NO"
  echo "PUSH_RETRY=NO"
  echo "PUBLIC_REMOTE_UPDATED=YES"
  echo "PUBLIC_PUSH_STATUS=CLOSED_PASS"
} > "$REPORT"

shasum -a 256 "$REPORT" > "$REPORT.sha256"

cat "$REPORT"
echo "PUSH_EVIDENCE_REPORT=$REPORT"
echo "PUSH_EVIDENCE_SHA256=$(awk '{print $1}' "$REPORT.sha256")"
