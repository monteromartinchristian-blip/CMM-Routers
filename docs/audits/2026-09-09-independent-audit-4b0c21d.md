# CMM Subscription Router — Independent Audit of 4b0c21d

**Audited artifact:** `CMM-Subscription-Router-audit-4b0c21d.tar.gz`
**Embedded Git commit:** `4b0c21de905a089b8839cb1362618ca8f91589e3`
**Uploaded archive SHA-256:** `57ac4f0e99c9eccef0397aa0de123b5536675268fa9c5494ce4ef64747abcaa7`
**Verdict:** **FAIL — NOT ELIGIBLE FOR FINAL CLOSURE**

## Verification performed independently

- `gzip -t`: PASS.
- `git get-tar-commit-id` on decompressed archive: exact commit `4b0c21de905a089b8839cb1362618ca8f91589e3`.
- 389 regular files, 0 symlinks.
- Secret-like scan over tracked archive content: no apparent real `user_...`, `sk-...`, Google key, bearer token, OAuth token values found outside deliberate test/docs patterns.
- Shell-level reproduction of macOS install/preflight wrappers: FAIL as described below.
- Unsafe preflight reproduction with dummy PAYG environment: script exits `0` while reporting unsafe state.
- ESM runtime check: `require(...)` is undefined in Node ESM, matching the bearer-auth defect below.
- Full `npm test`/build could not be independently rerun inside this audit sandbox because `npm ci` stalled on dependency retrieval; therefore the previously reported 237-test result is not re-certified by this audit.

## Closure blockers

### B1 — Production entrypoint registers zero providers — CRITICAL

`src/index.ts:11-19` creates a `ProviderRegistry`, leaves all four provider registrations commented behind a TODO, then calls `refresh()`.

Impact:
- production `/ready` -> 503;
- production `/v1/models` -> empty;
- Chat/Responses cannot resolve any provider model;
- LaunchAgent launches a functionally empty router.

The E2E tests bypass this by constructing registries and registering mocks/adapters directly, so they do not cover the real `dist/index.js` composition root.

### B2 — Bearer authentication uses CommonJS `require` inside ESM — CRITICAL

`src/security/bearer-auth.ts:26` calls:

```ts
require("node:crypto").timingSafeEqual(...)
```

The package is `"type": "module"` with `module: NodeNext`. In Node ESM, `require` is undefined. A direct Node ESM probe reproduces `ReferenceError: require is not defined in ES module scope`.

Impact: authenticated `/v1/*` requests can fail at the authentication boundary in the compiled production runtime.

### B3 — Claude isolation mutates global `process.env` — CRITICAL SECURITY/CONCURRENCY

`src/providers/claude/adapter.ts:12-45` temporarily writes/deletes:
- `CLAUDE_CONFIG_DIR`
- `ANTHROPIC_API_KEY`
- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_AUTH_TOKEN`

Yet `src/providers/claude/sdk-client.ts` already defines `buildIsolatedEnvironment()`, and that safe environment is not passed to SDK calls.

Impact:
- concurrent requests can observe each other's temporary environment;
- unrelated code in the router process can see modified values;
- the asserted “global process env mutation = none” is false;
- OmniRoute/PAYG isolation is not concurrency-safe.

Tests validate the unused environment builder, not the actual adapter execution path.

### B4 — Antigravity PAYG/AI-Credits setting guards are not enforced in runtime — CRITICAL SECURITY

`readGlobalSettingsState()` is imported/exported by the Antigravity adapter but never invoked by `discoverModels()`, `health()` or `run()`.

Therefore runtime does not fail closed if:
- `modelProvider == "gemini"`; or
- `useG1Credits == true`.

The live test checks those values after/before a run, but the production adapter itself does not enforce them. The preflight also does not fail non-zero, so there is no reliable operational guard.

### B5 — Preflight reports unsafe state but exits successfully — MAJOR SECURITY/OPS

A real shell probe with dummy `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, and `GOOGLE_GEMINI_BASE_URL` produced:

```text
CLAUDE_PAYG_ENV=UNSAFE
GOOGLE_PAYG_ENV=UNSAFE
```

but `scripts/preflight.sh` exited `0`.

It also does not validate all startup invariants (e.g. no hard failure for unsafe Antigravity global settings).

This contradicts the README claim that preflight fails on unsafe PAYG state and the later security gate requirements.

### B6 — macOS installer and launchd preflight wrapper use the wrong repo root — CRITICAL DEPLOYMENT

`scripts/macos/install-router.sh:5` goes up only one directory from `scripts/macos`, resolving `REPO_DIR` to `<repo>/scripts`, then tries `<repo>/scripts/launchd/...`.

Independent safe reproduction with a temporary HOME:

```text
sed: can't read .../scripts/launchd/com.cmm.subscription-router.plist.template
INSTALL_RC=0
```

The script still prints `Installed ...` and exits success, potentially leaving an empty/broken plist.

`scripts/macos/preflight-router.sh:4` similarly resolves to:

`<repo>/scripts/scripts/preflight.sh`

and independently reproduced exit code `127`.

Task 17's test does not execute the actual installer path calculation; it manually renders the template instead.

### B7 — Three providers buffer complete upstream output; “streaming PASS” is not real streaming — MAJOR FUNCTIONAL

- **Claude:** `adapter.ts:247-356` collects all SDK events in `collectedEvents`, awaits completion, then yields the array.
- **Antigravity:** `SpawnInferenceRunner` accumulates all child stdout until process `close`; adapter parses/yields only after `runInference()` resolves.
- **Command Code:** `client.ts:316-318`, `455-462`, `499-506` uses `response.text()` for the entire HTTP response and only then splits/yields SSE chunks.

Only Codex currently yields deltas as they arrive.

Tests equate “multiple delta events exist” with streaming, but do not assert first-byte delivery before upstream completion. Thus the v1 `STREAMING=PASS` criterion is not met for Claude, Google or Command Code.

### B8 — Observability store exists but is disconnected from production traffic — MAJOR

`UsageStore` is implemented and unit-tested, but:
- `src/index.ts` does not construct/pass one;
- Chat/Responses handlers never call `beginRequest()` / `endRequest()`.

Therefore production `/v1/cmm/usage` is always `status: disabled` even if provider registration is fixed, and request metrics/counters are not recorded.

Task 14 is not complete in production composition.

### B9 — Codex logs completion content — MAJOR PRIVACY

`src/providers/codex/adapter.ts:133` logs the first 50 characters of every model delta:

```ts
console.log(`[CodexAdapter] Yielding delta: "${params.delta.substring(0, 50)}..."`)
```

This directly violates the design invariant that local telemetry/logging must not log prompts/completions/tool/file bodies. Under launchd this content lands in persistent log files.

### B10 — Tool-roundtrip Definition of Done is not met — MAJOR SCOPE

The authoritative plan/spec still require:

`QODER_TOOL_ROUNDTRIP=PASS`

and “Tool calls round-trip through Qoder” as a v1 completion criterion.

Current production capabilities are deliberately:

```text
chatgpt/* = CHAT_ONLY
claude/* = CHAT_ONLY
google/* = CHAT_ONLY
command-code/* = CHAT_ONLY
```

The tool integration test accepts either a real tool call **or chat-only text**, so it does not prove the required roundtrip. This is truthful as a limitation, but it means the existing spec/plan is not complete unless the human explicitly revises v1 scope.

## Additional major/minor findings

### M1 — Production startup configuration is not reproducible from the documented install steps

The archive contains `config/shared.example.json`, not `config/shared.json`. `loadConfig()` catches a missing file and passes `{}` to a schema where `mode` and `host` are required. README installation does not instruct copying/creating `shared.json`.

A fresh clone following README therefore lacks the required shared configuration.

### M2 — Config provider options are largely not wired

The schema exposes `enabled`, `codexHome`, `profileDir`, and `agyPath`, but the production composition root does not use them. Even after provider registration is fixed, constructors currently do not consume several of those options without further wiring.

### M3 — Command Code explicit entitlement exclusion is not filtered despite reported claim

`CommandCodeAdapter.discoverModels()` pushes every catalog entry, including `goatIncluded === false`.

The test named “filters explicit exclusion metadata but keeps unknown entries” actually asserts all 3 entries remain (`models.length === 3`).

Request-time fail-closed behavior prevents spending, so this is not a PAYG escape, but `KNOWN_EXCLUDED_FILTERED=YES` is not true for this bundle and `/v1/models` can advertise known-unusable premium models.

### M4 — Command Code internal timeout is bypassed when a request signal is provided

`client.ts:307-314` creates a timeout AbortController, but chooses `init.signal ?? controller.signal`. Adapter calls pass a signal, so the timeout controller is not attached for normal inference requests. A stalled upstream can therefore outlive the intended client timeout unless another layer aborts it.

### M5 — HTTP disconnect cancellation is weak for streaming responses

Both Chat and Responses register a `close` listener that only aborts when `!reply.sent`. Once streaming headers/body are underway, cancellation relies on the provider yielding another event so the loop notices `reply.raw.destroyed`. A stalled provider after client disconnect can remain active.

### M6 — Codex completion finish reason is not normalized

`CodexAdapter` uses `params?.turn?.status || "stop"` as the `RouterEvent.completed.finishReason`. Real app-server examples use turn status such as `"completed"`, which is not an OpenAI finish reason (`stop|tool_calls|length`). Because `params` is `any`, TypeScript cannot protect this path.

### M7 — Antigravity temp directories are never removed

Every discovery/run uses `mkdtempSync(...)`, with no cleanup path. Long-running use can accumulate temp directories.

### M8 — Qoder smoke/acceptance is weaker than the report implies

`scripts/qoder-smoke.sh` tests one first-discovered model, non-streaming Chat only; it does not require exact `QODER_SMOKE_OK`, streaming, Responses, cancellation, per-provider coverage, or real Qoder UI behavior. Router-side HTTP E2E tests use mocked providers.

### M9 — Evidence/README are stale at audited HEAD

`docs/audits/2026-09-09-implementation-evidence.md` still states Command Code live is blocked/missing, despite later successful live proof outside the bundle's evidence update sequence. README likewise states Command Code live is blocked. The artifact therefore does not self-describe its latest verified state.

### M10 — Final security-audit script has significant blind spots

The script exits PASS on this archive while not checking:
- global `process.env` mutation in Claude;
- completion-content logging;
- Antigravity global settings enforcement;
- production provider registration;
- real launchd installer execution;
- ESM runtime auth behavior.

## Per-task audit summary

| Task | Audit verdict | Notes |
|---|---|---|
| 1 Bootstrap | PASS | Structure/toolchain present. |
| 2 Provider contract/events | PASS | Neutral contract present. |
| 3 Config/security | FAIL | Production config reproducibility + bearer ESM defect. |
| 4 Registry | PASS in isolation | Exact namespace/cache logic exists. |
| 5 HTTP skeleton | PARTIAL | Handlers exist; production composition unusable. |
| 6 Codex client | PASS/PARTIAL | Client exists; logging/finish normalization issues. |
| 7 Codex adapter | PARTIAL | Live path previously demonstrated; privacy + finish reason issues remain. |
| 8 Claude | FAIL | Global env mutation; fake/buffered streaming. |
| 9 Antigravity | FAIL | Runtime spending settings not enforced; buffered streaming. |
| 10 Command Code | PARTIAL | GOAT live inference proved externally; buffered streaming, entitlement filtering/timeout gaps. |
| 11 Chat Completions | PARTIAL | Mock compatibility exists; production entrypoint/cancellation issues. |
| 12 Responses API | PARTIAL | Same production/cancellation caveats. |
| 13 Tools | FAIL against authoritative DoD | All routes CHAT_ONLY; no Qoder-owned roundtrip. |
| 14 Observability | FAIL | UsageStore not connected to production requests. |
| 15 Preflight | FAIL | Unsafe state exits 0. |
| 16 Qoder acceptance | FAIL/PENDING | UI external; router production composition currently empty. |
| 17 macOS service | FAIL | Installer/preflight wrapper path bugs. |
| 18 Remote-worker contract | PASS | Versioned, provider-neutral, secret guard present. |
| 19 Final gate | FAIL | Multiple blockers; evidence stale; final audit criteria not met. |

## Independent final verdict

```text
CMM_SUBSCRIPTION_ROUTER_INDEPENDENT_AUDIT=FAIL
AUDITED_HEAD=4b0c21de905a089b8839cb1362618ca8f91589e3
FINAL_CLOSURE_ELIGIBLE=NO
```

The underlying provider-specific live work is valuable and several isolated components are sound, but the production composition and security/streaming/deployment gates need remediation before another final audit.
