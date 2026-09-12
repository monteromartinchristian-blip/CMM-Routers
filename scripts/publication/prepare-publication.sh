#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
POLICY="$SCRIPT_DIR/lib/policy.mjs"
TREE="$SCRIPT_DIR/lib/tree.mjs"

fail() {
  echo "PUBLICATION_PREPARE_ERROR=$1" >&2
  exit 1
}

INTERNAL=""
PUBLIC=""
SOURCE_SHA=""
MESSAGE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --internal-repo)
      [ "$#" -ge 2 ] || fail "missing-internal-repo-value"
      INTERNAL="$2"
      shift 2
      ;;
    --public-staging)
      [ "$#" -ge 2 ] || fail "missing-public-staging-value"
      PUBLIC="$2"
      shift 2
      ;;
    --source-sha)
      [ "$#" -ge 2 ] || fail "missing-source-sha-value"
      SOURCE_SHA="$2"
      shift 2
      ;;
    --message)
      [ "$#" -ge 2 ] || fail "missing-message-value"
      MESSAGE="$2"
      shift 2
      ;;
    *)
      fail "unknown-argument:$1"
      ;;
  esac
done

[ -n "$INTERNAL" ] || fail "internal-repo-required"
[ -n "$PUBLIC" ] || fail "public-staging-required"
[ -n "$SOURCE_SHA" ] || fail "source-sha-required"
[ -n "$MESSAGE" ] || fail "message-required"
[ -d "$INTERNAL/.git" ] || fail "internal-repo-missing"
[ -d "$PUBLIC/.git" ] || fail "public-staging-missing"
[ -f "$POLICY" ] || fail "policy-module-missing"
[ -f "$TREE" ] || fail "tree-module-missing"

INTERNAL="$(cd "$INTERNAL" && pwd -P)"
PUBLIC="$(cd "$PUBLIC" && pwd -P)"

[ -z "$(git -C "$INTERNAL" status --porcelain)" ] || fail "internal-worktree-dirty"
[ -z "$(git -C "$PUBLIC" status --porcelain)" ] || fail "public-staging-dirty"

RESOLVED_SOURCE="$(git -C "$INTERNAL" rev-parse "${SOURCE_SHA}^{commit}" 2>/dev/null || true)"
[ -n "$RESOLVED_SOURCE" ] || fail "source-sha-not-a-commit"
[ "$RESOLVED_SOURCE" = "$SOURCE_SHA" ] || fail "source-sha-must-be-full-resolved-commit"

[ "$(git -C "$PUBLIC" branch --show-current)" = "main" ] || fail "public-branch-not-main"

ORIGIN="$(git -C "$PUBLIC" remote get-url origin 2>/dev/null || true)"
[ -n "$ORIGIN" ] || fail "public-origin-missing"

PUBLIC_PREDECESSOR="$(git -C "$PUBLIC" rev-parse HEAD)"
REMOTE_PREDECESSOR="$(
  git ls-remote --heads "$ORIGIN" refs/heads/main 2>/dev/null | awk 'NR==1 {print $1}'
)"
[ -n "$REMOTE_PREDECESSOR" ] || fail "remote-main-missing"
[ "$REMOTE_PREDECESSOR" = "$PUBLIC_PREDECESSOR" ] || fail "remote-predecessor-mismatch"

BAD_META="$(
  git -C "$PUBLIC" log --format='%ae%n%ce' |
    awk 'NF && $0 !~ /@users\.noreply\.github\.com$/ {print; exit}'
)"
[ -z "$BAD_META" ] || fail "public-history-non-noreply-metadata"

AUTHOR_NAME="$(git -C "$PUBLIC" log -1 --format='%an')"
AUTHOR_EMAIL="$(git -C "$PUBLIC" log -1 --format='%ae')"
COMMITTER_NAME="$(git -C "$PUBLIC" log -1 --format='%cn')"
COMMITTER_EMAIL="$(git -C "$PUBLIC" log -1 --format='%ce')"

case "$AUTHOR_EMAIL" in
  *@users.noreply.github.com) ;;
  *) fail "public-author-not-noreply" ;;
esac
case "$COMMITTER_EMAIL" in
  *@users.noreply.github.com) ;;
  *) fail "public-committer-not-noreply" ;;
esac

TMP="$(mktemp -d "${TMPDIR:-/tmp}/cmm-publication-prepare.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM

RAW="$TMP/raw"
CANDIDATE="$TMP/candidate"
VERIFY="$TMP/verify"
mkdir -p "$RAW" "$CANDIDATE" "$VERIFY"

echo "PUBLICATION_SOURCE_SHA=$SOURCE_SHA"
echo "PUBLICATION_PUBLIC_PREDECESSOR=$PUBLIC_PREDECESSOR"
echo "PUBLICATION_REMOTE_PREDECESSOR=$REMOTE_PREDECESSOR"
echo "PUBLICATION_PRECHECK=PASS"

git -C "$INTERNAL" archive --format=tar "$SOURCE_SHA" |
  tar -xf - -C "$RAW"

node "$TREE" sanitize "$RAW" "$CANDIDATE"
node "$TREE" prove "$RAW" "$CANDIDATE"
node "$POLICY" scan-tree "$CANDIDATE"

echo "PUBLIC_CANDIDATE_ALLOWED_TRANSFORM_ONLY=PASS"
echo "PUBLIC_CANDIDATE_PRIVACY_SCAN=PASS"

rsync -a --delete "$CANDIDATE/" "$VERIFY/"

(
  cd "$VERIFY"

  npm ci
  echo "PUBLIC_CANDIDATE_NPM_CI=PASS"

  npm run build
  echo "PUBLIC_CANDIDATE_BUILD=PASS"

  CMM_ROUTERS_PUBLICATION_CANDIDATE_VERIFY=1 npx vitest run
  echo "PUBLIC_CANDIDATE_META_PUBLICATION_TESTS=SKIPPED_RECURSION_GUARD"
  echo "PUBLIC_CANDIDATE_FULL_TEST_SUITE=PASS"

  npm run typecheck
  echo "PUBLIC_CANDIDATE_TYPECHECK=PASS"

  bash scripts/security-audit.sh
  echo "PUBLIC_CANDIDATE_SECURITY_AUDIT=PASS"
)

PUBLIC_GIT_DIR_BEFORE="$(git -C "$PUBLIC" rev-parse --absolute-git-dir)"
PUBLIC_GIT_INODE_BEFORE="$(stat -f '%i' "$PUBLIC_GIT_DIR_BEFORE")"

rsync -a --delete --exclude '.git/' "$CANDIDATE/" "$PUBLIC/"

PUBLIC_GIT_DIR_AFTER="$(git -C "$PUBLIC" rev-parse --absolute-git-dir)"
PUBLIC_GIT_INODE_AFTER="$(stat -f '%i' "$PUBLIC_GIT_DIR_AFTER")"

[ "$PUBLIC_GIT_DIR_AFTER" = "$PUBLIC_GIT_DIR_BEFORE" ] || fail "public-git-dir-changed"
[ "$PUBLIC_GIT_INODE_AFTER" = "$PUBLIC_GIT_INODE_BEFORE" ] || fail "public-git-dir-replaced"

STAGING_TREE="$TMP/staging-tree"
mkdir -p "$STAGING_TREE"
rsync -a --delete --exclude '.git/' "$PUBLIC/" "$STAGING_TREE/"
node "$TREE" prove "$RAW" "$STAGING_TREE"

git -C "$PUBLIC" add -A
git -C "$PUBLIC" diff --cached --check

if git -C "$PUBLIC" diff --cached --quiet; then
  fail "empty-public-diff"
fi

GIT_AUTHOR_NAME="$AUTHOR_NAME" \
GIT_AUTHOR_EMAIL="$AUTHOR_EMAIL" \
GIT_COMMITTER_NAME="$COMMITTER_NAME" \
GIT_COMMITTER_EMAIL="$COMMITTER_EMAIL" \
  git -C "$PUBLIC" commit --quiet -m "$MESSAGE"

PUBLIC_PREPARED_SHA="$(git -C "$PUBLIC" rev-parse HEAD)"
PARENT_COUNT="$(git -C "$PUBLIC" rev-list --parents -n 1 HEAD | awk '{print NF-1}')"
PUBLIC_PARENT="$(git -C "$PUBLIC" rev-parse HEAD^)"

[ "$PARENT_COUNT" = "1" ] || fail "public-prepared-commit-parent-count-not-one"
[ "$PUBLIC_PARENT" = "$PUBLIC_PREDECESSOR" ] || fail "public-parent-not-predecessor"
[ -z "$(git -C "$PUBLIC" status --porcelain)" ] || fail "public-worktree-dirty-after-commit"

if git -C "$PUBLIC" cat-file -e "${SOURCE_SHA}^{commit}" 2>/dev/null; then
  if git -C "$PUBLIC" merge-base --is-ancestor "$SOURCE_SHA" "$PUBLIC_PREPARED_SHA" 2>/dev/null; then
    fail "internal-git-ancestry-imported"
  fi
fi

HEAD_AUTHOR_EMAIL="$(git -C "$PUBLIC" log -1 --format='%ae')"
HEAD_COMMITTER_EMAIL="$(git -C "$PUBLIC" log -1 --format='%ce')"
case "$HEAD_AUTHOR_EMAIL" in
  *@users.noreply.github.com) ;;
  *) fail "prepared-author-not-noreply" ;;
esac
case "$HEAD_COMMITTER_EMAIL" in
  *@users.noreply.github.com) ;;
  *) fail "prepared-committer-not-noreply" ;;
esac

EVIDENCE_DIR="${CMM_ROUTERS_EVIDENCE_DIR:-$HOME/.cmm-routers/publication-evidence}"
mkdir -p "$EVIDENCE_DIR"
REPORT="$EVIDENCE_DIR/CMM-Routers-publication-prepare-${PUBLIC_PREPARED_SHA:0:7}.txt"

{
  echo "INTERNAL_SOURCE_SHA=$SOURCE_SHA"
  echo "PUBLIC_PREDECESSOR_SHA=$PUBLIC_PREDECESSOR"
  echo "PUBLIC_PREPARED_SHA=$PUBLIC_PREPARED_SHA"
  node -e "import('$POLICY').then(m => console.log('SANITIZATION_POLICY_VERSION=' + m.SANITIZATION_POLICY_VERSION))"
  echo "INTERNAL_GIT_ANCESTRY_IMPORTED=NO"
  echo "PUBLIC_WORKTREE_CLEAN=YES"
  echo "PUSH_PERFORMED=NO"
  echo "PUBLICATION_PREPARE_STATUS=READY_FOR_EXPLICIT_PUSH_APPROVAL"
} > "$REPORT"

shasum -a 256 "$REPORT" > "$REPORT.sha256"

cat "$REPORT"
echo "PREPARE_EVIDENCE_REPORT=$REPORT"
echo "PREPARE_EVIDENCE_SHA256=$(awk '{print $1}' "$REPORT.sha256")"
