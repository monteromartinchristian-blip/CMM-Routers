# Task 14 — Codex Post-Tool Continuation Compatibility

## Status

**CLOSED — preferred outcome achieved (live ChatGPT/Codex canary PASS).**

## Goal

Make ChatGPT/Codex complete a real Qoder-owned external tool round-trip with a visible post-tool final assistant answer through a supported Codex path, without weakening any Router security or subscription-only guarantees.

## Result

Live canary on `chatgpt/gpt-5.6-sol`, 2026-09-11, after the fix:

```
LIVE_CANARY_EXACT_MODEL_SELECTION=PASS
LIVE_CANARY_MODEL_FALLBACK=NONE
LIVE_CANARY_AUTH_CONSUMER=QODER
LIVE_CANARY_CAPABILITY=CHAT_AND_TOOLS
LIVE_CANARY_TOOL_REQUEST_RECEIVED=YES
LIVE_CANARY_RESULT_NONCE_ONLY_AFTER_TOOL_CALL=YES
LIVE_CANARY_TOOL_RESULT_IS_UNIQUE_INFORMATION=YES
LIVE_CANARY_QODER_SYNTHETIC_EXECUTION=YES
LIVE_CANARY_TOOL_RESULT_SUBMITTED=YES
LIVE_CANARY_SAME_PROVIDER_CONTINUATION=YES
LIVE_CANARY_SECOND_RESPONSE_TERMINAL=YES
LIVE_CANARY_FINAL_DERIVED_FROM_TOOL_RESULT=YES
LIVE_CANARY_FULL_ROUNDTRIP=PASS
LIVE_CANARY_PASS_EXIT=0
```

`FINAL_DERIVED_FROM_TOOL_RESULT=YES` is emitted only when the final text
contains `RESULT_NONCE=<per-run random value>` — a value generated *after* the
tool call and present nowhere in the prompt, the tool call or the tool
arguments. The answer is therefore causally derived from the Qoder-produced tool
result, on the same provider, same thread and same turn. No fallback, no PAYG,
no synthetic history.

Evidence: `CMM-Subscription-Router-task14-codex-live-canary-chatgpt-2026-09-11.txt`.

## Starting point

Base commit:

`1d34199564fba68b0f45d8aa25711127a90f1e85`

Parent implementation baseline:

`6b772f039197b030f90c906ec75b1f31cbef2207`

Known live behavior on `codex app-server 0.153.4` before the fix:

1. real provider tool request succeeds;
2. Qoder-owned result is correlated successfully;
3. continuation remains on the same provider, same thread and same turn;
4. Codex reports output/reasoning tokens;
5. final `agentMessage` is empty;
6. the same empty post-tool final answer is reproducible directly against `codex app-server`, with no CMM Router in the loop.

## Findings (2026-09-11)

### F1 — The Router is exonerated (unchanged)

Deterministic replay of the verbatim live continuation frames through the real
`CodexAdapter` proves the Router surfaces any text the provider emits:

- observed frames (empty `agentMessage`) → no `text_delta`, terminal `completed`;
- counterfactual frames (same order, non-empty `agentMessage`) → the text IS
  surfaced as `text_delta`.

Evidence: `CMM-Subscription-Router-task13-codex-live-replay-temp-6b772f0.ts`
(investigation artifact) and the live frame capture below.

### F2 — The Task 13 "direct app-server reproduction" was confounded

The Task 13 exoneration rested on reproducing the empty final answer directly
against `codex app-server`. That reproduction used the **same prompt as the live
canary**:

```
You must call the tool canary_echo exactly once with {"text":"<sentinel>"}.
Do not answer in plain text. Do not call any other tool.
```

`Do not answer in plain text` is a prohibition on the very output being tested.
It is reproduced verbatim in the direct probe
(`CMM-Subscription-Router-task13-codex-raw-appserver-repro-6b772f0.txt`,
`turn/start` input, sentinel `probe123`).

So the direct reproduction reproduced the **harness instruction**, not an
independently established provider limitation. `UPSTREAM_LIMITATION_CONFIRMED`
is therefore NOT established — confirmed false by the live PASS above.

### F3 — Why the confound bites Codex specifically

The continuation shapes differ by provider:

- Claude / Google / Command Code: the continuation is a **separate request**
  whose last message is a `tool` result. The model is answering a fresh turn, and
  Google's live canary PASSED with the original prompt.
- ChatGPT / Codex: the continuation **reuses the same provider turn** (the Router
  answers the parked `item/tool/call` via `respondToServerRequest` and re-enters
  `drainTurn`; it never issues a second `turn/start`). The original prompt,
  including `Do not answer in plain text`, is therefore still in context when the
  tool result arrives.

Under that instruction the model has completed its only permitted action and has
nothing left to emit → empty final `agentMessage`. The captured frame sequence is
consistent with this: `dynamicToolCall` completed → `reasoning` item → `agentMessage`
`text:""` `phase:"final_answer"` → `turn/completed`.

### F4 — Version check

- installed: `codex-cli 0.153.4` (npm `@openai/codex`).
- current stable: `0.154.0`; alpha `0.155.0-alpha.3`.
- `0.154.0` experimental schema diff vs `0.153.4`: additive only for the
  continuation surface (`TurnStartParams`/`ThreadStartParams`/`ItemCompleted`/
  `TurnCompleted` unchanged in the fields the Router uses; new
  `UserVerification/*` client requests, new `ThreadEnvironment`/`daybreakEnabled`/
  `originator` thread fields). No post-tool text-emission change is implied by the
  schema.
- A newer version alone is therefore not a supported fix; the installed version
  was not changed. The live PASS was produced on the original `0.153.4`.

### F5 — Protocol options reviewed

- `turn/start.toolOutput` exists but only on a **new** `turn/start`; using it
  would replace the true same-turn external-tool continuation with synthetic
  history, which Task 14 forbids.
- `AgentMessageDelivery` is `async`-only; `MessagePhase` is `commentary |
  final_answer`. Neither exposes a "suppress final text" control.
- `TurnItemsView` (`notLoaded | summary | full`) explains `turn.items = []`; the
  text carrier is `item/agentMessage/delta` / `item/completed`, not `turn.items`.
- No supported app-server configuration was found that changes post-tool text
  emission.

## Change

The canary prompt is now provider-scoped (`buildCanaryPrompt(provider, sentinel)`
in `scripts/live-canary/canary-driver.ts`):

- `chatgpt`: forces the single `canary_echo` call **and** requires a plain-text
  final answer derived from the tool result;
- `claude` / `google` / `command-code`: **byte-for-byte unchanged**, so their
  recorded live evidence remains valid and Task 14 does not alter their behavior.

No Router production code was changed: no supported protocol path was shown to be
misused, and no fabricated text, synthetic history or empty-answer shim was added.

## Deterministic verification

- `npx vitest run tests/live-canary/canary-driver.test.ts` → 27 passed.
- `npx vitest run tests/providers tests/live-canary` → 372 passed.
- `npm run typecheck` → clean.
- `npm run build` → clean.
- `bash scripts/security-audit.sh` → `SECURITY_AUDIT=PASS`.
- full suite ×2 → 676 passed / 25 skipped.

Regression coverage added in `tests/live-canary/canary-driver.test.ts`:

- the ChatGPT prompt must contain the tool call requirement and a plain-text
  answer requirement, and must NOT forbid plain text;
- the other providers' prompt must equal the original string byte-for-byte;
- both ChatGPT requests must carry the corrected prompt.

## Evidence

- `CMM-Subscription-Router-task14-codex-post-tool-continuation-2026-09-11.txt`
- `CMM-Subscription-Router-task14-codex-live-canary-chatgpt-2026-09-11.txt`

Both stored with SHA-256 sidecars in the canonical iCloud Downloads evidence
directory. Task 13 remains CLOSED.

## Hard constraints (unchanged, all preserved)

Do not replace true external-tool continuation with fake assistant/tool history
merely to make the canary green.

Preserve:

- same-provider continuation;
- Qoder execution ownership;
- no provider-native repo mutation;
- no PAYG;
- no cross-provider fallback;
- no unknown-model fallback;
- request isolation;
- correlation integrity;
- no secret logging;
- no push unless separately authorized.
