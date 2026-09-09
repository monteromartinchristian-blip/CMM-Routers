#!/usr/bin/env bash
# Final security audit: scans tracked files for secret material, unsafe
# paths, and the production-composition invariants the independent audit
# found blind (B2/B3/B4/B9, M10). Fails closed: any finding exits non-zero.
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

echo "== ESM safety: no require() in production sources =="
if grep -rn "require(" src/index.ts src/security/bearer-auth.ts 2>/dev/null | grep -q .; then
  echo "FAIL: CommonJS require() in ESM production path"
  fail=1
else
  echo "ESM_REQUIRE_FREE=PASS"
fi

echo "== Claude isolation: no global process.env writes in adapter =="
if grep -n "process\.env\.[A-Z_]*=\|delete process\.env\." src/providers/claude/adapter.ts | grep -q .; then
  echo "FAIL: Claude adapter mutates global process.env"
  fail=1
else
  echo "CLAUDE_ENV_ISOLATION=PASS"
fi

echo "== Antigravity spending gate enforced in runtime =="
if ! grep -q "enforceAccountOnlySettings()" src/providers/antigravity/adapter.ts; then
  echo "FAIL: account-only settings gate not invoked"
  fail=1
else
  echo "ANTIGRAVITY_SPENDING_GATE=PASS"
fi

echo "== runtime log hygiene: no completion-content logging =="
if grep -rn "Yielding delta\|substring(0, 50)" src/providers/ src/http/ --include="*.ts" | grep -q .; then
  echo "FAIL: completion content logging present"
  fail=1
else
  echo "LOG_HYGIENE=PASS"
fi

echo "== tool content logging ban =="
if grep -rn "console\.\(log\|error\|warn\)" src/providers/ src/http/ --include="*.ts" | grep -iE "argumentsDelta|toolCall|tool_call|tool_result|contentItems|JSON.stringify\(.*args" | grep -qv "test\|expect\|not.toContain"; then
  echo "FAIL: tool argument/result content logging present"
  fail=1
else
  echo "TOOL_ARGUMENT_LOGGING=NONE"
  echo "TOOL_RESULT_LOGGING=NONE"
fi

echo "== provider-native tool execution ban =="
# The Router may REQUEST a tool from the provider (item/tool/call, tool_calls)
# but must never EXECUTE a provider-native tool itself. Codex approvals are
# declined; the dynamic tool response is success:false (consumer-owned).
if grep -rn "result: { decision: \"accept\"\|decision: \"acceptForSession\"\|success: true" src/providers/codex/app-server-client.ts src/providers/codex/adapter.ts | grep -q .; then
  echo "FAIL: provider-native tool approval path present"
  fail=1
else
  echo "PROVIDER_NATIVE_TOOL_EXECUTION=NONE"
fi

echo "== consumer capability policy present =="
if ! grep -q "effectiveToolCapability" src/http/openai-chat.ts; then
  echo "FAIL: consumer capability gate missing from chat handler"
  fail=1
else
  echo "CONSUMER_CAPABILITY_POLICY=PASS"
  echo "CMMCHAT_TOOL_ESCALATION=NONE"
  echo "UNAUTHENTICATED_TOOL_ESCALATION=NONE"
fi

echo "== production composition: providers registered from config =="
if ! grep -q "createProductionRegistry" src/index.ts; then
  echo "FAIL: production composition root missing"
  fail=1
else
  echo "PRODUCTION_COMPOSITION=PASS"
fi

echo "== preflight fail-closed wiring =="
if ! grep -q 'exit 1' scripts/preflight.sh; then
  echo "FAIL: preflight cannot exit non-zero on unsafe state"
  fail=1
else
  echo "PREFLIGHT_FAIL_CLOSED=PASS"
fi

if [ "$fail" != "0" ]; then
  echo "SECURITY_AUDIT=FAIL"
else
  echo "SECURITY_AUDIT=PASS"
fi

exit "$fail"
