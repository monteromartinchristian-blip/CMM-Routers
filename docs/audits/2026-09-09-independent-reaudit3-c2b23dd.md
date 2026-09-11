# CMM Subscription Router — Independent Re-audit 3

**Date:** 2026-09-09
**Audited HEAD:** `c2b23dd9bc90e0cfa700b0a5ecefd05772f303dd`
**Bundle SHA-256:** `a8f6fbde3799ecdcda36f06ae0a7dc31b1e308935bb0f371b1e94a8aed611aaf`
**Verification log SHA-256:** `198803ce886968f3f3706d4e21bfe8711ef09ca3e5661910d82ed3e793f22131`
**Verdict:** `FAIL — NOT YET LIVE-READY`

## 1. Integrity and supplied verification

The uploaded tarball is a Git archive whose embedded commit is exactly:

`c2b23dd9bc90e0cfa700b0a5ecefd05772f303dd`

The supplied verification log records:

- 3 consecutive full runs: `324 passed / 25 skipped`
- post-build run: `324 passed / 25 skipped`
- typecheck: PASS
- build: PASS
- security audit: PASS
- OpenAI PAYG poison: rc 1
- Anthropic PAYG poison: rc 1
- Google PAYG poison: rc 1
- real socket disconnect test: PASS
- targeted provider suite: PASS

The standalone command in the capture named `tests/http/production-process.test.ts` failed only because that filename does not exist. The actual test is `tests/http/dist-process-boot.test.ts`; it was executed in every full suite and proves a real `node dist/index.js` subprocess over TCP with auth, non-empty models, diagnostics, chat, Responses, usage, and clean shutdown.

This audit did not independently reinstall npm dependencies or rerun Vitest in the isolated audit container; test-pass claims above are grounded in the supplied captured log. Source-level findings below were independently inspected from the exact archive.

## 2. Previously reported blockers that are genuinely fixed

### PASS — production composition / actual entrypoint

`src/index.ts` now composes real enabled providers and a production `UsageStore`. `tests/http/dist-process-boot.test.ts` starts the compiled `dist/index.js` process rather than merely importing it.

### PASS — ESM bearer auth

The prior CommonJS `require()` problem is absent from the production authentication path.

### PASS — Claude process.env isolation

Claude builds an explicit allowlisted SDK environment and does not mutate global Anthropic environment variables per request.

### PASS — Claude partial-message streaming mechanism

`ClaudeAdapter.run()` now sets `includePartialMessages: true`, consumes `stream_event` / `content_block_delta` / `text_delta`, suppresses the duplicate trailing assistant echo, and has a race-proof first-delta-before-completion test.

### PASS — Antigravity adapter-level streaming buffer removed

`AntigravityAdapter.run()` now bridges subprocess callbacks through `StreamEventQueue` and drains the queue while `streamInference()` remains pending. The previous `pendingTexts`-after-process-exit design is gone.

### PASS — fresh-clone shared config bootstrap

`createProductionRegistry()` now invokes `ensureSharedConfigFromExample()` before `loadConfig()` when no config object is injected. Existing config is not overwritten.

### PASS — fail-closed preflight core cases

`OPENAI_API_KEY`, Anthropic PAYG variables, Google PAYG variables, enabled-provider auth absence, enabled-provider binary absence, and missing Node produce a non-zero preflight result in the current implementation/tests. Disabled providers can be skipped.

### PASS — real HTTP disconnect proof

`tests/http/socket-disconnect.test.ts` uses a real Fastify server and Node HTTP socket, destroys the client mid-stream, and verifies abort propagation, provider cancel, and usage cleanup without manually calling `cancel()` from the test.

### PASS — Command Code streamed-body deadline

The streaming paths retain a composed deadline through body iteration via `iterateWithDeadline()` and an abort-aware frame iterator. The shared TextDecoder was also replaced with per-response decoder state.

### PASS — Antigravity discovery cleanup

`discoverModels()` now removes its discovery temp directory in a `finally` block on success and failure.

### PASS — launchd path/failure mechanics

Installer path resolution is now rooted two levels above `scripts/macos`, missing-template errors propagate non-zero, plist rendering is linted, and uninstall behavior is tested. A real `launchctl bootstrap` remains intentionally unproven.

## 3. Remaining blockers

### B1 — MAJOR FUNCTIONAL: Claude and Antigravity discard system + assistant history

**Files:**

- `src/providers/claude/adapter.ts`
- `src/providers/antigravity/adapter.ts`

Both adapters currently build their effective prompt by filtering only:

`message.role === "user"`

Claude joins only user messages before passing the prompt to the Agent SDK. Antigravity does the same before invoking `agy --print`.

The Router's public contract accepts `system`, `user`, `assistant`, and `tool` messages. Qoder/OpenAI-compatible clients normally send system instructions and prior assistant turns as part of the conversation. Dropping those messages means a routed request can lose the Qoder system prompt, prior model answers, and conversation state.

This conflicts with the design's normalized message semantics and makes Chat Completions only partially compatible for these routes.

**Impact:** high. Even in `CHAT_ONLY` mode the two providers can behave as stateless/under-instructed models inside Qoder.

**Required remediation:** define a provider-safe conversation serializer that preserves role boundaries and order. For Claude, use supported Agent SDK context/system mechanisms where available; otherwise serialize all non-tool chat history explicitly and use a proper system option if supported. For Antigravity, flatten full supported history with unambiguous role delimiters into the one headless prompt. Add tests proving system instruction + user + assistant + next user all reach the provider in order.

Command Code's Anthropic Messages wire should likewise preserve top-level system content instead of dropping system-role messages when converting to Anthropic format.

### B2 — MAJOR CAPABILITY/SAFETY: `CHAT_ONLY` is documented but not enforced at HTTP boundary

All discovered production models report `CHAT_ONLY`, and README says external tools are blocked. However Chat Completions and Responses accept `tools` regardless of `model.capability` and forward the request to the adapter.

`CommandCodeAdapter` even converts and forwards tools on its OpenAI wire despite discovered models being declared `CHAT_ONLY`.

The mocked tool-loop test deliberately uses a model whose capability is `CHAT_ONLY` and then emits a tool call. That proves generic relay plumbing, but it also demonstrates that capability is metadata only, not an enforced boundary.

The implementation plan explicitly says a provider that cannot represent externally-owned tool calls should be marked chat-only **and not exposed to Qoder Agent mode** until support exists.

**Impact:** high. Qoder can submit agent/tool requests to models that the Router says do not support them; behavior then varies by adapter instead of failing closed.

**Required remediation for a chat-only v1:** if `model.capability === "CHAT_ONLY"` and request contains tools/tool-result continuation semantics, reject deterministically with a stable `unsupported_capability`/`invalid_request`-style error before provider execution. The mocked generic tool-loop fixture should use `CHAT_AND_TOOLS`, not `CHAT_ONLY`.

If the human chooses to satisfy the original Task 13 DoD instead, implement and live-prove per-provider externally-owned tool round trips before advertising `CHAT_AND_TOOLS`.

### B3 — MAJOR RELIABILITY: Command Code deadline still does not cover model-discovery/error bodies

**File:** `src/providers/command-code/client.ts`

The new body watchdog correctly protects successful streaming bodies. Two paths remain outside that protection:

1. `listModels()` awaits `readBodyText(response)` after `fetchFn()` returns. In the default fetch wrapper the internal header timer is cleaned up when the `Response` object is returned. If `/models` sends headers and stalls its body, model discovery/health can wait indefinitely.
2. For non-200 streaming responses, `streamAnthropicMessages()` and `streamPath()` call `composed.cleanup()` **before** `readBodyText(response)`. A server that returns error headers and then stalls the error body can also hang indefinitely.

Because registry refresh/model discovery participates in startup/health, the `/models` case can stall the service before normal routing.

**Required remediation:** add an abort-aware bounded text-body reader and keep the composed deadline alive through model/error body consumption. Tests should cover headers-immediate/body-hangs for `/models` and non-200 request bodies.

## 4. Additional defects / cleanup

### M1 — Antigravity inference temp directory can leak on early validation returns

`AntigravityAdapter.run()` creates `cmm-antigravity-run-*` before several checks, but the cleanup `finally` begins later.

Early returns for an invalid/empty user prompt, an environment guard failure, or the unsafe-argv guard occur before entering that `try/finally`, leaving the temp directory behind.

Move creation inside an outer `try/finally`, or start the cleanup scope immediately after `mkdtempSync()`.

### M2 — preflight ignores configurable provider paths/names

Runtime supports:

- `providers.claude.profileDir`
- `providers.google.agyPath`
- `providers.command-code.secretEnv`

but `scripts/preflight.sh` checks the default Claude profile path, default agy discovery locations, and hard-coded `COMMAND_CODE_SECRET`.

A valid custom configuration can therefore fail preflight, and an invalid default path can be checked even though production will use another path.

Parse these configured values together with provider enablement and test custom-path/custom-secret cases.

### M3 — Claude auth guidance uses default profile path

`ClaudeAdapter` correctly injects a configured `profileDir` into the SDK environment, but auth-required error details still interpolate the module-level default `CLAUDE_CONFIG_DIR`. A custom-profile deployment receives the wrong login command.

Use `this.profileDir ?? defaultClaudeConfigDir()` for user-facing guidance.

### M4 — `.env.example` advertises unused host/port variables

`.env.example` contains `CMM_ROUTER_HOST` and `CMM_ROUTER_PORT`, while runtime host/port come from shared config and the schema hard-locks host to `127.0.0.1`. Either remove the unused variables or deliberately wire/document them without weakening loopback-only policy.

## 5. Task 13 status

The generic HTTP tool relay contract is now demonstrated with mocks, but the production providers remain:

- `chatgpt/*` — `CHAT_ONLY`
- `claude/*` — `CHAT_ONLY`
- `google/*` — `CHAT_ONLY`
- `command-code/*` — `CHAT_ONLY`

Therefore:

`TASK_13_ORIGINAL_DOD=NOT_MET`

`TOOL_ACCEPTANCE=BLOCKED_PROVIDER_CAPABILITY`

This remains a human scope decision. The original plan's Definition of Done still contains `QODER_TOOL_ROUNDTRIP=PASS`.

If v1 is formally amended to chat-only, capability enforcement (B2) must be added so Agent-mode/tool requests fail closed instead of being silently accepted.

## 6. Verification interpretation

The capture's explicit command:

`npx vitest run tests/http/production-process.test.ts`

returned rc 1 because that filename was guessed incorrectly. This is **not** evidence that production-process testing failed. The real test file `tests/http/dist-process-boot.test.ts` ran and passed in all three full suites and the post-build suite, producing:

- `ACTUAL_DIST_PROCESS_BOOT=PASS`
- `ACTUAL_DIST_HTTP=PASS`
- `ACTUAL_DIST_AUTH=PASS`
- `ACTUAL_DIST_MODELS_NONEMPTY=PASS`
- `ACTUAL_DIST_USAGE=PASS`
- `ACTUAL_DIST_CLEAN_SHUTDOWN=PASS`

No remediation is required for the filename mismatch itself.

The repeated Codex model-manager timeout messages appearing during tests are noisy environmental/provider-process diagnostics; they did not fail the suites. They should not be treated as proof of a Router defect without a reproducible failing behavior.

## 7. Re-audit verdict

```text
CMM_SUBSCRIPTION_ROUTER_INDEPENDENT_REAUDIT_3=FAIL
AUDITED_HEAD=c2b23dd9bc90e0cfa700b0a5ecefd05772f303dd
INTEGRITY=PASS
REGRESSION_SIGNAL=STRONG
PREVIOUS_REMEDIATION_FIXES=SUBSTANTIALLY_VERIFIED
LIVE_FINAL_REPROOF_AUTHORIZED=NO

BLOCKERS:
- preserve full chat/system/history semantics for Claude + Antigravity
- enforce CHAT_ONLY capability at Qoder-facing HTTP boundary OR implement Task 13
- bound Command Code /models and non-200 body consumption by deadline

FOLLOW_UP:
- close Antigravity early-return temp cleanup
- make preflight honor custom provider paths/secret env
- correct Claude custom-profile auth guidance
- clean unused .env host/port documentation

TASK_13_ORIGINAL_DOD=NOT_MET
QODER_UI_ACCEPTANCE=PENDING
IMAC_LIVE_INSTALL=PENDING
LAUNCHD_RUNTIME_SMOKE=BLOCKED_TEST_ENVIRONMENT
NEXT=TARGETED_REMEDIATION_4
```

The next remediation should be small and must not reopen the fixes already validated in this re-audit.
