# CMM Subscription Router — Targeted Remediation 4 Evidence (2026-09-09)

**Status:** `IMPLEMENTED_PENDING_INDEPENDENT_REAUDIT`

Follow-up to `docs/audits/2026-09-09-independent-reaudit3-c2b23dd.md`
(`AUDITED_HEAD=c2b23dd`, verdict FAIL). This report is remediation
evidence, not an independent audit. A fresh human re-audit is still
required. No live provider quota was burned: all proof is unit/contract,
real-boundary (actual SDK-input inspection, spawned argv, endpoint
validation, timeout behavior, temp filesystem, effective config), build,
and compiled-process checks.

## Heads

- Start: `91e6d05` (re-audit 3 report commit)
- Final: recorded at bundle time (see `git log`)
- Tree: clean at report time (`git status --short` empty)

## Delta commits

- `f90c9cd` fix: preserve Claude conversation context
- `f69dc37` fix: preserve Antigravity conversation context
  (also preserves Command Code Anthropic top-level system)
- `e5e880a` fix: enforce chat-only capability at HTTP boundary
- `54e7f58` fix: enforce Command Code deadlines on discovery and error bodies
- `1a7eaa3` fix: guarantee Antigravity temp cleanup on early exits
- `22ca089` fix: align preflight with effective provider configuration
- `b19ba64` fix: use configured Claude profile in auth guidance
- `d17b99f` docs: align router environment example with runtime
- (this report) docs: add targeted remediation 4 evidence

## Finding-by-finding evidence

### 1 — Claude full conversation semantics (was B1)

Root cause: `run()` built provider input by filtering to `role === "user"`,
dropping system instructions, assistant history, and tool results.

Changed (`src/providers/claude/adapter.ts`): new `buildClaudeConversation()`
splits Router messages into a system prompt plus ordered frames. System
content maps to the SDK's dedicated `systemPrompt` option
(`{ type: "custom", prompt, snapshot: false }` — snapshot off so per-request
Qoder instructions render fresh); user, assistant history, and tool results
(labelled `[tool_result <id>]` text on the user turn — words only, no
execution) stream in order as SDK `SDKUserMessage` frames via the official
`prompt: AsyncIterable<SDKUserMessage>` mechanism. Native tools stay disabled;
`CHAT_ONLY` unchanged; partial streaming untouched.

Tests (`tests/providers/claude-conversation.test.ts`): helper-level marker +
order assertions (`CLAUDE_SYSTEM_PRESERVED=YES`,
`CLAUDE_USER_HISTORY_PRESERVED=YES`, `CLAUDE_ASSISTANT_HISTORY_PRESERVED=YES`,
`CLAUDE_MESSAGE_ORDER_PRESERVED=YES`) AND actual-SDK-input inspection —
draining the real `query()` prompt iterable and asserting texts/roles in
order. Existing partial-streaming suites remain green.

Commit: `f90c9cd`. Remaining limitation: live multi-turn reproof pending
(no quota burned).

### 2 — Antigravity full conversation semantics (was B1)

Root cause: same user-only reduction before `agy --print`.

Changed (`src/providers/antigravity/adapter.ts`):
`serializeConversationForHeadlessPrompt()` emits deterministic
`[SYSTEM]` / `[USER]` / `[ASSISTANT]` / `[USER: tool_result <id>]` sections
in original order into the single headless prompt. No repo context injected,
no credentials, prompt never logged. Command Code Anthropic wire likewise
preserves top-level system content as Anthropic `system`
(`src/providers/command-code/client.ts` `buildAnthropicRequestBody`).

Tests (`tests/providers/antigravity-conversation.test.ts`): serializer
markers + ordering (`ANTIGRAVITY_*_PRESERVED=YES`) AND actual spawned argv
inspection (fake runner captures `--print` prompt, asserts all four markers
in order, no unsafe flags). True-streaming suites green
(`ANTIGRAVITY_FIRST_ROUTER_DELTA_BEFORE_UPSTREAM_COMPLETION=YES` intact).

Commit: `f69dc37`. Remaining limitation: live agy conversation reproof
pending.

### 3 — CHAT_ONLY enforcement at the Router boundary (was B2)

Root cause: capability was advertised metadata; endpoints accepted and
forwarded `tools` regardless, and the mocked loop fixture used `CHAT_ONLY`
while emitting tool calls.

Changed: new `RouterErrorCode` `unsupported_capability` (mapped to HTTP 400
in chat error mapping, shared by responses). `rejectChatOnlyTools()` in
`src/http/openai-chat.ts` fails closed BEFORE provider invocation on tools
definitions (non-empty), `tool_choice` / `parallel_tool_calls`, or tool-role
continuation messages for any model whose capability is `CHAT_ONLY`
(missing defaults to chat-only = fail closed). No stripping, no forwarding,
no fallback. Both chat and responses enforce via the shared helper.

Tests (`tests/http/chat-only-enforcement.test.ts`, 6 tests): per-wire
rejection on a `CHAT_ONLY` double with `PROVIDER_INVOCATION_COUNT=0` /
`CROSS_PROVIDER_FALLBACK=NONE` assertions
(`CHAT_ONLY_CHAT_COMPLETIONS_REJECTION=PASS`,
`CHAT_ONLY_RESPONSES_REJECTION=PASS`, `CHAT_ONLY_TOOL_ENFORCEMENT=PASS`);
`CHAT_AND_TOOLS` doubles still receive tools; plain chat still works.
Generic relay doubles retargeted to `CHAT_AND_TOOLS` per the audit.

Commit: `e5e880a`. Task 13 verdict unchanged: `NOT_MET`,
`BLOCKED_PROVIDER_CAPABILITY` (enforcement is truthfulness, not fulfillment).

### 4 — Command Code discovery + error body deadlines (was B3)

Root cause: `listModels()` awaited unbounded `readBodyText()`; non-200 paths
called `composed.cleanup()` BEFORE reading the error body. Headers-then-stall
on either path hung indefinitely.

Changed (`src/providers/command-code/client.ts`): `listModels()` composes the
caller signal with the client timeout and reads via `readBodyTextBounded()`
(remaining-budget race + caller sentinel). Both non-200 streaming paths read
error bodies through the same bounded reader. Stalls → `provider_timeout`;
completed bodies keep exact upstream mapping; caller abort stays silent. No
retries, no `/extra`, no on-demand/cross-provider fallback.

Tests (`tests/providers/command-code-body-coverage.test.ts`):
`/models` stall → `provider_timeout` (`COMMAND_CODE_MODELS_BODY_TIMEOUT=PASS`);
400/401/429/500 stalls → `provider_timeout`
(`COMMAND_CODE_ERROR_BODY_TIMEOUT=PASS`); completed 403 still maps to
`provider_quota_exhausted`. Proven RED on the pre-fix tree for the two stall
cases. All 6 Command Code suites green (46 tests).

Commit: `54e7f58`.

### 5 — Antigravity temp cleanup on early exits (was M1)

Root cause: `cmm-antigravity-run-*` was created before spending/PAYG/prompt/
argv validation, but the cleanup `finally` started after — early returns
leaked.

Changed: temp creation moved after every validation gate; the `try/finally`
owns all exits from creation onward. Early paths now allocate nothing.

Tests (`tests/providers/antigravity-allpath-cleanup.test.ts`, 4 paths):
empty prompt, PAYG poison, spawn failure, protocol error — each asserts zero
new temp dirs (`ANTIGRAVITY_ALL_PATH_TEMP_CLEANUP=PASS`). Proven 2-failed
pre-fix on the stashed tree.

Commit: `1a7eaa3`.

### 6 — Preflight effective configuration (was M2)

Root cause: preflight checked default profile path, default agy locations,
and hard-coded `COMMAND_CODE_SECRET`, diverging from production's
`profileDir` / `agyPath` / `secretEnv`.

Changed (`scripts/preflight.sh`): parses all three values from the same
shared config alongside enablement (single python source). Configured
`agyPath` is authoritative; profile check targets the configured dir (prints
`CLAUDE_PROFILE_DIR_CONFIG`); secret check dereferences the configured env
name (prints `COMMAND_CODE_SECRET_ENV`).

Tests (`tests/integration/preflight-config.test.ts`):
`PREFLIGHT_CLAUDE_PROFILE_CONFIG=PASS`, `PREFLIGHT_AGY_PATH_CONFIG=PASS`
(present + missing directions), `PREFLIGHT_COMMAND_SECRET_ENV_CONFIG=PASS`.
All 13 preflight tests green (matrix + redaction + fail-closed + config).

Commit: `22ca089`.

### 7 — Claude auth guidance profile (was M3)

Root cause: auth-required details interpolated the module default
`CLAUDE_CONFIG_DIR` while the SDK env correctly used the configured dir.

Changed (`src/providers/claude/adapter.ts`): `effectiveProfileDir()`
(`this.profileDir ?? defaultClaudeConfigDir()`) feeds all five guidance
strings; no user settings mutated; no secrets exposed.

Tests (`tests/providers/claude-auth-guidance.test.ts`):
`CLAUDE_AUTH_GUIDANCE_PROFILE=CONFIGURED` for custom dir, default path
otherwise. Proven RED pre-fix (custom case failed on stashed tree).

Commit: `b19ba64`.

### 8 — Env example alignment (was M4)

Root cause: `.env.example` advertised `CMM_ROUTER_HOST`/`CMM_ROUTER_PORT`,
which no runtime path consumes (host schema-locked to `127.0.0.1`, port from
shared config).

Changed: example keeps only `CMM_ROUTER_TOKEN` with a truthful header comment.
Safety path chosen: dead config removed, loopback policy untouched.

Tests (`tests/config/env-example.test.ts`): `ENV_EXAMPLE_MATCHES_RUNTIME=PASS`,
`LOOPBACK_ONLY=PASS`.

Commit: `d17b99f`.

### 9 — Task 13 (unchanged, per instructions)

No provider-specific live tool loop implemented or claimed (no quota burned).
Mocked neutral relay contract stands as plumbing evidence only. Verdict:

```text
TASK_13_ORIGINAL_DOD=NOT_MET
TOOL_ACCEPTANCE=BLOCKED_PROVIDER_CAPABILITY
PROVIDER_CAPABILITIES=chatgpt/CHAT_ONLY claude/CHAT_ONLY google/CHAT_ONLY command-code/CHAT_ONLY
```

No scope auto-amendment; human decides v1 chat-only formally.

## Verification (no live quota burned)

```text
TEST_RUN_1: 58 files passed | 5 skipped; 348 passed | 25 skipped
TEST_RUN_2: 348 passed | 25 skipped
TEST_RUN_3: 348 passed | 25 skipped
POST_BUILD_TEST: 348 passed | 25 skipped
TYPECHECK: PASS
BUILD: PASS
SECURITY_AUDIT: PASS
POISON PROBES: OPENAI_RC=1, ANTHROPIC_RC=1, GEMINI_RC=1
TARGETED REGRESSIONS (20 tests, 6 files): PASS
LIVE_TESTS_RUN: NO
```

## Security re-scan

- Tracked `user_…` values: none.
- `0.0.0.0` in sources: none (audit script's own detection string only).
- Provider/HTTP `console.*` content logging: none.
- `oauth`/`api_key`/`access_token` hits: guards only (wire secret-field
  rejection list, PAYG allowlist comments, settings-gate messages) — no
  extraction, copy, or sync paths.
- Invariants hold: `API_PAYG_FALLBACK=NONE`, `CROSS_PROVIDER_FALLBACK=NONE`,
  `UNKNOWN_MODEL_FALLBACK=NONE`, `COMMAND_CODE_ON_DEMAND=NONE`,
  prompt/completion/tool-body logging NONE, bind `127.0.0.1`.
- Normal Claude/OmniRoute config untouched; Antigravity global settings
  untouched; Qwen untouched; Command Code key/ack never created here.

## Known limitations / next

- Live multi-turn conversation reproof (Claude/Antigravity/CC-Anthropic),
  live GOAT inference, Qoder UI acceptance, iMac install: externally gated,
  pending human runs.
- Task 13 DoD NOT_MET by design of this pass; scope decision is the human's.
- `launchctl bootstrap` runtime smoke remains blocked by test environment
  (prior pass; unchanged).
