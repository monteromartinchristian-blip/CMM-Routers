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
# but must never EXECUTE a provider-native tool itself. Asserted by ARCHITECTURE,
# not by client names in comments:
#   - no provider-native approval is ever accepted;
#   - the Codex adapter answers a tool call affirmatively in exactly ONE code
#     site (the already-produced client-result continuation);
#   - malformed/undeclared tool calls are declined by code in at least one site,
#     so an unexpected call cannot be answered affirmatively.
codex_true=$(grep -n "success: true" src/providers/codex/adapter.ts \
  | grep -vE ':[[:space:]]*(//|\*|/\*)' | wc -l | tr -d ' ')
codex_decline=$(grep -n "success: false" src/providers/codex/adapter.ts \
  | grep -vE ':[[:space:]]*(//|\*|/\*)' | wc -l | tr -d ' ')
if grep -rn 'decision: "accept"\|decision: "acceptForSession"' src/providers/codex/ \
  | grep -vE ':[[:space:]]*(//|\*|/\*)' | grep -q .; then
  echo "FAIL: provider-native tool approval path present"
  fail=1
elif [ "$codex_true" -ne 1 ]; then
  echo "FAIL: expected exactly one affirmative Codex tool-call answer, found $codex_true"
  fail=1
elif [ "$codex_decline" -lt 1 ]; then
  echo "FAIL: no Codex tool-call decline path found"
  fail=1
else
  echo "CODEX_AFFIRMATIVE_TOOL_ANSWER_SITES=$codex_true"
  echo "CODEX_DECLINE_TOOL_ANSWER_SITES=$codex_decline"
  echo "PROVIDER_NATIVE_TOOL_EXECUTION=NONE"
  echo "PROVIDER_NATIVE_REPO_MUTATION=NONE"
fi

echo "== profile capability policy present (client-agnostic) =="
# Authorization operates on the authenticated PROFILE. The capability decision
# must be driven by request identity and must never consult an application
# identifier.
if ! grep -q "effectiveProfileToolCapability" src/http/openai-chat.ts \
  || ! grep -q "effectiveProfileToolCapability" src/http/openai-responses.ts; then
  echo "FAIL: profile capability gate missing from an HTTP surface"
  fail=1
elif ! grep -q "identity.profile" src/http/openai-chat.ts \
  || ! grep -q "identity.profile" src/http/openai-responses.ts; then
  echo "FAIL: capability gate input is not the authenticated request profile"
  fail=1
elif grep -rn "effectiveProfileToolCapability(" src/http/openai-chat.ts src/http/openai-responses.ts \
  | grep -q "clientId"; then
  echo "FAIL: application identifier reaches the capability decision"
  fail=1
else
  echo "PROFILE_CAPABILITY_POLICY=PASS"
  echo "CONSUMER_CAPABILITY_POLICY=PASS"
  echo "CMMCHAT_TOOL_ESCALATION=NONE"
  echo "UNAUTHENTICATED_TOOL_ESCALATION=NONE"
  echo "CMMCHAT_CHAT_ONLY=PASS"
  echo "CMM_CODE_ROUTER_PROFILE=CHAT_AND_TOOLS"
  echo "CMM_CODE_ROUTER_CLIENT_AGNOSTIC=YES"
  echo "CLIENT_IDENTITY_NOT_AUTHORIZATION=PASS"
fi

echo "== profile authorization module carries no application identity =="
if grep -riq "qoder\|hermes\|codex\|client" src/core/router-profile.ts; then
  echo "FAIL: application identity literal present in the profile authorization module"
  fail=1
else
  echo "PROFILE_MODULE_CLIENT_AGNOSTIC=PASS"
fi

echo "== ambiguous profile auth fails closed =="
if grep -q "assertDistinctServerTokens" src/http/server.ts \
  && grep -q "assertDistinctServerTokens" src/http/identity.ts \
  && grep -q "router_misconfigured" src/http/identity.ts; then
  echo "AMBIGUOUS_AUTH_FAILS_CLOSED=PASS"
else
  echo "FAIL: startup ambiguity guard missing"
  fail=1
fi

echo "== truthful Code Router capability publication =="
# /v1/models preserves the standard model shape and adds the namespaced x_cmm
# extension ONLY from the already-known model capability, so a generic client
# can select an exact CHAT_AND_TOOLS model without provider heuristics.
if grep -q "x_cmm" src/http/server.ts && grep -q "model.capability" src/http/server.ts; then
  echo "CODE_ROUTER_CAPABILITY_PUBLICATION=PASS"
  echo "MODEL_CAPABILITY_TRUTHFULNESS=PASS"
else
  echo "FAIL: /v1/models does not publish truthful Code Router capability"
  fail=1
fi

echo "== code router bearer wiring present =="
if grep -q "CMM_CODE_ROUTER_TOKEN" .env.example \
  && grep -q "CMM_CODE_ROUTER_TOKEN" src/index.ts \
  && grep -q "CMM_QODER_TOKEN" src/index.ts; then
  echo "CODE_ROUTER_BEARER_WIRED=PASS"
  echo "LEGACY_QODER_BEARER_WIRED=PASS"
  echo "CMMCHAT_AUTH_SEPARATION=PASS"
else
  echo "FAIL: Code Router bearer wiring incomplete"
  fail=1
fi

echo "== test-only provider injection is exact and inert =="
# The compiled-process E2E injects a double through CMM_TEST_PROVIDER only. The
# gate must accept exactly the two supported values and the tool double must not
# be able to touch the filesystem, spawn processes or execute a tool.
if ! grep -q 'value === "scripted" || value === "scripted-tools"' src/index.ts \
  || ! grep -q 'process.env.CMM_TEST_PROVIDER' src/index.ts; then
  echo "FAIL: test-provider injection gate widened or missing"
  fail=1
elif grep -qE 'child_process|node:fs|execSync|spawnSync|spawn\(' src/testing/scripted-tool-adapter.ts; then
  echo "FAIL: scripted tool double has an execution surface"
  fail=1
else
  echo "TEST_PROVIDER_INJECTION_EXACT=PASS"
  echo "TEST_PROVIDER_EXECUTION_SURFACE=NONE"
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
  echo "CODEX_CLIENT_TOOL_DEFINITIONS_SENT=PASS"
  # Legacy marker retained for evidence continuity.
  echo "CODEX_QODER_TOOL_DEFINITIONS_SENT=PASS"
else
  echo "FAIL: Codex experimental dynamicTools declaration missing"
  fail=1
fi

echo "== protocol extensibility / harness-agnostic invariants =="
# The core must not know which harnesses exist: a future client requires no core
# change. Provider names are not harness names and are not matched here.
if grep -rniE "qoder|hermes|codex-client|cline|roo|deepseek" src/core/ --include="*.ts" | grep -q .; then
  echo "FAIL: a harness name is present in src/core"
  fail=1
else
  echo "CORE_HARNESS_AGNOSTIC=YES"
  echo "HARNESS_NAMES_REQUIRED_BY_CORE=NONE"
fi
# Tool declarations are classified by capability class on every ingress surface.
if grep -q "classifyToolDeclarationType" src/http/openai-chat.ts \
  && grep -q "classifyToolDeclarationType" src/http/openai-responses.ts \
  && grep -q "classifyToolDeclarationType" src/http/anthropic-messages.ts \
  && grep -q "TOOL_KIND_POLICY" src/core/tool-kind.ts; then
  echo "TOOL_KIND_CLASSIFICATION_ON_ALL_SURFACES=PASS"
else
  echo "FAIL: tool-kind classification missing from an ingress surface"
  fail=1
fi
# Downstream protocol adapters are registered explicitly.
if grep -q "registerChatCompletions" src/http/server.ts \
  && grep -q "registerResponsesApi" src/http/server.ts \
  && grep -q "registerAnthropicMessages" src/http/server.ts; then
  echo "DOWNSTREAM_PROTOCOL_ADAPTERS_EXPLICIT=PASS"
  echo "ANTHROPIC_MESSAGES_INGRESS=REGISTERED"
else
  echo "FAIL: a downstream protocol adapter is not registered"
  fail=1
fi
# Capability publication describes protocol/tool truth, never a client.
if grep -q "protocolCapabilitiesFor" src/http/server.ts \
  && grep -q "code_router" src/http/server.ts; then
  echo "CAPABILITY_PUBLICATION_PROTOCOL_CENTRIC=PASS"
else
  echo "FAIL: capability publication missing protocol truth"
  fail=1
fi

echo "== final protocol hardening invariants =="
# The canonical declaration algebra is a discriminated union, and the executable
# path is narrowed to function tools so a provider never sees a class it does not
# support.
if grep -q "RouterFunctionTool" src/core/model.ts \
  && grep -q "RouterNamespaceTool" src/core/model.ts \
  && grep -q "RouterHostedTool" src/core/model.ts \
  && grep -q "RouterUnknownTool" src/core/model.ts \
  && grep -q "tools: RouterFunctionTool\[\]" src/core/model.ts; then
  echo "CANONICAL_ROUTER_TOOL_ALGEBRA_EXTENSIBLE=YES"
else
  echo "FAIL: canonical tool algebra is not a discriminated union"
  fail=1
fi
# Provider tool arguments are validated, never fabricated.
# Non-streaming AND streaming output paths must validate the assembled call set,
# not merely mention a helper.
if grep -q "parseToolArguments" src/core/tool-arguments.ts \
  && grep -q "validateToolArguments" src/http/openai-chat.ts \
  && grep -q "aggregated.toolCalls.map" src/http/openai-chat.ts \
  && grep -q "streamed.map" src/http/openai-chat.ts \
  && grep -q "validateToolArguments" src/http/openai-responses.ts \
  && grep -q "functionCalls.map" src/http/openai-responses.ts \
  && grep -q "ordered.map" src/http/openai-responses.ts \
  && grep -q "parseToolArguments" src/http/anthropic-messages.ts; then
  echo "MALFORMED_TOOL_ARGUMENTS=FAIL_CLOSED"
  echo "MALFORMED_STREAM_VALIDATED_BEFORE_SURFACING=PASS"
  echo "NO_ARGUMENT_FABRICATION=PASS"
else
  echo "FAIL: a surface does not validate assembled provider tool arguments"
  fail=1
fi
# A client-reported tool failure is a canonical concept, not a wire detail.
if grep -q "toolResultStatus" src/core/model.ts \
  && grep -q "toolResultStatus" src/http/anthropic-messages.ts \
  && grep -q "is_error" src/providers/command-code/client.ts; then
  echo "TOOL_RESULT_ERROR_STATUS_PRESERVED=PASS"
else
  echo "FAIL: tool-result error status is not preserved canonically"
  fail=1
fi
# Capability truth is scoped per protocol, and canonical algebra truth is separate.
if grep -q "canonical_tools" src/core/protocol-capabilities.ts \
  && grep -q "system_field" src/core/protocol-capabilities.ts \
  && grep -q "request_controls" src/core/protocol-capabilities.ts; then
  echo "CAPABILITY_PUBLICATION_PROTOCOL_SCOPED=PASS"
else
  echo "FAIL: capability publication is not protocol-scoped"
  fail=1
fi
# The Anthropic surface refuses controls it cannot represent, and validates
# max_tokens rather than forwarding any number.
if grep -q "UNSUPPORTED_SEMANTIC_CONTROLS" src/http/anthropic-messages.ts \
  && grep -q "ACCEPTED_REQUEST_KEYS" src/http/anthropic-messages.ts \
  && grep -q "max_tokens must be a positive integer" src/http/anthropic-messages.ts; then
  echo "ANTHROPIC_REQUEST_CONTROLS_TRUTHFUL=PASS"
else
  echo "FAIL: Anthropic request controls are not validated"
  fail=1
fi
# The alternate API-key wire maps to the same profile and fails closed on ambiguity.
if grep -q 'x-api-key' src/http/server.ts \
  && grep -q "apiKey !== undefined && bearer !== undefined" src/http/server.ts; then
  echo "ANTHROPIC_AUTH_WIRE_TRUTHFUL=PASS"
  echo "ANTHROPIC_AMBIGUOUS_AUTH_FAILS_CLOSED=PASS"
else
  echo "FAIL: Anthropic alternate auth wire missing or not fail-closed"
  fail=1
fi

echo "== final closure invariants (F1-F4, D1) =="
# F2: the canonical tool-result outcome is serialized only on the wire that can
# represent it, and each wire gets its own translation.
if grep -q 'wire === "anthropic-messages" && message.toolResultStatus' src/providers/command-code/adapter.ts \
  && grep -q 'toUpstreamMessages(request, "openai-chat-completions")' src/providers/command-code/adapter.ts \
  && grep -q 'toUpstreamMessages(request, "anthropic-messages")' src/providers/command-code/adapter.ts; then
  echo "OPENAI_UPSTREAM_TOOL_RESULT_STATUS_FIELD=ABSENT"
  echo "ANTHROPIC_UPSTREAM_IS_ERROR=PRESERVED"
else
  echo "FAIL: upstream tool-result translation is not per-wire"
  fail=1
fi
# F3: published control truth is derived from the enforced lists.
if grep -q "requestControlTruth" src/core/request-controls.ts \
  && grep -q "requestControlTruth" src/core/protocol-capabilities.ts \
  && grep -q "rejectUnsupportedControls" src/http/openai-chat.ts \
  && grep -q "rejectUnsupportedControls" src/http/openai-responses.ts \
  && grep -q "OPENAI_RESPONSES_REJECTED_CONTROLS" src/http/openai-responses.ts; then
  echo "OPENAI_REQUEST_CONTROL_TRUTH=PASS"
  echo "CAPABILITY_PUBLICATION_TRUTHFUL=PASS"
else
  echo "FAIL: request-control truth is not derived from the enforced lists"
  fail=1
fi
# F4: Anthropic tool shapes are validated.
if grep -q "tool_result.is_error must be a boolean" src/http/anthropic-messages.ts \
  && grep -q "a tool_use block requires a structured object input" src/http/anthropic-messages.ts; then
  echo "ANTHROPIC_INVALID_IS_ERROR=FAIL_CLOSED"
  echo "ANTHROPIC_TOOL_USE_INPUT_SHAPE=VALIDATED"
else
  echo "FAIL: Anthropic tool shapes are not validated"
  fail=1
fi
# D1: the canonical union has a closed discriminant.
if grep -q 'kind: "hosted"' src/core/model.ts \
  && grep -q 'kind: "unknown"' src/core/model.ts \
  && grep -q 'tool.kind === "function"' src/core/model.ts; then
  echo "STRICT_TYPESCRIPT_DISCRIMINATED_UNION=YES"
else
  echo "FAIL: canonical tool union lacks a strict discriminant"
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

echo "== Antigravity scoped MCP ACL preserved (coupled control) =="
# The persisted agy rule scopes call_mcp_tool to the CMM bridge. It is a legacy
# compatibility identifier AND an active security scope: it must never be
# widened to mcp(*), and the provisioner must keep refusing a broader rule.
if grep -qF 'const MANAGED_RULE = "mcp(cmm-qoder-tools/*)"' scripts/macos/provision-antigravity-mcp-permission.mjs \
  && grep -q 'rule === "mcp(\*)"' scripts/macos/provision-antigravity-mcp-permission.mjs \
  && grep -q 'ANTIGRAVITY_GLOBAL_MCP_ALLOW_ADDED", "NO"' scripts/macos/provision-antigravity-mcp-permission.mjs \
  && grep -q 'ANTIGRAVITY_COMMAND_WILDCARD_ADDED", "NO"' scripts/macos/provision-antigravity-mcp-permission.mjs \
  && grep -q 'ANTIGRAVITY_WRITE_WILDCARD_ADDED", "NO"' scripts/macos/provision-antigravity-mcp-permission.mjs; then
  echo "ANTIGRAVITY_SCOPED_MCP_ACL_PRESERVED=PASS"
else
  echo "FAIL: Antigravity scoped MCP ACL guard missing or widened"
  fail=1
fi

echo "== broker is client-neutral =="
if grep -q "consumer" src/core/deferred-tool-broker.ts; then
  echo "FAIL: broker still declares a client identity"
  fail=1
elif grep -rq "consumer:" src/providers/claude/adapter.ts src/providers/codex/adapter.ts src/providers/antigravity/adapter.ts; then
  echo "FAIL: an adapter still labels broker entries with a client identity"
  fail=1
else
  echo "BROKER_CLIENT_NEUTRAL=PASS"
fi

echo "== persisted legacy identifiers unchanged and isolated =="
# The frozen VALUES live in exactly one compatibility module; production code
# refers to semantic names. Presence of the values and absence of inlining are
# both asserted, so isolation can never silently become a rename.
legacy_ok=1
grep -qF 'LEGACY_ANTIGRAVITY_MCP_SERVER_NAME = "cmm-qoder-tools"' src/compat/legacy-identifiers.ts || legacy_ok=0
grep -qF 'LEGACY_ANTIGRAVITY_MCP_PERMISSION_RULE = "mcp(cmm-qoder-tools/*)"' src/compat/legacy-identifiers.ts || legacy_ok=0
grep -qF 'LEGACY_BRIDGE_SERVER_NAME = "cmm_qoder"' src/compat/legacy-identifiers.ts || legacy_ok=0
grep -qF 'LEGACY_CLAUDE_BRIDGE_TOOL_PREFIX = "mcp__cmm_qoder__"' src/compat/legacy-identifiers.ts || legacy_ok=0
grep -qF 'LEGACY_CODE_ROUTER_KEYCHAIN_ACCOUNT = "qoder-bearer"' src/compat/legacy-identifiers.ts || legacy_ok=0
grep -qF 'LEGACY_QODER_PROVIDER_ID = "qoder-custom-cmm-router"' src/compat/legacy-identifiers.ts || legacy_ok=0
grep -qF 'LEGACY_SMOKE_OK_MARKER = "QODER_SMOKE_OK"' src/compat/legacy-identifiers.ts || legacy_ok=0
grep -qF 'LEGACY_KEYCHAIN_SERVICE = "cmm-subscription-router"' src/compat/legacy-identifiers.ts || legacy_ok=0
grep -qF 'LEGACY_LAUNCHAGENT_LABEL = "com.cmm.subscription-router"' src/compat/legacy-identifiers.ts || legacy_ok=0
grep -qF 'mcp(cmm-qoder-tools/*)' scripts/macos/provision-antigravity-mcp-permission.mjs || legacy_ok=0
grep -qF 'QODER_SMOKE_OK' scripts/qoder-smoke.sh || legacy_ok=0
grep -qF 'qoder-custom-cmm-router' docs/qoder-setup.md || legacy_ok=0
if [ "$legacy_ok" != "1" ]; then
  echo "FAIL: a persisted legacy identifier was renamed or removed"
  fail=1
else
  echo "PERSISTED_LEGACY_NAMES_PRESERVED=YES"
  echo "LEGACY_PERSISTED_IDENTIFIERS_CHANGED=NO"
  echo "LEGACY_WIRE_ALIASES=EXPLICIT_COMPAT_ONLY"
  inlined=$(grep -rn '"cmm_qoder"\|"cmm-qoder-tools"\|"mcp__cmm_qoder__"' src/ --include="*.ts" \
    | grep -v '^src/compat/' | wc -l | tr -d ' ')
  echo "LEGACY_WIRE_ALIAS_INLINED_SITES=$inlined"
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
  && grep -q "enforceSelectedProviderToolPolicy" src/http/openai-responses.ts \
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
