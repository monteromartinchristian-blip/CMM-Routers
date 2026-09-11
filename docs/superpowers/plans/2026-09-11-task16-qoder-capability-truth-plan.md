# Task 16 Qoder Capability Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace provisional Qoder metadata with evidence-backed per-model capabilities and make Qoder reasoning effort actually reach the subscription runtimes.

**Architecture:** Capability truth lives on `DiscoveredModel.runtimeCapabilities`, is exposed through namespaced `/v1/models.x_cmm`, validated at HTTP ingress, and consumed by provider adapters. Qoder provisioning consumes the same metadata, so UI configuration and runtime behavior cannot drift independently.

**Tech Stack:** TypeScript, Fastify, Vitest, Codex app-server JSON-RPC, Claude Agent SDK, Antigravity CLI, macOS Keychain/Qoder JSON provisioning.

**Spec:** `docs/superpowers/specs/2026-09-11-task16-qoder-capability-truth-design.md`

## Global Constraints

- No API PAYG fallback.
- No cross-provider fallback.
- No unknown-model fallback.
- Qoder remains the tool executor.
- Provider-native repository mutation remains disabled.
- Do not advertise vision until Router image transport exists.
- Command Code remains disabled/deferred.
- No live inference is required for this task.
- Do not print or commit bearer/API secrets.
- Secret-bearing Qoder backups are local-only, never iCloud.
- Do not push.

---

### Task 1: Capability types and validation primitives

**Files:**
- Modify: `src/core/model.ts`
- Create: `src/core/model-capabilities.ts`
- Test: `tests/core/model-capabilities.test.ts`

**Interfaces:**
- Produces `ReasoningEffort`, `ModelRuntimeCapabilities`.
- Produces `validateReasoningEffort(model, requested)` returning a validated effort or throwing `RouterError("invalid_request", ...)`.

- [ ] **Step 1: Write failing tests**

Cover:

```ts
expect(validateReasoningEffort(adjustable(["low","high"]), "high")).toBe("high");
expect(() => validateReasoningEffort(adjustable(["low","high"]), "xhigh"))
  .toThrow(/not supported/i);
expect(() => validateReasoningEffort(fixed("medium"), "high"))
  .toThrow(/fixed.*medium/i);
expect(validateReasoningEffort(fixed("medium"), undefined)).toBeUndefined();
```

Also assert the canonical enum accepts `none|low|medium|high|xhigh|max`.

- [ ] **Step 2: Run the focused test and observe RED**

Run:

`npm test -- tests/core/model-capabilities.test.ts`

Expected: failure because capability types/validator do not exist.

- [ ] **Step 3: Implement minimal capability types and validator**

Do not add provider-specific knowledge here.

- [ ] **Step 4: Run focused tests GREEN**

- [ ] **Step 5: Commit**

`git commit -m "feat: add model runtime capability truth"`

---

### Task 2: Per-provider discovery capability metadata

**Files:**
- Create: `src/providers/codex/capabilities.ts`
- Create: `src/providers/claude/capabilities.ts`
- Create: `src/providers/antigravity/capabilities.ts`
- Modify: `src/providers/codex/adapter.ts`
- Modify: `src/providers/claude/adapter.ts`
- Modify: `src/providers/antigravity/adapter.ts`
- Test: `tests/providers/codex-model-capabilities.test.ts`
- Test: `tests/providers/claude-model-capabilities.test.ts`
- Test: `tests/providers/antigravity-model-capabilities.test.ts`

**Interfaces:**
- Each discovered model receives `runtimeCapabilities`.
- Codex supported reasoning efforts come from live app-server model metadata where present.
- Claude aliases resolve capability family from `value` + `displayName`; unknown targets fail closed.
- Antigravity fixed-effort slugs are marked `fixed`.

- [ ] **Step 1: Add RED tests for the exact 25-model matrix**

Assert contexts/output ceilings and effort mode exactly as the spec table.

- [ ] **Step 2: Add RED tests that Codex runtime-advertised effort levels override static expectations**

This prevents stale OpenAI docs from overruling the authenticated subscription runtime.

- [ ] **Step 3: Implement capability resolvers**

Important static truths:

```ts
// OpenAI current family
gpt-5.5: 1_050_000 / 128_000
gpt-5.6-*: 1_050_000 / 128_000
gpt-6-astra: 1_050_000 / 128_000
daybreak-blue: 1_050_000 / 128_000

// Claude
Fable/Opus/Sonnet current families: 1_000_000 / 128_000
Haiku 4.5: 200_000 / 64_000

// Gemini 3.x
1_048_576 / 65_536

// gpt-oss-120b
131_072 / 131_072
```

All effective `vision=false`.

- [ ] **Step 4: Run focused tests GREEN**

- [ ] **Step 5: Commit**

`git commit -m "feat: attach provider capability metadata"`

---

### Task 3: Chat Completions and Responses effort ingress

**Files:**
- Modify: `src/http/openai-chat.ts`
- Modify: `src/http/openai-responses.ts`
- Test: `tests/http/openai-chat.test.ts`
- Test: `tests/http/openai-responses.test.ts`
- Create: `tests/http/reasoning-effort-validation.test.ts`

**Interfaces:**
- Chat accepts top-level `reasoning_effort`.
- Responses accepts `reasoning.effort`.
- Both call the same capability validator.

- [ ] **Step 1: RED — Chat Completions forwards `reasoning_effort: "xhigh"` into RouterRequest**

- [ ] **Step 2: RED — invalid effort returns HTTP 400**

Examples: `"minimal"`, `"ultra"`, numbers, arrays.

- [ ] **Step 3: RED — fixed model rejects conflicting effort**

Example: `google/gemini-3.8-flash-low` + `reasoning_effort:"high"`.

- [ ] **Step 4: Implement minimal parser/validator**

Do not silently coerce levels.

- [ ] **Step 5: Run focused tests GREEN**

- [ ] **Step 6: Commit**

`git commit -m "feat: validate reasoning effort at OpenAI ingress"`

---

### Task 4: Codex effort transport

**Files:**
- Modify: `src/providers/codex/adapter.ts`
- Test: `tests/providers/codex-adapter.test.ts`
- Test: `tests/integration/codex.integration.test.ts`

**Interfaces:**
- Validated `request.reasoningEffort` maps to schema-backed `turn/start.params.effort`.
- Omitted effort produces byte-equivalent/no-field behavior.

- [ ] **Step 1: RED — `high` appears in the captured turn/start request**

- [ ] **Step 2: RED — omitted effort does not create an effort field**

- [ ] **Step 3: Implement minimal mapping**

- [ ] **Step 4: Run Codex deterministic tests GREEN**

- [ ] **Step 5: Commit**

`git commit -m "feat: forward Qoder effort to Codex"`

---

### Task 5: Claude effort transport

**Files:**
- Modify: `src/providers/claude/adapter.ts`
- Test: `tests/providers/claude-adapter.test.ts`

**Interfaces:**
- Validated effort maps to Claude Agent SDK `Options.effort`.
- Haiku has no adjustable effort in Qoder metadata.

- [ ] **Step 1: RED — SDK options receive `xhigh`**

- [ ] **Step 2: RED — no explicit effort leaves SDK option absent**

- [ ] **Step 3: Implement minimal mapping**

- [ ] **Step 4: Run Claude deterministic tests GREEN**

- [ ] **Step 5: Commit**

`git commit -m "feat: forward Qoder effort to Claude"`

---

### Task 6: Antigravity effort transport without double controls

**Files:**
- Modify: `src/providers/antigravity/adapter.ts`
- Test: `tests/providers/antigravity-adapter.test.ts`

**Interfaces:**
- `buildInferenceArgs(upstreamSlug, prompt, effort?)`.
- Adjustable Antigravity models append `--effort`.
- Fixed-effort slugs receive no Qoder effort selector and conflicting requests are rejected before adapter execution.

- [ ] **Step 1: RED — adjustable Claude-on-Antigravity appends `--effort high`**

- [ ] **Step 2: RED — fixed Gemini slug args contain no second effort when Qoder omitted effort**

- [ ] **Step 3: Implement minimal optional `--effort` mapping**

Only `low|medium|high` can reach `agy`.

- [ ] **Step 4: Run Antigravity deterministic tests GREEN**

- [ ] **Step 5: Commit**

`git commit -m "feat: forward adjustable effort to Antigravity"`

---

### Task 7: Expose capability truth via `/v1/models`

**Files:**
- Modify the existing models-list HTTP implementation in `src/http/`
- Test: existing models endpoint test file
- Create: `tests/http/model-capability-metadata.test.ts`

**Interfaces:**
- Every advertised model with known truth includes `x_cmm`.
- Standard `id`, `object`, `owned_by` remain unchanged.

- [ ] **Step 1: RED — GPT-5.6 Sol returns 1,050,000 / 128,000 and adjustable effort metadata**

- [ ] **Step 2: RED — Gemini fixed-low returns fixed reasoning metadata**

- [ ] **Step 3: RED — all 25 return `vision:false`**

- [ ] **Step 4: Implement namespaced extension**

- [ ] **Step 5: Run HTTP tests GREEN**

- [ ] **Step 6: Commit**

`git commit -m "feat: expose model capability truth"`

---

### Task 8: Correct Qoder MacBook provider from Router metadata

**Files:**
- Create: `scripts/qoder/render-provider.py`
- Create: `scripts/qoder/reconcile-provider.sh`
- Test: `tests/integration/qoder-provider-capabilities.test.ts`
- Update: Task 16 evidence documentation

**Interfaces:**
- Renderer consumes authenticated `/v1/models.x_cmm`.
- Reconciler owns only `providers["qoder-custom-cmm-router"]`.

- [ ] **Step 1: RED — fixture rendering rejects missing `x_cmm`**

- [ ] **Step 2: RED — renderer creates exact context/output/effort metadata**

- [ ] **Step 3: RED — unrelated providers survive byte/semantic comparison**

- [ ] **Step 4: RED — backup path outside iCloud is enforced**

Canonical backup root:

`$HOME/Library/Application Support/CMM Routers/Qoder Backups`

- [ ] **Step 5: Implement renderer/reconciler**

No secret output. Read local bearer from Keychain.

- [ ] **Step 6: Run deterministic reconciliation against a temp settings fixture**

- [ ] **Step 7: Run real MacBook reconciliation with Qoder closed**

This mutates only local Qoder settings, not provider runtimes and does not run inference.

- [ ] **Step 8: Verify Qoder has exactly one CMM Router provider and 25 corrected models**

- [ ] **Step 9: Commit**

`git commit -m "feat: reconcile Qoder from Router capabilities"`

---

### Task 9: Regression gates and Task 16 closure evidence

**Files:**
- Create/update Task 16 evidence docs
- Update relevant regression tests

- [ ] **Step 1: Add anti-regression assertions**

Required markers:

```text
GLOBAL_200K_FALLBACK=NONE
GLOBAL_8192_OUTPUT_FALLBACK=NONE
QODER_VISION_ADVERTISED=NO
CHAT_REASONING_EFFORT_WIRED=YES
CODEX_REASONING_EFFORT_WIRED=YES
CLAUDE_REASONING_EFFORT_WIRED=YES
ANTIGRAVITY_REASONING_EFFORT_WIRED=YES
COMMAND_CODE_INCLUDED=NO
```

- [ ] **Step 2: Run focused capability suite**

- [ ] **Step 3: Run typecheck and build**

- [ ] **Step 4: Run full deterministic suite twice**

- [ ] **Step 5: Verify worktree clean and no secrets tracked**

- [ ] **Step 6: Produce independent re-audit bundle**

- [ ] **Step 7: Close Task 16 capability correction**

Task 16B cross-Mac sync starts only after this gate is green.
