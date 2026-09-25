# CMM Code Router — Client-Agnostic Completion Implementation Plan

**Date:** 2026-09-21
**Status:** Plan only — no production source changed by this document
**Product:** CMM Routers
**Profile:** CMM Code Router — `CHAT_AND_TOOLS`
**Worktree:** `/Users/example/CMM-Routers/.worktrees/cmm-code-router-client-agnostic`
**Branch:** `feature/cmm-code-router-client-agnostic`
**Audited starting HEAD:** `f65c4fc1fa0b62f512609ec2704b0a3a72fcfd12`
**Baseline preserved:** `e993a234d8a91ae62203bf975a4f56999ce4fb25` (Antigravity client-owned-tool-session work — treated as current behaviour, not rewritten)

**Frozen design (authoritative):**
`docs/superpowers/specs/2026-09-21-cmm-code-router-client-agnostic-design.md`

**Related inputs:**
- `CMM-Code-Router-client-agnostic-plan-prompt.md` (planning prompt)
- `CMM-Code-Router-client-agnostic-handoff.md` (handoff)
- `docs/superpowers/specs/2026-09-09-consumer-capability-policy.md` (current Qoder-coupled policy)
- `docs/superpowers/specs/2026-09-10-deferred-tool-broker-design.md`
- `docs/superpowers/specs/2026-09-11-task16-qoder-capability-truth-design.md`
- `README.md` §Roadmap (pre-stable compatibility gates)

---

## 0. Audit of the current implementation

This part is the evidence base for the plan. Everything below was read directly from the
audited HEAD. No command in this audit performed provider inference or consumed quota.

### 0.1 Verified starting state

| Check | Result |
|---|---|
| `git rev-parse HEAD` | `f65c4fc1fa0b62f512609ec2704b0a3a72fcfd12` |
| Branch | `feature/cmm-code-router-client-agnostic` |
| Working tree | clean (no tracked or untracked changes) |
| Baseline commit present in history | `e993a23` (Antigravity MCP tool-session isolation) |
| `CMM_CODE_ROUTER_TOKEN` in production code/config | absent (design doc only) |

### 0.2 Coupling inventory by classification

The planning prompt requires every Qoder-specific assumption to be classified as exactly one of:
**(1)** true security semantics that must change, **(2)** legacy compatibility identifiers that must
remain temporarily, **(3)** documentation-only naming, **(4)** safe to generalize immediately.

#### Class 1 — true security semantics that must change

| Location | Current semantics | Why it is a security primitive |
|---|---|---|
| `src/core/consumer-capability.ts:18-24` | `effectiveToolCapability(consumer, providerCapability)` returns `CHAT_AND_TOOLS` **only** when `consumer === CONSUMER_QODER` (`"qoder"`) | This is the authorization decision: client *identity* grants tools |
| `src/core/consumer-capability.ts:1-4` | `CONSUMER_QODER` is the tool-granting identity; consumer identity is the authorization subject | Conflates profile capability with vendor identity |
| `src/http/server.ts:32-42` | `resolveConsumerId()` maps bearer → consumer; the optional second bearer is the **Qoder** bearer | Bearer wiring is bound to a vendor name and to a single second profile |
| `src/http/server.ts:58-71` | preHandler attaches `consumerId`; any `/v1/*` request must resolve to one of two consumers | The authorization subject is a consumer, not a profile |
| `src/http/openai-chat.ts:437-438` | `effectiveToolCapability(consumerId, model.capability)` | Tool gate source |
| `src/http/openai-responses.ts:237-238` | same gate on the Responses surface | Tool gate source |
| `src/index.ts:202-211, 234-236` | `createProductionServer(..., qoderSecret)` / `process.env.CMM_QODER_TOKEN` | Production authorization wiring is named and shaped around Qoder |
| `src/core/deferred-tool-broker.ts:14-15, 103-105` | `BrokerKey.consumer: "qoder"` and `createPendingCall` **throws** for anything else | The broker refuses non-Qoder entries; this is a hard-coded identity gate inside shared infrastructure |
| `src/providers/codex/adapter.ts:686`, `src/providers/claude/adapter.ts:617`, `src/providers/antigravity/adapter.ts:1193` | adapters construct broker keys with the literal `consumer: "qoder"` | Provider adapters encode the client identity into shared correlation state |

#### Class 2 — legacy compatibility identifiers that must remain temporarily

These are operationally load-bearing for already-installed clients, LaunchAgents, Keychain items,
persisted `agy` MCP registrations and historical evidence. **None may be deleted or renamed in this
change.**

| Identifier | Where | Why it cannot be renamed atomically |
|---|---|---|
| `CMM_QODER_TOKEN` | `.env.example:12`, `scripts/macos/run-router.sh:125-130`, `tests/integration/launchagent.test.ts:48`, `tests/integration/qoder-bearer-provisioning.test.ts:15,33` | Live LaunchAgent environment + documented operator procedure |
| `qoder-bearer` Keychain account | `launchd/com.cmm.subscription-router.plist.template:49-50`, `scripts/macos/run-router.sh:62`, `scripts/macos/install-router.sh:144-152`, `README.md:151` | Existing Keychain items on installed Macs; re-provisioning is a manual human step |
| `CMM_QODER_KEYCHAIN_SERVICE` / `CMM_QODER_KEYCHAIN_ACCOUNT` | plist template `:47-50`, `run-router.sh:61-62` | Rendered into installed plists; renaming orphans stored items |
| `com.cmm.subscription-router` LaunchAgent label | `launchd/...template:6`, `install-router.sh:7`, `README.md:150` | Renaming breaks an installed LaunchAgent |
| `cmm-subscription-router` Keychain service | plist template `:40,44,48`, `run-router.sh:55-62` | Orphans all stored secrets |
| `cmm-qoder-tools` (`ANTIGRAVITY_MCP_SERVER_NAME`, `CMM_QODER_TOOLS_MCP_SERVER_NAME`, `ANTIGRAVITY_BRIDGE_NAME`) | `src/providers/antigravity/adapter.ts:765`, `mcp-registration.ts:29`, `mcp-bridge.ts:18` | Persisted `agy mcp add` registration; reconciliation converges on this exact name (`mcp-registration.ts:352-418`) |
| `cmm_qoder` (`CMM_BRIDGE_SERVER_NAME` default + Claude MCP server key) | `src/bridge/mcp-bridge-process.ts:178,411`, `src/bridge/mcp-bridge-launcher.ts:76`, `src/providers/claude/adapter.ts:850,856` | Fixed bridge protocol name and Claude `allowedTools` prefix |
| `mcp__cmm_qoder__` tool prefix | `src/providers/claude/deferred-tools.ts:36,52-53`, `src/providers/claude/adapter.ts:916` | Renameable atomically (derived from the in-request `mcpServers` key), but there is no migration value and tests pin it (`tests/providers/claude-deferred-bridge.test.ts:56,64`) |
| `mcp(cmm-qoder-tools/*)` agy permission ACL | `scripts/macos/provision-antigravity-mcp-permission.mjs:19,45-46,82-86,131,161` | Persisted in `~/.gemini/antigravity-cli/settings.json`. This Qoder-**named** rule is doing real security work: Antigravity's restricted agent uses `inheritMcp: true` + `tools: [call_mcp_tool]`, which can address *any* MCP server registered in `agy`, so this scoped allow rule is the only thing narrowing the dispatcher to the CMM bridge |
| `qoder-custom-cmm-router` Qoder provider ID | `docs/qoder-setup.md:17`, `scripts/qoder/reconcile-qoder-provider.mjs:20` | Already-registered provider entry in `~/.qoder/settings.json` |
| `QODER_SMOKE_OK` marker + `scripts/qoder-smoke.sh` | `scripts/qoder-smoke.sh:27`, `src/testing/scripted-adapter.ts:39` | Operator-facing acceptance marker |
| `scripts/qoder/reconcile-qoder-provider.mjs`, `scripts/qoder/add-cavoti-model.mjs` | `scripts/qoder/*` | Documented operational scripts |

#### Class 3 — documentation-only naming

Comments, doc strings and diagnostics text that name Qoder while describing generic behaviour. Safe
to reword, zero runtime effect (must not be a global search-and-replace — see the guard in T3.6).

Representative sites: `src/core/deferred-tool-broker.ts:8-11,31`, `src/index.ts:23-27,114`,
`src/http/server.ts:21-26,53-57,117-118`, `src/http/openai-chat.ts:445-447`,
`src/providers/claude/deferred-tools.ts:10-19,27`, `src/providers/command-code/adapter.ts:134-137`,
`src/providers/codex/schema-translator.ts:129`, `src/providers/codex/app-server-client.ts:393,565`,
`src/providers/claude/mcp-bridge.ts:4-6,63,94,107`, `src/bridge/control-ipc.ts:12,224`,
`src/bridge/mcp-bridge-process.ts:7-28,219-290,360`.

#### Class 4 — safe to generalize immediately

| Item | Location | Note |
|---|---|---|
| `BrokerKey.consumer` field | `src/core/deferred-tool-broker.ts:15` + 3 adapter call sites | Labels/metadata only; not consulted for any decision other than the hard-coded refusal. Removing it loses nothing (proof in §5.1) |
| `ConsumerId` type name | `src/core/consumer-capability.ts:4` | Internal type, no persisted form |
| `QODER_TOKEN_ENV` constant | `src/core/consumer-capability.ts:6` | Unused outside the module today; superseded by new constants |
| `resolveConsumerId` export | `src/http/server.ts:32` | No production or test caller (`grep` over `src/` + `tests/` finds only its definition) |

### 0.3 Per-area audit

#### Authentication / consumer policy

- The authorization primitive is bearer → consumer (`src/http/server.ts:32-42`), consumed by
  `effectiveToolCapability` (`src/core/consumer-capability.ts:18-24`).
- The CMMChat bearer is checked **first**; a token that matches both configured secrets silently
  resolves to CMMChat (implicit downgrade). This is the "ambiguous auth" case the new design requires
  to fail closed.
- Absence of the optional second bearer means every authenticated client is CMMChat → tools are
  impossible for everyone (`src/index.ts:232-234`).
- The CMMChat profile is `CHAT_ONLY` by construction (`effectiveToolCapability` returns `CHAT_ONLY`
  for every non-Qoder consumer regardless of provider capability).
- Bearer comparison is already constant-time and hash-based (`src/security/bearer-auth.ts:7-28`).

#### HTTP / protocol boundary

- Chat Completions and Responses both normalize their own `tool_choice` wire shape into one shared
  internal `NormalizedToolChoice`, then apply one shared provider policy
  (`src/core/tool-policy.ts:47-89,137-184`). No Qoder identity leaks into this contract.
- Capability enforcement is shared and fail-closed for tools, `tool_choice`, `parallel_tool_calls`,
  tool-role continuation and assistant tool-call history (`src/http/openai-chat.ts:214-247`).
- Streaming, cancellation and `[DONE]` handling live in the surface handlers
  (`src/http/openai-chat.ts:549-643`, `src/http/openai-responses.ts`).
- `tool_result` payloads are bounded at the boundary (`src/core/tool-result-bound.ts:9-27`).
- `GET /v1/models` publishes **only** `id`/`object`/`owned_by` (`src/http/server.ts:102-112`).
  Per-model capability truth is **not** published anywhere, even though `DiscoveredModel.capability`
  exists (`src/core/model.ts:14-20`). A generic client therefore cannot select an "exact
  `CHAT_AND_TOOLS` model" from discovery today.
- Exact model selection is namespace-exact with no fallback (`src/registry/provider-registry.ts:86-159`).
- The only Qoder leakage at this boundary is the *source* of `effective` (the consumer), not the
  contract.

#### Deferred tool broker / correlation

- The broker is Router-internal, bounded (`maxPending` 64, TTL 120 s,
  `src/core/deferred-tool-broker.ts:92-95`) and never executes tools.
- Public ids are Router-generated, globally unique and unguessable
  (`createPublicToolCallId`, `:57-60`); provider-internal identity is retained separately in
  `PendingToolContext` (`:33-39`).
- Resolution is by public id (`claimByPublicToolCallId`, `:161-172`) or composite key
  (`claimCall`, `:175-177`); terminal states are retained for duplicate/stale detection
  (`:213-263`).
- Cancellation, expiry and abort cleanup exist (`:138-145`, `:195-202`, `:229-240`).
- The `consumer` field is **not** used for any correlation, ACL, cancellation or bound decision — the
  only read is the refusal at `:103-105`. Removing it is therefore safe (see §5.1).
- Cross-request correlation relies on the client round-tripping only the public `tool_call_id` plus
  ordinary message history (`:8-12`). This is standard OpenAI-compatible behaviour, not Qoder-specific.

#### Provider bridges

| Provider | Qoder coupling found | Native-execution guard |
|---|---|---|
| ChatGPT/Codex | `consumer: "qoder"` broker key (`adapter.ts:686`); naming in comments; `schema-translator.ts:129` | `dynamicTools` only with `experimentalApi: true` (`adapter.ts:136`); undeclared tool → fail closed (`:666-678`); approvals declined (`app-server-client.ts`) |
| Claude | `consumer: "qoder"` (`adapter.ts:617`); bridge server key `cmm_qoder` (`:850,856`); `mcp__cmm_qoder__` allowedTools prefix (`:916`); `disallowedTools` list (`:890-901`) | `disallowedTools` disables all native tools (`:889-903`); `permissionMode: "auto"` with tools disabled |
| Google/Antigravity | `consumer: "qoder"` (`adapter.ts:1193`); persisted MCP server name `cmm-qoder-tools` (`:765`, `mcp-registration.ts:29`); agent definition comments | `args.includes("--dangerously-skip-permissions")` refusal; account-only settings gate |
| Command Code | comments only (`adapter.ts:134-137,359,449-450`) | declared-tool ACL (`declaredToolNames`) |
| Cavoti | none found | spend-guard + PAYG acknowledgement |

No provider executes a provider-native tool. All three park-and-await providers declare only the
caller's tools, and the ACL (declared tool names) is enforced at the provider boundary and again at
the MCP bridge (`src/bridge/mcp-bridge-process.ts`, `declaredTools.has(name)`).

Additional provider findings that shape Phase 3:

- **Antigravity is the most Qoder-coupled security surface in the repository, and the coupling is
  outside `src/`.** `mcp(cmm-qoder-tools/*)` is written into `~/.gemini/antigravity-cli/settings.json`
  by `scripts/macos/provision-antigravity-mcp-permission.mjs` and is what scopes
  `call_mcp_tool` to the CMM bridge. The provisioner deliberately refuses `mcp(*)` and refuses to
  run when a higher-precedence `ask`/`deny` MCP rule exists (`:44-47,75-80,137-140`). Any future
  rename must migrate registration (Class 2, above) **and** this rule in one deployment step, and
  must never widen it to `mcp(*)`.
- **`src/providers/claude/deferred-tools.ts` is effectively dead in production** — its only
  importers are tests (`tests/providers/claude-deferred-bridge.test.ts`). The live Claude mechanism is
  `mcpServers` + `allowedTools` + `disallowedTools` in `adapter.ts:855-917`. Comment rewording there
  is zero-risk.
- **Claude's native-tool barrier is a 10-name denylist** (`adapter.ts:890-901`) plus
  `permissionMode: "auto"`, not an exclusive allowlist. `node_modules` is absent in this worktree, so
  the SDK's `allowedTools` semantics (auto-approve vs exclusive allowlist) are **unverified**. This
  is a pre-existing residual risk, not introduced here; Phase 6 records it and T4.6 forbids widening it.
- **Codex continuation can theoretically re-derive its ACL**: `adapter.ts:324-326` falls back to
  `new Set(request.tools…)` when the per-thread ACL entry was evicted (`MAX_TRACKED_THREADS = 64`),
  which would let a continuation widen the declared-tool set mid-loop. Low likelihood; hardened in T3.8.
- **Command Code / Cavoti declared-tool ACLs are self-referential** (they check the returned call is
  in the caller's declared set). A client can therefore declare an upstream *server-side* tool name
  and the upstream may execute it. That is client-owned tools by design, but it must not be described
  as "the Router prevents provider-native execution".
- **The broker is in-memory only** (`deferred-tool-broker.ts:83-88`). Codex/Claude/Antigravity
  continuations must return to the **same live Router process** while the provider turn is parked.
  This is provider-neutral but is a real operational contract for Hermes/Codex/generic client docs
  (T4.4) and real-client gates (Phase 7).

#### Qoder integration

- Bearer provisioning: `install-router.sh:140-152` reports (never creates) the `qoder-bearer`
  Keychain item; `run-router.sh:123-130` resolves it non-fatally into `CMM_QODER_TOKEN`;
  `docs/macos-install.md` documents the manual `security add-generic-password` step.
- Model reconciliation lives in scripts only, not in `src/`:
  `scripts/qoder/reconcile-qoder-provider.mjs` rewrites exactly one provider entry and preserves
  unmanaged tail models. It uses a **hard-coded 25-slot `LAYOUT` table** (`:50-79`) with static
  context/output/effort values, does not consume `/v1/models.x_cmm`, and carries the existing bearer
  over untouched.
- Live canary: `scripts/live-canary/canary-driver.ts:305-321` requires the Qoder bearer (env or
  Keychain) and refuses to fall back to `CMM_ROUTER_TOKEN`; it also blocks a token collision
  (`:368-372`). `scripts/qoder-smoke.sh:17` conversely uses `CMM_ROUTER_TOKEN` (CMMChat, permanently
  `CHAT_ONLY`) and therefore proves chat surfaces only. Two "Qoder" harnesses with opposite bearer
  semantics — a documentation/consistency defect to fix in Phase 5.
- Task 16B (multi-Mac bidirectional Qoder model synchronization) is specified to synchronize a
  manifest derived from `/v1/models.x_cmm` (`task16 design §12:284-290`) but **Task 16 capability
  truth is not implemented in this baseline**: `x_cmm` and `runtimeCapabilities` appear in no `src/`
  or `tests/` file, and there is no Task 16 closure evidence under `docs/audits/`. Task 16B is
  therefore blocked on a dependency that does not exist yet.

#### Client-neutral test surface already present

The suite is large (144 `*.test.ts`, 763 `it`/`test` blocks) and already contains client-neutral
boundary proofs — `tests/http/tool-loop-contract.test.ts:78-120` and
`tests/http/tool-roundtrip-boundary.test.ts:77-172` use a provider double and never name a client.
Phase 2 extends this style rather than inventing a parallel harness. Roughly 20 HTTP test files
authenticate with `qoderToken` purely as a means to obtain tools; preserving `qoderToken` as a legacy
alias (T1.4) keeps those green, and only the policy matrix
(`tests/http/consumer-capability.test.ts:72-78,80-113`,
`tests/http/chat-only-enforcement.test.ts:176-220`) must be rewritten for profile semantics.

Note: the literal markers `NO_PAYG_FALLBACK`, `NO_CROSS_PROVIDER_FALLBACK` and
`NO_UNKNOWN_MODEL_FALLBACK` currently appear in **no** test file (documentation only). T2.7 adds
behavioural assertions that emit them.

#### Scripts, installer and documentation coupling

- **Bearer provisioning:** nothing generates tokens. Every secret is human-created with
  `security add-generic-password -s cmm-subscription-router -a <account> -w` (prompts without echo).
  Four accounts exist: `router-bearer` (required), `qoder-bearer` (optional), `command-code-secret`,
  `cavoti-api-key`. The installer only **reports** the optional items
  (`install-router.sh:140-152`); the plist carries identifiers only
  (`launchd/...plist.template:28-51`).
- **Launch path:** label `com.cmm.subscription-router`, `ProgramArguments` →
  `scripts/macos/run-router.sh`, `WorkingDirectory` = repo root, logs under
  `~/Library/Logs/CMM-Subscription-Router/`.
- **Audit-script coupling:** `scripts/security-audit.sh:99-104` requires the literal substring
  `Qoder`/`qoder` as one of the accepted exemption tokens for the Codex `success: true` path (the
  alternatives `ORIGINAL`/`already-executed` must therefore survive any comment rewording), and
  `:135-143` emits the marker `CODEX_QODER_TOOL_DEFINITIONS_SENT=PASS`. These must be updated
  deliberately in Phase 3/6, not accidentally broken.
- **Preflight gap:** `scripts/preflight.sh` checks no bearer at all, and `validate-config.mjs:101`
  emits `BEARER_SECRET_ENV` which nothing consumes. A new Code Router bearer is invisible to
  preflight unless added (T5.9).
- **Doctrine to replace (documentation, but operationally read by humans):**
  `docs/macos-install.md:36-48` and `README.md:129-131` currently state that the *Qoder* bearer is
  what enables the Code Router profile.
- **Two opposite-bearer "Qoder" harnesses:** `scripts/qoder-smoke.sh:17` and
  `docs/qoder-setup.md:59` / `docs/qoder-acceptance.md:50` use `CMM_ROUTER_TOKEN` (CMMChat,
  `CHAT_ONLY`), while `scripts/live-canary/canary-driver.ts:305-321,368-372` refuses that bearer and
  requires `CMM_QODER_TOKEN`. `tests/integration/qoder-smoke-cancel.test.ts:78` runs the smoke script
  with `CMM_ROUTER_TOKEN`, so that behaviour must be preserved even after T5.6 adds the canonical
  harness.
- **Historical evidence is frozen:** all 26 files under `docs/audits/` predate this work; several
  contain claims contradicted by later evidence (e.g. the Google/Antigravity capability claim in
  `docs/task-13-closure.md` / `docs/qoder-acceptance.md:23` versus the NOT_SUPPORTED multi-step
  verdicts in `docs/audits/2026-09-10-*mcp-hardening-reaudit-516ccdd.md:831,868,872`). Do not rewrite
  them; record current truth in new documents (T5.10).

### 0.4 Open pre-stable items (not closed by this plan)

Tracked in `README.md` §Roadmap "Close current compatibility gaps" and design §16 Phase E. This plan
must not pretend any of these are closed:

1. Google/Antigravity GPT-OSS tool compatibility and real Qoder tool selection.
2. Sonnet real-Qoder tools.
3. ChatGPT/Codex revalidation when subscription quota permits.
4. Command Code live completion (disabled by default; human spend decision required).
5. Task 16 capability truth — **unimplemented in this baseline**, and the dependency of Task 16B.
6. Task 16B multi-Mac Qoder synchronization.
7. Final real-client compatibility gate.

### 0.5 Defects and gaps found by this audit

| ID | Finding | Consequence |
|---|---|---|
| A1 | Tools are granted by client identity, not profile capability | Blocks every non-Qoder client |
| A2 | `BrokerKey.consumer` hard-refuses non-`"qoder"` entries | Shared broker is structurally Qoder-only |
| A3 | No canonical Code Router bearer exists | Hermes/Codex/generic clients must impersonate Qoder |
| A4 | Ambiguous bearer configuration silently downgrades to CMMChat | No fail-closed signal for a misconfigured collision |
| A5 | `GET /v1/models` publishes no capability | A generic client cannot discover the exact `CHAT_AND_TOOLS` model |
| A6 | `qoder-smoke.sh` uses the CMMChat bearer while being named "qoder" | Operator confusion; tool paths unexercised by that script |
| A7 | Task 16 `x_cmm` / `runtimeCapabilities` unimplemented | Task 16B blocked; capability publication must be added minimally and forward-compatibly |
| A8 | `reconcile-qoder-provider.mjs` hard-codes a 25-slot layout | Must **not** be extended or depended on by the client-agnostic profile (Dynamic Catalog workstream) |
| A9 | No client identifier exists anywhere | No diagnostic evidence of which clients connect |
| A10 | No deterministic non-Qoder end-to-end client proof exists | Client-agnostic claim is unproven |
| A11 | Antigravity's only tool-scope control is the persisted Qoder-named rule `mcp(cmm-qoder-tools/*)` (`provision-antigravity-mcp-permission.mjs:19`) | The most coupled security mechanism lives outside `src/`; it must be guarded, never widened to `mcp(*)` |
| A12 | `scripts/security-audit.sh:99-104` accepts the literal `Qoder` substring as an exemption token and `:139` emits `CODEX_QODER_TOOL_DEFINITIONS_SENT` | Rewording comments can silently break or hollow out the audit gate (T3.9) |
| A13 | Codex continuation re-derives its declared-tool ACL on eviction (`adapter.ts:324-326`) | Theoretical mid-loop ACL widening driven by the continuation payload (T3.8) |
| A14 | `src/core/wire.ts:111-117` omits `cavoti` from the accepted provider list | Latent inconsistency in a module with no production caller today |
| A15 | `tests/providers/capability-truthfulness.test.ts:25-41` is vacuous (`void adapters;`) | A capability regression cannot be caught by that test |
| A16 | `tests/providers/codex-dynamic-tool.test.ts:97-101` contradicts `codex-dynamic-tool-declaration.test.ts:189-221` about dynamic-tool declaration | Conflicting evidence about a load-bearing tool channel |
| A17 | `scripts/preflight.sh` checks no bearer; `validate-config.mjs:101` emits an unused `BEARER_SECRET_ENV` | A new canonical bearer would be invisible to preflight |
| A18 | `docs/qoder-acceptance.md:23` claims `google/*` `CHAT_AND_TOOLS` "Proven" with no GPT-OSS carve-out, contradicted by multi-step NOT_SUPPORTED audit verdicts | Current documentation overstates capability |

### 0.6 Verification gaps and residual risks (recorded, not silently fixed)

These are pre-existing and cannot be resolved in this worktree. Their purpose here is truthfulness:
they must survive into Phase 6 evidence and Phase 7 gates rather than being assumed away.

1. **Claude SDK semantics unverified.** `node_modules` is absent, so whether
   `@anthropic-ai/claude-agent-sdk@0.3.266` treats `allowedTools` as an auto-approve list or an
   exclusive allowlist is unknown. If it is auto-approve, the 10-name `disallowedTools` denylist is
   the only barrier to an unnamed native tool. T4.6 forbids widening it; T6.8 records the gap.
2. **Antigravity headless default policy untested.** Whether `inheritMcp: true` + `call_mcp_tool`
   can reach a user-registered non-CMM MCP server in headless `--print` mode could not be tested
   (no live execution permitted). This is why the scoped ACL (A11) must be preserved exactly.
3. **In-memory broker.** A Router restart drops all parked correlation, and continuations must
   return to the same live process. Provider-neutral, but a real client contract (T4.4) and a reason
   the generic proof must not be misread as a durability guarantee.
4. **Command Code / Cavoti self-referential ACL.** They check the returned call is in the caller's
   declared set; a client may declare an upstream server-side tool name. That is client-owned tools
   by design and must not be documented as Router-enforced provider-native-execution prevention.
5. **Historical evidence is pre-Task-16.** All 26 `docs/audits/` files predate this workstream and
   contain superseded or self-contradicted claims. They are read-only history.

---

## 1. Target architecture

### 1.1 Orthogonality

Replace:

```text
QODER identity -> CHAT_AND_TOOLS
```

with:

```text
effective capability =
    authenticated profile capability            (CMMCHAT -> CHAT_ONLY | CODE -> tools-capable)
  ∩ truthful provider/model capability          (CHAT_AND_TOOLS only when proven)
  ∩ protocol representability                   (shared tool-policy enforcement)
```

Client identity is diagnostic/compatibility metadata and is **never** an authorization input.

### 1.2 Server-side identity model

```ts
// src/core/router-profile.ts
export const PROFILE_CMMCHAT = "cmmchat" as const;   // -> CHAT_ONLY, always
export const PROFILE_CODE    = "code"     as const;   // -> CHAT_AND_TOOLS ∩ provider truth
export type RouterProfile = typeof PROFILE_CMMCHAT | typeof PROFILE_CODE;

export const CLIENT_CMMCHAT = "cmmchat";
export const CLIENT_QODER   = "qoder";
export const CLIENT_HERMES  = "hermes";
export const CLIENT_CODEX   = "codex-client";   // client identity, NOT the chatgpt provider id
export const CLIENT_GENERIC = "generic-openai"; // default when the client sends nothing
export const CLIENT_OTHER   = "other";          // bounded bucket for unknown identifiers
export type RouterClientId = /* the six literals above */;
```

`effectiveProfileToolCapability(profile, providerCapability)`:

```text
profile !== CODE                      -> CHAT_ONLY
profile === CODE && providerCapability === "CHAT_AND_TOOLS" -> CHAT_AND_TOOLS
otherwise                             -> CHAT_ONLY
```

### 1.3 Authentication precedence (explicit, deterministic)

Three server-configured secrets exist. The **profile** is derived from which secret validated:

| # | Secret source | Env var | Keychain account (default) | Profile | Default client id |
|---|---|---|---|---|---|
| 1 | CMMChat bearer | `bearerSecretEnv` (default `CMM_ROUTER_TOKEN`) | `router-bearer` | `cmmchat` | `cmmchat` |
| 2 | Code Router bearer (canonical) | `CMM_CODE_ROUTER_TOKEN` | `code-router-bearer` | `code` | `generic-openai` |
| 3 | Legacy Qoder bearer (compatibility window) | `CMM_QODER_TOKEN` | `qoder-bearer` | `code` | `qoder` |

Rules:

1. **Startup fail-closed:** if the CMMChat secret equals the canonical Code Router secret, or equals
   the legacy secret, the server refuses to start (`router_misconfigured`). This replaces today's
   silent downgrade (A4). Two Code Router secrets with the same value are not ambiguous (same
   profile) and are accepted.
2. **Only legacy configured** → the CODE profile works (compatibility window). Existing Qoder
   installs keep working unchanged.
3. **Only canonical configured** → the CODE profile works.
4. **Both configured** → both authenticate CODE; the canonical secret is the documented path, the
   legacy secret remains accepted until the compatibility window closes. No precedence is needed
   because both resolve to the same profile.
5. **Neither configured** → there is no CODE profile; every authenticated client is CMMChat
   (`CHAT_ONLY`) and a request presenting any unconfigured token is `401`.
6. **CMMChat bearer can never authenticate as CODE** — guaranteed structurally by rule 1 plus
   per-secret profile mapping.
7. No token value is ever logged, echoed, embedded in tracked files, or returned in a response.

### 1.4 Client identifier contract

- Optional request header `X-CMM-Client` (case-insensitive).
- Absent/empty → `generic-openai`.
- Normalized: trim → lowercase → strip to `[a-z0-9._-]` → collapse repeats → truncate to 64 chars →
  map onto the closed `RouterClientId` set; anything unrecognized → `other`.
- The normalized value is **only** used for diagnostics. It can never change profile, provider,
  model, capability, billing or fallback behaviour. No normalized value is ever echoed back raw.
- The CMMChat profile always reports `cmmchat`, ignoring the header (no diagnostic spoofing).

### 1.5 Compatibility window

- Both the legacy Qoder bearer and the new Code Router bearer authenticate the CODE profile.
- Legacy identifiers in §0.2 Class 2 remain present and operational.
- **Removal criteria** (a separate future change, explicitly out of scope here): every Mac has
  provisioned `code-router-bearer`, every client has been re-pointed to the canonical secret, and a
  documented deprecation period has elapsed with no legacy-bearer authentication observed in usage
  diagnostics.

---

## 2. Global constraints and non-goals

**Constraints**

- CMMChat is permanently `CHAT_ONLY`; no client identity can elevate it.
- Provider/model capability is never overstated; unsupported combinations fail closed with no silent
  downgrade.
- No PAYG fallback, no cross-provider fallback, no unknown-model fallback.
- Provider/model owns reasoning; client/harness owns tool execution; provider-native
  filesystem/shell/repository mutation stays forbidden.
- Exact model selection; namespace-exact registry resolution.
- Loopback-only binding (`127.0.0.1`).
- Loop over TDD: RED first for every behavioural change.
- Small, reviewable commits grouped by phase.

**Non-goals (must not be folded in)**

- Dynamic Provider Catalog Reconciliation (only avoid blocking it).
- Task 16 full capability truth (`runtimeCapabilities`, context/vision/reasoning metadata).
- Task 16B multi-Mac synchronization.
- The `$HOME/CMM-Routers` → `$HOME/CMM Routers` local path migration.
- CMM Routers Console.
- Cosmetic global rename of Class 2 identifiers.
- Rewriting historical audit evidence in `docs/audits/`.
- Deleting legacy identifiers.
- Weakening tests/timeouts/security gates for green output.
- Any live provider inference during implementation phases (Phase 7 gates only, human-authorized).

---

## 3. Phase 1 — Profile/client separation

### T1.1 — Introduce the profile/client identity core

**Goal:** new client-neutral authorization types and the profile capability decision.

**Files**
- create `src/core/router-profile.ts`
- create `tests/core/router-profile.test.ts`

**RED**
`tests/core/router-profile.test.ts`:
- `effectiveProfileToolCapability(PROFILE_CMMCHAT, "CHAT_AND_TOOLS") === "CHAT_ONLY"` → log
  `CMMCHAT_CHAT_ONLY=PASS`
- `effectiveProfileToolCapability(PROFILE_CMMCHAT, undefined) === "CHAT_ONLY"`
- `effectiveProfileToolCapability(PROFILE_CODE, "CHAT_AND_TOOLS") === "CHAT_AND_TOOLS"` → log
  `CMM_CODE_ROUTER_PROFILE=CHAT_AND_TOOLS`
- `effectiveProfileToolCapability(PROFILE_CODE, "CHAT_ONLY") === "CHAT_ONLY"` and
  `(PROFILE_CODE, undefined) === "CHAT_ONLY"` (no unknown-capability promotion)
- `normalizeClientId(undefined|""|"   ") === "generic-openai"`
- `normalizeClientId("Qoder") === "qoder"`, `" hermes "` → `hermes`, `"codex-client"` →
  `codex-client`, `"CMMChat"` → `cmmchat`
- unknown (`"acme-harness"`, `"qoder;rm -rf /"`, `"a".repeat(500)`) → `other`; output length ≤ 64;
  output never contains the raw input when the input was rejected

**GREEN**
Implement `src/core/router-profile.ts` with the constants, the closed `RouterClientId` union,
`normalizeClientId`, and `effectiveProfileToolCapability`. The module must contain no reference to
any client identity in an authorization branch.

**Verify**
`npx vitest run tests/core/router-profile.test.ts`

---

### T1.2 — Keep legacy consumer-capability as a compatibility shim

**Goal:** existing imports keep working and keep their old observable semantics without keeping the
Qoder authorization literal in the decision path.

**Files**
- modify `src/core/consumer-capability.ts`
- create `tests/core/consumer-capability-compat.test.ts`

**RED**
`tests/core/consumer-capability-compat.test.ts`:
- `CONSUMER_CMMCHAT === PROFILE_CMMCHAT`
- `effectiveToolCapability(CONSUMER_CMMCHAT, "CHAT_AND_TOOLS") === "CHAT_ONLY"`
- `effectiveToolCapability(CONSUMER_QODER, "CHAT_AND_TOOLS") === "CHAT_AND_TOOLS"`
- `effectiveToolCapability(CONSUMER_QODER, "CHAT_ONLY") === "CHAT_ONLY"`
- `QODER_TOKEN_ENV === "CMM_QODER_TOKEN"` (legacy env name preserved)
- new `CODE_ROUTER_TOKEN_ENV === "CMM_CODE_ROUTER_TOKEN"`
- no `qoder` string literal inside `src/core/router-profile.ts`

**GREEN**
Rewrite `src/core/consumer-capability.ts` as a thin deprecated re-export layer:
`CONSUMER_CMMCHAT = PROFILE_CMMCHAT`, `CONSUMER_QODER = PROFILE_CODE` (legacy alias),
`ConsumerId = RouterProfile`, `effectiveToolCapability = effectiveProfileToolCapability`, plus
`CODE_ROUTER_TOKEN_ENV`. Document each export as deprecated-but-supported with the compatibility
window reference.

**Verify**
`npx vitest run tests/core/consumer-capability-compat.test.ts`

---

### T1.3 — Client-neutral token/identity resolution

**Goal:** bearer → profile mapping with startup fail-closed on ambiguity.

**Files**
- create `src/http/identity.ts`
- create `tests/http/identity-resolution.test.ts`

**RED**
`tests/http/identity-resolution.test.ts`:
- canonical token → `{ profile: "code", clientId: "generic-openai" }`
- legacy token → `{ profile: "code", clientId: "qoder" }` →
  `LEGACY_QODER_BEARER_STILL_AUTHENTICATES_CODE=PASS`
- legacy token + `X-CMM-Client: hermes` → `{ code, hermes }`
- canonical token + `X-CMM-Client: qoder` → `{ code, qoder }` (diagnostic only)
- CMMChat token → `{ cmmchat, cmmchat }` and
  `X-CMM-Client: qoder` does **not** change it → `CMMCHAT_BEARER_CANNOT_ELEVATE=PASS`
- unknown/absent token → `null`
- only-legacy configured → code resolves; only-canonical configured → code resolves
- `assertDistinctServerTokens` throws when cmmchat == canonical and when cmmchat == legacy →
  `AMBIGUOUS_AUTH_FAILS_CLOSED=PASS`
- `assertDistinctServerTokens` accepts canonical == legacy (same profile)
- no returned/logged value contains the presented token

**GREEN**
Implement `src/http/identity.ts` with `ServerTokens`, `ResolvedIdentity`,
`assertDistinctServerTokens`, `resolveRequestIdentity` (constant-time `verifyBearer`), and a
`CLIENT_ID_HEADER = "x-cmm-client"` constant. Never log the token.

**Verify**
`npx vitest run tests/http/identity-resolution.test.ts tests/security/bearer-auth.test.ts`

---

### T1.4 — Wire identity into the HTTP server without breaking existing callers

**Goal:** the preHandler attaches a profile-based identity; the legacy `qoderToken` option keeps
working as the legacy Code Router secret.

**Files**
- modify `src/http/server.ts`
- modify `src/index.ts`
- modify `tests/http/server.test.ts` (add cases only)

**RED**
Add to an HTTP server test:
- `buildServer({ bearerSecret, codeRouterToken })` → code bearer reaches a provider
- `buildServer({ bearerSecret, qoderToken })` (legacy option, no new option) → still reaches a
  provider → `LEGACY_QODER_OPTION_STILL_WORKS=PASS`
- both options set with different values → both reach a provider
- `bearerSecret === codeRouterToken` → `buildServer` throws
- unconfigured token → `401`

**GREEN**
- `ServerOptions`: add `codeRouterToken?: string`; keep `qoderToken?: string` documented as the
  deprecated legacy Code Router secret (maps to `legacyQoderToken`).
- `buildServer` calls `assertDistinctServerTokens` once at construction.
- preHandler resolves `ResolvedIdentity` and attaches `(request as ConsumerRequest).identity`;
  keep `consumerId` as a deprecated derived alias (profile) for the compatibility window.
- keep `resolveConsumerId` exported as a deprecated wrapper over `resolveRequestIdentity` returning
  the profile, so any unpublished consumer of that helper is unaffected.
- `src/index.ts`: `createProductionServer(composition, bearerSecret, options?)` where `options` is
  `{ codeRouterSecret?: string; legacyQoderSecret?: string }`; `main()` reads
  `process.env.CMM_CODE_ROUTER_TOKEN` and `process.env.CMM_QODER_TOKEN`.
  Update the only existing 3-arg call (`main()`); the two 2-arg test call sites are unaffected.

**Verify**
`npx vitest run tests/http/server.test.ts tests/http/identity-resolution.test.ts`

---

### T1.5 — Gate tool semantics on the profile, not the client

**Goal:** `effective` comes from `identity.profile` on both surfaces; no Qoder identity remains in
the decision.

**Files**
- modify `src/http/openai-chat.ts` (`:18`, `:437-438`)
- modify `src/http/openai-responses.ts` (`:9`, `:237-238`)
- create `tests/http/code-router-profile.test.ts`

**RED**
`tests/http/code-router-profile.test.ts` (canonical bearer, no client header):
- CODE profile gets tools on a `CHAT_AND_TOOLS` model (chat) → `GENERIC_OPENAI_CODE_ROUTER=PASS`
- CODE profile gets tools on the Responses surface (parity)
- CODE profile + `X-CMM-Client: qoder` still gets tools; CODE profile + `X-CMM-Client: totally-other`
  still gets tools (client metadata cannot change capability)
- CMMChat bearer + capable model + tools → `400 unsupported_capability`, provider invocations `0` →
  `CMMCHAT_TOOLS_REJECTED=PASS`
- CMMChat bearer + `X-CMM-Client: qoder` + tools → still `400` →
  `CLIENT_CAPABILITY_SPOOFING=NONE`
- CODE profile on a `CHAT_ONLY` model + tools → `400`, provider invocations `0` →
  `CHAT_ONLY_PROVIDER_STAYS_CHAT_ONLY=PASS`
- CODE bearer not configured → `401` (`MISSING_CODE_BEARER_FAILS_CLOSED=PASS`)
- legacy bearer works identically to the canonical bearer

Keep `tests/http/consumer-capability.test.ts` green as the legacy regression (its assertions are
semantically preserved by T1.2).

**GREEN**
Replace `consumerId` usage with `identity.profile` and `effectiveProfileToolCapability` in both
handlers. No other behaviour change: `rejectChatOnlyTools`, tool policy and error mapping stay
byte-identical.

**Verify**
`npx vitest run tests/http/code-router-profile.test.ts tests/http/consumer-capability.test.ts tests/http/chat-only-enforcement.test.ts`

---

### T1.6 — Profile-separation security audit checks

**Goal:** mechanical proof that client identity is not an authorization input.

**Files**
- modify `scripts/security-audit.sh`

**RED**
Add checks that fail the audit when violated (run against current code first to see them fail, then
land with T1.1–T1.5):
- `src/core/router-profile.ts` contains no case-insensitive `qoder`
- the capability gate text appears as `effectiveProfileToolCapability` in both HTTP handlers
- the string `clientId` never appears as an argument to `effectiveProfileToolCapability`
- `BrokerKey` no longer declares a `consumer` field (checked in T3.1; land the check there)
- emit `CMM_CODE_ROUTER_PROFILE=CHAT_AND_TOOLS` and `CMM_CODE_ROUTER_CLIENT_AGNOSTIC=YES`

**GREEN**
Implement with the existing grep-style pattern of the script. Keep the existing
`CONSUMER_CAPABILITY_POLICY=PASS` marker as a compatibility marker and add
`PROFILE_CAPABILITY_POLICY=PASS`.

**Verify**
`bash scripts/security-audit.sh` (after T1.5 is complete)

---

### T1.7 — Legacy compatibility regression lock

**Goal:** prove nothing from Class 2 was removed.

**Files**
- create `tests/integration/legacy-code-router-compat.test.ts`

**RED/GREEN**
This is a characterization test; write it first and let it pass, then keep it as a permanent lock:
- `CMM_QODER_TOKEN` still present in `.env.example`, `run-router.sh`, plist template
- `qoder-bearer` account still present in plist template, `install-router.sh`, `run-router.sh`
- `cmm-qoder-tools` still the Antigravity MCP server name in `mcp-registration.ts`
- `cmm_qoder` still the bridge default name in `mcp-bridge-process.ts`
- `mcp__cmm_qoder__` still the Claude tool prefix
- legacy bearer authenticates the CODE profile end to end (server-level)
- log `LEGACY_COMPAT_IDENTIFIERS_PRESERVED=PASS`

**Verify**
`npx vitest run tests/integration/legacy-code-router-compat.test.ts`

---

## 4. Phase 2 — Canonical Code Router protocol

### T2.1 — Minimal truthful capability publication on `GET /v1/models`

**Goal:** a generic client can discover the exact tool-capable model without any client-specific
list.

**Files**
- modify `src/http/server.ts` (`:102-112`)
- create `tests/http/models-capability-publication.test.ts`

**RED**
- capable model entry includes `x_cmm.code_router === "CHAT_AND_TOOLS"`
- chat-only model entry includes `x_cmm.code_router === "CHAT_ONLY"`
- model with unknown capability omits `x_cmm` entirely
- `id`, `object`, `owned_by` are unchanged and additive-only
- redaction still applies
- log `MODEL_CAPABILITY_TRUTHFULNESS=PASS`

**GREEN**
Additivity only:

```ts
...(model.capability ? { x_cmm: { code_router: model.capability } } : {})
```

**Fencing note (must appear in the commit body):** this publishes the Code Router capability verdict
inside the `x_cmm` namespace already reserved by the Task 16 design. It is **not** the Task 16
`runtimeCapabilities` schema (context window, max output tokens, vision, reasoning). Task 16 extends
the same namespace and must preserve this key. No new table, no client-specific list, no rigid layout.

**Verify**
`npx vitest run tests/http/models-capability-publication.test.ts tests/http/server.test.ts`

---

### T2.2 — Client identity diagnostics (never authorization)

**Goal:** record the normalized client identity for observability only.

**Files**
- modify `src/observability/usage-store.ts` (`UsageRecord`, `beginRequest`)
- modify `src/http/usage-tracking.ts` (optional identity parameter)
- modify `src/http/openai-chat.ts`, `src/http/openai-responses.ts` (pass identity)
- modify `tests/observability/usage-store.test.ts`, add `tests/http/client-identity-diagnostics.test.ts`

**RED**
- `beginRequest(id, provider, model, { profile, clientId })` records both on the usage record
- records without identity keep the current shape (no new required fields)
- a request with `X-CMM-Client: qoder;rm -rf /` produces `clientId === "other"` in diagnostics
- the same header on a `CHAT_ONLY` provider still yields `400` (no capability change)
- no token value appears anywhere in `/v1/cmm/usage` output
- log `CLIENT_IDENTITY_DIAGNOSTIC_ONLY=PASS`

**GREEN**
Add optional `profile`/`clientId` to `UsageRecord` and `beginRequest`; thread the resolved identity
from both HTTP handlers through `trackProviderStream`. `redactObject` continues to wrap diagnostics.

**Verify**
`npx vitest run tests/http/client-identity-diagnostics.test.ts tests/observability/usage-store.test.ts tests/http/usage-wiring.test.ts`

---

### T2.3 — Deterministic generic OpenAI-compatible round-trip harness

**Goal:** the architectural proof, using an identity that is not Qoder, Hermes or Codex, against a
provider-neutral adapter.

**Files**
- create `tests/helpers/generic-tool-adapter.ts` (in-process `CHAT_AND_TOOLS` double under the
  `command-code` provider namespace; no network, no quota, no secrets)
- create `tests/http/generic-code-router-client.test.ts`

**RED**
Using the canonical Code Router bearer and `X-CMM-Client: generic-openai`:
- `GET /v1/models` → exact model `command-code/generic-echo` with
  `x_cmm.code_router === "CHAT_AND_TOOLS"`
- exchange 1 (non-streaming chat): `tools:[cmm_echo]` → `200`,
  `finish_reason === "tool_calls"`, structured `tool_calls[0]` with a Router-generated id and the
  declared function name → `HTTP_ROUNDTRIP_TOOL_CALL_SURFACED=PASS`
- exchange 2: assistant `tool_calls` history + `role:"tool"` result with that id → `200`, final text
  causally derived from the submitted result →
  `E2E_PROVIDER_CONTINUATION_CAUSALLY_DEPENDS_ON_TOOL_RESULT=PASS`
- multi-step: three sequential tool rounds then a terminal answer
- undeclared tool name is never surfaced or forwarded → `DECLARED_TOOL_ACL=PASS`
- no client identity appears in any provider-facing payload (assert the adapter never receives it)

**GREEN**
Implement the deterministic double and the assertions. This tier proves the provider-neutral wire
contract only; broker involvement is proven separately in T2.4. Model the test on the existing
client-neutral proofs `tests/http/tool-loop-contract.test.ts:78-120` and
`tests/http/tool-roundtrip-boundary.test.ts:77-172` rather than creating a parallel harness style,
and reuse `tests/fixtures/tool-contract.ts` (`CMM_ECHO_TOOL`).

**Verify**
`npx vitest run tests/http/generic-code-router-client.test.ts`

---

### T2.4 — Generic non-Qoder client on the production broker/bridge path

**Goal:** directly answer "prove a generic non-Qoder Code Router client can use the same broker
safely".

**Files**
- create `tests/http/generic-client-broker-roundtrip.test.ts`
- reuse `tests/helpers/fake-claude-sdk.ts`, `src/bridge/mcp-bridge-process.ts`

**RED**
Clone the shape of `tests/http/tool-roundtrip-production.test.ts`, but:
- authenticate with the **canonical Code Router bearer**, not the legacy one
- send `X-CMM-Client: generic-openai`
- keep the production `ClaudeAdapter` + `DeferredToolBroker` + real MCP bridge process
- assert the full two-exchange round trip, same-session continuation, and
  `activeToolSessions() === 0` at the end
- assert the broker entry was created **without** any client identity field
- log `GENERIC_OPENAI_CODE_ROUTER=PASS`, `CLIENT_OWNS_TOOLS=YES`,
  `PROVIDER_NATIVE_TOOL_EXECUTION=NONE`

**GREEN**
No production change needed beyond Phase 1/3; this test is the proof.

**Verify**
`npx vitest run tests/http/generic-client-broker-roundtrip.test.ts tests/http/tool-roundtrip-production.test.ts`

---

### T2.5 — Generic-client cancellation and pending-state cleanup

**Files**
- create `tests/http/generic-client-cancellation.test.ts`

**RED**
- abort a generic-client request while a tool call is parked → the parked correlation is released,
  provider run aborted, usage records `cancelled`, active requests drain to `0`
- a second concurrent parked session on the same bearer is unaffected (isolation)
- a tool result submitted after cancellation is classified stale/unknown and never resolves a fresh
  call → `CANCELLATION_CLEANS_PENDING_STATE=PASS`
- an unknown public tool-call id fails closed

**GREEN**
No production change expected; if the abort-time identity plumbing (T2.2) interferes, fix the
plumbing, not the test.

**Verify**
`npx vitest run tests/http/generic-client-cancellation.test.ts tests/providers/deferred-tool-cancellation.test.ts tests/http/production-cancellation-matrix.test.ts`

---

### T2.6 — Streaming and Responses parity for the generic client

**Files**
- create `tests/http/generic-client-surface-parity.test.ts`

**RED**
- chat SSE: `tool_calls` deltas then `finish_reason: "tool_calls"` then `data: [DONE]`
- Responses (non-streaming and streaming): function-call item surfaced, function-call-output item
  accepted on continuation, same provider/model continues
- both surfaces produce identical tool ids, names and continuation semantics for the same exchange
- log `CHAT_RESPONSES_GENERIC_PARITY=PASS`

**Verify**
`npx vitest run tests/http/generic-client-surface-parity.test.ts tests/http/responses-function-call-output.test.ts tests/http/responses-function-call-stream.test.ts tests/http/streaming-tool-calls.test.ts`

---

### T2.7 — No-fallback guarantees under a generic identity

**Files**
- create `tests/http/generic-client-no-fallback.test.ts`

**RED**
- unknown model id → `400 unknown_model`, provider invocation count unchanged
- model id of a different provider than the one that is capable → no cross-provider substitution
- `CHAT_ONLY` model + tools → `400 unsupported_capability`
- a discovered-but-unverified model is never promoted to `CHAT_AND_TOOLS`
- PAYG env poisoning still refuses to start the runtime (existing `payg-guard`)
- log `NO_UNKNOWN_MODEL_FALLBACK=YES`, `NO_CROSS_PROVIDER_FALLBACK=YES`, `NO_PAYG_FALLBACK=YES`

**Verify**
`npx vitest run tests/http/generic-client-no-fallback.test.ts tests/security/payg-guard.test.ts`

---

### T2.8 — Compiled-process generic-client end-to-end proof

**Goal:** the strongest deterministic proof: real `dist/index.js`, real HTTP, a non-Qoder identity,
no external provider.

**Files**
- create `src/testing/scripted-tool-adapter.ts` (test-only double, enabled **only** by
  `CMM_TEST_PROVIDER=scripted-tools`)
- modify `src/index.ts` (`isTestProviderEnabled` allowlist)
- create `tests/http/dist-generic-client-e2e.test.ts`

**RED**
Boot the compiled process with:
- `CMM_CONFIG_DIR` temp config, `bearerSecretEnv` = a temp CMMChat env name
- `CMM_CODE_ROUTER_TOKEN` = a distinct temp value
- `CMM_TEST_PROVIDER=scripted-tools`
Then, over real HTTP with the Code Router bearer + `X-CMM-Client: generic-openai`:
- `GET /v1/models` shows the scripted `CHAT_AND_TOOLS` model
- full two-exchange round trip succeeds
- the same flow with the CMMChat bearer is rejected with `400`
- usage diagnostics record `profile: "code"`, `clientId: "generic-openai"`
- log `ACTUAL_DIST_GENERIC_CODE_ROUTER_E2E=PASS`

**GREEN**
Add the scripted tool double and gate it strictly: only the exact values `scripted` and
`scripted-tools` enable a test provider; production never sets either. Add a security-audit
assertion that the test-provider branch is reachable only through `CMM_TEST_PROVIDER`.

**Verify**
`npm run build && npx vitest run tests/http/dist-generic-client-e2e.test.ts tests/http/dist-process-boot.test.ts`

---

## 5. Phase 3 — Broker / provider neutrality

### T3.1 — Remove the client identity from the deferred tool broker

**Goal:** shared correlation infrastructure carries no client identity.

**Security argument (must be in the commit body):** the broker has no client-facing surface. Entries
are created only from inside provider adapters that already passed the HTTP profile/capability gate.
Every correlation, ACL, bound and cancellation decision uses provider/session/turn/tool-call
identity. The only read of `BrokerKey.consumer` is the hard refusal at
`src/core/deferred-tool-broker.ts:103-105`. Removing the field therefore removes a coupling without
removing a control. The controls that remain: HTTP profile gate (Phase 1), provider declared-tool
ACL, MCP bridge declared-tool ACL, public-id uniqueness, pending bound + TTL, abort cleanup.

**Files**
- modify `src/core/deferred-tool-broker.ts` (drop `consumer` from `BrokerKey` and the `:103-105`
  guard; update the doc comment)
- modify `src/providers/codex/adapter.ts:684-702`
- modify `src/providers/claude/adapter.ts` (broker key site)
- modify `src/providers/antigravity/adapter.ts` (broker key site)
- modify `tests/core/deferred-tool-broker.test.ts` and any test constructing `consumer: "qoder"`

**RED**
- the broker accepts a key with no client identity
- the source declares no `consumer` field; commit-level assertion:
  `!grep -q "consumer" src/core/deferred-tool-broker.ts`
- all existing broker behaviour is unchanged (composite key, public-id index, terminal
  classification, bound, TTL, cancellation, waiter rejection)

**GREEN**
Remove the field and guard; update the three adapter call sites.

**Verify**
`npx vitest run tests/core/deferred-tool-broker.test.ts tests/providers/deferred-tool-isolation.test.ts tests/providers/codex-broker-adversarial.test.ts tests/providers/bounded-pending-state.test.ts`

---

### T3.2 — Provider bridge neutrality audit and comment rewrite

**Goal:** no semantically required Qoder naming remains; wire identifiers stay untouched.

**Files**
- comments/doc-strings only in `src/providers/**`, `src/bridge/**`, `src/index.ts`,
  `src/http/server.ts`
- create `tests/integration/bridge-identifier-stability.test.ts`

**RED**
`tests/integration/bridge-identifier-stability.test.ts` asserts the Class 2 wire identifiers are
**unchanged** (`cmm-qoder-tools`, `cmm_qoder`, `mcp__cmm_qoder__`, `CMM_BRIDGE_SERVER_NAME`
default) while asserting the changed strings:
- `src/bridge/mcp-bridge-process.ts` tool description no longer says "Qoder-owned tool"
- `src/providers/claude/deferred-tools.ts` permission reason no longer says "Qoder owns execution"
- no comment in `src/core/` or `src/providers/` states that Qoder is the authorization identity

**GREEN**
Reword Class 3 comments/strings to "client-owned"/"consumer-owned". Do **not** rename wire
identifiers. Do not touch `docs/audits/**`.

**Verify**
`npx vitest run tests/integration/bridge-identifier-stability.test.ts tests/providers/antigravity-mcp-registration.test.ts tests/providers/claude-deferred-bridge.test.ts`

---

### T3.3 — Neutralize the Codex provider-facing naming

**Files**
- modify `src/providers/codex/adapter.ts`, `src/providers/codex/schema-translator.ts`
- modify `tests/providers/codex-dynamic-tool-declaration.test.ts` if it asserts comment text (it
  should not)

**RED**
- the Codex dynamic-tool declaration path is unchanged (tool specs, ACL, `success: true` only with
  an already-produced client result)
- `scripts/security-audit.sh` `PROVIDER_NATIVE_TOOL_EXECUTION=NONE` still passes

**GREEN**
Comments and internal variable naming only; no behaviour change.

**Verify**
`npx vitest run tests/providers/codex-dynamic-tool.test.ts tests/providers/codex-multistep-tool-loop.test.ts tests/providers/codex-same-turn-continuation.test.ts`

---

### T3.4 — Test-double marker neutrality

**Files**
- modify `src/testing/scripted-adapter.ts:39`
- modify `tests/http/dist-process-boot.test.ts` (marker assertion, if any)

**RED/GREEN**
Replace `QODER_SMOKE_OK scripted reply` with `CODE_ROUTER_SMOKE_OK scripted reply`; update the
compiled-process test. Do **not** rename the operator-facing `QODER_SMOKE_OK` marker used by
`scripts/qoder-smoke.sh` (Class 2).

**Verify**
`npx vitest run tests/http/dist-process-boot.test.ts tests/http/e2e.test.ts`

---

### T3.5 — Preserve provider-native execution prohibitions

**Files**
- modify `scripts/security-audit.sh` (additions only)

**RED/GREEN**
Add explicit checks so the client-agnostic refactor cannot weaken provider safety:
- Claude adapter still declares `disallowedTools` for Bash/Read/Write/Edit/WebFetch/WebSearch/Glob/
  Grep/NotebookEdit/ImageGen
- Antigravity still refuses `--dangerously-skip-permissions`
- Codex still declines native approvals
- MCP bridge still enforces `declaredTools.has(name)` and `MCP_INVALID_PARAMS`
- emit `PROVIDER_NATIVE_TOOL_EXECUTION=NONE` and `PROVIDER_NATIVE_REPO_MUTATION=NONE`

**Verify**
`bash scripts/security-audit.sh`

---

### T3.6 — Guard against cosmetic global rename

**Files**
- modify `scripts/security-audit.sh`

**RED/GREEN**
Add a check that the Class 2 identifiers still exist and that no `src/` file lost a required bridge
identifier. This is the mechanical enforcement of "no cosmetic global rename".

**Verify**
`bash scripts/security-audit.sh`

---

### T3.7 — Guard the Antigravity scoped MCP ACL (the most coupled control)

**Goal:** make the Qoder-named, persisted agy permission rule an explicit, protected coupling instead
of an implicit one.

**Files**
- modify `scripts/security-audit.sh`
- extend `tests/integration/antigravity-mcp-permission-provision.test.ts`

**RED**
- `scripts/macos/provision-antigravity-mcp-permission.mjs` still declares exactly
  `mcp(cmm-qoder-tools/*)` and still refuses `mcp(*)` and higher-precedence `ask`/`deny` conflicts
- the provisioner still emits `ANTIGRAVITY_GLOBAL_MCP_ALLOW_ADDED=NO`,
  `ANTIGRAVITY_COMMAND_WILDCARD_ADDED=NO`, `ANTIGRAVITY_WRITE_WILDCARD_ADDED=NO`,
  `ANTIGRAVITY_ASK_OR_DENY_MODIFIED=NO`
- security audit emits `ANTIGRAVITY_SCOPED_MCP_ACL_PRESERVED=PASS`
- a deliberate mutation that widens the rule to `mcp(*)` or `mcp(cmm-qoder-tools/*)` removal fails
  the audit

**GREEN**
Add the audit checks and the regression assertions. Document in the commit body that this rule is a
Class 2 compatibility identifier **and** an active security scope, so any future rename must migrate
registration and ACL together and must never widen.

**Verify**
`npx vitest run tests/integration/antigravity-mcp-permission-provision.test.ts && bash scripts/security-audit.sh`

---

### T3.8 — Harden the Codex continuation ACL against mid-loop widening

**Goal:** close the theoretical ACL re-derivation path (A13).

**Files**
- modify `src/providers/codex/adapter.ts:324-326`
- extend `tests/providers/codex-broker-adversarial.test.ts` or `codex-multistep-tool-loop.test.ts`

**RED**
- a continuation that removes a previously declared tool from its `tools` array must **not** be able
  to widen the thread ACL
- a continuation after ACL eviction borrows the ACL captured at `thread/start` rather than the
  continuation's own `tools` array; if no captured ACL exists, the continuation fails closed
- the existing same-turn and multi-step Codex paths are unchanged

**GREEN**
Replace the `?? new Set(request.tools…)` fallback with a fail-closed path, or derive the ACL only
from the original parked entry. Confirmed by the security-audit
`CODEX_UNDECLARED_DYNAMIC_TOOL_FAIL_CLOSED=PASS` marker.

**Verify**
`npx vitest run tests/providers/codex-multistep-tool-loop.test.ts tests/providers/codex-broker-adversarial.test.ts tests/providers/codex-dynamic-tool-declaration.test.ts`

---

### T3.9 — Neutralize audit-script exemption tokens and reconcile the wire provider list

**Goal:** remove accidental audit-script coupling (A12) and the latent provider-list inconsistency
(A14).

**Files**
- modify `scripts/security-audit.sh:99-104,135-143`
- modify `src/core/wire.ts:111-117`
- extend `tests/core/wire.test.ts`

**RED**
- the Codex `success: true` exemption no longer depends on the literal `Qoder` substring but on a
  neutral, explicit token set that still fails closed for an unexplained `success: true`
- a neutral alias marker `CODEX_CLIENT_TOOL_DEFINITIONS_SENT=PASS` is emitted; the legacy
  `CODEX_QODER_TOOL_DEFINITIONS_SENT=PASS` marker is retained for evidence continuity
- `parseRequestEnvelope` accepts `cavoti` consistently with `ProviderId`
- an unknown provider is still rejected

**GREEN**
Rewrite the exemption to match the actual invariant (a `success: true` response is only valid on the
already-produced-result path), not a client name. Add `cavoti` to the wire allowlist.

**Verify**
`npx vitest run tests/core/wire.test.ts && bash scripts/security-audit.sh`

---

## 6. Phase 4 — Client adapters / compatibility

### T4.1 — Qoder compatibility contract (deterministic)

**Files**
- create `tests/http/qoder-code-router-compat.test.ts`

**RED**
- legacy Qoder bearer + capable model + tools → full round trip →
  `QODER_CODE_ROUTER=PASS`
- canonical Code Router bearer with `X-CMM-Client: qoder` → identical behaviour
- Qoder model reconciliation is untouched: `scripts/qoder/reconcile-qoder-provider.mjs` still
  preserves unmanaged tail models (existing behaviour, characterization assertions only)
- no Qoder bearer configured → nothing can obtain tools

**Verify**
`npx vitest run tests/http/qoder-code-router-compat.test.ts tests/integration/qoder-*.test.ts`

---

### T4.2 — Hermes readiness contract (Router side only)

**Files**
- create `tests/http/hermes-code-router-readiness.test.ts`
- create `docs/code-router-clients.md` (Hermes section; shared with T4.3)

**RED**
Deterministic Router-side assertions with `X-CMM-Client: hermes`:
- model discovery (`GET /v1/models`) returns namespaced ids and `x_cmm.code_router`
- non-streaming chat, streaming chat (SSE ending `data: [DONE]`)
- tool declaration → tool call surfaced → client result submitted → same provider/model continues
- `tool_choice` (`auto|none|required|named`) and `parallel_tool_calls` accepted only where the
  provider represents them, rejected otherwise (no silent drop)
- log `HERMES_CODE_ROUTER_READINESS=PASS` (explicitly labelled Router-side only)

**Explicitly NOT claimed by this task** (deferred to T7.2): real Hermes custom base-URL/provider
configuration, real model discovery behaviour, whether Hermes uses Chat Completions or Responses,
streaming expectations, Hermes' tool schema, tool-result continuation, any client-specific headers
or model-naming constraints. Mocked OpenAI-shaped requests are not Hermes compatibility evidence.

**Verify**
`npx vitest run tests/http/hermes-code-router-readiness.test.ts`

---

### T4.3 — Codex-as-client readiness contract (separate from Codex-as-provider)

**Files**
- create `tests/http/codex-client-readiness.test.ts`
- extend `docs/code-router-clients.md` (Codex section)

**RED**
- `ProviderId` remains `chatgpt` for the upstream Codex route; the downstream client identifier is
  `codex-client` — assert no code path conflates them (e.g. `normalizeClientId("codex-client")`
  returns `codex-client` and the `chatgpt` provider namespace is unchanged)
- deterministic Router-side round trip with `X-CMM-Client: codex-client` on both surfaces
- log `CODEX_CLIENT_CODE_ROUTER_READINESS=PASS` (Router-side only)

**Explicitly NOT claimed by this task** (deferred to T7.3): real Codex `config.toml` custom-provider
support, `wire_api` values, `env_key`, model naming, tool-calling behaviour against a custom base URL.

**Verify**
`npx vitest run tests/http/codex-client-readiness.test.ts`

---

### T4.4 — Generic OpenAI-compatible client contract documentation

**Files**
- create `docs/code-router-setup.md` (generic onboarding: base URL, bearer, models, chat, tools,
  continuation, cancellation)
- create `tests/integration/code-router-docs-contract.test.ts`

**RED**
Documentation contract test asserting the doc states:
- `GET /v1/models`, `POST /v1/chat/completions`, `POST /v1/responses`
- the Code Router bearer environment variable name (never a value)
- the `X-CMM-Client` header is optional diagnostics and cannot change capability
- tool continuation is standard OpenAI (`role:"tool"` + `tool_call_id`; assistant `tool_calls`
  history), and no Router-private correlation field is required
- for Codex/Claude/Antigravity a continuation must return to the **same live Router process** while
  the provider turn is parked (the broker is in-memory); this is stated as a client contract, not
  hidden
- no PAYG / cross-provider / unknown-model fallback
- log `CODE_ROUTER_DOCS_CONTRACT=PASS`

**Verify**
`npx vitest run tests/integration/code-router-docs-contract.test.ts`

---

### T4.5 — Compatibility matrix documentation

**Files**
- modify `README.md` (Supported clients + legacy identifiers table)
- extend `docs/code-router-clients.md`

**Content**
- Qoder: supported; legacy bearer accepted; real gate pending (T7.1)
- Hermes: Router-side contract proven; real client gate pending (T7.2)
- Codex client: Router-side contract proven; real client gate pending (T7.3)
- generic OpenAI-compatible: deterministic proof complete (T2.3/T2.4/T2.8)
- Add the new identifiers to the legacy/naming table, distinguishing **new canonical** from
  **legacy compatibility** rows.

**Verify**
`npx vitest run tests/integration/cmm-routers-branding.test.ts` (extend if it asserts the table)

---

### T4.6 — Client adapter boundary discipline test

**Files**
- create `tests/integration/client-identity-boundary.test.ts`

**RED**
- `RouterRequest` carries no `clientId`/`profile`/`consumer` field (source assertion)
- no provider adapter reads any client identifier
- `effectiveProfileToolCapability` is the only capability decision on the HTTP surfaces
- log `CLIENT_IDENTITY_NOT_AUTHORIZATION=PASS`

**Verify**
`npx vitest run tests/integration/client-identity-boundary.test.ts`

---

## 7. Phase 5 — Documentation / install / migration

### T5.1 — `.env.example` and config documentation

**Files**
- modify `.env.example`
- modify `tests/config/env-example.test.ts`

**RED/GREEN**
Add `CMM_CODE_ROUTER_TOKEN=` (name only, no value) with a comment stating: canonical Code Router
bearer; when `CMM_QODER_TOKEN` is also set, both authenticate the CODE profile; neither ever
authenticates CMMChat. Keep `CMM_QODER_TOKEN` documented as the legacy compatibility path.

**Verify**
`npx vitest run tests/config/env-example.test.ts`

---

### T5.2 — launchd plist: additive Code Router Keychain identifiers

**Files**
- modify `launchd/com.cmm.subscription-router.plist.template`
- modify `tests/integration/launchagent.test.ts`

**RED/GREEN**
Add (identifiers only, never values):
`CMM_CODE_ROUTER_KEYCHAIN_SERVICE=cmm-subscription-router`,
`CMM_CODE_ROUTER_KEYCHAIN_ACCOUNT=code-router-bearer`.
Keep every existing key, including `CMM_QODER_KEYCHAIN_*`, untouched.

**Verify**
`npx vitest run tests/integration/launchagent.test.ts`

---

### T5.3 — `run-router.sh`: resolve the canonical Code Router bearer, keep legacy

**Files**
- modify `scripts/macos/run-router.sh`
- modify `tests/integration/launchd-deterministic.test.ts` / `launchd-fail-closed.test.ts` as needed

**RED**
- when `CMM_CODE_ROUTER_TOKEN` is unset, read it from the configured Keychain pair and export it
- when `CMM_QODER_TOKEN` is unset, keep the existing legacy Keychain resolution unchanged
- the final fail-closed check still requires only the CMMChat bearer
- neither value is echoed or written to disk; no code→cmmchat fallback exists
- log `CODE_ROUTER_BEARER_RUNTIME_LOOKUP=PASS`

**Verify**
`npx vitest run tests/integration/launchd-deterministic.test.ts tests/integration/launchd-fail-closed.test.ts tests/integration/qoder-bearer-provisioning.test.ts`

---

### T5.4 — `install-router.sh`: report Code Router bearer provisioning idempotently

**Files**
- modify `scripts/macos/install-router.sh`
- modify `tests/integration/qoder-bearer-provisioning.test.ts` (extend, do not replace)

**RED/GREEN**
Add an idempotent report block for `code-router-bearer` mirroring the existing `qoder-bearer` block:
detect with `security find-generic-password`, leave an existing item untouched, print the
`security add-generic-password` command, never print or store a value. Keep the Qoder block.

**Verify**
`npx vitest run tests/integration/qoder-bearer-provisioning.test.ts tests/integration/launchagent.test.ts`

---

### T5.5 — `docs/macos-install.md`: dual provisioning instructions

**Files**
- modify `docs/macos-install.md`
- extend `tests/integration/qoder-bearer-provisioning.test.ts`

**RED/GREEN**
Document both Keychain items, the canonical-first recommendation, the legacy compatibility note, and
the fact that renaming the legacy service/account is out of scope.

**Verify**
`npx vitest run tests/integration/qoder-bearer-provisioning.test.ts`

---

### T5.6 — Fix the smoke-test bearer inconsistency (A6)

**Files**
- create `scripts/code-router-smoke.sh`
- modify `scripts/qoder-smoke.sh` (document its actual CMMChat/`CHAT_ONLY` scope; keep it working)
- create `tests/integration/code-router-smoke-contract.test.ts`

**RED**
`scripts/code-router-smoke.sh` must:
- require the Code Router bearer (canonical or legacy), and explicitly refuse to fall back to the
  CMMChat bearer (mirroring `canary-driver.ts:318-321`)
- exercise `/health`, `/v1/models` (including `x_cmm.code_router`), non-streaming chat, streaming
  chat with `data: [DONE]`, `/v1/responses`, and real cancellation observed through
  `/v1/cmm/usage`
- never print the token
- log `CODE_ROUTER_SMOKE=PASS`

`scripts/qoder-smoke.sh` keeps its current behaviour but its header documents that it authenticates
as CMMChat and proves chat surfaces only.

**Verify**
`npx vitest run tests/integration/code-router-smoke-contract.test.ts` plus a manual run against a
locally started Router (no provider inference required beyond normal chat).

---

### T5.7 — Compatibility-window documentation

**Files**
- create `docs/code-router-migration.md`
- create `tests/integration/code-router-migration-doc.test.ts`

**Content**
- both bearers are accepted and both map to the same profile
- the legacy bearer default client id is `qoder`; the canonical bearer default is `generic-openai`
- collision of the CMMChat secret with either Code Router secret is a startup failure
- removal criteria and that removal is a separate, future change
- explicit statement that no legacy identifier is deleted by this work

**Verify**
`npx vitest run tests/integration/code-router-migration-doc.test.ts`

---

### T5.8 — README naming and roadmap truth

**Files**
- modify `README.md`

**Content**
- add canonical rows (`CMM_CODE_ROUTER_TOKEN`, `code-router-bearer`,
  `CMM_CODE_ROUTER_KEYCHAIN_*`) clearly marked as current
- keep legacy rows marked as retained compatibility identifiers
- keep the pre-stable roadmap and list the still-open gates (§0.4) unchanged in status
- do not claim Hermes/Codex real-client support anywhere

**Verify**
`npx vitest run tests/integration/cmm-routers-branding.test.ts`

---

### T5.9 — Surface the Code Router bearer in preflight (names and presence only)

**Files**
- modify `scripts/preflight.sh`
- modify `scripts/validate-config.mjs` (consume the `BEARER_SECRET_ENV` it already emits)
- extend `tests/integration/preflight*.test.ts`

**RED**
- preflight reports whether the canonical Code Router bearer is present (canonical or legacy), never
  the value
- preflight reports the CMMChat bearer presence, which it currently does not check at all
- absence of the canonical bearer is informational, not fatal (existing installs must still start)
- log `PREFLIGHT_CODE_ROUTER_BEARER=<present|legacy-only|absent>` and
  `PREFLIGHT_SECRET_VALUES_PRINTED=NONE`

**GREEN**
Implement a presence-only check. Never echo, hash-print or length-print a secret.

**Verify**
`npx vitest run tests/integration/preflight.test.ts tests/integration/preflight-config.test.ts tests/integration/preflight-failclosed.test.ts`

---

### T5.10 — Record current capability truth (do not rewrite history)

**Files**
- create `docs/code-router-capability-status.md`
- create `tests/integration/capability-status-doc.test.ts`

**Content (must be truthful, not optimistic)**
- per provider/model: `CHAT_ONLY` vs `CHAT_AND_TOOLS`, with the deterministic evidence and the
  real-client gate status
- explicitly qualify the Google/Antigravity claim: deterministic single-step support is proven,
  multi-step and GPT-OSS remain open, so `docs/qoder-acceptance.md:23` must be reconciled in a new
  document rather than by editing historical evidence
- reconcile the Codex status: `docs/task-14-codex-post-tool-continuation.md` records an authorized
  live PASS on 2026-09-11 while `README.md:190` still lists revalidation as open — state both facts
- list Task 16 / 16B as blockers with their unmet dependencies (§0.3)
- assert the doc contains no unconditional "proven" claim for a real client that has not passed T7.x
- log `CAPABILITY_STATUS_TRUTHFUL=PASS`

**Verify**
`npx vitest run tests/integration/capability-status-doc.test.ts`

---

## 8. Phase 6 — Verification

### T6.1 — Focused per-phase test passes

Run after each phase; record the exact command and result in the phase commit body.

```bash
npx vitest run tests/core/router-profile.test.ts tests/core/consumer-capability-compat.test.ts
npx vitest run tests/http/identity-resolution.test.ts tests/http/code-router-profile.test.ts
npx vitest run tests/http/generic-code-router-client.test.ts tests/http/generic-client-broker-roundtrip.test.ts
npx vitest run tests/http/generic-client-cancellation.test.ts tests/http/generic-client-surface-parity.test.ts
npx vitest run tests/http/generic-client-no-fallback.test.ts tests/integration/legacy-code-router-compat.test.ts
```

### T6.2 — Full deterministic suite and build

```bash
npx vitest run
npm run typecheck
npm run build
```

No live provider canary and no quota-consuming inference may run as part of this phase.

### T6.3 — Security audit markers

`bash scripts/security-audit.sh` must emit, at minimum:

```text
CMMCHAT_CHAT_ONLY=PASS
CMM_CODE_ROUTER_PROFILE=CHAT_AND_TOOLS
CMM_CODE_ROUTER_CLIENT_AGNOSTIC=YES
CLIENT_IDENTITY_NOT_AUTHORIZATION=PASS
CLIENT_OWNS_TOOLS=YES
PROVIDER_NATIVE_TOOL_EXECUTION=NONE
PROVIDER_NATIVE_REPO_MUTATION=NONE
NO_PAYG_FALLBACK=YES
NO_CROSS_PROVIDER_FALLBACK=YES
NO_UNKNOWN_MODEL_FALLBACK=YES
LOOPBACK_ONLY=YES
TRACKED_SECRETS=NONE
SECURITY_AUDIT=PASS
```

### T6.4 — Log-hygiene and redaction regression

```bash
npx vitest run tests/security/log-hygiene.test.ts tests/security/redaction.test.ts tests/security/bearer-auth.test.ts
```

Add assertions that neither bearer value nor the raw `X-CMM-Client` value can appear in any log or
diagnostic sink.

### T6.5 — Invariant proof test

Files: create `tests/integration/code-router-invariants.test.ts`.

Assert end to end, deterministically:
- CMMChat never obtains tools on any provider capability
- CODE never obtains tools on a `CHAT_ONLY` provider/model
- classification of tools/no-tools depends only on `(profile, providerCapability, protocol)`
- no path falls back to another provider, another model, or a PAYG route
- no provider adapter can be reached with an unauthenticated request

### T6.6 — Scope verification

```bash
git status --short
git diff --check
```

Confirm only the planned files changed, no `docs/audits/**` edits, no tracked secrets, and no
unintended renames of Class 2 identifiers.

### T6.7 — Repair the vacuous capability test and reconcile the Codex channel contradiction

**Files**
- modify `tests/providers/capability-truthfulness.test.ts:25-41`
- modify `tests/providers/codex-dynamic-tool.test.ts:97-101` and/or
  `tests/providers/codex-dynamic-tool-declaration.test.ts:189-221`

**RED**
- the capability truthfulness test makes a real assertion (every production adapter's discovered
  models report only `CHAT_ONLY` or `CHAT_AND_TOOLS`, and a `cavoti`-style pinned provider is not
  silently promoted) instead of `void adapters;`
- the two Codex tests no longer assert contradictory statements; whichever reflects the verified
  0.153.4 experimental schema (the `dynamicTools` declaration with `experimentalApi: true`) becomes
  the single source, and the other is corrected or removed with a comment citing the fixture
- security audit `CODEX_EXPERIMENTAL_API_OPT_IN=PASS` and
  `CODEX_UNDECLARED_DYNAMIC_TOOL_FAIL_CLOSED=PASS` still hold

**GREEN**
Fix the assertions; do not change provider behaviour to satisfy a test.

**Verify**
`npx vitest run tests/providers/capability-truthfulness.test.ts tests/providers/codex-dynamic-tool.test.ts tests/providers/codex-dynamic-tool-declaration.test.ts`

### T6.8 — Record residual provider risks in closure evidence

**Files**
- extend the Phase 6 closure evidence document (created under `docs/`, not `docs/audits/`)

Record, without weakening any gate:
- Claude SDK `allowedTools` semantics unverified (§0.6.1) and the denylist-only barrier
- Antigravity scoped-ACL dependency (§0.6.2)
- in-memory broker / same-process continuation requirement (§0.6.3)
- Command Code / Cavoti self-referential ACL (§0.6.4)
- "no live inference was run during Phases 1–6"

Evidence marker: `RESIDUAL_PROVIDER_RISKS_RECORDED=PASS`.

---

## 9. Phase 7 — Real-client gates (require the real installed clients)

These gates are **not** satisfiable by deterministic tests and **not** satisfiable by mocked
OpenAI-shaped requests. Each requires the real client, an explicit human go-ahead, and a harmless
canary. None may consume quota without explicit gating. None is claimed as passing by this plan.

### T7.1 — Real Qoder gate

- Re-point or verify the existing `qoder-custom-cmm-router` provider against the Router.
- Authenticate with the canonical Code Router bearer (legacy bearer also acceptable during the
  window).
- Prove: model discovery, ordinary chat, tool declaration, Qoder-owned execution with a harmless
  echo/nonce tool, structured result continuation, same-session provider continuation, terminal
  answer derived from the nonce.
- Prove no PAYG and no provider/model substitution.
- Marker: `QODER_CODE_ROUTER=PASS` only after all of the above.
- Also verify the model reconciliation script still preserves unmanaged models after any metadata
  refresh.
- Multi-Mac (Task 16B) remains blocked on Task 16 capability truth (§0.3) and is out of scope.

### T7.2 — Real Hermes gate

Verify against the installed Hermes client, not a mock:
- custom base URL / provider configuration mechanism
- model discovery behaviour against `GET /v1/models` (including unknown `x_cmm`)
- Chat Completions vs Responses usage
- streaming expectations and `[DONE]` handling
- tool schema shape accepted
- tool-result continuation (`role:"tool"` + `tool_call_id`, assistant `tool_calls` history)
- any client-specific headers or model-naming constraints
- Marker: `HERMES_CODE_ROUTER=PASS` only after a real harmless tool round trip.

### T7.3 — Real Codex-client gate

Keep the two identities separate:
- upstream provider route: `chatgpt/*` via the Codex adapter (already exercised deterministically)
- downstream client: `codex-client`

Verify against the installed Codex client's actual custom-provider/base-URL mechanism (for example a
`model_providers`-style entry with the supported wire API and environment key) before claiming
support. Do not promote behaviour observed from mocked OpenAI requests.
- Marker: `CODEX_CLIENT_CODE_ROUTER=PASS` only after a real harmless tool round trip.

### T7.4 — Generic OpenAI-compatible real client (non-Qoder)

Run at least one real, independently installed generic OpenAI-compatible client against the Code
Router bearer to confirm the deterministic proof transfers.
- Marker: `GENERIC_OPENAI_REAL_CLIENT=PASS`.

### T7.5 — Final real-client gate

All of the above, plus the open pre-stable provider items (§10), before
`CODE_ROUTER_REAL_CLIENT_GATE=PASS`.

---

## 10. Pre-stable compatibility integration (still open)

This plan **does not close** these; it records status and avoids making them harder.

| Item | Current state at audited HEAD | Effect of this plan |
|---|---|---|
| Google/Antigravity GPT-OSS tool compatibility | Open. Deterministic single-step support is proven; multi-step and GPT-OSS are **not** (`docs/audits/2026-09-10-task13-mcp-hardening-reaudit-516ccdd.md:831,868,872`). `docs/qoder-acceptance.md:23` overstates this by claiming `google/*` `CHAT_AND_TOOLS` "Proven" with no carve-out (A18) | No behaviour change; Phase 3 must not alter the agy bridge, MCP names or the scoped ACL (T3.7). Truth corrected in a new document (T5.10) |
| Sonnet real Qoder tools | Open. Not documented as a distinct item anywhere; `claude/*` is claimed from earlier authorized runs while audits mark live reproof pending | T7.1; truthful status in T5.10 |
| ChatGPT/Codex revalidation when quota permits | Open at roadmap level (`README.md:190`) **and** claimed closed by an authorized live PASS on 2026-09-11 (`docs/task-14-codex-post-tool-continuation.md:5,13-30`). Both facts are true and both must be stated | T7.1–T7.3; deterministic paths re-run in T6.2; contradiction reconciled in T5.10 |
| Command Code live completion when enabled | Open (`docs/task-15-command-code-live-enablement.md:5`); disabled by default; human spend decision required | No change; remains a PAYG-acknowledged, explicitly enabled provider |
| Task 16 capability truth (`x_cmm`, `runtimeCapabilities`) | **Unimplemented** at this HEAD | T2.1 adds only `x_cmm.code_router` additively; the Task 16 schema remains open and must extend, not replace, the namespace |
| Task 16B multi-Mac Qoder sync | Blocked on Task 16, on the reconciler consuming `x_cmm` (it does not), and on a second machine | Explicitly out of scope; dependencies recorded |
| Historical audit evidence | 26 files, all dated 2026-09-09/09-10, entirely pre-Task-16; the latest authoritative verdict is a narrow PASS (`docs/audits/2026-09-10-independent-task13-narrow-remediation-reaudit-54715cf.md:12`) | Read-only; never rewritten. New markers are added, not substituted |
| Final real-client gate | Open | T7.5 |

**Do not** add rigid model layouts, client-specific model lists, or Qoder-owned canonical model
state. `scripts/qoder/reconcile-qoder-provider.mjs` (hard-coded 25-slot `LAYOUT`) is the Dynamic
Catalog workstream's problem and must not be extended or depended upon here.

---

## 11. Test strategy matrix (RED/GREEN per required behaviour)

| Required behaviour | Test file (new unless noted) | Evidence marker |
|---|---|---|
| Code profile gets tools on a capable provider | `tests/http/code-router-profile.test.ts` | `CMM_CODE_ROUTER_PROFILE=CHAT_AND_TOOLS` |
| Arbitrary/generic client gets tools without pretending to be Qoder | `tests/http/generic-code-router-client.test.ts` | `GENERIC_OPENAI_CODE_ROUTER=PASS` |
| Generic client uses the production broker safely | `tests/http/generic-client-broker-roundtrip.test.ts` | `CMM_CODE_ROUTER_CLIENT_AGNOSTIC=YES` |
| Qoder still works | `tests/http/qoder-code-router-compat.test.ts` | `QODER_CODE_ROUTER_SIDE=PASS` |
| Legacy Qoder bearer still works | `tests/http/identity-resolution.test.ts` (+ compat lock) | `LEGACY_QODER_BEARER_STILL_AUTHENTICATES_CODE=PASS` |
| CMMChat bearer never gets tools | `tests/http/code-router-profile.test.ts`, `tests/http/chat-only-enforcement.test.ts` | `CMMCHAT_CHAT_ONLY=PASS` |
| `CHAT_ONLY` provider stays `CHAT_ONLY` for Code Router | `tests/http/code-router-profile.test.ts` | `CHAT_ONLY_PROVIDER_STAYS_CHAT_ONLY=PASS` |
| Missing Code bearer fails closed | `tests/http/code-router-profile.test.ts` | `MISSING_CODE_BEARER_FAILS_CLOSED=PASS` |
| Bad/ambiguous auth fails closed | `tests/http/identity-resolution.test.ts` | `AMBIGUOUS_AUTH_FAILS_CLOSED=PASS` |
| Client metadata cannot elevate | `tests/http/code-router-profile.test.ts`, `tests/http/client-identity-diagnostics.test.ts` | `CLIENT_CAPABILITY_SPOOFING=NONE` |
| No model/provider fallback | `tests/http/generic-client-no-fallback.test.ts` | `NO_UNKNOWN_MODEL_FALLBACK=YES` etc. |
| Tool result bound to the correct request/session/turn | `tests/core/deferred-tool-broker.test.ts`, `tests/providers/deferred-tool-isolation.test.ts`, `tests/http/generic-client-cancellation.test.ts` | `TOOL_RESULT_CORRELATION_BOUND=PASS` |
| Cancellation cleans pending state | `tests/http/generic-client-cancellation.test.ts` | `CANCELLATION_CLEANS_PENDING_STATE=PASS` |
| Generic two-step and multi-step round trip | `tests/http/generic-code-router-client.test.ts` | `HTTP_ROUNDTRIP_TOOL_CALL_SURFACED=PASS` |
| Chat Completions / Responses parity | `tests/http/generic-client-surface-parity.test.ts` | `CHAT_RESPONSES_GENERIC_PARITY=PASS` |
| Compiled-process generic E2E | `tests/http/dist-generic-client-e2e.test.ts` | `ACTUAL_DIST_GENERIC_CODE_ROUTER_E2E=PASS` |
| Client identity is not authorization | `tests/integration/client-identity-boundary.test.ts` | `CLIENT_IDENTITY_NOT_AUTHORIZATION=PASS` |
| Legacy identifiers preserved | `tests/integration/legacy-code-router-compat.test.ts`, `tests/integration/bridge-identifier-stability.test.ts` | `LEGACY_COMPAT_IDENTIFIERS_PRESERVED=PASS` |
| Capability publication truthful | `tests/http/models-capability-publication.test.ts` | `MODEL_CAPABILITY_TRUTHFULNESS=PASS` |
| Antigravity scoped MCP ACL preserved | `tests/integration/antigravity-mcp-permission-provision.test.ts` + audit | `ANTIGRAVITY_SCOPED_MCP_ACL_PRESERVED=PASS` |
| Codex continuation ACL cannot widen | `tests/providers/codex-broker-adversarial.test.ts` | `CODEX_CONTINUATION_ACL_NO_WIDENING=PASS` |
| Preflight reports bearer presence only | `tests/integration/preflight.test.ts` | `PREFLIGHT_SECRET_VALUES_PRINTED=NONE` |
| Capability status document is truthful | `tests/integration/capability-status-doc.test.ts` | `CAPABILITY_STATUS_TRUTHFUL=PASS` |
| Residual provider risks recorded | Phase 6 closure evidence | `RESIDUAL_PROVIDER_RISKS_RECORDED=PASS` |

---

## 12. Security gates / evidence markers

Closure evidence for this workstream must include at least:

```text
CMMCHAT_CHAT_ONLY=PASS
CMM_CODE_ROUTER_PROFILE=CHAT_AND_TOOLS
CMM_CODE_ROUTER_CLIENT_AGNOSTIC=YES
CLIENT_IDENTITY_NOT_AUTHORIZATION=PASS
CLIENT_OWNS_TOOLS=YES
PROVIDER_NATIVE_TOOL_EXECUTION=NONE
PROVIDER_NATIVE_REPO_MUTATION=NONE
NO_PAYG_FALLBACK=YES
NO_CROSS_PROVIDER_FALLBACK=YES
NO_UNKNOWN_MODEL_FALLBACK=YES
LOOPBACK_ONLY=YES
TRACKED_SECRETS=NONE
MODEL_CAPABILITY_TRUTHFULNESS=PASS
LEGACY_COMPAT_IDENTIFIERS_PRESERVED=PASS
ANTIGRAVITY_SCOPED_MCP_ACL_PRESERVED=PASS
CODEX_CONTINUATION_ACL_NO_WIDENING=PASS
PREFLIGHT_SECRET_VALUES_PRINTED=NONE
CAPABILITY_STATUS_TRUTHFUL=PASS
RESIDUAL_PROVIDER_RISKS_RECORDED=PASS
SECURITY_AUDIT=PASS
```

Real-client markers are produced only by Phase 7 and must never be emitted by deterministic tests:

```text
QODER_CODE_ROUTER=PASS
HERMES_CODE_ROUTER=PASS
CODEX_CLIENT_CODE_ROUTER=PASS
GENERIC_OPENAI_CODE_ROUTER=PASS
CODE_ROUTER_REAL_CLIENT_GATE=PASS
```

Any combination that cannot prove the complete round trip is reported as unsupported or pending —
never silently downgraded, never marked passing.

---

## 13. Plan quality gate (run before committing this plan)

1. Every task compared against the frozen design (§1–§19) — covered by the phase mapping in §3–§9.
2. No task folds in Dynamic Provider Catalog Reconciliation, Task 16 full capability truth, Task 16B
   or the local path migration — see §2 non-goals and §10.
3. Every behaviour change names its tests — see §11.
4. Migration is backward compatible for existing Qoder installs — T1.2, T1.4, T1.7, T5.2–T5.5.
5. Real-client claims separated from deterministic Router tests — §9 vs §11/§12.
6. No required live inference in Phases 1–6 — §8; only Phase 7 is gated.
7. Every audit finding A1–A18 in §0.5 maps to a task or an explicit non-goal; every §0.6 residual
   risk is either guarded (T3.5, T3.7, T4.6) or recorded (T6.8).
8. No task requires rewriting `docs/audits/**`; new markers are additive (T3.9, T5.10).
9. `git diff --check` clean.
10. Only the plan document under `docs/superpowers/plans/` is modified in this commit.

### Audit-finding → task traceability

| Finding | Covered by |
|---|---|
| A1, A2, A3, A4 | T1.1–T1.5, T3.1 |
| A5 | T2.1 |
| A6 | T5.6 |
| A7 | T2.1 (minimal, fenced), §10 |
| A8 | §2 non-goals, §10 |
| A9 | T2.2, T4.4 |
| A10 | T2.3, T2.4, T2.8 |
| A11 | T3.7 |
| A12 | T3.9 |
| A13 | T3.8 |
| A14 | T3.9 |
| A15, A16 | T6.7 |
| A17 | T5.9 |
| A18 | T5.10 |

Commit (plan only):

```bash
git add docs/superpowers/plans/2026-09-21-cmm-code-router-client-agnostic-implementation-plan.md
git commit -m "docs: plan client-agnostic CMM Code Router completion"
```

Do not begin implementation after committing this plan. Stop for human review.

---

## 14. Task/phase summary

| Phase | Tasks | Focus |
|---|---|---|
| 1 — Profile/client separation | T1.1–T1.7 (7) | Types, auth model, compatibility aliases, capability policy, tests |
| 2 — Canonical Code Router protocol | T2.1–T2.8 (8) | Client-neutral HTTP/tool-roundtrip contract, deterministic generic proof |
| 3 — Broker/provider neutrality | T3.1–T3.9 (9) | Remove semantic coupling, preserve wire aliases, native-execution bans and the scoped agy ACL |
| 4 — Client adapters/compatibility | T4.1–T4.6 (6) | Qoder, Hermes, Codex-client, generic — Router-side contracts |
| 5 — Documentation/install/migration | T5.1–T5.10 (10) | New bearer, legacy compatibility, setup, preflight visibility and truthful status |
| 6 — Verification | T6.1–T6.8 (8) | Focused tests, full suite, build, typecheck, security audit, invariants, test repairs |
| 7 — Real-client gates | T7.1–T7.5 (5) | Qoder, Hermes, Codex-client, generic real clients (gated) |

**53 tasks across 7 phases.** Phases 1–6 are deterministic and require no live inference. Phase 7 is
manual, gated, and explicitly not satisfied by this plan.
