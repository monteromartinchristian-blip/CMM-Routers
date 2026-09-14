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

## Commit gate status (whole wave)

The Mimosa L3 pre-commit hook denies `git commit` in this session over **36 high
+ 5 medium pre-existing repository findings** in files this wave does not touch
(`tests/security/redaction.test.ts` fake fixture credentials,
`tests/helpers/fake-agy-multistep.js` local test double,
`scripts/live-canary/canary-driver.ts` fixture tokens). Evidence that the
findings are not wave-local:

- `git status --porcelain` is empty for every reported file (unmodified from HEAD).
- The wave's staged file set contains none of them.
- The repository's own authoritative gate passes: `bash scripts/security-audit.sh`
  → `SECURITY_AUDIT=PASS`.
- The session's own findings for `src/providers/manifest.ts` (three
  `RegExp.exec`-shaped false positives) are recorded `static_verified` after the
  rewrite, i.e. the gate's finding ledger is not the blocker.

Investigated remedies that are NOT available from inside this session: no native
git hook is installed (shared hooks dir has no `pre-commit`, `core.hooksPath`
unset, worktree hooks dir absent), `mimosa policy` covers threat-model/network/
command/path/data only (no scan scope or severity threshold), `mimosa
git-gate status` reports only ZCode-side gate stages, and the plugin README
states hook/MCP configuration is snapshotted at task startup — so lifting the
gate requires a new task. Per the user's decision ("allow wave commits"), each
task's exact delta is preserved as a replayable patch series under
`.provider-wave-patches/` (see the replay instructions at the end of this file).

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

### Task 2 — Expand the generic OpenAI-compatible execution path

- RED: `npx vitest run ... tests/providers/openai-compatible-execution.test.ts`
  → `Cannot find module '../../src/providers/openai-compatible/adapter.js'` (0 tests).
- GREEN: same command → `Tests 13 passed (13)`.
- Files: `src/core/sse.ts` (SSE framing extracted from command-code into one
  shared module; `command-code/client.ts` now imports and re-exports it, so the
  existing `MAX_PROVIDER_SSE_FRAME_BYTES` / `parseSseDataLine` / `splitSseChunks`
  import sites are unchanged), `src/providers/openai-compatible/client.ts`
  (transport: bearer auth, chat completions, SSE records, timeout/abort race,
  normalized status mapping), `src/providers/openai-compatible/adapter.ts`
  (generic adapter: declared-tool ACL, usage mapping, activation gate,
  capability from the manifest), `scripts/security-audit.sh` (declared-tool ACL
  now asserted for the generic adapter and Cavoti too).
- Covered by test: bearer auth header, exact model id on the wire, streaming
  text deltas, tool-call passthrough + undeclared-name fail-closed, unchanged
  `tool_choice`/`parallel_tool_calls`/`max_tokens` forwarding, usage numbers,
  status→error-category mapping (401/402/429/404/500), activation fail-closed
  with no upstream request, cross-provider model id refusal, `provider_timeout`
  on a stalled upstream, silent stop on caller abort, one adapter class for two
  different manifests, refusal of a manifest without the
  openai-chat-completions style, and no credential value in error text.
- Regression: command-code SSE/adapter/fragmented-stream/body-coverage suites →
  35 passed; typecheck clean; `SECURITY_AUDIT=PASS`.
- Commit: `feat(providers): expand generic OpenAI-compatible routing`.

### Task 3 — Administrative model discovery

- RED: `npx vitest run ... tests/providers/openai-compatible-discovery.test.ts`
  → 3 failed / 5 passed: `display_name` tolerance missing (displayName fell back
  to the raw id), duplicates were listed twice, and one test-double bug
  (`secret: undefined` did not mean "no credential").
- GREEN: same command → `Tests 8 passed (8)`, including
  `ADMIN_MODEL_DISCOVERY_GET_ONLY=PASS` and
  `ADMIN_MODEL_DISCOVERY_NO_INFERENCE=PASS` printed from the test body.
- Files: `src/providers/openai-compatible/adapter.ts` (`displayNameOf`
  tolerance for `name`/`display_name`/`displayName`; first-occurrence-wins
  de-duplication matching the existing command-code policy).
- Covered by test: exactly one `GET` to `<baseUrl><discovery path>`, no request
  body, no URL containing a generation path, exact id preservation
  (`vendor/model:tag`), route ids namespaced per provider, capability published
  from the manifest, de-duplication, skipping entries with no usable id,
  rejection of malformed payloads (non-JSON, `{models: []}`, bare array,
  `{data: {}}`), configured discovery-path override, no request at all when no
  route is activated, and auth/transport/timeout failure categories.
- Commit: `feat(providers): add administrative model discovery`.

### Task 4 — Qwen Token Plan and Qwen Cloud PAYG

- RED: `npx vitest run ... tests/providers/qwen-route-separation.test.ts`
  → `Cannot find module '../../src/providers/manifests.js'` (0 tests).
- GREEN: same command → `Tests 8 passed (8)`.
- Files: `src/providers/manifests.ts` (Qwen manifests + wave inventory
  accessors + `resolveEffectiveActivation`), `src/config/schema.ts`
  (`activation` is now an optional override with no defaults, so it can never
  widen a manifest-level `none`; typed `waveProviderConfig` accessor),
  `src/providers/openai-compatible/adapter.ts` (effective activation),
  `src/index.ts` (`ProductionCompositionOptions.fetchFn` injection + wave
  registration loop with per-provider fail-closed skip reasons).
- Ruling R11 (new): both Qwen base URLs are `null` in the manifest (region is
  account-specific, proven by the repo's own Qwen notes) and an enabled Qwen
  route without `providers.<id>.baseUrl` is skipped with reason
  "base URL is not deterministically known …" — never registered against a
  guessed region. Cost if wrong: the operator must set one config field before
  the route can be enabled (fail closed, no silent misroute).
- Covered by test: distinct ids/credential namespaces/billing classes
  (`subscription` vs `payg`), identical upstream model ids resolving to two
  independent provider routes, both routes visible in the catalog, activation
  inheritance vs override, unique-inventory assertion, and production
  composition skipping/registering the two routes with an injected fixture
  transport (no live call).
- Capture note: patches `03`/`04` were taken after both tasks, so the
  `adapter.ts` activation delta for Task 4 rides in patch `04`; the RED/GREEN
  evidence above is per task.
- Commit: `feat(providers): add Qwen subscription and PAYG routes`.

self-review (SPEC, tasks 2-4): the plan asks for a generic OpenAI-compatible
execution path, administrative discovery that never touches a generation
endpoint, and two Qwen identities with separate namespaces, billing classes and
routes for identical model ids — all delivered, with the existing bridges
untouched. PASS.

self-review (QUALITY, tasks 2-4): one transport implementation + one adapter +
manifests (no per-provider subclasses); SSE framing now has a single definition;
credentials are read from env names only and never appear in messages; the
timeout/abort path races the fetch promise so a signal-ignoring transport cannot
hang the router; activation gates both discovery and `run`. Findings: none
Critical/Important. Minor deferred: `stream_options.include_usage` is NOT sent
(providers that reject unknown request fields would 400); usage is recorded only
when the upstream emits it in-stream.

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
