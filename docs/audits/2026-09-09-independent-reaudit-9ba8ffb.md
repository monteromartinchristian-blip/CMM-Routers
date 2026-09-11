# CMM Subscription Router — Independent Re-audit of 9ba8ffb

**Audited artifact:** `CMM-Subscription-Router-reaudit-9ba8ffb.tar.gz`
**Embedded Git commit:** `9ba8ffbda56fb0eb7ce02443f669c492e5fed829`
**Uploaded archive SHA-256:** `bc7b446b014d18c426a480284e2da96e27ac78041429414c0f1a96e1ad96e890`
**Verification log SHA-256:** `5a3c59a7b0b87e1d3d0960a696ebf34fe7594b4ea99c6b379ede994bb47ec8fb`
**Verdict:** **FAIL — NOT ELIGIBLE FOR FINAL CLOSURE**

## Evidence accepted from the supplied verification capture

The supplied exact-HEAD capture reports three consecutive normal-suite runs plus a post-build run, each green:

- `287 passed / 25 skipped` on run 1;
- `287 passed / 25 skipped` on run 2;
- `287 passed / 25 skipped` on run 3;
- `287 passed / 25 skipped` post-build;
- typecheck `rc=0`;
- build `rc=0`;
- ESM import probe `rc=0`;
- security-audit script `rc=0`;
- PAYG-poison preflight (combined Anthropic/Google poison) `rc=1` as expected.

These are strong regression signals, but the independent source audit below found remaining gaps that those tests do not exercise correctly.

## Independent verification performed

- Recomputed bundle SHA-256: exact match.
- Recomputed verification-log SHA-256: exact match.
- `git get-tar-commit-id` on the decompressed archive: exact commit `9ba8ffbda56fb0eb7ce02443f669c492e5fed829`.
- Inspected production composition, provider adapters, HTTP surfaces, usage tracking, preflight, launchd scripts, Qoder smoke, config bootstrap and audit scripts directly from the exact archive.
- Ran independent shell probes against the archived `scripts/preflight.sh`.
- Ran the actual archived macOS installer path logic against a temporary HOME with a test `dist/index.js` placeholder.
- Performed a tracked-content secret-like scan; no apparent real secret/token value was found.

## Findings from the first audit that are genuinely fixed

### PASS — production composition root exists

`src/index.ts` now registers enabled ChatGPT/Codex, Claude and Google adapters, and only registers Command Code when spend acknowledgement + secret preconditions are present. This fixes the original empty-registry defect at source level.

### PASS — bearer auth is ESM-safe

`src/security/bearer-auth.ts` now statically imports `timingSafeEqual` from `node:crypto`.

### PASS — Claude no longer mutates Anthropic/Claude environment variables per request

`ClaudeAdapter` now supplies an isolated `options.env` built by `buildIsolatedEnvironment()` rather than temporarily deleting/restoring `ANTHROPIC_*` in the adapter.

### PASS — Antigravity account-only spending guard is now invoked

`enforceAccountOnlySettings()` executes before discovery and inference, blocking `modelProvider=gemini` and `useG1Credits=true` without rewriting the user's settings.

### PASS — macOS repo-root path bug is fixed

`install-router.sh`, `preflight-router.sh`, and `run-router.sh` correctly resolve `scripts/macos -> ../.. -> repo root`; installer uses `set -euo pipefail` and rejects missing template/build output. Independent temp-HOME installer probe rendered the expected plist successfully.

### PASS — UsageStore is wired into production server composition

`src/index.ts` creates one `UsageStore`, `createProductionServer()` passes it into the server, and Chat/Responses wrap provider streams with `trackProviderStream()`.

### PASS — completion-content logging defect removed

No provider delta logging remains in production sources; Codex has no `console.*` calls.

### PASS — Command Code explicit entitlement exclusion is filtered

`CommandCodeAdapter.discoverModels()` now drops `goatIncluded === false` while preserving unknown-entitlement catalog entries fail-closed at request time.

### PASS — Codex finish reason normalization exists

Codex upstream status is normalized into `stop | tool_calls | length`.

---

# Remaining closure blockers

## R1 — Claude still does NOT stream incrementally — CRITICAL FUNCTIONAL

`src/providers/claude/adapter.ts` iterates Agent SDK messages, but does **not** set:

```ts
includePartialMessages: true
```

and does not handle `message.type === "stream_event"` / `content_block_delta` / `text_delta` events.

Instead it emits text from `message.type === "assistant"`, which is the complete AssistantMessage path.

Anthropic's Agent SDK documentation explicitly states that complete AssistantMessage objects are the default and incremental output requires `includePartialMessages: true`, then reading `stream_event` content-block deltas.

Impact: Qoder does not receive real token/delta streaming from the Claude subscription route.

Required remediation:

- set `includePartialMessages: true` for inference;
- consume `stream_event` → `content_block_delta` → `text_delta`;
- avoid duplicating final AssistantMessage text after partial deltas;
- add a timing test proving first Router delta is observed before upstream completion.

## R2 — Antigravity adapter still buffers deltas until process completion — CRITICAL FUNCTIONAL

The runner now parses child stdout incrementally, but the adapter callback only pushes into `pendingTexts`:

```ts
onEvent(...) -> pendingTexts.push(...)
```

Then `run()` does:

```ts
result = await this.runner.streamInference(...)
yield* flushTexts()
```

So no Router event can be yielded until `streamInference()` resolves, which happens after child close.

The test named `yields the first delta before upstream completion` is a false-positive timing test: its fake resolves its own gate and emits the terminal event before returning; `iterator.next()` therefore receives the buffered text only after the fake runner has completed.

Impact: `google/*` is still buffered from Qoder's perspective.

Required remediation: replace the callback+array bridge with an async queue/channel (or make `streamInference()` itself an async iterable) so each parsed NDJSON event is yielded while the child is still running.

## R3 — Preflight remains materially non-fail-closed — CRITICAL SECURITY/OPS

Independent exact-archive probes:

### OPENAI-only PAYG poison

```text
OPENAI_API_KEY=dummy
...
PREFLIGHT=PASS
OPENAI_ONLY_POISON_RC=0
```

`scripts/preflight.sh` never checks `OPENAI_API_KEY`.

### Required binaries/auth unavailable

With a restricted PATH/HOME:

```text
NODE=FAIL
CODEX_BINARY=FAIL
CODEX_CHATGPT_AUTH=UNAVAILABLE
CLAUDE_BINARY=FAIL
AGY_BINARY=FAIL
...
PREFLIGHT=PASS
NO_PROVIDER_BINARIES_RC=0
```

The script only accumulates `UNSAFE`; it does not accumulate `AUTH_REQUIRED` or `UNAVAILABLE`/binary failures.

The supplied normal capture likewise prints `CODEX_CHATGPT_AUTH=AUTH_REQUIRED` and still exits `PREFLIGHT=PASS`.

Impact: Task 15's operational gate can green-light a router that cannot satisfy enabled provider requirements, and its own security-audit source check misses this.

Required remediation:

- check `OPENAI_API_KEY` explicitly;
- load/understand enabled providers from shared config;
- aggregate `UNSAFE`, `AUTH_REQUIRED`, `UNAVAILABLE`, `READY` with fail-closed exit codes;
- do not require secrets/auth for providers explicitly disabled;
- add independent shell tests for OpenAI-only poison and missing enabled-provider binaries/auth.

## R4 — Fresh-clone config bootstrap is still not wired into production — MAJOR DEPLOYMENT

The archive contains only:

```text
config/shared.example.json
```

`ensureSharedConfig()` exists, but search of production code shows it is only invoked by tests. `main()`, `loadConfig()` and the macOS installer never call it. README installation says:

```bash
npm install
npm run build
bash scripts/preflight.sh
npm start
```

with no step to create `config/shared.json`.

`loadConfig()` catches missing `shared.json`, sets `{}`, then parses against a schema requiring `mode` and `host`; a clean clone therefore fails startup.

Required remediation: either invoke `ensureSharedConfig()` deterministically before production `loadConfig()`, or make install/bootstrap explicitly create `shared.json` from the example and test the actual `node dist/index.js` fresh-clone path.

## R5 — Configured Claude `profileDir` is ineffective because of import-time capture — MAJOR CONFIG/ISOLATION

`src/providers/claude/sdk-client.ts` computes:

```ts
export const CLAUDE_CONFIG_DIR = process.env.CMM_CLAUDE_PROFILE_DIR ?? defaultPath
```

at module evaluation time.

But `src/index.ts` imports `ClaudeAdapter` (and therefore `sdk-client.ts`) at top level, and only later inside `createProductionRegistry()` does:

```ts
process.env.CMM_CLAUDE_PROFILE_DIR = profileDir
```

That write happens too late to change the already-computed `CLAUDE_CONFIG_DIR`. The config test only checks the resolver string, not the actual child environment.

Impact: non-default `providers.claude.profileDir` is a no-op while production still mutates a global environment variable unnecessarily.

Required remediation: inject `profileDir` into `ClaudeAdapter` / `buildIsolatedEnvironment(profileDir)` directly; remove the startup `process.env` mutation.

## R6 — Claude health can consult normal user settings / OmniRoute instead of only the isolated profile — MAJOR ISOLATION

`ClaudeAdapter.health()` calls:

```ts
resolveSettings({ cwd: NEUTRAL_CWD })
```

with default setting sources. Agent SDK docs state `resolveSettings()` reads all filesystem setting sources by default. The code then returns `ready` immediately for a non-`firstParty` `apiProvider`, without running the isolated `startup()` check.

With a normal user Claude/OmniRoute configuration, health can therefore be influenced by the unrelated normal profile.

Required remediation: do not use normal user setting sources as an authentication oracle. Prefer an isolated startup/auth probe using the same `options.env` as real requests; if `resolveSettings()` remains, use only sources that cannot inherit the normal user profile and never bypass isolated startup on a third-party `apiProvider` observation.

## R7 — Command Code timeout still stops at HTTP headers, not the streamed body — MAJOR RELIABILITY

`CommandCodeClient` composes a timeout around `fetch()`, but calls `composed.cleanup()` as soon as `fetch()` returns. A Fetch promise resolves when headers are available; the response body can continue streaming afterward.

`streamPath()` and `streamAnthropicMessages()` also clean their composed timeout before `yield* chunks` consumes the body.

Impact: a provider that sends headers then stalls mid-SSE can outlive the advertised `120_000ms` timeout indefinitely unless the caller independently aborts.

Current timeout tests only model a `fetchFn` that never returns a response, so they do not exercise a stalled response body.

Required remediation: retain a deadline signal/timer until body iteration reaches terminal completion/error/cancel; add a test where headers arrive immediately and the body then stalls.

## R8 — Production entrypoint boot is still not actually tested — MAJOR VERIFICATION GAP

The verification command:

```bash
node -e 'import("./dist/index.js") ...'
```

only imports the module. Because `src/index.ts` calls `main()` only when:

```ts
import.meta.url === `file://${process.argv[1]}`
```

an `import()` probe does not execute `main()` or bind the server.

`tests/http/production-composition.test.ts` calls source-level `createProductionRegistry()` / Fastify injection; `tests/http/production-entrypoint-esm.test.ts` only source-scans for CommonJS `require()`.

Also, the test named `production-composed /v1/models returns provider models` asserts only HTTP 200, not `data.length > 0`.

Required remediation: spawn the actual built `node dist/index.js` in an isolated test configuration, wait for `/health`, authenticate to `/v1/models`, assert non-empty models for available fake/injected providers, exercise `/ready`, `/v1/cmm/usage`, then terminate the child cleanly.

## R9 — HTTP disconnect cancellation is not actually tested through HTTP — MAJOR VERIFICATION GAP

`tests/http/disconnect-cancel.test.ts` does not send an HTTP request. It calls `adapter.run()` directly, manually aborts an `AbortController`, and manually calls `adapter.cancel()`.

It therefore proves the provider can be cancelled, but not that Fastify/socket teardown triggers the path.

The production handlers listen on `request.raw.on("close")` and only call `tearDown()` when `!reply.sent`; streaming disconnect behavior is not independently demonstrated by the test.

Required remediation: use a real listening Fastify server + real HTTP client, start a deliberately hanging stream, destroy/abort the client socket after headers/first chunk, then assert provider signal abort + `cancel(requestId)` + UsageStore active-count cleanup.

## R10 — Original Task 13 Definition of Done remains unmet — MAJOR SCOPE/FUNCTIONAL

The authoritative implementation plan still says:

```text
QODER_TOOL_ROUNDTRIP=PASS
```

Current production capabilities are:

```text
chatgpt/* = CHAT_ONLY
claude/* = CHAT_ONLY
google/* = CHAT_ONLY
command-code/* = CHAT_ONLY
```

The remediation evidence itself correctly states that Task 13's original DoD is unmet and requires a human scope decision.

This is especially material because the router's target is Qoder: without externally owned tool calls, these routed models cannot drive Qoder's coding/file-edit tool loop through the Router.

Required decision:

1. implement and prove at least the required external tool round-trip(s), **or**
2. explicitly amend the v1 spec/plan with human approval to define v1 as chat-only and move Qoder agentic tools to a later phase.

Until one occurs, the original plan is not complete.

---

# Additional findings

## A1 — Qoder smoke “cancellation” is only reachability, not cancellation

`scripts/qoder-smoke.sh` sends a normal request with `curl --max-time 5` and treats HTTP 200 as `CANCEL_REACHABILITY=PASS`. It does not deliberately abort an in-flight request and observe cleanup.

This should not be used as evidence for Qoder cancellation acceptance.

## A2 — Antigravity discovery temp directories still leak

`AntigravityAdapter.run()` removes its `cmm-antigravity-run-*` directory in `finally`, but `discoverModels()` creates `cmm-antigravity-discovery-*` and never removes it.

## A3 — Shared streaming TextDecoder in Command Code is stateful across concurrent streams

`src/providers/command-code/client.ts` holds one module-global `TextDecoder` and calls `decode(..., {stream:true})`. Streaming decoder state is therefore shared across concurrent Command Code responses. A partial multibyte UTF-8 character at the end of one response chunk can contaminate decoding of another interleaved response.

Use one decoder per `streamChunks()` invocation.

## A4 — security-audit script is not sufficient as an independent security gate

It checks for the *presence* of certain source patterns rather than executing all security semantics. For example, it declares `PREFLIGHT_FAIL_CLOSED=PASS` merely because `scripts/preflight.sh` contains `exit 1`, while the independent OpenAI-only poison and all-binaries-missing probes both exit 0.

Keep it as a quick scan, but do not treat it as certification.

---

# Current Task-level verdict

| Task | Re-audit status | Notes |
|---|---|---|
| 1–5 Core/config/HTTP skeleton | **PARTIAL** | Core good; fresh-clone config bootstrap still not production-wired. |
| 6–7 Codex | **PASS with final live reproof pending** | Composition/finish/logging improved; prior live evidence not rerun after remediation. |
| 8 Claude | **FAIL** | Isolation improved, but true incremental streaming absent; health/profileDir isolation issues remain. |
| 9 Antigravity | **FAIL** | Spending gate fixed; adapter still buffers Router deltas; discovery temp leak. |
| 10 Command Code | **PARTIAL** | Entitlement/wire/live history strong; body timeout and decoder concurrency remain; fresh live reproof pending. |
| 11 Chat Completions | **PARTIAL** | Surface implemented; upstream streaming false for Claude/Google; real HTTP disconnect not proven. |
| 12 Responses | **PARTIAL** | Same streaming/cancellation caveats. |
| 13 Tool ownership | **FAIL against original DoD** | All routes CHAT_ONLY; human scope amendment or implementation required. |
| 14 Observability | **PASS source-level** | UsageStore is now wired and content not persisted. |
| 15 Preflight | **FAIL** | OpenAI-only poison + unavailable/auth states can still return PASS. |
| 16 Qoder acceptance | **FAIL/PENDING** | UI blocked; tools unavailable; smoke cancellation not real. |
| 17 macOS deployment | **PARTIAL** | Path/render defect fixed; fresh config startup and live Mac/iMac acceptance remain. |
| 18 Remote worker contract | **PASS source-level** | No new blocker found. |
| 19 Final gate | **FAIL** | Remaining blockers above; live suites skipped after remediation. |

# Independent verdict

```text
CMM_SUBSCRIPTION_ROUTER_INDEPENDENT_REAUDIT=FAIL
AUDITED_HEAD=9ba8ffbda56fb0eb7ce02443f669c492e5fed829
FINAL_CLOSURE_ELIGIBLE=NO

REGRESSION_SIGNAL=STRONG
SUPPLIED_TEST_RUNS=3x287_PASS_PLUS_POST_BUILD_287_PASS
TYPECHECK=PASS_IN_SUPPLIED_CAPTURE
BUILD=PASS_IN_SUPPLIED_CAPTURE

BLOCKERS_REMAINING=YES
LIVE_FINAL_REPROOF_AUTHORIZED=NO
NEXT=TARGETED_REMEDIATION_DELTA
```

The remediation materially improved the router and fixed most of the first audit's structural defects. The next pass should be **targeted only at R1–R10/A1–A3**, not another broad rewrite. Do not burn live provider quota until the structural blockers are corrected and independently rechecked.
