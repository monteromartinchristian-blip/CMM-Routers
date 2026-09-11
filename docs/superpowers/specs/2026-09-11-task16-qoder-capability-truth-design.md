# Task 16 — Qoder Capability Truth Design

**Date:** 2026-09-11
**Status:** APPROVED CORRECTION
**Parent:** Task 16 — Qoder Production Adoption
**Supersedes:** the provisional `200000 context / 8192 output / no thinking` metadata used by the first local Qoder provisioner.

## 1. Problem

The first Qoder provisioner deliberately used one conservative metadata shape for every CMM Router model:

- `contextWindow = 200000`
- `maxOutputTokens = 8192`
- `vision = false`
- no thinking/effort declaration

That is not an acceptable production representation.

For models with a larger real context window, Qoder can compact or truncate earlier than necessary. For models with adjustable reasoning, Qoder hides controls the runtime can actually support. Conversely, advertising vision today would also be false because the current Router message model does not transport image input.

Task 16 therefore needs **capability truth**, not a lowest-common-denominator profile.

## 2. Evidence already established

Local discovery on 2026-09-11 proved:

- Qoder custom models persist `contextWindow`, `maxOutputTokens`, `capabilities.vision`, and `capabilities.thinking.supportedEffortLevels`.
- Qoder/OpenAI-compatible chat uses the OpenAI-style `reasoning_effort` convention.
- `src/http/openai-chat.ts` currently does **not** parse reasoning effort.
- `src/http/openai-responses.ts` parses effort, but the Router type is restricted to `low | medium | high`.
- Codex, Claude and Antigravity adapters currently do not consume `request.reasoningEffort`.
- Claude Agent SDK accepts `low | medium | high | xhigh | max`.
- Antigravity `agy 1.2.0` accepts `--effort low|medium|high`.
- the Router currently has no image-input transport path, so effective Qoder vision support is false.
- Codex app-server model metadata can advertise supported reasoning efforts.
- Qoder supports configurable context windows and effort levels for custom models.

## 3. Design principle

Qoder must advertise the **effective intersection**:

`QODER_UI ∩ CMM_ROUTER_TRANSPORT ∩ SUBSCRIPTION_RUNTIME`

Provider-native capability alone is insufficient.

Examples:

- a model may support vision upstream, but Qoder must show `vision=false` until the Router transports images;
- a model may support `max` reasoning upstream, but it must not be shown if the subscription runtime path only accepts up to `high`;
- an Antigravity model whose slug already fixes `-low`, `-medium`, or `-high` must not also expose a contradictory adjustable effort selector.

## 4. Canonical capability type

Extend discovered model metadata with a namespaced capability record:

```ts
export type ReasoningEffort =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface ModelRuntimeCapabilities {
  contextWindow: number;
  maxOutputTokens: number;
  vision: boolean;
  reasoning:
    | { mode: "none" }
    | { mode: "fixed"; effort: Exclude<ReasoningEffort, "none"> }
    | {
        mode: "adjustable";
        supportedEfforts: ReasoningEffort[];
        defaultEffort?: ReasoningEffort;
      };
}
```

`DiscoveredModel` gains:

```ts
runtimeCapabilities?: ModelRuntimeCapabilities;
```

No capability is invented when evidence is absent.

## 5. Runtime effort transport

### 5.1 OpenAI-compatible Chat Completions

`/v1/chat/completions` must parse top-level:

```json
{"reasoning_effort":"high"}
```

Accepted values are exactly:

`none | low | medium | high | xhigh | max`

Unknown strings fail with `400 invalid_request`.

If a resolved model declares:

- `reasoning.mode=none`: any explicit effort fails closed;
- `reasoning.mode=fixed`: an explicit effort different from the fixed level fails closed;
- `reasoning.mode=adjustable`: only listed levels are accepted.

### 5.2 Responses

`/v1/responses` keeps `reasoning.effort`, but expands the validated enum to the same canonical set and applies the same per-model validation.

### 5.3 Codex

Codex receives the validated effort through the schema-backed `turn/start` effort field.

The Router must not synthesize an effort when Qoder omitted one. Provider/runtime defaults remain provider-owned.

### 5.4 Claude

Claude receives the validated effort through Claude Agent SDK `Options.effort`.

No PAYG variables or fallback models are introduced.

### 5.5 Antigravity

For models whose CMM capability is `adjustable`, pass:

`--effort <low|medium|high>`

to `agy`.

For fixed-effort slugs, do not add a second effort control.

## 6. Effective Qoder matrix — initial 25 models

All `vision` values below are **false in Qoder v1**, even where the upstream model is multimodal, because the Router currently transports text only.

### 6.1 ChatGPT / Codex

| Router model | Context | Max output | Qoder effort |
|---|---:|---:|---|
| `chatgpt/gpt-5.5` | 1,050,000 | 128,000 | dynamic Codex metadata; expected `none,low,medium,high,xhigh` |
| `chatgpt/gpt-5.6-luna` | 1,050,000 | 128,000 | dynamic Codex metadata; expected `none,low,medium,high,xhigh,max` |
| `chatgpt/gpt-5.6-sol` | 1,050,000 | 128,000 | dynamic Codex metadata; expected `none,low,medium,high,xhigh,max` |
| `chatgpt/gpt-5.6-terra` | 1,050,000 | 128,000 | dynamic Codex metadata; expected `none,low,medium,high,xhigh,max` |
| `chatgpt/gpt-6-astra` | 1,050,000 | 128,000 | dynamic Codex metadata; expected `low,medium,high,xhigh,max` |
| `chatgpt/gpt-daybreak-blue-latest` | 1,050,000 | 128,000 | dynamic Codex metadata only; no guessed fallback effort list |

For Codex, live app-server `model/list` is authoritative for adjustable reasoning levels. Static documented expectations are assertions/diagnostics, not a substitute for runtime truth.

### 6.2 Claude subscription

| Router model | Context | Max output | Qoder effort |
|---|---:|---:|---|
| `claude/claude-fable-5-1[1m]` | 1,000,000 | 128,000 | `low,medium,high,xhigh,max` |
| `claude/default` | target-derived | target-derived | target-derived |
| `claude/opus` | 1,000,000 | 128,000 | `low,medium,high,xhigh,max` when alias resolves to current Opus family |
| `claude/sonnet` | 1,000,000 | 128,000 | `low,medium,high,xhigh,max` when alias resolves to current Sonnet family |
| `claude/haiku` | 200,000 | 64,000 | none; Haiku 4.5 does not expose the modern effort parameter |

Claude aliases use `supportedModels()` display information to select the capability family. Unknown future alias targets fail closed rather than inheriting stale metadata.

### 6.3 Google / Antigravity

| Router model | Context | Max output | Effort mode |
|---|---:|---:|---|
| `google/claude-opus-4-6-thinking` | 1,000,000 | 128,000 | adjustable `low,medium,high` through `agy --effort` |
| `google/claude-sonnet-4-6` | 1,000,000 | 128,000 | adjustable `low,medium,high` through `agy --effort` |
| `google/gemini-3.1-pro-high` | 1,048,576 | 65,536 | fixed `high` |
| `google/gemini-3.1-pro-low` | 1,048,576 | 65,536 | fixed `low` |
| `google/gemini-3.6-flash-high` | 1,048,576 | 65,536 | fixed `high` |
| `google/gemini-3.6-flash-low` | 1,048,576 | 65,536 | fixed `low` |
| `google/gemini-3.6-flash-medium` | 1,048,576 | 65,536 | fixed `medium` |
| `google/gemini-3.7-flash-high` | 1,048,576 | 65,536 | fixed `high` |
| `google/gemini-3.7-flash-low` | 1,048,576 | 65,536 | fixed `low` |
| `google/gemini-3.7-flash-medium` | 1,048,576 | 65,536 | fixed `medium` |
| `google/gemini-3.8-flash-high` | 1,048,576 | 65,536 | fixed `high` |
| `google/gemini-3.8-flash-low` | 1,048,576 | 65,536 | fixed `low` |
| `google/gemini-3.8-flash-medium` | 1,048,576 | 65,536 | fixed `medium` |
| `google/gpt-oss-120b-medium` | 131,072 | 131,072 | fixed `medium` |

The `*-low|medium|high` Antigravity slugs already encode reasoning level. Qoder therefore does not get an adjustable effort selector for them.

## 7. Qoder serialization

Qoder model entries are generated from `runtimeCapabilities`.

For adjustable reasoning:

```json
{
  "capabilities": {
    "vision": false,
    "thinking": {
      "modes": ["enabled"],
      "supportsEffort": true,
      "supportedEffortLevels": ["low", "medium", "high"]
    }
  }
}
```

For fixed or unavailable reasoning, omit the `thinking` object. The effort is conveyed by the model ID itself where fixed.

`contextWindow` and `maxOutputTokens` use the matrix/runtime values above.

The provisional 200K/8192 metadata is forbidden by regression tests for models whose truth is larger.

## 8. `/v1/models` capability extension

Keep standard OpenAI fields and add one namespaced extension:

```json
{
  "id": "chatgpt/gpt-5.6-sol",
  "object": "model",
  "owned_by": "cmm:chatgpt",
  "x_cmm": {
    "context_window": 1050000,
    "max_output_tokens": 128000,
    "vision": false,
    "reasoning": {
      "mode": "adjustable",
      "supported_efforts": ["none","low","medium","high","xhigh","max"]
    }
  }
}
```

Clients that ignore unknown fields remain compatible.

Task 16B will consume this extension to build the shared Qoder manifest. This prevents a second manually maintained capability table.

## 9. Vision boundary

Task 16 does not implement multimodal input.

Until `RouterMessage` and all required provider adapters carry image input end-to-end:

`QODER_VISION_ADVERTISED=NO`

This is deliberately stricter than provider-native documentation.

Vision becomes a separate evidence-backed task.

## 10. Security invariants

Unchanged:

- `NO_PAYG_FALLBACK=YES`
- `NO_CROSS_PROVIDER_FALLBACK=YES`
- `NO_UNKNOWN_MODEL_FALLBACK=YES`
- `QODER_EXECUTION_OWNER=YES`
- `PROVIDER_NATIVE_REPO_MUTATION=NONE`
- `TRACKED_SECRETS=NONE`
- `DO_NOT_PUSH=YES`

New:

- unsupported effort fails closed;
- fixed effort cannot be silently overridden;
- no capability is advertised unless the Router path actually transports it;
- Qoder settings backups containing credentials are local-only, never iCloud.

## 11. Correcting the already-provisioned MacBook

The existing `qoder-custom-cmm-router` entry may contain the provisional 200K metadata.

The corrected provisioner must:

1. verify Router health and exact 25-model catalog;
2. read the local Qoder bearer from Keychain without printing it;
3. create a secret-bearing backup under a **local-only** directory, not iCloud;
4. replace only `providers["qoder-custom-cmm-router"]`;
5. use capability metadata returned by authenticated `/v1/models`;
6. preserve every unrelated Qoder provider;
7. write atomically while Qoder is closed;
8. reopen Qoder;
9. verify all 25 entries and their metadata;
10. never run provider inference.

## 12. Task 16B dependency

Cross-Mac sync does not start until this capability truth work is closed.

Task 16B will synchronize a non-secret manifest derived from `/v1/models.x_cmm`, while each Mac injects its own local Keychain bearer.

Therefore the MacBook and iMac will consume the same capability truth rather than synchronizing the provisional 200K configuration.

## 13. Acceptance

Task 16 capability truth closes only when deterministic tests prove:

- Chat Completions parses and validates `reasoning_effort`;
- Responses validates the full canonical effort enum;
- Codex receives selected effort on `turn/start`;
- Claude receives selected effort through SDK options;
- Antigravity receives `--effort` only for adjustable models;
- fixed-effort model overrides fail closed;
- `/v1/models` emits accurate `x_cmm`;
- Qoder generated metadata matches `x_cmm`;
- no current model is globally forced to 200K/8192;
- effective vision remains false until multimodal transport exists;
- the corrected MacBook Qoder entry has 25 models;
- unrelated Qoder providers are byte/semantic-preserved;
- no provider inference is required;
- full deterministic suite passes;
- worktree is clean;
- no push occurs.
