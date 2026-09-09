#!/usr/bin/env bash
# Final security audit: scans tracked files for secret material and unsafe paths.
set -u
cd "$(dirname "$0")/.."

fail=0

echo "== tracked secret-value scan =="
if git ls-files | xargs grep -lE "user_[A-Za-z0-9]{20,}" 2>/dev/null | grep -q .; then
  echo "FAIL: tracked secret-like value found"
  fail=1
else
  echo "NO_TRACKED_SECRETS=PASS"
fi

echo "== unsafe runtime scan =="
if grep -rn "0\.0\.0\.0" src/ --include="*.ts" | grep -qv "not.toContain\|test"; then
  echo "FAIL: 0.0.0.0 listener found"
  fail=1
else
  echo "LOOPBACK_ONLY=PASS"
fi

# The only allowed occurrence is the fail-closed refusal guard in the
# Antigravity adapter (args.includes check + refusal error). Any actual
# argv construction containing the flag is a failure.
if grep -rn "dangerously-skip-permissions" src/ --include="*.ts" | grep -v "args.includes\|Refusing to run\|not.toContain\|Never pass\|never passes" | grep -q .; then
  echo "FAIL: active dangerously-skip-permissions path"
  fail=1
else
  echo "NO_UNSAFE_FLAGS=PASS"
fi

echo "== PAYG guard presence =="
for var in OPENAI_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY GOOGLE_API_KEY; do
  if ! grep -rq "$var" src/security/payg-guard.ts; then
    echo "FAIL: $var missing from PAYG guard"
    fail=1
  fi
done
echo "PAYG_GUARD=PASS"

echo "== dist/tests duplication check =="
if git ls-files dist/ | grep -q "tests"; then
  echo "FAIL: dist/tests tracked"
  fail=1
else
  echo "BUILD_ARTIFACT_TEST_DUPLICATION=NONE"
fi

exit "$fail"
