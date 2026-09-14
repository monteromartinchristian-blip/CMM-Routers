# CMM Routers — Provider Expansion Wave Ledger (2026-09-14)

- Worktree: `/Users/chris/CMM-Routers/.worktrees/provider-expansion-wave`
- Branch: `feature/provider-expansion-wave`
- Base: `e993a234d8a91ae62203bf975a4f56999ce4fb25` (`fix/antigravity-client-owned-tool-agent`)
- Plan: `docs/superpowers/plans/2026-09-14-provider-expansion-wave.md` (authoritative text in the task brief)

This ledger records every `Ruling:` (decision + evidence + cost if wrong), every
fix applied during the wave, and every deferred minor. Task commits are listed
with their SHA as they land.

```text
ROUTER_LINEAGE_AUDIT=PASS
PROVIDER_EXPANSION_BASE=e993a234d8a91ae62203bf975a4f56999ce4fb25
CAVOTI_HISTORY_SEARCH=PASS
ACTIVE_WORKTREES_TOUCHED=NO
```

## Phase 0 — lineage audit (re-verified in-worktree, read-only)

- Canonical repo: `/Users/chris/CMM-Routers` (`/Users/chris/CMM Routers` absent).
- Worktree HEAD at start: `e993a23` = `main` (`86c1ebf`) + 1 commit
  ("fix: isolate Antigravity tool sessions to MCP"); working tree clean.
- `feature/cmm-usage-registry-bridge` (`5a1bffa`) = `e993a23` + 1 Usage-only commit
  (`src/usage/providers/registry-bridge.ts`), unmerged → not the runtime lineage tip.
- Router runtime lineage tip = `e993a23` → `PROVIDER_EXPANSION_BASE`.
- Cavoti history: recovery = port/repair the existing in-tree implementation
  (`src/providers/cavoti/{adapter,client,spend-guard}.ts`, `tests/providers/cavoti-provider.test.ts`),
  no rewritten adapter. `CAVOTI_HISTORY_SEARCH=PASS`.
- No other worktree was mutated: all Phase 0 inspection used `git log/show/ls-tree`
  and `grep` inside this worktree.

### Historical provider evidence found (authoritative, reused)

`feature/cmm-usage` lineage (`cc3f09e` … `5a1bffa`) contains the canonical CMM Usage
provider-integration notes. Reused as evidence (read-only):

- `src/usage/adapters/qwen-model-studio/README.md`: Qwen **Token Plan** is a
  subscription with dedicated `sk-sp-*` keys against
  `https://token-plan.<region>.maas.aliyuncs.com/compatible-mode/v1`; Qwen **PAYG**
  is post-paid `sk-`/`sk-ws-` keys against
  `https://dashscope.<region>.aliyuncs.com/compatible-mode/v1`. The two products
  must never share a credential or quota namespace and have no PAYG fallback path.
- `src/usage/runtime/integration-catalog.ts`: DeepSeek default base
  `https://api.deepseek.com`; OpenRouter base `https://openrouter.ai/api/v1`;
  Command Code root `https://api.commandcode.ai`.
- `src/usage/adapters/openrouter/README.md`: all OpenRouter metadata surfaces are
  authenticated `GET`s under `https://openrouter.ai/api/v1`; `GET /models` is
  authoritative discovery with no hardcoded catalog.
- `src/usage/adapters/command-code/README.md`: dogfooding 2026-09-14 found the
  router's legacy `/provider/v1` prefix 404 while the CLI API root works.
- `src/usage/providers/registry-bridge.ts`: canonical billing vocabulary is
  `subscription | payg | api | free_or_api`, and canonical identity is
  `connection_id` → account key, `route_id` → route key (per-route, not per-model).

## Rulings

### R1 — `PROVIDER_EXPANSION_BASE=e993a234d8a91ae62203bf975a4f56999ce4fb25`

Evidence: worktree HEAD and router runtime lineage tip (`main` + Antigravity
isolation fix). Cost if wrong: the wave would be built without (or with) the
Antigravity tool-session isolation fix, or would drag unrelated CMM Usage work in.

### R2 — Provider identity vocabulary mirrors the canonical Usage billing kinds

Decision: `ProviderBillingClass = subscription | payg | api | free_or_api`, matching
`UsageBillingKind` in the existing `registry-bridge` lineage.
Evidence: `src/usage/providers/registry-bridge.ts` `USAGE_BILLING_KINDS` (same repo history).
Cost if wrong: a translation layer between router billing class and CMM Usage
billing kind would be needed at the Task 13 bridge.

### R3 — Base URLs are set only from plan text, repository evidence, or the product's own documented API host

Decision rule for `ProviderManifest.baseUrl`:

1. plan-canonical → set (Kira: `https://kiraai.vn/api/v1`);
2. repository evidence → set (DeepSeek, OpenRouter, Command Code existing default);
3. product's own documented public API host → set (NVIDIA NIM, OpenCode Zen, Ollama
   Cloud, Cline API);
4. region/account-parameterized endpoint → **`null`** (Qwen Token Plan, Qwen Cloud):
   the repo's own Qwen notes prove the host encodes the region, so any fixed
   default would be wrong for half the accounts;
5. no evidence of any host → **`null`** (Vikey).

`baseUrl: null` means "configuration must supply it"; enabling such a provider
without a configured base URL is skipped with a clear reason (fail closed), never
registered against a guessed host. Cost if wrong: a grouped-3 default host is
incorrect and discovery fails closed with a clear DNS/HTTP error surfaced to the
operator, who overrides `providers.<id>.baseUrl` in `config/shared.json`; no
silent misroute is possible because the manifest host is the only routing target.

### R4 — `command-code` keeps its provider id (no rename to `commandcode`)

Evidence: `command-code` is the stable route namespace in production
(`command-code/<model>` model ids, existing config key, Qoder model ids, 14 test
files, `src/http/*` diagnostics). Renaming would break live clients. The plan's
inventory token `commandcode` maps to the already-registered `command-code` route.
Cost if wrong: cosmetic inventory mismatch only; the final report records the mapping.

### R5 — `command-code` and `cavoti` keep dedicated adapters; all other wave providers share one generic adapter

Evidence for the exceptions: Command Code has two upstream wires (OpenAI Chat +
Anthropic Messages), spend-ack gating, and plan-entitlement wire semantics; Cavoti
has an exact-pinned single model, PAYG spend-ack gating and pinned-route refusal.
Both are demonstrated protocol/state differences, not stylistic ones.
Cost if wrong: two specialized adapters exist where a generic one would have
sufficed for part of the surface.

### R6 — Kimi K3 activation stays `none` until the exact provider model id is administratively confirmed

Evidence: no repository evidence for the exact NVIDIA NIM Kimi K3 provider model
id (history grep for `nvidia`/`nim`/`kimi` returns no provider metadata). The plan
forbids inventing it. `activation.mode: "none"` keeps discovered routes visible in
discovery but not routable; the operator can set
`providers.nvidia-nim.activation = { mode: "allowlist", models: ["<exact id>"] }`.
Cost if wrong: NVIDIA NIM routes stay non-routable until an operator confirms the
exact id (fail closed, no spend).

### R7 — Kira billing class is `api` (unknown pricing), not `free_or_api`

Evidence: the plan supplies expected *free-model names* as fixtures, not an
authoritative pricing catalog, and requires "do not infer pricing/free status
beyond explicit provider metadata or existing CMM Usage semantics". `api` is the
neutral canonical kind. Cost if wrong: a later provider-metadata source reclassifies
Kira as free/subscription in the usage bridge.

### R8 — Command Code router base URL default is left unchanged

Evidence: `https://api.commandcode.ai/provider/v1` is the existing configured
default and the subject of 20+ existing tests; the Usage-lineage note about the
legacy prefix 404 concerns the *billing* CLI surface, a different concern from the
router's generation route. The manifest carries the same default and config can
override it. Cost if wrong: a live canary (already deferred to user authorization)
would surface a 404 and the operator overrides `baseUrl` in config.

### R9 — Kira and Vikey publish `CHAT_ONLY` until tool calling is proven

Evidence: no repository evidence of an OpenAI function-calling round-trip for
either provider. `toolCapability` is a required manifest field (no implicit
default), so the conservative value is stated explicitly instead of being
assumed; `CHAT_AND_TOOLS` is what unlocks tools for the Qoder consumer, so an
unproven provider must not claim it. Cost if wrong: Qoder gets no tools on those
two routes until evidence is added (fail closed, no silent tool execution).

### R10 — `activation.models` default is `[]` with mode `all`; `none`/`allowlist` are explicit operator states

Evidence: `all` matches the existing OpenRouter/Qwen doctrine that discovery is
authoritative and no model catalog is hardcoded; `none` is what R6 needs for
Kimi K3. Cost if wrong: none observed — the config refinement makes an
allowlist without ids (or ids without allowlist mode) a validation error.

## Task log

### Task 1 — Normalize the provider manifest/config contract

- RED: `npx vitest run --no-file-parallelism --maxWorkers 1 tests/providers/provider-manifest.test.ts`
  → `Error: Cannot find module '../../src/providers/manifest.js' imported from .../provider-manifest.test.ts` (0 tests).
- GREEN: same command → `Tests 13 passed (13)`.
- Files: `src/providers/manifest.ts` (new contract + validation),
  `src/core/model.ts` (ProviderId extended with the 11 wave identities),
  `src/config/schema.ts` (`openAiCompatibleProviderSchema` + 10 wave entries with
  pinned credential namespaces), `src/core/tool-policy.ts` (wave cases),
  `src/security/payg-guard.ts` (`FORBIDDEN_PAYG_ENV_VARS` exported, single source).
- Backward compatibility: `tests/config/`, `tests/registry/`, `tests/core/`,
  `tests/providers/cavoti-provider.test.ts` → 80 passed; `tests/http/production-composition.test.ts`
  → 6 passed.
- Fix applied during the task: extending `src/config/schema.ts` gave it a local
  import for the first time, which broke `scripts/validate-config.mjs` under
  Node 22 native TypeScript resolution (`ERR_MODULE_NOT_FOUND` for the
  TypeScript-style `./x.js` specifier), making preflight report
  `CONFIG=UNAVAILABLE` instead of validating. `tests/integration/preflight-schema-equivalence.test.ts`
  reproduced it (11 failed). Fixed by registering a narrow resolve hook that maps
  a relative `./x.js` specifier to its real `x.ts` sibling when the `.js` file
  does not exist; the compiled-artifact fallback stays for runtimes without
  synchronous hooks. Re-run: 12 passed.
- Gates: typecheck clean, build clean, `bash scripts/security-audit.sh` →
  `SECURITY_AUDIT=PASS`, `git diff --check` clean.
- Note: `node scripts/validate-config.mjs` returns `CONFIG=MISSING` (rc=3) in
  this worktree because `config/shared.json` is gitignored and absent — expected.
- Commit: `feat(providers): normalize provider manifest contract`.

self-review (SPEC): the plan asks for a provider definition that can express
provider ID, display name, billing class, base URL, auth scheme, discovery
endpoint, API styles and an optional activation/model allowlist — all present in
one contract used by both the runtime manifest and the strict config schema, with
existing bridges untouched. PASS, plus one addition beyond the literal list
(`toolCapability`) justified by R9 and required for truthful capability
publication.

self-review (QUALITY): endpoint safety lives in one place (`manifest.ts`) and is
reused by the config refinement instead of being duplicated; the manifest is the
single source of default base URLs; Zod `prefault` keeps the default providers
block derived from the per-provider schemas rather than duplicated; no new
dependencies; no secret values anywhere; credential namespaces are pinned per
provider. Findings: none Critical/Important. Minor deferred: the `providers`
default block in `sharedConfigSchema` is seeded with four entries and relies on
`prefault` to fill the rest — documented inline.

(commits, RED/GREEN evidence, self-reviews appended per task)
