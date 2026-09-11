# CMM Subscription Router — Independent Task 13 Final Protocol Edge Re-audit

**Date:** 2026-09-10
**Audited HEAD:** `814a6998b730bec9c05b0ae98923993cbcf03f37`
**Scope:** Task 13 — Final Protocol Edge Hardening
**Independent verdict:** **FAIL**
**Live provider canaries authorized:** **NO**

---

## 0. Audit method and evidence boundary

This re-audit used the uploaded exact-head Git archive plus the uploaded Mac verification capture.

Fresh independent checks performed against the uploaded artifacts:

```text
UPLOADED_BUNDLE_SHA256=6d528bad845ade64b25a22251d2fb7c56a2a2194884df26b9bd28a29b28b52d0
UPLOADED_LOG_SHA256=1836178622db7edc787088e6213946e09e6c34ae186584569341106fa8fc6997
GZIP_TEST=PASS
ARCHIVE_COMMIT=814a6998b730bec9c05b0ae98923993cbcf03f37
EXTRACTED_FILES=549
```

The archive therefore identifies the expected audited Git HEAD and extracted cleanly.

The uploaded Mac verification transcript records the following executable gate:

```text
HEAD=814a6998b730bec9c05b0ae98923993cbcf03f37

TEST_RUN_1_RC=0
TEST_RUN_2_RC=0
TEST_RUN_3_RC=0
TYPECHECK_RC=0
BUILD_RC=0
POST_BUILD_TEST_RC=0
SECURITY_AUDIT_RC=0
CHANGED_TESTS_RC=0

LIVE_PROVIDER_INFERENCE_RUN=NO
LIVE_CANARY_SCRIPTS_EXECUTED=NO
```

The captured full suite reports:

```text
119 test files passed
5 test files skipped
615 tests passed
25 tests skipped
```

The skipped tests are the pre-existing live-gated provider/mutation integration suites.

This audit environment does not contain the repository's installed `node_modules`, so the TypeScript test suite was **not independently re-executed in the audit container**. The executable test verdict above is therefore evidence captured on the user's Mac; source-level claims below were independently checked against the extracted Git archive.

### Capture-hash note

The verification transcript itself records:

```text
CAPTURE_REPORTED_BUNDLE_SHA256=4028dfae765085947196ef59c6d884c8cf9b93086ae4459a711ba4786b5b83b8
CAPTURE_REPORTED_LOG_SHA256=7cb49ea074351b0f106af45036d9b43261016048172e3431c166c6848a97d20f
```

Those do not equal the freshly computed byte hashes of the two uploaded files.

For the source archive, this is an artifact-byte identity discrepancy:

```text
UPLOADED_BUNDLE_BYTE_HASH_MATCHES_CAPTURE=NO
```

It does **not** change the audited source-tree verdict because the uploaded archive independently passes gzip integrity and embeds the exact expected Git archive commit id:

```text
ARCHIVE_COMMIT_MATCH=YES
```

Before a final release-quality closure bundle, the capture procedure should be adjusted so the exact files later uploaded can be byte-for-byte matched against recorded hashes.

---

# 1. Executive result

`814a699` is a substantial improvement over `516ccdd`.

Independent source inspection supports the following major corrections:

```text
RESPONSES_API_SPECIFIC_TOOL_CHOICE_NORMALIZATION=PASS
ANTIGRAVITY_STREAM_OVERFLOW_TERMINAL_PATH=PASS
MCP_PROVIDER_FACING_STDIO_FRAME_BOUND=PASS
MCP_EXECUTABLE_JSONRPC_IDENTITY_VALIDATION=PASS

CLAUDE_TWO_STEP_TOOL_LOOP=PASS_DETERMINISTIC_ARCHITECTURE
ANTIGRAVITY_TWO_STEP_TOOL_LOOP=PASS_DETERMINISTIC_ARCHITECTURE
CODEX_REUSABLE_TOOL_WAITER=PASS_DETERMINISTIC_ARCHITECTURE
COMMAND_CODE_TWO_STEP_HISTORY_WIRES=PRESENT

CLAUDE_GOOGLE_EXPLICIT_PARALLEL_APPROXIMATION=REMOVED
```

The Mac capture additionally contains repeated PASS markers for all of those deterministic tests and for the multi-step cancellation suite.

However, the final protocol-edge pass is **not closure-eligible**. Two important defects remain in production/acceptance infrastructure, and several secondary hardening gaps remain:

```text
ANTIGRAVITY_MCP_HIDDEN_ENV_RECONCILIATION=FAIL
ANTIGRAVITY_MCP_CANONICAL_TYPE_CHECK=FAIL

LIVE_CANARY_QODER_AUTH=FAIL
LIVE_CANARY_PROVIDER_POLICY_COMPATIBILITY=FAIL
LIVE_CANARY_TOOL_ROUNDTRIP=FAIL
LIVE_CANARY_BLOCKED_EXIT_STATUS=FAIL
LIVE_CANARY_MODEL_SELECTION=FRAGILE

AGY_NAMED_BYTE_LIMITS_ARE_CHARACTER_LIMITS=PARTIAL
SESSION_DESCRIPTOR_ATOMIC_PUBLISH=NOT_PROVEN
AGY_MCP_CLI_EXECUTION_BOUND=FAIL_UNBOUNDED_TIMEOUT
```

The broken canary harness is especially important because the remaining uncertainty is now **live provider behavior**. The scripts prepared to resolve that uncertainty currently cannot do so.

Therefore:

```text
LIVE_PROVIDER_CANARIES_AUTHORIZED=NO
FINAL_TASK13_CLOSURE_ELIGIBLE=NO
```

---

# 2. Responses `tool_choice` normalization — fixed

The prior audit found that Chat Completions and Responses were incorrectly parsed with one wire shape.

Current source separates the two public formats:

```text
parseChatToolChoice(...)
parseResponsesToolChoice(...)
```

and normalizes both into a provider-independent internal representation.

The Chat parser accepts the nested named-function form:

```json
{
  "type": "function",
  "function": {
    "name": "t"
  }
}
```

while the Responses parser accepts the flat form:

```json
{
  "type": "function",
  "name": "t"
}
```

`openai-chat.ts` and `openai-responses.ts` call their own parsers before provider policy enforcement.

The captured tests include:

```text
RESPONSES_CANONICAL_NAMED_FUNCTION_TOOL_CHOICE=PASS
CHAT_RESPONSES_TOOL_POLICY_WIRE_NORMALIZATION=PASS
```

### Verdict

```text
RESPONSES_CANONICAL_NAMED_FUNCTION_TOOL_CHOICE=PASS
API_SPECIFIC_TOOL_CHOICE_NORMALIZATION=PASS
```

---

# 3. Literal provider policy — fixed for Claude/Google

The previous implementation accepted explicit:

```text
parallel_tool_calls=false
```

for Claude/Google even though no exact upstream control was proven.

Current `enforceProviderToolPolicy()` does the conservative thing:

```text
Claude:
  absent parallel_tool_calls -> allowed
  true  -> rejected
  false -> rejected

Google:
  absent parallel_tool_calls -> allowed
  true  -> rejected
  false -> rejected
```

`tool_choice` for Claude/Google accepts only the default/`auto` semantics that the current adapters can faithfully represent.

This removes the previous silent approximation.

### Verdict

```text
CLAUDE_EXPLICIT_PARALLEL_POLICY_NO_SILENT_APPROXIMATION=PASS
GOOGLE_EXPLICIT_PARALLEL_POLICY_NO_SILENT_APPROXIMATION=PASS
```

---

# 4. MCP provider-facing parser — materially fixed

`src/bridge/mcp-bridge-process.ts` now has a finite provider-facing stdio frame limit:

```text
MAX_MCP_STDIO_FRAME_BYTES=1 MiB
```

and checks accumulated byte size while receiving chunks rather than waiting for a newline.

Executable `tools/call` is now checked before it can reach the Router control channel.

The audited production path requires, among other things:

```text
jsonrpc == "2.0"
id is string or finite number
method == "tools/call"
params is an object
params.name is a declared tool
arguments is object-shaped
duplicate in-flight request id is rejected
```

Malformed executable frames therefore no longer automatically acquire Qoder execution authority.

### Verdict

```text
MCP_PROVIDER_FACING_STDIO_FRAME_BOUND=PASS
MCP_TOOL_CALL_JSONRPC_VERSION_REQUIRED=PASS
MCP_TOOL_CALL_JSONRPC_ID_REQUIRED=PASS
MCP_DECLARED_TOOL_ACL=PASS
```

---

# 5. Antigravity event overflow — fixed at the intended adapter boundary

The previous `StreamEventQueue` merely set an `overflowed` flag and dropped events.

Current source makes queue overflow terminal:

```text
queue overflow
→ terminal protocol error retained
→ onOverflow callback
→ exact run AbortController abort
→ drain observes overflow
→ provider_protocol_error
→ normal cleanup
```

The queue is no longer merely memory-bounded; overflow is now observable by production behavior.

The captured Mac tests repeatedly report the relevant markers as PASS.

### Verdict

```text
ANTIGRAVITY_STREAM_QUEUE_BOUND=PASS
ANTIGRAVITY_STREAM_OVERFLOW_FAIL_CLOSED=PASS_DETERMINISTIC
ANTIGRAVITY_STREAM_OVERFLOW_PROVIDER_ABORT=PASS_DETERMINISTIC
```

---

# 6. Antigravity process termination — major correction is present

`src/providers/antigravity/process-client.ts` now has a shared `terminateChild()` primitive.

Normal path:

```text
SIGINT
→ bounded grace period
→ SIGKILL if still alive
→ close/error or bounded terminal verdict
```

The ordinary `AbortSignal` path now calls this same termination machinery instead of only sending SIGINT.

The captured deterministic test uses a real local child that deliberately survives SIGINT and reports:

```text
AGY_ABORT_SIGINT_SENT=PASS
AGY_ABORT_SIGKILL_ESCALATION=PASS
AGY_ABORT_CHILD_EXIT_OBSERVED=PASS
```

### Narrow verdict

```text
AGY_ABORT_SIGKILL_ESCALATION=PASS_NORMAL_LOCAL_PROCESS_CASE
ANTIGRAVITY_ABORT_CONTROLLER_WIRED_TO_TERMINATION=PASS
```

There is still a lower-level semantic caveat in §15: the bounded verdict may settle even if an exceptionally pathological child never delivers a close event.

---

# 7. Multi-step Claude loop — previous one-tool ceiling is removed

This was one of the most important additions in the DeepSeek pass.

The protocol-faithful fake Claude SDK now:

```text
reads production mcpServers
→ spawns the configured MCP child
→ tools/call A
→ waits for result A
→ derives tool B arguments from result A
→ tools/call B
→ waits for result B
→ final text derived from result A and result B
```

There is no `fake.release()`-style manual continuation in the causal path.

Production `ClaudeAdapter` resets the sequential park gate after a successful result:

```text
session.gate.parked = false
```

while unresolved simultaneous calls remain refused.

The capture contains repeated:

```text
CLAUDE_TWO_SEQUENTIAL_TOOLS_SAME_LOGICAL_RUN=PASS
```

### Verdict

```text
CLAUDE_TWO_STEP_TOOL_LOOP=PASS_DETERMINISTIC
CLAUDE_SAME_LOGICAL_RUN=PASS_DETERMINISTIC
CLAUDE_REAL_SUBSCRIPTION_SDK_TWO_STEP_LOOP=LIVE_PROOF_REQUIRED
```

---

# 8. Multi-step Antigravity loop — same agy process architecture is present

The fake agy process is substantially stronger than the earlier test harness.

It spawns the production launcher as its own child and performs:

```text
tool A
→ wait for MCP result A
→ only then issue tool B
→ wait for MCP result B
→ emit final text derived from both
```

This is the right causal direction: the test harness does not inject tool B before result A exists.

Production also reopens the sequential gate after one delivered tool result while retaining the same provider session/run.

The captured tests include:

```text
ANTIGRAVITY_TWO_SEQUENTIAL_TOOLS_SAME_AGY_RUN=PASS
MULTI_STEP_QODER_AGENT_LOOP_GOOGLE=PASS
```

### Verdict

```text
ANTIGRAVITY_TWO_STEP_TOOL_LOOP=PASS_DETERMINISTIC
ANTIGRAVITY_SAME_AGY_RUN=PASS_DETERMINISTIC
ANTIGRAVITY_REAL_AGY_TWO_STEP_LOOP=LIVE_PROOF_REQUIRED
```

---

# 9. Multi-step Codex loop — one-shot waiter replaced

The prior implementation used a one-shot `toolCallFuture`.

Current `CodexAdapter` contains a reusable `pumpTurn()` loop that repeatedly arms a scoped `item/tool/call` waiter against the same:

```text
threadId
turnId
```

After resolving one external call, the loop re-arms for the next provider request instead of immediately becoming text-only.

The captured tests report:

```text
CODEX_TWO_SEQUENTIAL_TOOLS_SAME_THREAD=PASS
CODEX_TWO_SEQUENTIAL_TOOLS_SAME_TURN=PASS
```

### Verdict

```text
CODEX_TWO_STEP_TOOL_LOOP=PASS_DETERMINISTIC
CODEX_SAME_THREAD=PASS_DETERMINISTIC
CODEX_SAME_TURN=PASS_DETERMINISTIC
CODEX_REAL_APP_SERVER_MODEL_TURN=LIVE_PROOF_REQUIRED
```

---

# 10. Command Code two-step history — deterministic coverage exists

The pass adds dedicated two-step tests for both upstream formats:

```text
OpenAI:
assistant.tool_calls A
→ tool result A
→ assistant.tool_calls B
→ tool result B
→ final

Anthropic:
tool_use A
→ tool_result A
→ tool_use B
→ tool_result B
→ final
```

The capture contains repeated PASS markers for both.

### Verdict

```text
COMMAND_CODE_OPENAI_TWO_STEP_TOOL_LOOP=PASS_DETERMINISTIC
COMMAND_CODE_ANTHROPIC_TWO_STEP_TOOL_LOOP=PASS_DETERMINISTIC
```

Live subscription-provider behavior remains a canary item.

---

# 11. Finding F1 — prepared live canaries use the CMMChat bearer, not the Qoder bearer

This is a concrete blocker.

`scripts/live-canary/canary-lib.sh` currently initializes:

```bash
CANARY_TOKEN="${CMM_ROUTER_TOKEN:-}"
```

and all four wrapper scripts tell the operator to set:

```bash
CMM_ROUTER_TOKEN=<router-bearer>
```

But the production server resolves consumers in this order:

```ts
if (bearerSecret matches) return CMMCHAT;
if (qoderToken matches) return QODER;
```

and the capability policy says:

```ts
if (consumer !== QODER) return "CHAT_ONLY";
```

Therefore the live tool canaries authenticate as the **CMMChat consumer**.

They do not authenticate as Qoder.

Consequences:

```text
LIVE_CANARY_AUTHENTICATES_AS_QODER=NO
LIVE_CANARY_QODER_TOOL_CAPABILITY=NO
```

Even setting the same secret for both would not repair this: CMMChat is checked first.

### Required remediation

Use the Qoder bearer:

```text
CMM_QODER_TOKEN
```

or retrieve the already-provisioned Qoder bearer securely from its local Keychain entry.

Never print the token.

### Verdict

```text
LIVE_CANARY_QODER_BEARER=FAIL
```

This alone prevents authorizing the prepared live tool canaries.

---

# 12. Finding F2 — the shared live-canary payload contradicts the provider policy

The shared canary request contains:

```json
{
  "tool_choice": "auto",
  "parallel_tool_calls": false
}
```

But the final provider policy deliberately rejects explicit parallel-tool control for Claude and Google:

```text
parallel_tool_calls=false -> unsupported_capability
```

Codex also rejects explicit `parallel_tool_calls=false` because the app-server surface cannot represent that constraint.

So after correcting the bearer, the common canary payload would still fail before provider inference for:

```text
Claude
Google/Antigravity
ChatGPT/Codex
```

The Codex wrapper comment even states that the canary uses the *absent/default* policy, but the shared library explicitly sends `parallel_tool_calls:false`.

### Verdict

```text
LIVE_CANARY_CLAUDE_POLICY_COMPATIBILITY=FAIL
LIVE_CANARY_GOOGLE_POLICY_COMPATIBILITY=FAIL
LIVE_CANARY_CODEX_POLICY_COMPATIBILITY=FAIL
LIVE_CANARY_COMMAND_CODE_POLICY_COMPATIBILITY=LIKELY_PASS
```

### Required remediation

Generate provider-specific request policy.

For Claude/Google:

```text
omit parallel_tool_calls entirely
tool_choice auto or absent
```

For Codex:

```text
omit unrepresentable parallel control
use only the accepted default/auto semantics
```

For Command Code, exact supported tool-policy controls may be used.

---

# 13. Finding F3 — the prepared live canaries do not execute a tool round-trip

The shared script advertises:

```text
Exactly ONE minimal, non-streaming request
```

and explicitly says:

```text
the tool is NEVER executed by this script
```

That is incompatible with the uncertainty the canaries are supposed to resolve.

The script sends one request with a harmless `canary_echo` definition and then merely inspects whether the response happened to contain a tool call.

If no tool call appears, it prints:

```text
LIVE_CANARY_ROUTE_USES_QODER_TOOL_WIRE=NO
```

but does not fail the canary.

There is no:

```text
Qoder-side synthetic tool execution
tool result submission
same provider continuation
final response verification
```

Therefore it cannot establish the essential live chain:

```text
real provider
→ real tool request
→ Router
→ Qoder execution owner
→ tool result
→ same provider run resumes
→ final answer
```

It cannot resolve the live-only uncertainties listed in the evidence document.

### Required remediation

The canary itself may safely act as the **Qoder-side harmless executor** for one synthetic tool:

```text
request 1 with declared canary_echo
→ REQUIRE exactly one canary_echo call
→ parse safe arguments
→ create local synthetic echo result (no I/O)
→ request 2 carrying the tool result
→ REQUIRE final provider response derived from the echo result
```

For provider surfaces that cannot force tool use, the prompt should strongly require use of `canary_echo`, and failure to emit the tool call must be a failed canary rather than a soft informational marker.

### Verdict

```text
LIVE_CANARY_TOOL_REQUEST_REQUIRED=NO
LIVE_CANARY_TOOL_RESULT_SUBMITTED=NO
LIVE_CANARY_PROVIDER_CONTINUATION_PROVEN=NO
LIVE_CANARY_FULL_ROUNDTRIP=FAIL
```

---

# 14. Finding F4 — `canary_blocked()` exits successfully

Current code:

```bash
canary_blocked() {
  echo "LIVE_CANARY=BLOCKED ..."
  exit 0
}
```

A missing token, wrong auth, quota exhaustion, ambiguous model route, unhealthy Router or unexpected HTTP response therefore terminates with shell success.

This is dangerous acceptance evidence because a wrapper can interpret a completely blocked canary as a passing command.

### Required remediation

Use a distinct nonzero code, for example:

```text
0 = PASS
2 = BLOCKED / prerequisite not satisfied
1 = FAIL
```

or another documented nonzero convention.

### Verdict

```text
LIVE_CANARY_BLOCKED_EXIT_STATUS=FAIL
```

---

# 15. Finding F5 — canary model resolution requires exactly one model per provider

`canary_resolve_model()` filters `/v1/models` by provider prefix and requires:

```bash
count == 1
```

A valid subscription route exposing two or more models becomes:

```text
route-ambiguous-or-absent
```

This makes the canary fragile as model catalogs evolve.

### Recommended remediation

Prefer:

```text
CMM_LIVE_CANARY_MODEL=<exact model id>
```

and verify that:

```text
the exact model exists
its provider prefix is the selected provider
the Router reports the expected route/capability
```

A deterministic documented default may be used only if its selection rule cannot silently switch billing/provider routes.

### Verdict

```text
LIVE_CANARY_MODEL_SELECTION=FRAGILE
```

---

# 16. Finding F6 — Antigravity MCP registration cannot actually prove hidden env is absent

This is the most important remaining production correctness defect.

`src/providers/antigravity/mcp-registration.ts` correctly documents that:

```text
agy mcp list does not print env
```

and even states that a "no env" check can only be enforced by re-issuing `agy mcp add` without `--env`.

But `isCanonical()` checks:

```ts
entry.command === options.command
arraysEqual(entry.args, options.args)
entry.enabled
Object.keys(env).length === 0
```

where `env` is the **desired input options env**, not persisted env discovered from `agy mcp list`.

Then:

```ts
if (before.length === 1 && isCanonical(before[0])) {
  return action: "noop";
}
```

So consider this real restart state:

```text
persisted cmm-qoder-tools:
  visible command = correct
  visible args    = correct
  enabled         = yes
  hidden persisted env:
    OLD_SESSION_SECRET=...
```

Because `agy mcp list` cannot expose the hidden env:

```text
before looks canonical
desired env object is empty
isCanonical == true
action == noop
```

No canonical `agy mcp add` is re-issued.

The stale hidden env survives.

That directly contradicts the evidence claim:

```text
"no env is enforced by re-issuing add"
```

because production only re-issues `add` when a **visible** mismatch exists.

The existing test that clears leftover env also starts with a disabled registration, so the visible disabled status forces the repair and masks this case.

### Required remediation

Because `agy mcp list` cannot prove persisted env:

**Preferred fail-safe design:**

On the first ensure/reconcile in every new Router process:

```text
list
→ validate managed name
→ canonical re-add cmm-qoder-tools WITHOUT --env unconditionally
→ list again
→ verify visible canonical fields
```

This makes the persisted entry secret-free by construction even when it looked canonical before the rewrite.

Alternatively, inspect the exact backing config and verify env directly if that format is stable and safely supported. Do not infer absence from `mcp list`.

### Verdict

```text
ANTIGRAVITY_MCP_HIDDEN_ENV_RECONCILIATION=FAIL
ANTIGRAVITY_MCP_REGISTRATION_SECRET_FREE_PROOF=FAIL
ANTIGRAVITY_MCP_RESTART_RECONCILIATION=PARTIAL
```

---

# 17. Finding F7 — canonical Antigravity MCP registration does not verify `type=="stdio"`

The parsed registration includes:

```ts
type: string
```

but `isCanonical()` does not compare that type to `"stdio"`.

A row with matching visible command/args/status but an unexpected transport type may therefore be accepted as canonical.

### Required remediation

Include:

```text
entry.type === "stdio"
```

in canonical validation and add a RED test for the wrong type.

### Verdict

```text
ANTIGRAVITY_MCP_CANONICAL_TRANSPORT_TYPE_CHECK=FAIL
```

---

# 18. Finding F8 — agy limits named “BYTES” are implemented as JavaScript character counts

`process-client.ts` defines:

```text
MAX_AGY_STDOUT_DIAGNOSTIC_BYTES
MAX_AGY_STDERR_DIAGNOSTIC_BYTES
MAX_AGY_NDJSON_LINE_BYTES
```

but `CappedTextBuffer` and the NDJSON line checks use JavaScript `.length` / `.slice()`.

That measures UTF-16 code units, not UTF-8 bytes.

Consequently a provider sending multibyte Unicode can exceed the documented 64 KiB / 1 MiB byte limits while remaining below the character count.

This does **not** recreate unlimited growth — the strings are still bounded by finite character counts — but the exact byte-limit and cross-layer equivalence claims are false.

### Required remediation

Use:

```ts
Buffer.byteLength(text, "utf8")
```

for protocol limits and implement the diagnostic cap in byte-aware fashion.

Add multibyte adversarial tests.

### Verdict

```text
AGY_OUTPUT_MEMORY_BOUNDED=YES
AGY_UTF8_BYTE_BOUNDS_EXACT=NO
AGY_NAMED_BYTE_LIMITS=PARTIAL
```

---

# 19. Finding F9 — session descriptor publication is not atomic

`BridgeSessionRegistry.register()` publishes:

```ts
writeFileSync(selectorFile(pid), JSON.stringify(descriptor), { mode: 0o600 })
```

directly to the final selector path.

The launcher polls that same descriptor path.

Meanwhile reconciliation treats malformed JSON as stale/malformed and may remove it.

There is therefore a small but real publication race:

```text
Router opens/truncates selector file
→ launcher/reconciler observes partial JSON
→ parse fails
→ descriptor removed
→ Router finishes writing an already-unlinked inode
→ launcher cannot discover session
```

The small descriptor and synchronous write make this low probability, but this is exactly the kind of race a live canary can expose.

### Required remediation

Publish atomically:

```text
write unique temp file in same directory, mode 0600
→ fsync if justified
→ atomic rename to agy-<pid>.json
```

### Verdict

```text
SESSION_DESCRIPTOR_CONTENT_VALIDATION=PASS
SESSION_DESCRIPTOR_ATOMIC_PUBLISH=NOT_PROVEN
```

---

# 20. Finding F10 — `agy mcp list/add` reconciliation calls have no execution timeout

The default MCP registration runner uses:

```ts
execFileSync(agyPath, argv, ...)
```

without a timeout.

If `agy mcp list` or `agy mcp add` hangs, the Router's Node process can block indefinitely while preparing the first Google tool-capable route.

This is inconsistent with the otherwise strongly bounded provider-control design.

### Required remediation

Set a finite:

```text
timeout
maxBuffer
```

on the CLI operation and map timeout/overflow to a fail-closed provider error.

### Verdict

```text
ANTIGRAVITY_MCP_CLI_NO_SHELL=PASS
ANTIGRAVITY_MCP_CLI_EXECUTION_TIME_BOUND=FAIL
ANTIGRAVITY_MCP_CLI_OUTPUT_BOUND=FAIL
```

---

# 21. Lower-level process-exit wording should be narrowed

`terminateChild()` has a final bounded verdict timer that can resolve `"killed"` even if no `close` event was observed.

For ordinary user processes, SIGKILL plus the captured local fixture provides strong evidence.

But the implementation's absolute claim:

```text
guarantees provider process exit
```

is stronger than what the API can prove in every pathological OS state.

Additionally, timeout-triggered termination initiates `requestTermination()` but some terminal settlement still depends on child close/error events.

This is not the primary blocker on this HEAD, but the evidence wording should distinguish:

```text
termination escalation requested and verified against real local child
```

from:

```text
mathematical guarantee that every pathological process has exited
```

### Verdict

```text
AGY_NORMAL_PROCESS_TERMINATION_ESCALATION=PASS
AGY_ABSOLUTE_PROCESS_EXIT_GUARANTEE=OVERCLAIMED
```

---

# 22. What the deterministic core now gets right

The following work should be preserved and not reopened without contrary evidence:

```text
CMMCHAT_CHAT_ONLY=PASS_BASELINE
QODER_CONSUMER_BOUNDARY=PASS_BASELINE

RESPONSES_WIRE_SPECIFIC_TOOL_CHOICE=PRESERVE
PROVIDER_POLICY_LITERAL_CLAUDE_GOOGLE=PRESERVE

MCP_STDIO_FRAME_BOUND=PRESERVE
MCP_STRICT_EXECUTABLE_JSONRPC=PRESERVE
DECLARED_TOOL_ACL=PRESERVE

ANTIGRAVITY_STREAM_OVERFLOW_TERMINAL=PRESERVE
AGY_SIGINT_TO_SIGKILL_ESCALATION=PRESERVE

CODEX_REUSABLE_SAME_TURN_TOOL_PUMP=PRESERVE
CLAUDE_SEQUENTIAL_GATE_REOPEN=PRESERVE
ANTIGRAVITY_SEQUENTIAL_GATE_REOPEN=PRESERVE

COMMAND_CODE_OPENAI_TWO_STEP_HISTORY=PRESERVE
COMMAND_CODE_ANTHROPIC_TWO_STEP_HISTORY=PRESERVE

BROKER_PUBLIC_INTERNAL_IDENTITY_SPLIT=PRESERVE
BROKER_TTL_AND_BOUND=PRESERVE

QODER_EXECUTION_OWNER=PRESERVE
PROVIDER_NATIVE_REPO_MUTATION=NONE_BASELINE

API_PAYG_FALLBACK=NONE_BASELINE
CROSS_PROVIDER_FALLBACK=NONE_BASELINE
UNKNOWN_MODEL_FALLBACK=NONE_BASELINE
COMMAND_CODE_ON_DEMAND=NONE_BASELINE
```

---

# 23. Independent verdict

```text
CMM_SUBSCRIPTION_ROUTER_INDEPENDENT_TASK13_FINAL_PROTOCOL_EDGE_REAUDIT=FAIL

AUDITED_HEAD=814a6998b730bec9c05b0ae98923993cbcf03f37
ARCHIVE_COMMIT=814a6998b730bec9c05b0ae98923993cbcf03f37
ARCHIVE_COMMIT_MATCH=YES
GZIP_TEST=PASS

UPLOADED_BUNDLE_SHA256=6d528bad845ade64b25a22251d2fb7c56a2a2194884df26b9bd28a29b28b52d0
UPLOADED_LOG_SHA256=1836178622db7edc787088e6213946e09e6c34ae186584569341106fa8fc6997

CAPTURE_REPORTED_BUNDLE_SHA256=4028dfae765085947196ef59c6d884c8cf9b93086ae4459a711ba4786b5b83b8
CAPTURE_REPORTED_LOG_SHA256=7cb49ea074351b0f106af45036d9b43261016048172e3431c166c6848a97d20f
UPLOADED_BUNDLE_BYTE_HASH_MATCHES_CAPTURE=NO

MACHINE_REGRESSION_GATE=PASS_CAPTURED
TEST_RUN_1=PASS_CAPTURED
TEST_RUN_2=PASS_CAPTURED
TEST_RUN_3=PASS_CAPTURED
TYPECHECK=PASS_CAPTURED
BUILD=PASS_CAPTURED
POST_BUILD_TEST=PASS_CAPTURED
SECURITY_AUDIT=PASS_CAPTURED
CHANGED_TESTS=PASS_CAPTURED

LIVE_PROVIDER_INFERENCE_RUN=NO

RESPONSES_CANONICAL_NAMED_FUNCTION_TOOL_CHOICE=PASS
API_SPECIFIC_TOOL_CHOICE_NORMALIZATION=PASS

ANTIGRAVITY_STREAM_OVERFLOW_FAIL_CLOSED=PASS_DETERMINISTIC
MCP_PROVIDER_FACING_STDIO_FRAME_BOUND=PASS
MCP_TOOL_CALL_JSONRPC_ID_REQUIRED=PASS

CODEX_TWO_STEP_TOOL_LOOP=PASS_DETERMINISTIC
CLAUDE_TWO_STEP_TOOL_LOOP=PASS_DETERMINISTIC
ANTIGRAVITY_TWO_STEP_TOOL_LOOP=PASS_DETERMINISTIC
COMMAND_CODE_OPENAI_TWO_STEP_TOOL_LOOP=PASS_DETERMINISTIC
COMMAND_CODE_ANTHROPIC_TWO_STEP_TOOL_LOOP=PASS_DETERMINISTIC
MULTI_STEP_QODER_AGENT_LOOP=PASS_DETERMINISTIC_CORE

CLAUDE_GOOGLE_EXPLICIT_PARALLEL_APPROXIMATION=NONE

ANTIGRAVITY_MCP_HIDDEN_ENV_RECONCILIATION=FAIL
ANTIGRAVITY_MCP_REGISTRATION_SECRET_FREE_PROOF=FAIL
ANTIGRAVITY_MCP_CANONICAL_TRANSPORT_TYPE_CHECK=FAIL

LIVE_CANARY_QODER_BEARER=FAIL
LIVE_CANARY_PROVIDER_POLICY_COMPATIBILITY=FAIL
LIVE_CANARY_TOOL_ROUNDTRIP=FAIL
LIVE_CANARY_BLOCKED_EXIT_STATUS=FAIL
LIVE_CANARY_MODEL_SELECTION=FRAGILE

AGY_UTF8_BYTE_BOUNDS_EXACT=NO
SESSION_DESCRIPTOR_ATOMIC_PUBLISH=NOT_PROVEN
ANTIGRAVITY_MCP_CLI_EXECUTION_TIME_BOUND=FAIL

LIVE_PROVIDER_CANARIES_AUTHORIZED=NO
FINAL_TASK13_CLOSURE_ELIGIBLE=NO

NEXT=TASK13_CANARY_AND_REGISTRATION_CORRECTNESS_PASS
```

---

# 24. Required next pass — narrow corrective scope

Do **not** reopen the multi-step provider architecture.

The next remediation should be small and centered on the acceptance boundary:

1. **Fix `cmm-qoder-tools` persistent registration truth**
   - never infer hidden env absence from `agy mcp list`;
   - canonicalize the registration on every new Router process, or inspect exact backing config;
   - require `type=="stdio"`;
   - add finite timeout/maxBuffer to `agy mcp` subprocess operations.

2. **Replace the live canary harness**
   - authenticate with the Qoder bearer;
   - never use the CMMChat bearer for tool acceptance;
   - provider-specific tool policy;
   - blocked/failure exits nonzero;
   - exact model selector or deterministic model selection;
   - require a real tool request;
   - perform harmless Qoder-side `canary_echo`;
   - send the tool result back;
   - require the same provider run to produce a final value derived from the echo result.

3. **Make byte limits genuinely byte-based**
   - UTF-8 `Buffer.byteLength`;
   - multibyte tests.

4. **Publish Antigravity session descriptors atomically**
   - temp file + atomic rename.

5. **Re-capture exact artifacts**
   - ensure the byte hashes printed at capture time correspond to the exact files uploaded for the next independent audit.

After that pass, rerun deterministic gates and perform one final independent re-audit.

Only if that re-audit passes should live subscription canaries be authorized.

---

# 25. Final conclusion

The important architectural news is positive: the new multi-step Qoder loop is no longer merely a claim layered over a one-shot tool path. The inspected Codex, Claude and Antigravity implementations now contain reusable sequential-tool machinery, and the captured tests exercise two-step causal flows.

The remaining blockers are now concentrated at the **real-world acceptance edge** rather than the core tool broker:

```text
persistent Antigravity MCP registration truth
+
correct Qoder-authenticated live canaries
+
real tool-result continuation canary
+
a handful of small hardening bounds/races
```

That is why the correct verdict is still **FAIL**, but the next pass should be materially smaller than the previous ones.

Do not run the current live canary scripts on `814a699`.
