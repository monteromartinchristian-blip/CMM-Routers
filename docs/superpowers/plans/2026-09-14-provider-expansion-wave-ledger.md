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

### Task 5 — DeepSeek, OpenRouter and OpenCode Zen

- RED: `npx vitest run ... tests/providers/wave-deepseek-openrouter-zen.test.ts`
  → `Error: Provider deepseek is not part of the approved wave inventory` (5 failed).
- GREEN: same command → `Tests 5 passed (5)` after adding the three manifests.
- Files: `src/providers/manifests.ts` (`openAiWaveManifest` factory + the three
  manifests), `tests/providers/wave-deepseek-openrouter-zen.test.ts`,
  `tests/helpers/wave-fixtures.ts` (shared fixture transport: recording fetch,
  catalog + SSE responses, adapter factory).
- Test-fixture fix during the task: the first version of the end-to-end case fed
  a plain JSON body where SSE frames were required; replaced with a real
  `ReadableStream` SSE fixture.
- Verified: identity/credential/endpoint per provider, discovery authoritative
  (`activation: all`, no catalog), one adapter class for all three, exact model
  ids namespaced per provider, one `GET /models` then one `POST
  /chat/completions` end to end with the injected transport.

### Task 6 — Kira AI

- RED: `npx vitest run ... tests/providers/wave-kira.test.ts` → same
  not-in-inventory error (6 failed).
- GREEN: `Tests 6 passed (6)`.
- Ruling R7 applied: billing class is the neutral `api`; the four user-supplied
  free-model names are used ONLY as discovery fixtures, and the test asserts no
  source file embeds them (no second catalog) and that an extra unexpected model
  still surfaces (discovery, not the list, defines the catalog).
- Ruling R9 applied: `toolCapability: "CHAT_ONLY"` until a Kira tool round-trip
  is proven.

### Task 7 — NVIDIA NIM / initial activation scope

- RED: `npx vitest run ... tests/providers/wave-nvidia-nim.test.ts` → 4 failed.
- GREEN: `Tests 5 passed (5)` after adding `NVIDIA_NIM_MANIFEST` with
  `activation: { mode: "none", models: [] }`.
- Ruling R6 applied verbatim: the exact provider model id is not deterministically
  known, so nothing is routable and no upstream request is made; discovery stays
  available to an operator, and a configured `allowlist` (the administrative
  confirmation) exposes the catalog while routing exactly one exact id.
- The test also asserts no `kimi`/`moonshotai`/`nvidia/<id>` literal exists in `src/`.
- Ruling R12 (new): billing class `api` (neutral) — no repository evidence of the
  account's billing shape, and the router must not claim pricing it cannot prove.

### Task 8 — Vikey

- RED: `npx vitest run ... tests/providers/wave-vikey.test.ts` → 6 failed.
- GREEN: `Tests 6 passed (6)`.
- Ruling R3 applied: no canonical host is known, so `baseUrl` is `null` and the
  endpoint is configuration-required. Tests prove an enabled-but-unconfigured
  route is skipped with a `baseUrl` reason, and that a configured route does
  exactly one authenticated `GET /models` with exact id preservation.
- `toolCapability: "CHAT_ONLY"` (R9).

### Task 9 — Recover and integrate Cavoti AI

- RED: `npx vitest run ... tests/providers/cavoti-billing-state.test.ts` → 5 failed.
- GREEN: `Tests 8 passed (8)`; historical `tests/providers/cavoti-provider.test.ts`
  passes unchanged (two failures surfaced mid-task were caused by an over-strict
  config accessor and are fixed below).
- Historical recovery: the in-tree `adapter.ts` / `client.ts` / `spend-guard.ts`
  and its historical tests are reused as-is; no adapter was rewritten. The task
  adds the missing account-state classification and the manifest entry.
- 402 classification: HTTP 402 whose body marks an unsettled/outstanding account
  now maps to the new `provider_billing_blocked` category (meta
  `billingState: "unsettled"`), while a plain 402 keeps
  `provider_quota_exhausted`. Detection lives in one helper
  (`isUnsettledBillingState` in `src/core/errors.ts`) shared by the Cavoti client
  and the generic OpenAI-compatible transport, so both paths agree.
- Usage boundary: `provider_billing_blocked → "billing_blocked"`, a new
  `UsageStatus` counted separately as `billingBlockedEvents` (never merged into
  `quotaEvents`); `/v1/cmm/usage` exposes the counter; HTTP mapping is 402 with
  the stable `provider_billing_blocked` type (not 429, so nothing retries a
  block that only settlement clears).
- Fix applied: `waveProviderConfig` threw for config objects built without the
  schema (the historical Cavoti tests pass a literal), which would have broken
  hand-built/legacy configs; it now returns `undefined` and the composition root
  skips that provider with reason "not present in config" (fail closed).
- Ruling R13 (new): Cavoti's manifest declares `activation: allowlist` with the
  pinned model, so the inventory records the same exact-route truth the runtime
  enforces.

### Task 10 — Cline API / ClinePass

- RED: `npx vitest run ... tests/providers/wave-cline.test.ts` → 4 failed.
- GREEN: `Tests 4 passed (4)`.
- Treated as its own API/ClinePass provider (`https://api.cline.bot/api/v1`), not
  as promotional IDE/CLI free models: only the account's `GET /models` catalog is
  exposed. Streaming + tool-call coverage exercises exactly the generic router
  path that already exists (no Cline-specific behavior added).

### Task 11 — Ollama Cloud

- RED: `npx vitest run ... tests/providers/wave-ollama-cloud.test.ts` → 7 failed.
- GREEN: `Tests 5 passed (5)`; test-only fix: the "no local runtime" scan was
  file-scoped and flagged unrelated loopback literals (the router's own listen
  host) plus one of my own comments — it is now line-scoped.
- Cloud identity: `ollama-cloud` with `https://ollama.com/v1`, API-key auth,
  `OLLAMA_CLOUD_API_KEY`, `billingClass: payg`. No local Ollama runtime support,
  no loopback base URL, no local-runtime environment variable handling; the
  regression test asserts the manifest host is public and that every request in
  the fixture goes to the cloud host.

### Task 12 — CommandCode deterministic

- RED: `npx vitest run ... tests/providers/wave-commandcode.test.ts` → 1 failed
  (registration/inventory); the deterministic `/models` and both-wire routing
  fixtures already passed against the existing adapter, which is the point: the
  implementation is recovered, not re-derived.
- GREEN: `Tests 4 passed (4)` after adding `COMMAND_CODE_MANIFEST`.
- Ruling R4 applied: the route id stays `command-code`; the plan's `commandcode`
  token maps to it. Ruling R8 applied: the router base URL default is unchanged.
- Recorded markers (printed by the test and recorded here):
```text
COMMANDCODE_IMPLEMENTATION=PASS
COMMANDCODE_LIVE_CANARY=DEFERRED_UNTIL_USER_AUTHORIZATION_AFTER_QUOTA_RESET
```

### Task 13 — Integrate provider inventory with CMM Usage metadata

- RED: `npx vitest run ... tests/providers/wave-inventory.test.ts` → 3 failed.
- GREEN: `Tests 6 passed (6)`, printing
  `WAVE_REGISTERED_PROVIDER_COUNT=13` and
  `CMM_USAGE_PROVIDER_METADATA_BRIDGE=PASS`.
- Files: `src/providers/manifests.ts` (`providerInventory()` — a projection of
  the manifest catalog, never a second list), `src/registry/provider-registry.ts`
  (`listProviderIds()`), `src/http/diagnostics.ts` (`/v1/cmm/providers` reports
  route identity + billing class + credential NAMESPACE + tool capability +
  activation scope; `/v1/cmm/usage` reports `billingBlockedEvents`),
  `config/shared.example.json`, `.env.example`, `scripts/validate-config.mjs`
  (status-safe wave fields: enabled flags, credential names, configured base
  URLs, activation scope).
- Inventory: the 12 approved providers appear exactly once (11 route ids plus the
  `commandcode` → `command-code` mapping), and the three subscription bridges
  remain present and unchanged. Neither list is duplicated anywhere else.
- Billing metadata flows through the existing route/account identity fields
  (provider id → registry route; provider/model → usage record); no second
  catalog and no credit/balance claim is introduced.
- State distinctions at the existing Usage boundary: routability = registered
  route + discovered catalog + activation scope; unsettled billing =
  `billing_blocked`/`billingBlockedEvents`; rate-limited = `rate_limit_error`;
  available credit = deliberately NOT claimed by the router (that is the
  provider's own billing surface, and CMM Usage owns money state).

### Task 14 — Full deterministic verification and broad review

See "Verification results" below for the captured commands and outcomes.
`LIVE_ADMIN_CALLS=0` and `LIVE_INFERENCE_COUNT=0`: every provider interaction in
this wave is driven by injected fixture transports; no provider was contacted.

self-review (SPEC, tasks 5-14): every task's plan checklist is implemented as
written, including the exact negative instructions (`commandcode` mapping, no
invented initial-scope model id, Kira expectations as fixtures only, Cavoti 402
distinction, Ollama Cloud ≠ local, CommandCode markers, inventory completeness).

self-review (QUALITY, tasks 5-14): one adapter + manifests for the generic
providers, data-only manifests validated at construction, two documented
exceptions with demonstrated protocol/account-state reasons (Command Code,
Cavoti), credential namespaces pinned per provider and unique across the wave,
activation fail-closed at discovery and run time, no secrets in code, logs,
fixtures or reports. Findings: none Critical/Important. Minors deferred:

1. `stream_options.include_usage` is not sent (providers that reject unknown
   request fields would fail); usage is recorded only when the upstream emits it.
2. The buffered (non-streaming) discovery body is bounded by the operation
   deadline but not by a byte cap before `JSON.parse`; the SSE path does cap its
   buffer.
3. `providerInventory()` re-derives a small projection per diagnostics call;
   trivial cost, kept for a single source of truth.
4. Activation inheritance means an operator cannot express "all models" for a
   manifest that says `none` without listing exact ids — intentional (R6/R10),
   recorded so it is not mistaken for a bug.

## Verification results (Task 14)

- Full serialized suite: `npx vitest run --no-file-parallelism --maxWorkers 1`
  → `Test Files 152 passed | 5 skipped (157)`,
  `Tests 863 passed | 25 skipped (888)`, 0 failed, 292.23s. The 5 skipped files
  are the live-opt-in integration suites (antigravity, claude, codex,
  command-code, tool-roundtrip) which are skipped by design without a live
  session — pre-existing, not a wave regression.
- `npm run build` → clean. `npm run typecheck` → clean.
- `bash scripts/security-audit.sh` → `SECURITY_AUDIT=PASS`, including the new
  `OPENAI_COMPATIBLE_UNDECLARED_TOOL_FAIL_CLOSED=PASS` assertion.
- `node scripts/validate-config.mjs` against `config/shared.example.json`
  (copied into a temp `CMM_CONFIG_DIR`) → `CONFIG=VALID`,
  `WAVE_PROVIDER_COUNT=10`, `WAVE_PROVIDERS_ENABLED=0`.
- `git diff --check` → clean (two "new blank line at EOF" warnings were found
  during the run and fixed).
- Secret scan over tracked + new files
  (`git ls-files` + `git status` paths, patterns for `sk-…`, `Bearer …`,
  `api_key: …`) → only two pre-existing test-double files
  (`tests/http/production-composition.test.ts`, `tests/security/bearer-auth.test.ts`),
  both unchanged from HEAD and containing injected test tokens, not real secrets.
- `LIVE_ADMIN_CALLS=0`, `LIVE_INFERENCE_COUNT=0`: no provider was contacted; all
  provider interaction used injected fixture transports.

### Updated final marker block

```text
ROUTER_LINEAGE_AUDIT=PASS
PROVIDER_EXPANSION_BASE=e993a234d8a91ae62203bf975a4f56999ce4fb25
CAVOTI_HISTORY_SEARCH=PASS
ACTIVE_WORKTREES_TOUCHED=NO
CMM_ROUTERS_PROVIDER_WAVE=PASS
EXISTING_SUBSCRIPTION_BRIDGES_REGRESSION=PASS
QWEN_TOKEN_PLAN_PAYG_SEPARATION=PASS
OPENAI_COMPATIBLE_GENERIC_PATH=PASS
ADMIN_MODEL_DISCOVERY_NO_INFERENCE=PASS
CAVOTI_HISTORICAL_RECOVERY=PASS
CAVOTI_LIVE_CANARY=DEFERRED_BILLING_STATE
COMMANDCODE_LIVE_CANARY=DEFERRED_USER_AUTHORIZATION
OLLAMA_CLOUD_NOT_LOCAL=PASS
CMM_USAGE_PROVIDER_METADATA_BRIDGE=PASS
SECRETS_EXPOSED=0
PUSH_PERFORMED=NO
MERGE_PERFORMED=NO
```

## Commit replay instructions

Every task's exact delta is in `.provider-wave-patches/*.patch`, in plan order.
From the worktree root:

```bash
git apply .provider-wave-patches/01-normalize-provider-manifest-contract.patch
git add -A -- src tests scripts config docs .env.example && git commit -m "feat(providers): normalize provider manifest contract"
git apply .provider-wave-patches/02-expand-generic-openai-compatible-routing.patch
git add -A -- src tests scripts config docs .env.example && git commit -m "feat(providers): expand generic OpenAI-compatible routing"
git apply .provider-wave-patches/03-add-administrative-model-discovery.patch
git add -A -- src tests scripts config docs .env.example && git commit -m "feat(providers): add administrative model discovery"
git apply .provider-wave-patches/04-add-qwen-subscription-and-payg-routes.patch
git add -A -- src tests scripts config docs .env.example && git commit -m "feat(providers): add Qwen subscription and PAYG routes"
git apply .provider-wave-patches/05-add-deepseek-openrouter-and-zen.patch
git add -A -- src tests scripts config docs .env.example && git commit -m "feat(providers): add DeepSeek OpenRouter and Zen"
git apply .provider-wave-patches/06-add-kira-ai.patch
git add -A -- src tests scripts config docs .env.example && git commit -m "feat(providers): add Kira AI"
git apply .provider-wave-patches/07-add-nvidia-nim-activation-scope.patch
git add -A -- src tests scripts config docs .env.example && git commit -m "feat(providers): add NVIDIA NIM Kimi K3 route"
git apply .provider-wave-patches/08-add-vikey.patch
git add -A -- src tests scripts config docs .env.example && git commit -m "feat(providers): add Vikey"
git apply .provider-wave-patches/09-integrate-cavoti-ai.patch
git add -A -- src tests scripts config docs .env.example && git commit -m "feat(providers): integrate Cavoti AI"
git apply .provider-wave-patches/10-add-cline-api.patch
git add -A -- src tests scripts config docs .env.example && git commit -m "feat(providers): add Cline API"
git apply .provider-wave-patches/11-add-ollama-cloud.patch
git add -A -- src tests scripts config docs .env.example && git commit -m "feat(providers): add Ollama Cloud"
git apply .provider-wave-patches/12-add-commandcode-api.patch
git add -A -- src tests scripts config docs .env.example && git commit -m "feat(providers): add CommandCode API"
git apply .provider-wave-patches/13-integrate-expanded-provider-inventory.patch
git add -A -- src tests scripts config docs .env.example && git commit -m "feat(providers): integrate expanded provider inventory"
git apply .provider-wave-patches/14-ledger.patch
git add -A -- src tests scripts config docs .env.example && git commit -m "docs(providers): record provider expansion wave ledger"
git apply .provider-wave-patches/15-eof-hygiene.patch
git add -A -- src tests scripts config docs .env.example && git commit -m "style(providers): drop trailing blank line at EOF"
git apply .provider-wave-patches/16-ledger-final.patch
git add -A -- src tests scripts config docs .env.example && git commit -m "docs(providers): finalize provider expansion wave ledger"
```

Patch-series verification: all 16 patches were replayed onto a pristine
`git archive HEAD` extract inside `.provider-wave-patches/replay/`, applying in
order without a single conflict, and the resulting tree is byte-identical to the
wave's worktree for every changed or added file (35/35 files `SAME`, verified
with `diff -q`). `15-eof-hygiene` exists because the trailing blank line left by
patch `02` was cleaned up after that patch was captured, and `16-ledger-final`
carries this section plus the final markers.

Notes: patches 03 and 04 were captured after both tasks, so the Task-4
activation delta rides in patch 04 (documented above). `.provider-wave-patches/`,
`.mimosa/` (plugin state) and `dist/` are worktree-local artifacts and are not
part of any commit; the `state/` snapshots are baselines used to compute the
deltas, not deliverables.
