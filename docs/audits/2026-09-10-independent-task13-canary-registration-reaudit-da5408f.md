# CMM Subscription Router — Independent Task 13 Canary & Registration Re-audit

**Date:** 2026-09-10
**Audited HEAD:** `da5408fcef45c5fac7d22dc64aa1eecb9a2ba497`
**Base HEAD:** `6341e0fc6f36d2933429d524f60d601f5c1deb7a`
**Scope:** Task 13 — Canary & Antigravity Registration Correctness
**Independent verdict:** **FAIL**
**Live provider canaries authorized:** **NO**

---

## 0. Independent artifact integrity

The three uploaded artifacts were independently verified before source inspection.

Fresh byte hashes:

```text
BUNDLE_SHA256=1ba9ee3982bc3ebbd771c68966e9f977e7d9509ca3cfa81dbb3c2367f88a650a
VERIFICATION_SHA256=deb50f48add0dca1f955bfaa069e8db3af8db3cbc7de97cde61c577917a0d0d3
MANIFEST_SHA256=a800c9c32dc0c27c9e6b14e7f38ba1851da500212b71388808e744b29d5b0cec
```

Fresh manifest verification:

```text
CMM-Subscription-Router-task13-canary-registration-reaudit-da5408f.tar.gz: OK
CMM-Subscription-Router-task13-canary-registration-reaudit-da5408f-verification.txt: OK
MANIFEST_VERIFY=PASS
```

Fresh archive verification:

```text
GZIP_TEST=PASS
ARCHIVE_COMMIT=da5408fcef45c5fac7d22dc64aa1eecb9a2ba497
ARCHIVE_COMMIT_MATCH=YES
EXTRACTED_FILES=562
```

The byte-identity defect from the previous audit is therefore resolved for this capture.

The uploaded Mac verification transcript records:

```text
HEAD=da5408fcef45c5fac7d22dc64aa1eecb9a2ba497
BRANCH=main

TEST_RUN_1_RC=0
TEST_RUN_2_RC=0
TEST_RUN_3_RC=0
TYPECHECK_RC=0
BUILD_RC=0
POST_BUILD_TEST_RC=0
SECURITY_AUDIT_RC=0
CHANGED_TESTS_RC=0
LIVE_CANARY_SYNTAX_RC=0

LIVE_PROVIDER_INFERENCE_RUN=NO
LIVE_CANARY_SCRIPTS_EXECUTED=NO
WORKTREE_REMAINED_CLEAN=YES
```

Full-suite counts in the capture:

```text
124 test files passed
5 test files skipped
652 tests passed
25 tests skipped
```

The skipped suites remain the live-gated provider/mutation tests.

The audit container does not contain this repository's installed `node_modules`,
so the full TypeScript/Vitest suite was not independently re-executed here.
The Mac transcript is therefore executable evidence for the regression gate;
the source conclusions below were independently derived from the exact Git archive.

Independent executable checks performed in the audit environment:

```text
bash -n scripts/live-canary/canary-claude.sh=PASS
bash -n scripts/live-canary/canary-antigravity.sh=PASS
bash -n scripts/live-canary/canary-codex.sh=PASS
bash -n scripts/live-canary/canary-command-code.sh=PASS
bash -n scripts/live-canary/canary-lib.sh=PASS
bash -n scripts/capture-bundle.sh=PASS

bash scripts/capture-bundle.sh selftest:
CAPTURE_BUNDLE_BYTE_IDENTITY=PASS
CAPTURE_LOG_BYTE_IDENTITY=PASS
CAPTURE_SHA256_MANIFEST_VERIFY=PASS
```

---

# 1. Executive result

The remediation at `da5408f` fixes almost every defect identified in the previous
independent audit.

Independent source inspection supports:

```text
ANTIGRAVITY_MCP_HIDDEN_ENV_REWRITE_LOGIC=PRESENT
ANTIGRAVITY_MCP_CANONICAL_TYPE_STDIO_REQUIRED=PASS_STATIC
ANTIGRAVITY_MCP_CLI_TIMEOUT_BOUND=PASS_STATIC
ANTIGRAVITY_MCP_CLI_MAXBUFFER_BOUND=PASS_STATIC
ANTIGRAVITY_MCP_CLI_NO_SHELL=PASS_STATIC

AGY_STDOUT_UTF8_BYTE_BOUND=PASS_STATIC
AGY_STDERR_UTF8_BYTE_BOUND=PASS_STATIC
AGY_NDJSON_UTF8_BYTE_BOUND=PASS_STATIC

SESSION_DESCRIPTOR_ATOMIC_PUBLISH=PASS_STATIC
SESSION_DESCRIPTOR_TEMP_MODE_0600=PASS_STATIC
SESSION_DESCRIPTOR_SAME_DIR_RENAME=PASS_STATIC

LIVE_CANARY_QODER_BEARER=PASS_STATIC
LIVE_CANARY_CMMCHAT_FALLBACK=NONE
LIVE_CANARY_EXACT_MODEL_SELECTION=PASS_STATIC
LIVE_CANARY_EXIT_CODES=PASS_STATIC
CAPTURE_BYTE_IDENTITY=PASS_INDEPENDENT
```

However the newly rewritten live-canary harness contains **two P0 correctness
defects** that make its intended live acceptance result capable of being false
or impossible:

```text
F1_COMMAND_CODE_CONTINUATION_TOOL_CHOICE_REQUIRED=FAIL
F2_CANARY_CAUSAL_RESULT_PROOF=FAIL
```

There are also two secondary evidence-quality issues:

```text
F3_SECOND_RESPONSE_TERMINAL_SHAPE_NOT_VALIDATED=PARTIAL
F4_CLIENT_PAYG_POISON_MARKER_DOES_NOT_POISON_ROUTER_PROCESS=OVERCLAIMED
```

Therefore:

```text
LIVE_PROVIDER_CANARIES_AUTHORIZED=NO
TASK13_CANARY_REGISTRATION_CLOSURE_ELIGIBLE=NO
NEXT=TASK13_CANARY_CAUSALITY_AND_PHASE_POLICY_FIX
```

The core multi-step Router/provider architecture should remain closed. The next
pass is narrow and should touch primarily the canary driver/tests.

---

# 2. Antigravity MCP hidden-env reconciliation — remediation is structurally present

The previous defect was that `agy mcp list` cannot reveal persisted env, so a
visible-canonical registration could hide a stale secret and be incorrectly
accepted as `noop`.

Current source now explicitly treats absence of persisted env as unknowable from
`mcp list` and performs process-first canonicalization:

```text
canonicalizedThisProcess = Set<registration identity>

first ensure in Router process:
  list
  -> even if visibly canonical, do not noop
  -> agy mcp add ... cmm-qoder-tools ... WITHOUT --env
  -> list again
  -> verify visible canonical state
  -> mark canonicalizedThisProcess

subsequent ensure in same Router process:
  visible canonical + marker
  -> noop
```

`isCanonical()` now also requires:

```text
entry.type === "stdio"
entry.command === expected
entry.args === expected
entry.enabled === true
desired env is empty
```

The production adapter calls `ensureAntigravityMcpRegistration()` without an env
object, so the production add argv contains no `--env`.

The captured targeted tests include a fake persistent store whose hidden env is
not rendered by `mcp list`, and the GREEN test records
`ANTIGRAVITY_MCP_HIDDEN_ENV_RECONCILIATION=PASS`.

### Evidence boundary

The deterministic fake models the documented/assumed `agy 1.2.0` property that
re-adding an existing named registration without `--env` replaces/clears the
previous env. The current capture shows the real machine currently has:

```text
No MCP servers configured.
```

Therefore no stale hidden env exists in the current real state at capture time.

The source-level remediation is correct under the exact `agy mcp add` replacement
semantics already adopted by the project, but the hidden-env removal itself has
not been demonstrated against a real persisted env entry during this pass.

### Verdict

```text
ANTIGRAVITY_MCP_HIDDEN_ENV_RECONCILIATION=PASS_DETERMINISTIC
ANTIGRAVITY_MCP_SECRET_FREE_BY_CONSTRUCTION=PASS_DETERMINISTIC
ANTIGRAVITY_MCP_REAL_PERSISTED_HIDDEN_ENV_CLEAR=LIVE_NON_INFERENCE_PROOF_NOT_RUN
ANTIGRAVITY_MCP_CANONICAL_TYPE_STDIO_REQUIRED=PASS
```

This is not the blocker on `da5408f`.

---

# 3. Bounded `agy mcp` CLI operations — fixed

`execFileAgyRunner()` now uses:

```text
timeout = 10_000 ms
maxBuffer = 1 MiB
killSignal = SIGTERM
stdio = ignore/pipe/pipe
shell = not used
```

and classifies:

```text
ETIMEDOUT -> timeout
ENOBUFS / ERR_CHILD_PROCESS_STDIO_MAXBUFFER -> max_buffer
ENOENT -> not_found
unexpected signal -> signal
```

`ensureAntigravityMcpRegistration()` converts failed list/add/verification
operations into fail-closed `provider_unavailable`.

The captured changed-test run independently records the real child fixture
passing hanging, oversized stdout, oversized stderr, nonzero exit, normal CLI
and shell-metacharacter argv cases.

### Verdict

```text
ANTIGRAVITY_MCP_CLI_TIMEOUT_BOUND=PASS
ANTIGRAVITY_MCP_CLI_MAXBUFFER_BOUND=PASS
ANTIGRAVITY_MCP_CLI_FAILURE_FAIL_CLOSED=PASS
ANTIGRAVITY_MCP_CLI_NO_SHELL=PASS
```

---

# 4. UTF-8 byte limits — fixed

The previous implementation used JavaScript string length for limits named
`*_BYTES`.

Current source uses `Buffer.byteLength(..., "utf8")` for the NDJSON protocol
limits and introduces code-point-aware:

```text
truncateUtf8Head()
truncateUtf8Tail()
CappedTextBuffer
```

The retained diagnostic value is bounded by encoded UTF-8 byte length and avoids
splitting a Unicode code point.

The captured tests exercise multibyte-only payloads and both terminated and
unterminated oversized NDJSON lines.

### Verdict

```text
AGY_STDOUT_UTF8_BYTE_BOUND=PASS
AGY_STDERR_UTF8_BYTE_BOUND=PASS
AGY_NDJSON_UTF8_BYTE_BOUND=PASS
AGY_DIAGNOSTIC_MEMORY_REMAINS_BOUNDED=PASS
```

---

# 5. Atomic session descriptor publication — fixed

`BridgeSessionRegistry.publishDescriptor()` now performs:

```text
openSync(unique same-directory temp, "wx", 0600)
write complete JSON
fsync
close
renameSync(temp, final agy-<pid>.json)
```

The temp naming contract is outside the final descriptor naming contract, and
temp cleanup runs under the registry directory lock.

The captured race test records:

```text
SESSION_DESCRIPTOR_PARTIAL_JSON_VISIBLE=NO
SESSION_DESCRIPTOR_ATOMIC_PUBLISH=PASS
SESSION_DESCRIPTOR_MODE_0600=PASS
```

and the source implements exactly the temp+rename structure the test claims.

### Verdict

```text
SESSION_DESCRIPTOR_ATOMIC_PUBLISH=PASS
SESSION_DESCRIPTOR_PARTIAL_JSON_VISIBLE=NO_DETERMINISTIC
SESSION_DESCRIPTOR_MODE_0600=PASS
```

---

# 6. Qoder bearer and exact model selection — fixed

The old canary used `CMM_ROUTER_TOKEN`, which identifies the CMMChat consumer.

Current driver resolves:

```text
CMM_QODER_TOKEN
or
Keychain service/account:
  cmm-subscription-router / qoder-bearer
```

matching the production `scripts/macos/run-router.sh` contract.

It never falls back to the CMMChat bearer and blocks a directly visible token
collision.

The driver requires:

```text
CMM_LIVE_CANARY_MODEL=<exact router model id>
```

and checks `/v1/models` for:

```text
exact id
provider prefix == wrapper provider
owned_by == cmm:<provider>
```

There is no prefix-based fallback selection.

### Verdict

```text
LIVE_CANARY_AUTH_SOURCE=QODER
LIVE_CANARY_CMMCHAT_BEARER_FALLBACK=NONE
LIVE_CANARY_EXACT_MODEL_SELECTION=PASS
LIVE_CANARY_MODEL_FALLBACK=NONE
LIVE_CANARY_BLOCKED_EXIT=2
LIVE_CANARY_FAIL_EXIT=1
LIVE_CANARY_PASS_EXIT=0
```

---

# 7. Finding F1 — Command Code uses `tool_choice: required` on the continuation request

This is a P0 live-canary correctness blocker.

The driver builds provider policy once:

```ts
const policy = buildCanaryPolicy(provider);
```

For Command Code:

```ts
return { tool_choice: "required" };
```

The same `policy` object is spread into **both** request bodies:

```text
request 1:
  ...policy

request 2, AFTER the canary_echo result:
  ...policy
```

Production does not remove this field on continuation.

For Command Code OpenAI wire, the adapter forwards it as:

```text
tool_choice = "required"
```

For Command Code Anthropic wire, the internal normalized `required` maps to:

```text
tool_choice = { type: "any" }
```

Both semantics mean the model is required to issue another tool call.

But request 2 is supposed to produce the final textual answer.

So the live sequence currently asks Command Code to do two mutually incompatible
things:

```text
request 2:
  here is the canary_echo tool result
  AND tool_choice=required
  AND please give me final text
```

A provider obeying the declared policy should request another tool instead of
terminating with final text.

### Why the deterministic test misses it

`tests/live-canary/canary-driver.test.ts` asserts that Command Code policy equals:

```text
{ tool_choice: "required" }
```

but its fake Router only mirrors rejection rules for unsupported provider fields.
On the continuation path, once it sees a `role:"tool"` message, it directly
returns final text.

It never models the semantic consequence of `tool_choice:"required"` on request 2.

The real Fastify integration test uses a synthetic `CanaryAdapter` that also
ignores `request.toolChoice` when producing the final response.

Therefore the deterministic PASS is a false positive for this exact live
Command Code condition.

### Required remediation

Make canary policy **phase-specific**, not merely provider-specific.

Recommended:

```text
request 1:
  command-code -> tool_choice=required

request 2:
  command-code -> tool_choice=none
```

`none` is exactly representable on both supported Command Code upstream wires and
expresses the actual acceptance requirement: consume the supplied tool result and
terminate without requesting another tool.

For Claude / Google / Codex, continue using only representable/default policy.

Add a policy-faithful fake where request 2 with `required` emits a second tool
call. It MUST fail on `da5408f` and pass after the correction.

### Verdict

```text
COMMAND_CODE_CANARY_REQUEST1_POLICY=PASS
COMMAND_CODE_CANARY_REQUEST2_POLICY=FAIL
COMMAND_CODE_LIVE_CANARY_TERMINAL_CONTINUATION=NOT_VALID
```

---

# 8. Finding F2 — the final sentinel does not prove causal consumption of the tool result

This is the second P0 blocker.

The driver generates one sentinel `S`.

Before any tool result exists, the original user prompt already contains `S`:

```text
You must call canary_echo exactly once with {"text":"S"}
```

The provider therefore knows `S` from the user message.

After the tool call, the synthetic result is:

```text
RESULT=S|echo=<tool argument>
```

The final proof only checks:

```ts
content.includes(`RESULT=${S}|echo=`)
```

That does **not** prove the final provider response consumed the tool result.

A provider that ignored the tool-result message could still manufacture:

```text
RESULT=S|echo=
```

using only the sentinel it saw in the original user prompt.

The evidence statement:

```text
"the final response can only reproduce it by actually consuming the result"
```

is therefore false for this implementation.

### Stronger causal construction

Use two independent random values:

```text
CALL_SENTINEL = S
RESULT_NONCE  = R
```

`S` may appear in request 1.

`R` MUST be generated only **after** the valid tool call is received and must
never appear in:

```text
original prompt
assistant tool call
tool arguments
any prior message
```

Synthetic result:

```text
RESULT_NONCE=R|echo=S
```

The final provider response must contain the exact complete result token or at
least the unpredictable `RESULT_NONCE=R`.

Now a response that ignores the tool-result message cannot know `R`.

Also require:

```text
tool argument text === CALL_SENTINEL
```

rather than merely accepting any `{text:string}`.

### Required adversarial RED

Add a fake provider whose continuation deliberately ignores the tool result and
returns a plausible value constructed only from the original prompt sentinel:

```text
RESULT=S|echo=S
```

On `da5408f`, this can satisfy the current final-prefix logic.

After the fix it must fail because the provider never saw `RESULT_NONCE=R`.

### Verdict

```text
LIVE_CANARY_TOOL_RESULT_IS_UNIQUE_INFORMATION=NO
LIVE_CANARY_FINAL_CAUSALITY_PROOF=FAIL
LIVE_CANARY_FINAL_DERIVED_FROM_TOOL_RESULT=NOT_PROVEN
```

---

# 9. Finding F3 — second response terminal shape is not validated

The current second-response path checks only:

```text
HTTP 200
message.content is a string
content includes expected token
```

It does not reject:

```text
additional tool_calls
finish_reason == tool_calls
```

A response could therefore contain another tool request plus some matching text
and still be treated as a completed round-trip.

This interacts directly with F1: a Command Code provider obeying
`tool_choice:required` could emit another tool request on request 2.

### Required remediation

For request 2 require a true terminal response:

```text
no tool_calls
finish_reason != tool_calls
final content present
final content contains unpredictable RESULT_NONCE
```

Prefer requiring:

```text
finish_reason == stop
```

unless a provider-normalization rule gives another explicitly accepted terminal
reason.

### Verdict

```text
LIVE_CANARY_SECOND_RESPONSE_TERMINAL_SHAPE=PARTIAL
```

---

# 10. Finding F4 — PAYG poison marker is client-local, not Router-local

The driver mutates:

```ts
deps.env.OPENAI_API_KEY
deps.env.ANTHROPIC_API_KEY
deps.env.GEMINI_API_KEY
...
```

In the real canary, `deps.env` is the **canary process's** `process.env`.

The live provider turn is executed by the already-running Router process.

Therefore:

```text
LIVE_CANARY_PAYG_POISON=PASS
```

does not itself prove that the Router/provider subprocess receives poison values;
the canary cannot retroactively mutate another process's environment.

This does **not** mean the project has a PAYG hole.

Production `loadConfig()` independently executes:

```ts
assertNoPaygFallback(process.env)
```

before normal production composition, and provider-specific child environments
have additional stripping/guards. Therefore the economic invariant is structurally
protected by the Router.

The issue is the canary marker/evidence wording, not the current production
PAYG guard.

### Recommended remediation

Do not present client-local poisoning as proof of Router/provider poisoning.

Either:

```text
rename marker:
LIVE_CANARY_CLIENT_PAYG_POISON=PASS
```

and separately document:

```text
ROUTER_STARTUP_PAYG_GUARD=PASS_DETERMINISTIC
```

or add a safe non-secret runtime invariant to the Router health/preflight surface
that confirms the production process has its PAYG guard active.

Do not expose environment values.

### Verdict

```text
API_PAYG_FALLBACK_PRODUCTION_GUARD=PRESERVED
LIVE_CANARY_PAYG_POISON_MARKER=OVERCLAIMED
```

This finding is secondary to F1/F2.

---

# 11. Capture byte identity — independently fixed

This is the first capture in this chain whose separately uploaded manifest
independently verifies the exact uploaded bundle and verification transcript.

Fresh independent command:

```text
shasum -a 256 -c <manifest>
```

returned both files `OK`.

Fresh `capture-bundle.sh selftest` also passed in the audit environment.

### Verdict

```text
CAPTURE_BUNDLE_BYTE_IDENTITY=PASS
CAPTURE_LOG_BYTE_IDENTITY=PASS
CAPTURE_SHA256_MANIFEST_VERIFY=PASS
```

Preserve this workflow.

---

# 12. Deterministic regression signal

The uploaded Mac capture provides a strong regression signal:

```text
FULL_SUITE_X3=PASS_CAPTURED
TYPECHECK=PASS_CAPTURED
BUILD=PASS_CAPTURED
POST_BUILD_TEST=PASS_CAPTURED
SECURITY_AUDIT=PASS_CAPTURED
CHANGED_TESTS=PASS_CAPTURED
LIVE_CANARY_SHELL_SYNTAX=PASS_CAPTURED

TEST_FILES=129
PASSED_TEST_FILES=124
SKIPPED_TEST_FILES=5

TESTS=677
PASSED_TESTS=652
SKIPPED_TESTS=25
```

The targeted changed-test capture includes successful execution of:

```text
tests/bridge/session-registry-atomic.test.ts
tests/live-canary/canary-driver.test.ts
tests/providers/antigravity-byte-limits.test.ts
tests/providers/antigravity-mcp-canonicalization.test.ts
tests/providers/antigravity-mcp-cli-bounds.test.ts
```

Those tests genuinely cover the new code, but the canary test model is incomplete
in exactly the two ways described by F1/F2.

Therefore test green does not override the source-level findings.

---

# 13. Independent verdict matrix

```text
CMM_SUBSCRIPTION_ROUTER_INDEPENDENT_TASK13_CANARY_REGISTRATION_REAUDIT=FAIL

AUDITED_HEAD=da5408fcef45c5fac7d22dc64aa1eecb9a2ba497
BASE_HEAD=6341e0fc6f36d2933429d524f60d601f5c1deb7a

BUNDLE_SHA256=1ba9ee3982bc3ebbd771c68966e9f977e7d9509ca3cfa81dbb3c2367f88a650a
VERIFICATION_SHA256=deb50f48add0dca1f955bfaa069e8db3af8db3cbc7de97cde61c577917a0d0d3
MANIFEST_SHA256=a800c9c32dc0c27c9e6b14e7f38ba1851da500212b71388808e744b29d5b0cec

MANIFEST_VERIFY=PASS
GZIP_TEST=PASS
ARCHIVE_COMMIT=da5408fcef45c5fac7d22dc64aa1eecb9a2ba497
ARCHIVE_COMMIT_MATCH=YES

FULL_REGRESSION_X3=PASS_CAPTURED
TYPECHECK=PASS_CAPTURED
BUILD=PASS_CAPTURED
POST_BUILD_TEST=PASS_CAPTURED
SECURITY_AUDIT=PASS_CAPTURED
CHANGED_TESTS=PASS_CAPTURED
LIVE_PROVIDER_INFERENCE_RUN=NO

ANTIGRAVITY_MCP_HIDDEN_ENV_RECONCILIATION=PASS_DETERMINISTIC
ANTIGRAVITY_MCP_CANONICAL_TYPE_STDIO_REQUIRED=PASS
ANTIGRAVITY_MCP_CLI_TIMEOUT_BOUND=PASS
ANTIGRAVITY_MCP_CLI_MAXBUFFER_BOUND=PASS
ANTIGRAVITY_MCP_CLI_NO_SHELL=PASS

AGY_STDOUT_UTF8_BYTE_BOUND=PASS
AGY_STDERR_UTF8_BYTE_BOUND=PASS
AGY_NDJSON_UTF8_BYTE_BOUND=PASS

SESSION_DESCRIPTOR_ATOMIC_PUBLISH=PASS
SESSION_DESCRIPTOR_MODE_0600=PASS

LIVE_CANARY_QODER_BEARER=PASS
LIVE_CANARY_CMMCHAT_FALLBACK=NONE
LIVE_CANARY_EXACT_MODEL_SELECTION=PASS
LIVE_CANARY_EXIT_CODES=PASS

COMMAND_CODE_CANARY_REQUEST1_TOOL_CHOICE=REQUIRED
COMMAND_CODE_CANARY_REQUEST2_TOOL_CHOICE=REQUIRED
COMMAND_CODE_CANARY_REQUEST2_POLICY=FAIL

LIVE_CANARY_CALL_SENTINEL_VISIBLE_IN_PROMPT=YES
LIVE_CANARY_RESULT_PROOF_USES_SAME_SENTINEL=YES
LIVE_CANARY_RESULT_ONLY_NONCE=NONE
LIVE_CANARY_FINAL_CAUSALITY_PROOF=FAIL

LIVE_CANARY_SECOND_RESPONSE_REJECTS_EXTRA_TOOL_CALLS=NO
LIVE_CANARY_SECOND_RESPONSE_TERMINAL_SHAPE=PARTIAL

API_PAYG_FALLBACK_PRODUCTION_GUARD=PRESERVED
LIVE_CANARY_CLIENT_LOCAL_PAYG_POISON=YES
LIVE_CANARY_REMOTE_ROUTER_PAYG_POISON_PROOF=NO

CAPTURE_BUNDLE_BYTE_IDENTITY=PASS
CAPTURE_LOG_BYTE_IDENTITY=PASS
CAPTURE_SHA256_MANIFEST_VERIFY=PASS

LIVE_PROVIDER_CANARIES_AUTHORIZED=NO
FINAL_TASK13_CLOSURE_ELIGIBLE=NO

BLOCKERS=2
MAJORS=1
MINORS=1

NEXT=TASK13_CANARY_CAUSALITY_AND_PHASE_POLICY_FIX
```

---

# 14. Required next pass — very narrow

Do **not** reopen:

```text
Codex tool pump
Claude MCP bridge
Antigravity MCP topology
DeferredToolBroker
Command Code provider adapters
multi-step provider architecture
registration/byte/descriptor fixes that just passed
```

The next pass should modify primarily:

```text
scripts/live-canary/canary-driver.ts
tests/live-canary/canary-driver.test.ts
evidence docs
```

Required corrections:

1. **Phase-specific Command Code policy**
   - request 1: `tool_choice=required`
   - request 2: `tool_choice=none`
   - fake provider must obey required/none semantics.

2. **Unpredictable result-only nonce**
   - prompt contains `CALL_SENTINEL=S`;
   - valid tool args must equal S;
   - only after tool request, generate `RESULT_NONCE=R`;
   - R must appear nowhere before the tool-result message;
   - final must contain R / exact result token.

3. **Adversarial causality negative control**
   - fake provider ignores tool result and fabricates output from prompt sentinel;
   - current implementation must be shown RED;
   - fixed implementation must reject it.

4. **Terminal second-response validation**
   - no second-response tool calls;
   - `finish_reason` must be terminal;
   - extra tool request is FAIL.

5. **Evidence wording**
   - distinguish client-local PAYG poison from the Router startup PAYG guard;
   - do not claim the client process can alter the Router's environment.

Recommended but non-blocking:
- finite HTTP timeout around canary `/health`, `/v1/models`, request 1 and request 2.

After this small pass:

```text
npm test x3
typecheck
build
post-build test
security audit
changed canary test by path
bash -n wrappers
capture manifest
independent re-audit
```

Only then should the real provider canaries be authorized.

---

# 15. Final conclusion

`da5408f` is not another broad architectural failure.

The Antigravity registration correction, UTF-8 bounds, atomic descriptor
publication, Qoder bearer selection, exact model selection, exit semantics and
capture-byte identity are materially improved and should be preserved.

The remaining failure is concentrated in the acceptance canary itself:

```text
Command Code is forced to call a tool again on the supposed final request
+
the final "proof" uses information already visible in the original prompt
```

Those two defects are enough to make a live PASS untrustworthy.

The correct action is therefore:

```text
DO_NOT_RUN_LIVE_CANARIES
FIX_CANARY_PHASE_POLICY_AND_CAUSAL_NONCE
REAUDIT
THEN_AUTHORIZE_LIVE
```
