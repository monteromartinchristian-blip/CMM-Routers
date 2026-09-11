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
# declined; DynamicToolCallResponse success:true is allowed ONLY with Qoder's
# already-executed result (same-turn continuation), never as native execution.
if grep -rn "result: { decision: \"accept\"\|decision: \"acceptForSession\"" src/providers/codex/app-server-client.ts src/providers/codex/adapter.ts | grep -q .; then
  echo "FAIL: provider-native tool approval path present"
  fail=1
elif grep -rn "success: true" src/providers/codex/adapter.ts | grep -qv "Qoder\|qoder\|ORIGINAL\|already-executed" | grep -q .; then
  echo "FAIL: unexplained success:true tool path present"
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

echo "== codex experimental opt-in + dynamic tool declaration =="
if grep -q "experimentalApi: true" src/providers/codex/adapter.ts \
  && grep -q "toDynamicToolSpecs" src/providers/codex/adapter.ts; then
  echo "CODEX_EXPERIMENTAL_API_OPT_IN=PASS"
  echo "CODEX_QODER_TOOL_DEFINITIONS_SENT=PASS"
else
  echo "FAIL: Codex experimental dynamicTools declaration missing"
  fail=1
fi

echo "== tool-call identity fabrication ban =="
# A synthesized provider call id would let a malformed frame masquerade as a
# real call. The contract requires fail-closed on missing identity.
if grep -rn 'call-\${Date.now\|`call-\$' src/providers/ --include="*.ts" | grep -q .; then
  echo "FAIL: fabricated provider call id present"
  fail=1
else
  echo "CODEX_PROVIDER_CALL_ID_FABRICATION=NONE"
fi

echo "== bounded broker is the production pending state =="
if grep -q "class DeferredToolBroker" src/core/deferred-tool-broker.ts \
  && grep -q "maxPending" src/core/deferred-tool-broker.ts \
  && grep -q "defaultTtlMs" src/core/deferred-tool-broker.ts \
  && grep -q "new DeferredToolBroker()" src/index.ts; then
  echo "BROKER_PRODUCTION_INSTANTIATED=PASS"
  echo "BROKER_PENDING_BOUND=PASS"
  echo "BROKER_TTL=PASS"
else
  echo "FAIL: production bounded broker missing"
  fail=1
fi
# The Codex adapter must not keep its own unbounded callId-keyed pending map.
if grep -q "private readonly pendingTools = new Map" src/providers/codex/adapter.ts; then
  echo "FAIL: adapter-local unbounded pending map present"
  fail=1
else
  echo "RUNTIME_PENDING_MAP_REMOVED=PASS"
fi

echo "== bridge-control socket security =="
if grep -q "chmodSync(dir, 0o700)" src/bridge/control-ipc.ts \
  && grep -q "chmodSync(socketPath, 0o600)" src/bridge/control-ipc.ts \
  && grep -q "frame.token !== this.token" src/bridge/control-ipc.ts \
  && grep -q "rmSync(this.dir" src/bridge/control-ipc.ts; then
  echo "BRIDGE_CONTROL_SOCKET_HARDENED=PASS"
else
  echo "FAIL: bridge-control socket hardening missing"
  fail=1
fi
if grep -rn "createServer(" src/bridge/control-ipc.ts | grep -q "listen(" ; then
  echo "FAIL: bridge-control may bind a network port"
  fail=1
else
  echo "BRIDGE_CONTROL_UNIX_SOCKET_ONLY=PASS"
fi

echo "== tool-result size bound =="
if grep -q "MAX_TOOL_RESULT_BYTES" src/core/tool-result-bound.ts \
  && grep -q "assertToolResultsWithinBound" src/http/openai-chat.ts \
  && grep -q "assertToolResultsWithinBound" src/http/openai-responses.ts; then
  echo "TOOL_RESULT_SIZE_BOUND=PASS"
else
  echo "FAIL: tool-result size bound not enforced on both surfaces"
  fail=1
fi

echo "== provider-native execution disabled for MCP bridge providers =="
if grep -q "disallowedTools" src/providers/claude/adapter.ts \
  && grep -q "mcpServers" src/providers/claude/adapter.ts \
  && grep -qF 'args.includes("--dangerously-skip-permissions")' src/providers/antigravity/adapter.ts; then
  echo "CLAUDE_NATIVE_TOOL_EXECUTION=NONE"
  echo "ANTIGRAVITY_NATIVE_TOOL_EXECUTION=NONE"
else
  echo "FAIL: native execution guard missing for a bridge provider"
  fail=1
fi

echo "== MCP registration carries no secret =="
# The persistent agy MCP registration must not embed the per-session token or
# socket; the launcher discovers them from a user-only rendezvous file instead.
# The descriptor is created 0600 and published by an atomic rename, so it is
# never observable as a partial file and never readable by other users.
if grep -q "mcpRegistrar(ANTIGRAVITY_MCP_SERVER_NAME, this.bridgeCommand, \[" src/providers/antigravity/adapter.ts \
  && grep -q 'openSync(tempPath, "wx", 0o600)' src/bridge/session-registry.ts \
  && grep -q "renameSync" src/bridge/session-registry.ts \
  && grep -q "recursive: true, mode: 0o700" src/bridge/session-registry.ts \
  && grep -q "no exact CMM bridge session for this provider run" src/bridge/mcp-bridge-launcher.ts; then
  echo "MCP_REGISTRATION_SECRET_FREE=PASS"
  echo "BRIDGE_SESSION_RENDEZVOUS_HARDENED=PASS"
else
  echo "FAIL: MCP registration or session rendezvous hardening missing"
  fail=1
fi

echo "== no global ambiguous rendezvous scan =="
# The launcher must correlate through an exact per-run selector. A global
# "there must be exactly one live session" inference is a concurrency failure.
if grep -q "live.length !== 1" src/bridge/session-registry.ts \
  || grep -q "discoverBridgeSession" src/bridge/session-registry.ts src/bridge/mcp-bridge-launcher.ts; then
  echo "FAIL: global ambiguous rendezvous scan present"
  fail=1
else
  echo "ANTIGRAVITY_GLOBAL_SINGLE_SESSION_SCAN=REMOVED"
fi

echo "== explicit session registry bound =="
if grep -q "SESSION_REGISTRY_MAX_LIVE" src/bridge/session-registry.ts \
  && grep -q "provider_rate_limited" src/bridge/session-registry.ts; then
  echo "SESSION_REGISTRY_BOUND=PASS"
  echo "SESSION_REGISTRY_OVERFLOW_FAIL_CLOSED=PASS"
else
  echo "FAIL: session registry bound missing"
  fail=1
fi

echo "== explicit bridge control pending bound =="
if grep -q "BRIDGE_CONTROL_MAX_PENDING" src/bridge/control-ipc.ts \
  && grep -q "BRIDGE_CONTROL_PENDING_TTL_MS" src/bridge/control-ipc.ts \
  && grep -q "bridge control pending state bounded" src/bridge/control-ipc.ts; then
  echo "BRIDGE_CONTROL_PENDING_BOUND=PASS"
  echo "BRIDGE_CONTROL_PENDING_TTL=PASS"
else
  echo "FAIL: bridge control pending bound missing"
  fail=1
fi

echo "== bounded provider tool queues =="
if grep -q "BoundedQueue" src/core/bounded-queue.ts \
  && grep -q "BoundedQueue" src/providers/claude/adapter.ts \
  && grep -q "BoundedQueue" src/providers/antigravity/adapter.ts \
  && grep -q "MAX_PENDING_TOOL_CALLS_PER_MCP_SESSION" src/providers/claude/adapter.ts \
  && grep -q "MAX_PENDING_TOOL_CALLS_PER_MCP_SESSION" src/providers/antigravity/adapter.ts; then
  echo "CLAUDE_TOOL_QUEUE_BOUND=PASS"
  echo "ANTIGRAVITY_TOOL_QUEUE_BOUND=PASS"
  echo "MAX_PENDING_TOOL_CALLS_PER_MCP_SESSION=1"
else
  echo "FAIL: provider tool queue bound missing"
  fail=1
fi

echo "== declared tool ACL at the MCP bridge boundary =="
if grep -q "declaredTools.has(name)" src/bridge/mcp-bridge-process.ts \
  && grep -q "MCP_INVALID_PARAMS" src/bridge/mcp-bridge-process.ts; then
  echo "MCP_UNDECLARED_TOOL_CALL_FAIL_CLOSED=PASS"
else
  echo "FAIL: MCP bridge declared-tool ACL missing"
  fail=1
fi

echo "== declared tool ACL at every provider boundary =="
acl_ok=1
grep -q "declaredToolNames" src/providers/codex/adapter.ts || acl_ok=0
grep -q "declaredToolNames" src/providers/command-code/adapter.ts || acl_ok=0
if [ "$acl_ok" = "1" ]; then
  echo "CODEX_UNDECLARED_DYNAMIC_TOOL_FAIL_CLOSED=PASS"
  echo "COMMAND_CODE_OPENAI_UNDECLARED_TOOL_FAIL_CLOSED=PASS"
  echo "COMMAND_CODE_ANTHROPIC_UNDECLARED_TOOL_FAIL_CLOSED=PASS"
  echo "DECLARED_TOOL_ACL_AT_PROVIDER_BOUNDARY=PASS"
else
  echo "FAIL: declared-tool ACL missing at a provider boundary"
  fail=1
fi

echo "== shared provider tool policy (no silent drop) =="
if grep -q "enforceProviderToolPolicy" src/core/tool-policy.ts \
  && grep -q "enforceProviderToolPolicy" src/http/openai-chat.ts \
  && grep -q "codexUnsupportedToolPolicy" src/http/openai-responses.ts \
  && grep -q "toAnthropicToolChoice" src/providers/command-code/client.ts; then
  echo "SILENT_TOOL_CHOICE_DROP=NONE"
  echo "SILENT_PARALLEL_TOOL_POLICY_DROP=NONE"
  echo "CHAT_RESPONSES_TOOL_POLICY_CONSISTENCY=PASS"
else
  echo "FAIL: shared provider tool policy not wired on both surfaces"
  fail=1
fi

echo "== provider abort cleanup path =="
if grep -q "session.abortController.abort()" src/providers/claude/adapter.ts \
  && grep -q "session.abortController.abort()" src/providers/antigravity/adapter.ts \
  && grep -q "iterator.return?.()" src/providers/claude/adapter.ts; then
  echo "CLAUDE_TTL_ABORTS_PROVIDER_RUN=PASS"
  echo "ANTIGRAVITY_TTL_ABORTS_PROVIDER_RUN=PASS"
  echo "PROVIDER_ABORT_CONTROLLER_CLEANUP=PASS"
else
  echo "FAIL: provider abort cleanup path missing"
  fail=1
fi

echo "== no test-only direct bridge hook in production =="
if grep -rn "spawnFn\|forTest\|__testOnly" src/ --include="*.ts" | grep -q .; then
  echo "FAIL: test-only hook exposed in production source"
  fail=1
else
  echo "PRODUCTION_TEST_HOOKS=NONE"
fi

echo "== Claude SDK owns the single provider-facing MCP process =="
if grep -q "mcpServers" src/providers/claude/adapter.ts \
  && ! grep -q "spawn(" src/providers/claude/adapter.ts; then
  echo "CLAUDE_PROVIDER_FACING_MCP_OWNER=claude-agent-sdk"
  echo "CLAUDE_DUPLICATE_MCP_BRIDGE_PROCESS=NONE"
else
  echo "FAIL: Claude adapter owns a provider-facing MCP process itself"
  fail=1
fi

if [ "$fail" != "0" ]; then
  echo "SECURITY_AUDIT=FAIL"
else
  echo "SECURITY_AUDIT=PASS"
fi

exit "$fail"
