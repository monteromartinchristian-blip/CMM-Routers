# Task 13 — Canary & Antigravity Registration Correctness (Evidence)

**Date:** 2026-09-10
**Status:** `IMPLEMENTED_PENDING_INDEPENDENT_REAUDIT`
**Design:** `docs/superpowers/specs/2026-09-10-task13-canary-registration-correctness-design.md`
**Plan:** `docs/superpowers/plans/2026-09-10-task13-canary-registration-correctness-plan.md`

```text
START_HEAD=6341e0fc6f36d2933429d524f60d601f5c1deb7a
IMPLEMENTATION_HEAD=cb8738ee0631a5b7a9b0d171d9bf003b2429dbc8
```

Input: the independent re-audit of `814a699`
(`docs/audits/2026-09-10-independent-task13-final-protocol-edge-reaudit-814a699.md`,
verdict FAIL). Every finding was re-derived from source and behaviour, not from
the audit text. The closed multi-step provider architecture, the
DeferredToolBroker and the provider-facing MCP topology were not reopened.

All work is deterministic. **No live provider inference was run in this pass.**

---

## 1. Commit list (focused, unsquashed; no historical commit amended, no push)

```text
73df96a docs: design Task 13 canary and registration correctness
be21812 docs: plan Task 13 canary and registration correctness
6dbcefc fix: canonicalize Antigravity MCP registration and bound agy MCP CLI
c7a1647 fix: make Antigravity byte limits UTF-8 exact
e35fea7 tooling: make audit capture byte-verifiable
ba93c35 feat: rewrite live canaries to prove the Qoder tool round-trip
fbf3e3d fix: publish Antigravity session descriptors atomically
247fd11 test: isolate Antigravity temp-cleanup suite from the shared temp dir
cb8738e security: audit the atomic 0600 descriptor publication boundary
```

`IMPLEMENTATION_HEAD=cb8738e`. This evidence document is committed on top of it
as a documentation-only commit (its direct parent is the audited code state).
`247fd11` and `cb8738e` are supporting changes described in §12.

## 2. Exact files changed (`git diff --name-status 6341e0f..cb8738e`)

Production:

```text
M src/providers/antigravity/mcp-registration.ts      (canonicalization, stdio type, CLI bounds)
M src/providers/antigravity/process-client.ts        (UTF-8 byte-true CappedTextBuffer)
M src/providers/antigravity/adapter.ts               (UTF-8 byte-true NDJSON line bound)
M src/bridge/session-registry.ts                     (atomic descriptor publication)
```

Tests / fixtures / scripts:

```text
A tests/providers/antigravity-mcp-canonicalization.test.ts
A tests/providers/antigravity-mcp-cli-bounds.test.ts
A tests/helpers/fake-agy-cli.js
A tests/providers/antigravity-byte-limits.test.ts
A tests/helpers/multibyte-oversize-provider.js
A tests/bridge/session-registry-atomic.test.ts
A scripts/capture-bundle.sh
A scripts/live-canary/canary-driver.ts
M scripts/live-canary/canary-lib.sh
M scripts/live-canary/canary-{claude,antigravity,codex,command-code}.sh
A tests/live-canary/canary-driver.test.ts
M tests/providers/antigravity-mcp-registration.test.ts
M tests/providers/antigravity-allpath-cleanup.test.ts
M scripts/security-audit.sh
```

---

## 3. P0 #1/#2 — Antigravity registration truth (audit F6/F7)

**Defect (confirmed).** `agy mcp list` never prints env, yet `isCanonical()`
compared the DESIRED env (empty) instead of the persisted env, and did not check
the transport type. A persisted entry
`type=stdio, command/args correct, enabled, hidden OLD_SESSION_SECRET` therefore
returned `noop` and the stale secret survived.

**Behaviour now.** `ensureAntigravityMcpRegistration` canonicalizes **by
construction**: the first ensure in every Router process re-issues
`agy mcp add` WITHOUT `--env` even when the visible row already matches, which
replaces the entry and drops any hidden env. A module-scoped marker keyed by
`agyPath + serverName + command + args` records a SUCCESSFUL canonicalization, so
later ensures in the same process may `noop`; any visible mismatch always
repairs. `isCanonical()` now requires `entry.type === "stdio"`. Only the managed
name is ever mutated. New action `canonicalized` distinguishes the process-first
rewrite. A test-only `resetAntigravityMcpRegistrationProcessState()` simulates a
Router restart.

**RED observed (pre-fix).** `tests/providers/antigravity-mcp-canonicalization.test.ts`:

```text
FAIL rewrites a visible-canonical entry whose persisted env is hidden, clearing it
  AssertionError: expected 'noop' not to be 'noop'      (hidden OLD_SESSION_SECRET=CANARY survived)
FAIL does not accept a non-stdio transport as canonical and repairs it
  AssertionError: expected 'noop' not to be 'noop'      (type=sse accepted)
Tests 2 failed | 1 passed (3)
```

**GREEN.**

```text
ANTIGRAVITY_MCP_HIDDEN_ENV_RECONCILIATION=PASS
ANTIGRAVITY_MCP_REGISTRATION_SECRET_FREE_BY_CONSTRUCTION=PASS
ANTIGRAVITY_MCP_CANONICAL_TYPE_STDIO_REQUIRED=PASS
ANTIGRAVITY_MCP_NEW_PROCESS_CANONICALIZATION=PASS
```

Proof: after the rewrite the hidden env is gone
(`fake.entriesFor(SERVER)[0]?.env` undefined), the visible state is canonical
(`type=stdio`, correct command/args, enabled), no `--env`/`-e` is ever passed,
and the unrelated registration is untouched. The existing
`tests/providers/antigravity-mcp-registration.test.ts` was updated: the
"no-op when already matching" case now truthfully asserts
`canonicalized` then `noop`, and a new test re-canonicalizes after a simulated
restart.

## 4. P0 #3 — Bounded `agy mcp` CLI operations (audit F10)

**Defect (confirmed).** `execFileAgyRunner` used `execFileSync` with neither
`timeout` nor `maxBuffer`.

**Behaviour now.** Every CMM-owned `agy mcp` call goes through
`execFileAgyRunner(agyPath, bounds)` with finite defaults
`AGY_MCP_CLI_TIMEOUT_MS = 10_000` and `AGY_MCP_CLI_MAX_BUFFER_BYTES = 1 MiB`,
no shell. Timeout (`ETIMEDOUT`), maxBuffer overflow (`ENOBUFS` /
`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`), unexpected signal and `ENOENT` are mapped
to explicit `AgyCliFailure` values, and `ensureAntigravityMcpRegistration` fails
closed with `provider_unavailable`. Diagnostics are bounded
(`AGY_MCP_CLI_DIAGNOSTIC_CHARS = 200`) and redacted for secret shapes.

**RED observed (pre-fix).** `tests/providers/antigravity-mcp-cli-bounds.test.ts`:

```text
- maxBuffer: AssertionError: expected undefined to be 'max_buffer'   (2 tests)
- timeout/hang: the run did not finish; the command had to be killed after 25 s
  (execFileSync had no timeout, so the worker blocked indefinitely)
```

**GREEN.** Real child-process fixture `tests/helpers/fake-agy-cli.js` modes
`hang` / `oversize-stdout` / `oversize-stderr` / `exit-nonzero` / `normal-list` /
`normal-add` / `argv-echo`:

```text
ANTIGRAVITY_MCP_CLI_TIMEOUT_BOUND=PASS            (hang: failure=timeout, <10 s)
ANTIGRAVITY_MCP_CLI_MAXBUFFER_BOUND=PASS          (oversize stdout and stderr)
ANTIGRAVITY_MCP_CLI_FAILURE_FAIL_CLOSED=PASS      (nonzero exit -> provider_unavailable)
ANTIGRAVITY_MCP_CLI_NO_SHELL=PASS                 (argv delivered literally; no side effect)
```

The no-shell proof passes a metacharacter-laden argv element
(`; touch … ; $(whoami) `id``) and asserts the child receives it verbatim
(JSON argv equality) and that no file is created.

## 5. P0 #4 — UTF-8 byte-true agy limits (audit F8)

**Defect (confirmed).** `MAX_AGY_STDOUT_DIAGNOSTIC_BYTES`,
`MAX_AGY_STDERR_DIAGNOSTIC_BYTES` and `MAX_AGY_NDJSON_LINE_BYTES` were enforced
with `.length`/`.slice()` (UTF-16 code units), so multibyte output could exceed
the documented byte limits.

**Behaviour now.** `CappedTextBuffer` is a real UTF-8 byte budget and truncates
by code point via `truncateUtf8Head`/`truncateUtf8Tail`, so a multibyte sequence
is never split and no U+FFFD is introduced. All three NDJSON line checks in
`SpawnInferenceRunner` use `Buffer.byteLength(text, "utf8")`.

**RED observed (pre-fix).** `tests/providers/antigravity-byte-limits.test.ts`:

```text
expected 10240 to be less than or equal to 4096        (multibyte stdout vs cap)
expected 1602 to be less than or equal to 1024         (multibyte stderr vs cap)
expected 4 to be less than or equal to 2               (single emoji vs cap 2)
expected 196608 to be less than or equal to 65536      (documented constants)
2x: expected [] to have a length of 1                  (oversize multibyte line not rejected)
Tests 6 failed (6)
```

**GREEN.**

```text
AGY_STDOUT_UTF8_BYTE_BOUND=PASS
AGY_STDERR_UTF8_BYTE_BOUND=PASS
AGY_NDJSON_UTF8_BYTE_BOUND=PASS
AGY_DIAGNOSTIC_MEMORY_REMAINS_BOUNDED=PASS
```

The end-to-end case uses the real `SpawnInferenceRunner` with
`maxNdjsonLineBytes: 512` and a fixture emitting 300 `中` (`.length` 355 < 512,
UTF-8 955 > 512) on both the partial-line and terminated-line paths: both fail
closed with exactly one `provider_protocol_error` and no completion.

## 6. P0 #5 — Atomic session descriptor publication (audit F9)

**Defect (confirmed).** `register()` published the descriptor in place, so a
concurrent launcher/reconciler could observe truncated/empty JSON, delete it, and
lose the live session.

**Behaviour now.** `publishDescriptor()` writes the complete JSON to a unique
temp file in the SAME directory, created `openSync(tempPath,"wx",0o600)`, fsyncs
it, and `renameSync`s it onto `agy-<pid>.json`. `removeAbandonedTempFiles()`
cleans crashed writers' temps inside the directory lock. Final descriptors and
verified-live descriptors are never touched.

**RED observed (pre-fix).** `tests/bridge/session-registry-atomic.test.ts`:

```text
SESSION_DESCRIPTOR_RACE_READS=4346 PARTIAL=21 (EMPTY=21 TORN=0) MISSING=273
Tests 2 failed | 2 passed
```

PARTIAL was non-zero in 4/4 pre-fix runs (21, 16, 17, 14).

**GREEN.**

```text
SESSION_DESCRIPTOR_ATOMIC_PUBLISH=PASS
SESSION_DESCRIPTOR_PARTIAL_JSON_VISIBLE=NO
SESSION_DESCRIPTOR_MODE_0600=PASS
```

Final run: `SESSION_DESCRIPTOR_RACE_READS=28051 PARTIAL=0 (EMPTY=0 TORN=0)`, and
PARTIAL=0 held across 4 consecutive runs of 600 real publishes of a ~20 KB
descriptor with an out-of-process polling reader. Also asserted: mode 0600,
orphan temp cleanup, unrelated file and foreign verified-live descriptor
untouched, duplicate-pid guard still throws.

## 7. P0 #6 — Live canary authenticates as Qoder (audit F1)

**Defect (confirmed).** `canary-lib.sh` read `CMM_ROUTER_TOKEN` (CMMChat,
permanently CHAT_ONLY), so the tool canaries could never authenticate as Qoder.

**Behaviour now.** The entire canary is a new dependency-free Node/TypeScript
driver, `scripts/live-canary/canary-driver.ts`, run by thin bash wrappers. It
resolves the bearer from `CMM_QODER_TOKEN` or the local Keychain
(`security find-generic-password` with the same
`CMM_QODER_KEYCHAIN_SERVICE`/`CMM_QODER_KEYCHAIN_ACCOUNT` contract as
`scripts/macos/run-router.sh`). It never falls back to `CMM_ROUTER_TOKEN`, and it
refuses a colliding `CMM_QODER_TOKEN === CMM_ROUTER_TOKEN`. The token is never
printed. Wrappers and `canary-lib.sh` contain no `CMM_ROUTER_TOKEN` read.

**Proof.** Deterministic tests: a valid Qoder bearer completes the round trip;
the CMMChat bearer is rejected pre-inference (400 `unsupported_capability`, no
spend) and the canary exits 2; a missing bearer exits 2 with
`reason=missing-qoder-bearer` and makes ZERO HTTP requests; a colliding bearer
exits 2.

```text
LIVE_CANARY_AUTH_CONSUMER=QODER
LIVE_CANARY_CAPABILITY=CHAT_AND_TOOLS
LIVE_CANARY_CMMCHAT_BEARER_USED=NO
```

The real-Router integration test proves the same against `buildServer` with a
real Qoder bearer vs the CMMChat bearer.

## 8. P0 #7 — Provider-specific canary tool policy (audit F2)

**Defect (confirmed).** One shared payload sent `tool_choice:auto` +
`parallel_tool_calls:false`, which production rejects for Claude/Google and
cannot represent for Codex.

**Behaviour now.** `buildCanaryPolicy(provider)`:

```text
claude        : {}                             (no tool_choice, no parallel_tool_calls)
google        : {}                             (no tool_choice, no parallel_tool_calls)
chatgpt       : {}                             (only the representable default)
command-code  : { tool_choice: "required" }    (exact supported OpenAI semantics)
```

**Proof.** The deterministic suite asserts each body's exact shape, drives the
full round trip for every provider against a policy mirror, and includes a
negative control showing the mirror really rejects `parallel_tool_calls:false`
for Claude (so the acceptance markers are not vacuous). The real-Router test
proves Command Code acceptance through the production `enforceProviderToolPolicy`.

```text
CLAUDE_CANARY_POLICY_ACCEPTED=PASS_DETERMINISTIC
GOOGLE_CANARY_POLICY_ACCEPTED=PASS_DETERMINISTIC
CODEX_CANARY_POLICY_ACCEPTED=PASS_DETERMINISTIC
COMMAND_CODE_CANARY_POLICY_ACCEPTED=PASS_DETERMINISTIC
```

## 9. P0 #8 — Live canary proves the real round-trip (audit F3)

**Defect (confirmed).** The old canary sent one request, never executed the tool
and never sent a result, so it could not resolve the live-only uncertainty.

**Behaviour now (exactly two inference requests).**

```text
request 1: declare canary_echo (strict JSON schema), require exactly one call
  -> unknown tool / no call / multiple calls = FAIL
  -> parse + validate args against the declared schema
  -> synthesize RESULT=<sentinel>|echo=<text> in memory (no shell, no fs, no net)
request 2: full history + role:tool with the exact tool_call_id
  -> require the final text to contain RESULT=<sentinel>|
```

The sentinel is generated by the canary itself and echoed through the tool
result, so the final response can only reproduce it by actually consuming the
result. The driver makes no filesystem, repository or network side effect beyond
the two Router requests, and executes no provider-native tool.

```text
LIVE_CANARY_TOOL_REQUEST_RECEIVED=YES
LIVE_CANARY_TOOL_NAME=canary_echo
LIVE_CANARY_QODER_SYNTHETIC_EXECUTION=YES
LIVE_CANARY_TOOL_RESULT_SUBMITTED=YES
LIVE_CANARY_SAME_PROVIDER_CONTINUATION=YES
LIVE_CANARY_FINAL_DERIVED_FROM_TOOL_RESULT=YES
LIVE_CANARY_FULL_ROUNDTRIP=PASS
LIVE_CANARY_NO_PROVIDER_NATIVE_TOOL=PASS
LIVE_CANARY_NO_REPO_MUTATION=PASS
```

## 10. P0 #9/#10 — Machine-truthful exits + exact model (audit F4/F5)

**Behaviour now.** Exit codes: `0 = PASS`, `1 = FAIL`, `2 = BLOCKED`.
`canary_blocked()`-equivalent paths exit 2 (there is no `exit 0` blocked path in
any canary script). Exact model selection: `CMM_LIVE_CANARY_MODEL` is required;
`GET /v1/models` must contain exactly that id with provider prefix == the wrapper
provider and `owned_by == cmm:<provider>`; no fallback or prefix guessing.

**Proof (deterministic).** 401→BLOCKED, 429→BLOCKED, 500→FAIL, missing confirm /
non-loopback base / unknown provider / missing model → BLOCKED; no tool call,
unknown tool, malformed args, wrong continuation id, unrelated final → FAIL;
unrelated model or wrong provider → BLOCKED; several models present → the exact
one is selected with `ROUTE_AMBIGUITY=NONE`.

```text
LIVE_CANARY_PASS_EXIT=0
LIVE_CANARY_FAIL_EXIT_NONZERO=PASS
LIVE_CANARY_BLOCKED_EXIT_NONZERO=PASS
LIVE_CANARY_EXACT_MODEL_SELECTION=PASS
LIVE_CANARY_MODEL_FALLBACK=NONE
```

## 11. P0 #11 — Spend / safety gate

The operator opt-in `CMM_LIVE_CANARY_CONFIRM=yes-i-accept-subscription-quota-spend`
is required (else exit 2). PAYG/API credential env vars are poisoned with
sentinels before any provider turn; the base URL must be loopback; the exact
Qoder consumer, exact model and subscription route are preflighted. Live
inference stays disabled in this pass.

```text
LIVE_CANARY_PAYG_POISON=PASS
LIVE_CANARY_SUBSCRIPTION_ROUTE_PREFLIGHT=PASS
```

## 12. P1 #12 / #13 — Deterministic harness + capture byte-identity

**P1 #12.** `tests/live-canary/canary-driver.test.ts` (17 tests) covers Qoder
auth success, CMMChat rejection, missing bearer, wrong model, multiple models,
no tool call, wrong tool, malformed arguments, correct tool request, correct
continuation, wrong continuation id, unrelated final, derived final, Router
401/429/500, blocked prerequisite and the provider-specific policy bodies —
against a fake Router AND the real Fastify server. No live inference.

```text
LIVE_CANARY_HARNESS_DETERMINISTIC_TESTS=PASS
```

**P1 #13.** `scripts/capture-bundle.sh` builds the Git archive, then hashes the
FINAL bundle and FINAL verification log into a SEPARATE `shasum -c` manifest
(never appending a hash to the hashed file).

```text
CAPTURE_BUNDLE_BYTE_IDENTITY=PASS
CAPTURE_LOG_BYTE_IDENTITY=PASS
CAPTURE_SHA256_MANIFEST_VERIFY=PASS
```

Independent smoke (this pass, HEAD `ba93c35`): bundle built, `gzip -t` OK,
`git get-tar-commit-id` == HEAD, manifest verified with `shasum -a 256 -c`
(both files OK), and a flipped-byte negative control makes verify fail. The
in-script `selftest` additionally asserts the manifest is a distinct file and
that the bundle/log bytes are unchanged after manifest generation.

**Supporting changes (not audit findings).**
`247fd11` makes `tests/providers/antigravity-allpath-cleanup.test.ts` hermetic:
it scanned the global `os.tmpdir()`, which races the other parallel Antigravity
suites now that the suite has grown; it now points `TMPDIR` at a private root.
No assertion was relaxed. `cb8738e` updates `scripts/security-audit.sh` to assert
the STRONGER descriptor invariant (`openSync(tempPath,"wx",0o600)` + `renameSync`)
instead of the removed `mode: 0o600` literal.

## 13. Adversarial self-review (goal §"ADVERSARIAL SELF-REVIEW")

```text
CMM_ROUTER_TOKEN in live-canary   -> only (a) a defensive REFUSAL predicate in the driver
                                     (blocks a colliding bearer; it is never used as a fallback)
                                     and (b) the launcher comment stating it is not read.
parallel_tool_calls:false common  -> gone; only provider-specific bodies (a codex wrapper comment remains).
exit 0 in blocked path            -> none in any canary script.
tool call optional canary         -> no; missing/extra/unknown call is FAIL.
one-request-only canary           -> no; two requests, result submitted.
no tool_result continuation       -> no; request 2 carries role:tool with the exact id.
prefix-based model ambiguity      -> gone; exact id + provider prefix + owned_by required.
hidden MCP env inferred from list -> fixed; canonical rewrite by construction (§3).
isCanonical without type          -> fixed; type=="stdio" required (§3).
execFileSync without timeout      -> fixed; finite timeout (§4).
execFileSync without maxBuffer    -> fixed; finite maxBuffer (§4).
.length for named byte limit      -> fixed; Buffer.byteLength (§5).
direct descriptor write           -> fixed; temp + fsync + rename (§6).
non-atomic JSON publication       -> fixed (§6).
temp session secret in agy config -> cleared by the env-less rewrite (§3).
PAYG fallback                     -> poisoned + no fallback; Router-side guards unchanged.
provider-native mutation          -> none; canary_echo is in-memory only.
```

## 14. Security invariants (unchanged)

```text
CMMCHAT_CHAT_ONLY=YES / QODER_CHAT_AND_TOOLS=YES
PROVIDER_OWNS_REASONING=YES
QODER_OWNS_TOOLS/FILESYSTEM/SHELL/EDITS=YES
PROVIDER_NATIVE_TOOL_EXECUTION/FILESYSTEM/SHELL/REPO=NO
API_PAYG_FALLBACK=NONE / CROSS_PROVIDER_FALLBACK=NONE / UNKNOWN_MODEL_FALLBACK=NONE
COMMAND_CODE_ON_DEMAND=NO / COMMAND_CODE_AUTO_TOP_UP=NO
OAUTH_EXTRACTION/COPY/SYNC=NO
PROMPT/COMPLETION/TOOL_ARGUMENT/TOOL_RESULT_LOGGING=NONE
LOOPBACK_ONLY=YES / NO_TRACKED_SECRETS=PASS
```

## 15. Regression gate (executed on `cb8738e`)

```text
TEST_RUN_1      = PASS   124 files passed | 5 skipped (129) · 652 passed | 25 skipped (677)
TEST_RUN_2      = PASS   identical
TEST_RUN_3      = PASS   identical
TYPECHECK       = PASS   (tsc -p tsconfig.json --noEmit, rc=0)
BUILD           = PASS   (tsc -p tsconfig.build.json, rc=0)
POST_BUILD_TEST = PASS   124 files passed | 5 skipped · 652 passed | 25 skipped
SECURITY_AUDIT  = PASS   (bash scripts/security-audit.sh, rc=0)
NEW_TESTS_BY_PATH = PASS 6 files · 51 tests passed
BASH_SYNTAX     = PASS   bash -n on canary-lib.sh + 4 wrappers
CAPTURE_SELFTEST= PASS   (bash scripts/capture-bundle.sh selftest, rc=0)
```

`TEST_FILES=129 · TESTS=677 · PASSED=652 · SKIPPED=25`. The 5 skipped files / 25
skipped tests are the pre-existing `CMM_RUN_LIVE` live-provider and mutation
gates. `LIVE_PROVIDER_INFERENCE_RUN=NO`.

## 16. Known limitations

- The live scripts are PREPARED, NOT EXECUTED. A real subscription round-trip is
  the remaining live-only uncertainty; `CMM_LIVE_CANARY_MODEL` must be supplied
  by the operator (deliberately no default, so a route can never be switched
  silently).
- The driver proves the Qoder consumer/capability boundary by the acceptance of
  request 1: a non-Qoder bearer is rejected pre-inference with 400
  `unsupported_capability`, so the proof never spends quota. The stronger
  deterministic proof of the consumer edge runs against the real Fastify server.
- The atomic descriptor race test is calibrated to a ~20 KB descriptor (the
  measured window); a multi-MB payload widened the reader's sampling period and
  measured PARTIAL=0 pre-fix, so the smaller payload is the honest RED.
- The duplicate-pid guard covers only one registry instance's live map; a
  different instance can still republish the same pid (pre-existing behaviour,
  deliberately retained).
- Canonicalization runs once per Router process; `reconcileAntigravityMcpRegistration`
  reports failure without throwing (startup-safe), while the run path
  (`ensureAntigravityMcpRegistration`) fails closed.

## 17. Verdict

```text
CMM_SUBSCRIPTION_ROUTER_TASK13_CANARY_REGISTRATION_CORRECTNESS=PASS
STATUS=IMPLEMENTED_PENDING_INDEPENDENT_REAUDIT
NEXT=INDEPENDENT_TASK13_CANARY_REGISTRATION_REAUDIT
```

Every required deterministic marker is PASS, the full regression gate is green,
and no item is skipped. Independent re-audit remains pending; no live provider
canary should run until it passes.
