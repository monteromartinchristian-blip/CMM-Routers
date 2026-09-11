#!/usr/bin/env bash
#
# capture-bundle.sh — deterministic, auditable capture of an exact-head Git
# archive plus a matching sha256 manifest.
#
# WHY THIS EXISTS
#   A prior capture procedure printed sha256 hashes that did NOT reproduce
#   against the delivered files (the hash was computed over, or appended to,
#   the file being hashed). This helper makes the byte-identity contract
#   explicit: the bundle and the verification log are hashed only AFTER they
#   are final/closed, and the resulting manifest is a SEPARATE file that
#   `shasum -a 256 -c` can resolve.
#
# USAGE
#   capture-bundle.sh bundle   <ref> <out.tar.gz>
#       Build the exact-head archive:
#         git archive --format=tar.gz --prefix=cmm-routers/ \
#           -o <out.tar.gz> <ref>
#       Nothing is appended to the archive afterwards.
#
#   capture-bundle.sh manifest <bundle> <log> <out.sha256>
#       After <bundle> and <log> are final, compute `shasum -a 256` for each
#       and write a manifest in `shasum -c` format, one line per file:
#           <64-hex-hash>  <path>      (exactly two spaces)
#       <out.sha256> must live in the same directory as <bundle>/<log>; the
#       files are referenced by basename so that `verify` can `cd` into that
#       directory. The manifest is a distinct file: a hash is NEVER appended
#       to the bundle or the log.
#
#   capture-bundle.sh verify <manifest>
#       `cd` to the manifest's directory and run
#         shasum -a 256 -c "$(basename <manifest>)"
#       Its exit status is propagated (0 = all files match).
#
#   capture-bundle.sh selftest
#       Fully deterministic self-test (no real commit required). Creates a
#       temp dir, writes dummy bundle/log bytes, generates a manifest, verifies
#       it, asserts manifest/bundle/log byte identity, and runs a negative
#       control (one flipped byte must make `verify` fail). Prints:
#         CAPTURE_BUNDLE_BYTE_IDENTITY=PASS
#         CAPTURE_LOG_BYTE_IDENTITY=PASS
#         CAPTURE_SHA256_MANIFEST_VERIFY=PASS
#       Exit 0 on success, nonzero on any failure. Temp dir is always removed.
#
set -euo pipefail

PROG="$(basename "$0")"

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

die() {
  printf '%s: ERROR: %s\n' "$PROG" "$*" >&2
  exit 1
}

usage() {
  printf 'usage: %s {bundle|manifest|verify|selftest} [args...]\n' "$PROG" >&2
  printf 'see the header of %s for argument details\n' "$PROG" >&2
}

# Absolute directory of a path (the path itself need not exist).
abspath_dir() {
  printf '%s\n' "$(cd "$(dirname "$1")" && pwd)"
}

# Full path form for an existing file, resolved without following symlinks.
abspath_file() {
  printf '%s/%s\n' "$(abspath_dir "$1")" "$(basename "$1")"
}

# Emit only the 64-hex sha256 digest of a file.
sha256_of() {
  shasum -a 256 "$1" | cut -d' ' -f1
}

# ---------------------------------------------------------------------------
# subcommands
# ---------------------------------------------------------------------------

cmd_bundle() {
  [ "$#" -eq 2 ] || die "bundle: expected <ref> <out.tar.gz>"
  local ref="$1" out="$2"

  command -v git >/dev/null 2>&1 || die "bundle: git not found"
  case "$ref" in
    "") die "bundle: ref must not be empty" ;;
  esac

  local outdir
  outdir="$(abspath_dir "$out")"
  [ -d "$outdir" ] || die "bundle: output directory does not exist: $outdir"

  # Exact-head archive. Nothing is appended after this command completes.
  git archive --format=tar.gz --prefix=cmm-routers/ -o "$out" "$ref"

  local hash
  hash="$(sha256_of "$out")"
  printf 'BUNDLE=%s\n' "$(abspath_file "$out")"
  printf 'SHA256=%s\n' "$hash"
}

cmd_manifest() {
  [ "$#" -eq 3 ] || die "manifest: expected <bundle> <log> <out.sha256>"
  local bundle="$1" log="$2" out="$3"

  command -v shasum >/dev/null 2>&1 || die "manifest: shasum not found"
  [ -f "$bundle" ] || die "manifest: bundle not found: $bundle"
  [ -f "$log" ] || die "manifest: log not found: $log"

  local bdir ldir odir
  bdir="$(abspath_dir "$bundle")"
  ldir="$(abspath_dir "$log")"
  odir="$(abspath_dir "$out")"

  [ "$bdir" = "$ldir" ] || die "manifest: bundle and log must share a directory"
  [ "$odir" = "$bdir" ] || die \
    "manifest: manifest must be written next to the files (expected dir: $bdir)"

  local mf
  mf="$bdir/$(basename "$out")"

  # Refuse to clobber the very files we are hashing.
  [ "$mf" != "$(abspath_file "$bundle")" ] || die "manifest: out path collides with bundle"
  [ "$mf" != "$(abspath_file "$log")" ] || die "manifest: out path collides with log"

  local bhash lhash bbase lbase
  bhash="$(sha256_of "$bundle")"
  lhash="$(sha256_of "$log")"
  bbase="$(basename "$bundle")"
  lbase="$(basename "$log")"

  # Separate manifest file, shasum -c format: "<hash>  <basename>" (two spaces).
  # The hashes were computed above, over the already-final files; no hash is
  # ever appended to the bundle or the log.
  printf '%s  %s\n' "$bhash" "$bbase" > "$mf"
  printf '%s  %s\n' "$lhash" "$lbase" >> "$mf"

  printf 'MANIFEST=%s\n' "$mf"
}

cmd_verify() {
  [ "$#" -eq 1 ] || die "verify: expected <manifest>"
  local manifest="$1"
  [ -f "$manifest" ] || die "verify: manifest not found: $manifest"

  local dir base
  dir="$(abspath_dir "$manifest")"
  base="$(basename "$manifest")"

  # cd into the manifest's directory so basename references resolve.
  # Exit status of shasum is propagated by this subshell / function.
  ( cd "$dir" && shasum -a 256 -c "$base" )
}

cmd_selftest() {
  [ "$#" -eq 0 ] || die "selftest: takes no arguments"

  command -v shasum >/dev/null 2>&1 || die "selftest: shasum not found"
  command -v dd >/dev/null 2>&1 || die "selftest: dd not found"

  local tmp=""
  # shellcheck disable=SC2064
  trap 'if [ -n "${tmp:-}" ] && [ -d "$tmp" ]; then rm -rf "$tmp"; fi' \
    EXIT INT TERM HUP

  tmp="$(mktemp -d "${TMPDIR:-/tmp}/capture-bundle-selftest.XXXXXX")"

  local bundle="$tmp/bundle.tar.gz"
  local log="$tmp/verification.txt"
  local manifest="$tmp/bundle.sha256"

  fail() { printf 'selftest: FAIL: %s\n' "$*" >&2; exit 1; }

  # 1. deterministic dummy inputs (~hundreds of bytes, multibyte content).
  {
    printf 'DUMMY-BUNDLE: deterministic bytes for capture-bundle selftest\n'
    local i=0
    while [ "$i" -lt 6 ]; do
      printf 'bundle-row %s: 多字节 ✓ éèü — 検証 0123456789\n' "$i"
      i=$((i + 1))
    done
  } > "$bundle"

  {
    printf 'VERIFICATION-LOG: deterministic multibyte payload — 検証 ✓\n'
    local j=0
    while [ "$j" -lt 6 ]; do
      printf 'log-row %s: 文字列 multibyte éèü 0123456789\n' "$j"
      j=$((j + 1))
    done
  } > "$log"

  [ -f "$bundle" ] || fail "dummy bundle was not created"
  [ -f "$log" ] || fail "dummy log was not created"

  # 2. generate the manifest over the final files.
  local mout
  mout="$(cmd_manifest "$bundle" "$log" "$manifest")" || fail "manifest subcommand failed"
  [ -f "$manifest" ] || fail "manifest file was not created"

  local bbase lbase
  bbase="$(basename "$bundle")"
  lbase="$(basename "$log")"

  # manifest shape: exactly two lines, "<64-hex>  <basename>".
  local lines
  lines="$(wc -l < "$manifest" | tr -d ' ')"
  [ "$lines" = "2" ] || fail "manifest must have exactly 2 lines, found: $lines"

  local m_bytes
  m_bytes="$(cat "$manifest")"
  case "$m_bytes" in
    *"$bbase"*) : ;;
    *) fail "manifest does not reference the bundle basename" ;;
  esac
  case "$m_bytes" in
    *"$lbase"*) : ;;
    *) fail "manifest does not reference the log basename" ;;
  esac

  # 3. verify must succeed.
  if ! cmd_verify "$manifest" >/dev/null 2>&1; then
    fail "verify failed on a freshly generated manifest"
  fi
  local verify_rc=0
  cmd_verify "$manifest" >/dev/null 2>&1 || verify_rc=$?

  # 4. manifest must be a distinct file from bundle and log.
  [ "$manifest" != "$bundle" ] || fail "manifest path equals bundle path"
  [ "$manifest" != "$log" ] || fail "manifest path equals log path"
  if [ "$manifest" -ef "$bundle" ]; then fail "manifest is the same file as the bundle"; fi
  if [ "$manifest" -ef "$log" ]; then fail "manifest is the same file as the log"; fi

  # 5. bundle and log bytes must be UNCHANGED after manifest generation.
  local mb ml nb nl
  mb="$(cut -d' ' -f1 < "$manifest" | sed -n '1p')"
  ml="$(cut -d' ' -f1 < "$manifest" | sed -n '2p')"
  nb="$(sha256_of "$bundle")"
  nl="$(sha256_of "$log")"
  [ "$nb" = "$mb" ] || fail "bundle bytes changed after manifest generation"
  [ "$nl" = "$ml" ] || fail "log bytes changed after manifest generation"

  # 6. negative control: flip one byte in the log -> verify MUST fail.
  printf 'X' | dd of="$log" bs=1 seek=0 count=1 conv=notrunc 2>/dev/null \
    || fail "could not flip a byte in the log"
  local nf
  nf="$(sha256_of "$log")"
  [ "$nf" != "$nl" ] || fail "negative control did not alter the log bytes"
  if cmd_verify "$manifest" >/dev/null 2>&1; then
    fail "verify passed on a tampered log (negative control)"
  fi

  # 7. success markers (printed only after every check passed).
  [ "$verify_rc" -eq 0 ] || fail "verify exit status was $verify_rc, expected 0"
  printf 'CAPTURE_BUNDLE_BYTE_IDENTITY=PASS\n'
  printf 'CAPTURE_LOG_BYTE_IDENTITY=PASS\n'
  printf 'CAPTURE_SHA256_MANIFEST_VERIFY=PASS\n'
  exit 0
}

# ---------------------------------------------------------------------------
# dispatch
# ---------------------------------------------------------------------------

cmd="${1:-}"
if [ "$#" -gt 0 ]; then
  shift
fi

case "$cmd" in
  bundle)   cmd_bundle "$@" ;;
  manifest) cmd_manifest "$@" ;;
  verify)   cmd_verify "$@" ;;
  selftest) cmd_selftest "$@" ;;
  "" | -h | --help | help)
    usage
    [ -n "$cmd" ] || exit 2
    ;;
  *)
    printf '%s: ERROR: unknown subcommand: %s\n' "$PROG" "$cmd" >&2
    usage
    exit 2
    ;;
esac
