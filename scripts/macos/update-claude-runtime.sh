#!/usr/bin/env bash
# Keep the Router's bundled Claude Code runtime current — safely and reversibly.
#
# The Agent SDK packages TWO versions that must never be conflated:
#   * the npm package version      (`@anthropic-ai/claude-agent-sdk` 0.3.316)
#   * the Claude Code runtime      (the SDK's manifest.json 2.1.316)
# Every message and evidence record names both explicitly.
#
# Phases (no phase is skipped):
#   1. preflight      clean tracked checkout, no in-progress Git operation, lock
#   2. resolve        newest published SDK + registry integrity/provenance
#   3. policy         deployment policy decides apply vs prepare (default: prepare)
#   4. validate       throwaway worktree: pin, install, integrity, signatures,
#                     typecheck, build, targeted Claude tests, runtime identity
#   5. canary         isolated Router on a spare port with its OWN bearer;
#                     health, readiness, catalog and required aliases
#   6. apply          backup -> merge -> node_modules swap -> build -> restart
#   7. verify/rollback live startup, auth, catalog; restore the previous runtime
#                     from the backup if anything fails
#
# The live Router's credentials are never read from another process and never
# printed. The canary uses a fresh random bearer. Evidence records versions,
# outcome, reason and rollback state only.
#
# Manual approval is required unless the deployment policy opts in:
#   config/claude-runtime-update-policy.json {"mode":"apply", ...}
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PKG="@anthropic-ai/claude-agent-sdk"
LABEL="${CMM_ROUTER_LABEL:-com.cmm.subscription-router}"
LOG_DIR="${CMM_RUNTIME_UPDATE_LOG_DIR:-$HOME/Library/Logs/CMM-Subscription-Router}"
EVIDENCE="$LOG_DIR/claude-runtime-update-evidence.jsonl"
LOCK="$LOG_DIR/claude-runtime-update.lock"
POLICY="${CMM_RUNTIME_UPDATE_POLICY:-$REPO/config/claude-runtime-update-policy.json}"
TEST_PORT="${CMM_RUNTIME_UPDATE_PORT:-18791}"
NPM="${CMM_NPM_BIN:-npm}"
CURL="${CMM_CURL_BIN:-curl}"
LAUNCHCTL="${CMM_LAUNCHCTL_BIN:-launchctl}"
LSOF="${CMM_LSOF_BIN:-lsof}"
OPENSSL="${CMM_OPENSSL_BIN:-openssl}"
SECURITY="${CMM_SECURITY_BIN:-/usr/bin/security}"
KEYCHAIN_SERVICE="${CMM_ROUTER_KEYCHAIN_SERVICE:-cmm-subscription-router}"
KEYCHAIN_ACCOUNT="${CMM_ROUTER_KEYCHAIN_ACCOUNT:-router-bearer}"

REQUEST=""            # apply | prepare | apply-prepared
PREPARED_REF=""
WORK=""
STAGE_PID=""
BACKUP=""
LIVE_PORT=""
FROM_SDK=""
FROM_RUNTIME=""
TO_SDK=""
TO_RUNTIME=""
POLICY_MODE="prepare"
PROVENANCE="unknown"
HEAD_BEFORE=""
HEAD_AFTER=""
PREPARED_BRANCH=""

mkdir -p "$LOG_DIR"
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

usage() {
  cat <<'EOF'
Usage:
  update-claude-runtime.sh [--prepare]              validate; leave a prepared ref (default)
  update-claude-runtime.sh --apply                  validate and apply when policy allows
  update-claude-runtime.sh --apply-prepared <ref>   apply an already validated ref
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) REQUEST="apply"; shift ;;
    --prepare) REQUEST="prepare"; shift ;;
    --apply-prepared)
      [ "$#" -ge 2 ] || { echo "missing value for --apply-prepared" >&2; exit 2; }
      REQUEST="apply-prepared"; PREPARED_REF="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

record() { # result reason rollback
  python3 - "$EVIDENCE" "$1" "$2" "$3" \
    "$FROM_SDK" "$TO_SDK" "$FROM_RUNTIME" "$TO_RUNTIME" \
    "$POLICY_MODE" "$PROVENANCE" "$HEAD_BEFORE" "$HEAD_AFTER" "$PREPARED_BRANCH" <<'PY'
import json, sys, datetime
(path, result, reason, rollback, fsdk, tsdk, fruntime, truntime,
 mode, provenance, head_before, head_after, prepared) = sys.argv[1:14]
record = {
    "ts": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "result": result,
    "reason": reason,
    "rollback_available": rollback == "yes",
    "from_sdk": fsdk or None,
    "to_sdk": tsdk or None,
    "from_runtime": fruntime or None,
    "to_runtime": truntime or None,
    "policy_mode": mode,
    "provenance": provenance,
    "head_before": head_before or None,
    "head_after": head_after or None,
    "prepared_ref": prepared or None,
}
with open(path, "a", encoding="utf-8") as fh:
    fh.write(json.dumps(record, sort_keys=True) + "\n")
PY
}

cleanup() {
  if [ -n "$STAGE_PID" ]; then
    pkill -P "$STAGE_PID" 2>/dev/null || true
    kill "$STAGE_PID" 2>/dev/null || true
    STAGE_PID=""
  fi
  if [ -n "$WORK" ]; then
    git -C "$REPO" worktree remove --force "$WORK" >/dev/null 2>&1 || true
  fi
  # The lock holds a pid file, so rmdir can never remove it; only ever remove
  # the lock this process owns.
  if [ "$(cat "$LOCK/pid" 2>/dev/null || true)" = "$$" ]; then
    rm -rf "$LOCK"
  fi
}
trap cleanup EXIT

finish() { # result reason rollback exit_code
  record "$1" "$2" "$3"
  log "result=$1 reason=$2 rollback=$3"
  exit "$4"
}

acquire_lock() {
  if mkdir "$LOCK" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK/pid"
    return 0
  fi
  local pid
  pid="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    log "another update is running (pid $pid); stop"
    exit 0
  fi
  # A lock whose owning process is gone is stale immediately; otherwise fall
  # back to age. A leaked lock must never silently disable updates forever.
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
    log "removing stale lock (pid $pid is gone)"
    rm -rf "$LOCK"
    mkdir "$LOCK" && printf '%s\n' "$$" > "$LOCK/pid"
    return 0
  fi
  if [ -d "$LOCK" ] && [ -n "$(find "$LOCK" -maxdepth 0 -mmin +360 2>/dev/null)" ]; then
    log "removing stale lock"
    rm -rf "$LOCK"
    mkdir "$LOCK" && printf '%s\n' "$$" > "$LOCK/pid"
    return 0
  fi
  log "lock present and not provably stale; stop"
  exit 0
}

sdk_version() { # <checkout>
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$1/node_modules/$PKG/package.json"
}

runtime_version() { # <checkout>
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$1/node_modules/$PKG/manifest.json"
}

version_gt() { # a b -> success when a > b
  node -e '
    const [a, b] = process.argv.slice(1);
    const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) process.exit(x > y ? 0 : 1);
    }
    process.exit(1);
  ' "$1" "$2"
}

version_gte() { # a b -> success when a >= b
  if [ "$1" = "$2" ]; then return 0; fi
  version_gt "$1" "$2"
}

major_minor() { printf '%s\n' "${1%.*}"; }

read_policy() {
  if [ ! -f "$POLICY" ]; then
    printf '%s' '{"mode":"prepare","allowedMajorMinor":["0.3"],"requireProvenance":true,"minimumRuntimeVersion":"2.1.280","requiredAliases":[]}'
    return 0
  fi
  node -e '
    const fs = require("fs");
    const raw = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const allowed = Array.isArray(raw.allowedMajorMinor) ? raw.allowedMajorMinor.map(String) : [];
    if (allowed.length === 0) throw new Error("allowedMajorMinor is required");
    const mode = raw.mode === "apply" ? "apply" : "prepare";
    const out = {
      mode,
      allowedMajorMinor: allowed,
      requireProvenance: raw.requireProvenance !== false,
      minimumRuntimeVersion: typeof raw.minimumRuntimeVersion === "string" ? raw.minimumRuntimeVersion : "2.1.0",
      requiredAliases: Array.isArray(raw.requiredAliases) ? raw.requiredAliases.map(String) : [],
    };
    process.stdout.write(JSON.stringify(out));
  ' "$POLICY"
}

create_worktree() { # <sha> <label>
  WORK="$(dirname "$REPO")/worktrees/.claude-runtime-$2-$$"
  mkdir -p "$(dirname "$WORK")"
  rm -rf "$WORK"
  git -C "$REPO" worktree add -q --detach "$WORK" "$1"
}

install_and_validate() { # <expected-sdk> <min-runtime> <integrity>
  local expected="$1" min_runtime="$2" integrity="$3"
  (
    cd "$WORK"
    "$NPM" install --no-audit --no-fund >/dev/null
  ) || return 20
  TO_SDK="$(sdk_version "$WORK")"
  [ "$TO_SDK" = "$expected" ] || return 20
  TO_RUNTIME="$(runtime_version "$WORK")"

  node -e '
    const fs = require("fs");
    const [lockPath, name, expectedVersion, expectedIntegrity] = process.argv.slice(1);
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    const entry = (lock.packages || {})["node_modules/" + name];
    if (!entry) { console.error("lock-entry-missing"); process.exit(1); }
    if (entry.version !== expectedVersion) { console.error("lock-version-mismatch"); process.exit(1); }
    if (expectedIntegrity && entry.integrity !== expectedIntegrity) {
      console.error("lock-integrity-mismatch"); process.exit(1);
    }
  ' "$WORK/package-lock.json" "$PKG" "$expected" "$integrity" || return 21

  node -e '
    const fs = require("fs");
    const [manifestPath, platform] = process.argv.slice(1);
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const info = (m.platforms || {})[platform];
    if (!info || typeof info.checksum !== "string" || !/^[a-f0-9]{64}$/.test(info.checksum)) {
      console.error("runtime-platform-checksum-missing");
      process.exit(1);
    }
  ' "$WORK/node_modules/$PKG/manifest.json" "darwin-$(uname -m)" || return 22

  version_gte "$TO_RUNTIME" "$min_runtime" || return 23

  (
    cd "$WORK"
    "$NPM" run -s typecheck >/dev/null
    "$NPM" run -s build >/dev/null
    "$NPM" run -s test -- tests/providers/claude- >/dev/null
  ) || return 24
}

canary() { # <checkout>
  local work="$1" conf token models i
  conf="$work/.stage-config"
  rm -rf "$conf"
  cp -R "$REPO/config" "$conf"
  node -e '
    const fs = require("fs");
    const [path, port] = process.argv.slice(1);
    const doc = JSON.parse(fs.readFileSync(path, "utf8"));
    doc.port = Number(port);
    fs.writeFileSync(path, JSON.stringify(doc, null, 2));
  ' "$conf/shared.json" "$TEST_PORT"

  token="$("$OPENSSL" rand -hex 24)"
  (
    cd "$work"
    CMM_CONFIG_DIR="$conf" CMM_ROUTER_TOKEN="$token" \
      bash "$work/scripts/macos/run-router.sh" >"$LOG_DIR/claude-runtime-stage.log" 2>&1
  ) &
  STAGE_PID=$!

  for i in $(seq 1 60); do
    "$CURL" -sf -m 2 "http://127.0.0.1:$TEST_PORT/health" >/dev/null 2>&1 && break
    sleep 1
  done
  "$CURL" -sf -m 5 "http://127.0.0.1:$TEST_PORT/health" >/dev/null || return 30
  "$CURL" -sf -m 90 "http://127.0.0.1:$TEST_PORT/ready" >/dev/null || return 31

  models="$work/.stage-models.json"
  "$CURL" -sf -m 90 -H "Authorization: Bearer $token" \
    "http://127.0.0.1:$TEST_PORT/v1/models" > "$models" || return 32

  node -e '
    const fs = require("fs");
    const [path, aliasesJson] = process.argv.slice(1);
    const aliases = JSON.parse(aliasesJson);
    const data = JSON.parse(fs.readFileSync(path, "utf8")).data || [];
    const available = data.filter(
      (m) => typeof m.id === "string" && m.id.startsWith("claude/claude-") && m.availability === "available",
    );
    if (available.length === 0) { console.error("claude-catalog-empty"); process.exit(1); }
    const ids = new Set(data.map((m) => m.id));
    for (const alias of aliases) {
      if (!ids.has("claude/" + alias)) { console.error("alias-missing:" + alias); process.exit(1); }
    }
  ' "$models" "$REQUIRED_ALIASES" || return 33

  pkill -P "$STAGE_PID" 2>/dev/null || true
  kill "$STAGE_PID" 2>/dev/null || true
  STAGE_PID=""
  return 0
}

wait_live() {
  local i
  for i in $(seq 1 60); do
    "$LSOF" -nP -iTCP:"$LIVE_PORT" -sTCP:LISTEN >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

restart_live() {
  "$LAUNCHCTL" kickstart -k "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || return 1
  wait_live
}

live_token() {
  "$SECURITY" find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w 2>/dev/null || true
}

verify_live() {
  local base="http://127.0.0.1:$LIVE_PORT" token code models
  "$CURL" -sf -m 10 "$base/health" >/dev/null || return 40
  "$CURL" -sf -m 120 "$base/ready" >/dev/null || return 41

  code="$("$CURL" -s -o /dev/null -m 10 -w '%{http_code}' -X POST "$base/v1/chat/completions" \
    -H 'content-type: application/json' -d '{"model":"claude/x","messages":[]}' || true)"
  [ "$code" = "401" ] || [ "$code" = "400" ] || return 42

  token="$(live_token)"
  if [ -n "$token" ]; then
    models="$LOG_DIR/claude-runtime-live-models.json"
    "$CURL" -sf -m 120 -H "Authorization: Bearer $token" "$base/v1/models" > "$models" || return 43
    node -e '
      const fs = require("fs");
      const [path, aliasesJson] = process.argv.slice(1);
      const aliases = JSON.parse(aliasesJson);
      const data = JSON.parse(fs.readFileSync(path, "utf8")).data || [];
      const available = data.filter(
        (m) => typeof m.id === "string" && m.id.startsWith("claude/claude-") && m.availability === "available",
      );
      if (available.length === 0) process.exit(1);
      const ids = new Set(data.map((m) => m.id));
      for (const alias of aliases) if (!ids.has("claude/" + alias)) process.exit(1);
    ' "$models" "$REQUIRED_ALIASES" || return 44
    log "live catalog and aliases verified"
  else
    log "live catalog not verified: no Keychain bearer available (route/auth still checked)"
  fi
  return 0
}

backup_live() {
  BACKUP="$LOG_DIR/claude-runtime-backup-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$BACKUP"
  cp -R "$REPO/node_modules/$PKG" "$BACKUP/sdk"
  cp -R "$REPO/dist" "$BACKUP/dist"
  cp "$REPO/package.json" "$BACKUP/package.json"
  cp "$REPO/package-lock.json" "$BACKUP/package-lock.json"
  printf '%s\n' "$HEAD_BEFORE" > "$BACKUP/PREV_HEAD"
}

rollback_live() { # <reason>
  local reason="$1"
  log "rolling back to $HEAD_BEFORE: $reason"
  if [ -d "$REPO/node_modules.prev" ]; then
    rm -rf "$REPO/node_modules"
    mv "$REPO/node_modules.prev" "$REPO/node_modules"
  fi
  git -C "$REPO" reset -q --keep "$HEAD_BEFORE" || true
  if [ -d "$BACKUP/dist" ]; then
    rm -rf "$REPO/dist"
    cp -R "$BACKUP/dist" "$REPO/dist"
  fi
  if restart_live && verify_live; then
    HEAD_AFTER="$(git -C "$REPO" rev-parse HEAD)"
    finish "rolled-back" "$reason" "yes" 1
  fi
  HEAD_AFTER="$(git -C "$REPO" rev-parse HEAD)"
  finish "rollback-failed" "$reason" "yes" 1
}

apply_from_worktree() { # <checkout> <new-sha>
  local work="$1" new_sha="$2"

  backup_live

  # Transactional install: the validated node_modules is swapped in while the
  # operative one stays untouched until success is proven.
  mv "$REPO/node_modules" "$REPO/node_modules.prev"
  if ! cp -R "$work/node_modules" "$REPO/node_modules"; then
    rm -rf "$REPO/node_modules"
    mv "$REPO/node_modules.prev" "$REPO/node_modules"
    finish "failed" "node-modules-swap-failed" "yes" 1
  fi

  if ! git -C "$REPO" merge --ff-only -q "$new_sha" >/dev/null 2>&1; then
    rollback_live "fast-forward-failed"
  fi
  HEAD_AFTER="$(git -C "$REPO" rev-parse HEAD)"

  if ! ( cd "$REPO" && "$NPM" run -s build >/dev/null 2>&1 ); then
    rollback_live "post-deploy-build-failed"
  fi
  if ! restart_live; then
    rollback_live "post-deploy-restart-failed"
  fi
  if ! verify_live; then
    rollback_live "post-deploy-verification-failed"
  fi

  rm -rf "$REPO/node_modules.prev"
  finish "applied" "validated-and-verified" "no" 0
}

# ---------------------------------------------------------------- preflight
acquire_lock

HEAD_BEFORE="$(git -C "$REPO" rev-parse HEAD)"
for op in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply BISECT_LOG; do
  if [ -e "$(git -C "$REPO" rev-parse --git-path "$op")" ]; then
    finish "failed" "git-operation-in-progress:$op" "no" 1
  fi
done
if [ -n "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]; then
  finish "failed" "live-checkout-has-tracked-changes" "no" 1
fi
LIVE_PORT="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("port",8790))' "$REPO/config/shared.json")"

# ------------------------------------------------------------------- policy
POLICY_JSON="$(read_policy)" || finish "failed" "deployment-policy-invalid" "no" 1
POLICY_MODE="$(python3 -c 'import json,sys;print(json.load(sys.stdin)["mode"])' <<<"$POLICY_JSON")"
ALLOWED="$(python3 -c 'import json,sys;print(" ".join(json.load(sys.stdin)["allowedMajorMinor"]))' <<<"$POLICY_JSON")"
REQUIRE_PROVENANCE="$(python3 -c 'import json,sys;print("1" if json.load(sys.stdin)["requireProvenance"] else "0")' <<<"$POLICY_JSON")"
MIN_RUNTIME="$(python3 -c 'import json,sys;print(json.load(sys.stdin)["minimumRuntimeVersion"])' <<<"$POLICY_JSON")"
REQUIRED_ALIASES="$(python3 -c 'import json,sys;print(json.dumps(json.load(sys.stdin)["requiredAliases"]))' <<<"$POLICY_JSON")"
log "policy mode=$POLICY_MODE allowed=$ALLOWED minRuntime=$MIN_RUNTIME"

# --------------------------------------------------------- apply-prepared
if [ "$REQUEST" = "apply-prepared" ]; then
  new_sha="$(git -C "$REPO" rev-parse "$PREPARED_REF^{commit}" 2>/dev/null || true)"
  [ -n "$new_sha" ] || finish "failed" "prepared-ref-not-found" "no" 1
  [ "$(git -C "$REPO" rev-parse "$new_sha^")" = "$HEAD_BEFORE" ] ||
    finish "failed" "prepared-ref-not-based-on-live-head" "no" 1
  if [ "$POLICY_MODE" != "apply" ]; then
    finish "failed" "deployment-policy-does-not-authorize-apply" "no" 1
  fi
  create_worktree "$new_sha" "prepared"
  (
    cd "$WORK"
    "$NPM" ci --no-audit --no-fund >/dev/null
    "$NPM" run -s build >/dev/null
  ) || finish "failed" "prepared-install-failed" "no" 1
  TO_SDK="$(sdk_version "$WORK")"
  TO_RUNTIME="$(runtime_version "$WORK")"
  canary "$WORK" || finish "failed" "canary-failed" "no" 1
  apply_from_worktree "$WORK" "$new_sha"
fi

# --------------------------------------------------------------- resolve
FROM_SDK="$(sdk_version "$REPO")"
FROM_RUNTIME="$(runtime_version "$REPO")"
log "current sdk=$FROM_SDK claudeCodeRuntime=$FROM_RUNTIME"

META="$("$NPM" view "$PKG@latest" version dist.integrity dist.tarball --json 2>/dev/null || true)"
[ -n "$META" ] || finish "noop" "registry-unreachable" "no" 0
LATEST="$(python3 -c 'import json,sys;print(json.load(sys.stdin).get("version",""))' <<<"$META")"
INTEGRITY="$(python3 -c 'import json,sys;print(json.load(sys.stdin).get("dist.integrity",""))' <<<"$META")"
TARBALL="$(python3 -c 'import json,sys;print(json.load(sys.stdin).get("dist.tarball",""))' <<<"$META")"
[ -n "$LATEST" ] || finish "noop" "registry-returned-no-version" "no" 0

if [ "$LATEST" = "$FROM_SDK" ]; then finish "noop" "already-current" "no" 0; fi
version_gt "$LATEST" "$FROM_SDK" || finish "noop" "registry-version-not-newer" "no" 0
TO_SDK="$LATEST"

case " $ALLOWED " in
  *" $(major_minor "$LATEST") "*) : ;;
  *) finish "blocked" "version-outside-policy-range" "no" 1 ;;
esac

if [ "$REQUIRE_PROVENANCE" = "1" ]; then
  case "$TARBALL" in
    https://registry.npmjs.org/*) : ;;
    *) finish "blocked" "untrusted-tarball-origin" "no" 1 ;;
  esac
  case "$INTEGRITY" in
    sha512-*) : ;;
    *) finish "blocked" "missing-registry-integrity" "no" 1 ;;
  esac
fi
PROVENANCE="registry-integrity"

# -------------------------------------------------------------- validate
log "candidate sdk=$LATEST (from $FROM_SDK)"
create_worktree "$HEAD_BEFORE" "$LATEST"
python3 - "$WORK/package.json" "$PKG" "$FROM_SDK" "$LATEST" <<'PY'
import json, sys
path, name, old, new = sys.argv[1:5]
doc = json.load(open(path))
assert doc["dependencies"][name] == old, "unexpected current pin"
doc["dependencies"][name] = new
json.dump(doc, open(path, "w"), indent=2)
open(path, "a").write("\n")
PY

if install_and_validate "$LATEST" "$MIN_RUNTIME" "$INTEGRITY"; then
  :
else
  code=$?
  case "$code" in
    21) reason="lock-integrity-verification-failed" ;;
    22) reason="platform-runtime-checksum-missing" ;;
    23) reason="runtime-below-policy-minimum" ;;
    24) reason="build-or-targeted-tests-failed" ;;
    *) reason="install-or-version-verification-failed" ;;
  esac
  finish "failed" "$reason" "no" 1
fi
log "validated sdk=$TO_SDK claudeCodeRuntime=$TO_RUNTIME"

if [ "$REQUIRE_PROVENANCE" = "1" ]; then
  if ! ( cd "$WORK" && "$NPM" audit signatures >/dev/null 2>&1 ); then
    finish "blocked" "registry-signature-verification-failed" "no" 1
  fi
  PROVENANCE="registry-signature+integrity"
fi

canary "$WORK" || finish "failed" "canary-failed" "no" 1
log "canary passed (catalog and aliases)"

# ---------------------------------------------------------------- commit
(
  cd "$WORK"
  git -c user.name="CMM runtime update" -c user.email="runtime-update@localhost" \
    commit -q -am "chore(claude): actualizar el SDK de Agent a $TO_SDK (Claude Code $TO_RUNTIME)"
)
NEW_SHA="$(git -C "$WORK" rev-parse HEAD)"
PREPARED_BRANCH="cmm/prepared-claude-runtime-$TO_SDK"

should_apply=0
if [ "$REQUEST" = "apply" ] && [ "$POLICY_MODE" = "apply" ]; then
  should_apply=1
fi

if [ "$should_apply" -eq 0 ]; then
  # Validated but not authorized: keep the exact commit reachable as a local
  # ref so an operator can approve it later without redoing the work.
  git -C "$REPO" branch -f "$PREPARED_BRANCH" "$NEW_SHA"
  if [ "$REQUEST" = "apply" ]; then
    finish "prepared" "policy-requires-explicit-approval" "no" 0
  fi
  finish "prepared" "prepare-only" "no" 0
fi

apply_from_worktree "$WORK" "$NEW_SHA"
