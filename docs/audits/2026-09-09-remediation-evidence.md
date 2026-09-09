# CMM Subscription Router — Remediation Evidence (2026-09-09)

Follow-up to `docs/audits/2026-09-09-independent-audit-4b0c21d.md`
(`AUDITED_HEAD=4b0c21d`, verdict FAIL). This report is remediation
evidence, not an independent audit. A fresh human audit is still required.

Targeted findings: B1–B10 (closure blockers) and M1–M10 (major/minor).
Live quota was not burned: all verification below is unit/contract,
composition with fakes, shell-level script probes, and build checks.

## Heads

- Audit baseline: `4b0c21d`
- Remediation range: `be20de9..37686a3` (19 commits, see `git log`)
- Tree state: clean (`git status --short` empty at report time)

## Remediation commits

- `a30b9be` fix: make bearer authentication ESM-safe
- `b8c96d0` fix: restore concurrent Claude environment isolation
- `a4f2ecf` fix: wire providers into production composition root
- `ca5dae7` fix: enforce Antigravity account-only spending gate
- `a61894a` fix: repair macOS service installer paths
- `ee889a9` fix: remove provider content from runtime logs
- `2166b1c` fix: make provider streaming truly incremental
- `d2a30d1` fix: enforce Command Code entitlement visibility
- `710623e` fix: stream Command Code responses incrementally on both wires
- `6e52709` fix: make production entrypoint ESM-safe with regression test
- `c5a023d` fix: make preflight fail closed on unsafe spending state
- `62a5ef8` fix: wire UsageStore into production chat and responses traffic
- `c90f101` fix: compose Command Code client timeout with caller cancellation
- `fd89dd0` fix: tear down provider runs on mid-stream client disconnect
- `6288448` fix: bootstrap missing shared config and wire provider options
- `4b78d9d` fix: clean up Antigravity per-request temp directories
- `8c17636` fix: close security-audit blind spots from independent audit
- `8d174f5` fix: harden Qoder smoke to cover streaming, responses, marker proof
- `37686a3` test: pin Codex finish-reason normalization contract

## Finding-by-finding evidence

- B1 (empty production entrypoint): `src/index.ts`
  `createProductionRegistry()` registers chatgpt/claude/google from config
  and command-code only with valid spend ack + secret env. Covered by
  `tests/http/production-composition.test.ts` (3+ providers, ack skip,
  disabled-provider, `/v1/models`, `/ready`).
- B2 (bearer `require` in ESM): `src/security/bearer-auth.ts` uses a static
  `node:crypto` import; `src/index.ts` no longer `require()`s the spend
  guard (static import instead). Covered by
  `tests/security/bearer-auth.test.ts` (no-`require` source assertion) and
  `tests/http/production-entrypoint-esm.test.ts` (src + dist have no
  `require(`). Verified: `npm run build` + `DIST_ESM_OK` dist import probe.
- B3 (Claude global env mutation): adapter performs zero `process.env`
  writes (source-scan test) and passes `options.env` from
  `buildIsolatedEnvironment()`. Covered by
  `tests/providers/claude-concurrency.test.ts` (host env unchanged,
  per-request isolation, zero-write source scan).
- B4 (Antigravity settings not enforced): `enforceAccountOnlySettings()`
  runs at the top of `discoverModels()` and `run()`, failing closed on
  `modelProvider=gemini` / `useG1Credits=true`. Covered by spending-gate
  tests in `tests/providers/antigravity-adapter.test.ts`.
- B5 (preflight exits 0 on unsafe): `scripts/preflight.sh` now tracks
  `UNSAFE=1` on unsafe Claude/Google PAYG state or unsafe Antigravity
  settings and exits 1 with `PREFLIGHT=FAIL`. Reproduced before
  (`PREFLIGHT_RC=0` with dummy keys) and after (`UNSAFE_RC=1`). Covered by
  `tests/integration/preflight-failclosed.test.ts` (2 tests) and the
  updated redaction test tolerating the fail-closed exit.
- B6 (installer wrong repo root): installer/preflight-wrapper/runner use
  `SCRIPT_DIR/../..`, `set -euo pipefail`, template + built-entrypoint
  assertions, and never claim success on render failure. Covered by
  `tests/integration/launchagent.test.ts` (root math, wrapper path,
  dry-run render, missing-template non-zero, strict mode).
- B7 (buffered "streaming"): Claude yields SDK deltas incrementally;
  Antigravity `streamInference()` parses NDJSON lines as they arrive via
  shared `feedStreamLine()`; Command Code yields SSE frames from the live
  body on both wires (`6e52709`/`710623e`). Covered by incremental
  streaming tests per provider (40 Antigravity, 28 Command Code adapter).
- B8 (UsageStore disconnected): new `src/http/usage-tracking.ts`
  passthrough tracker records begin/end, token counts, and terminal status
  for all four traffic paths (chat/responses × streaming/non-streaming)
  without breaking incremental SSE. Terminal events are recorded before
  yield so break-first consumers still account. Covered by
  `tests/http/usage-wiring.test.ts` (5 tests: success, error mapping,
  tokens, `/v1/cmm/usage` ok, streaming + responses).
- B9 (Codex content logging): all `console.*delta` / `substring(0, 50)`
  completion logging removed from codex/claude/antigravity/command-code
  and HTTP sources. Covered by `tests/security/log-hygiene.test.ts`
  (source scan + codex zero-console assertion).
- B10 (tool round-trip DoD): no change in capability — all routes remain
  honestly `CHAT_ONLY`; nothing is faked. Documented in README truth
  table and `docs/qoder-acceptance.md` as
  `TOOL_ACCEPTANCE=BLOCKED_PROVIDER_CAPABILITY` pending human scope
  decision. This is a scope verdict for the human, not a code defect.
- M1 (no reproducible startup config): new `ensureSharedConfig()` writes
  documented defaults for a fresh clone without overwriting or writing
  secrets. Covered by `tests/config/bootstrap-wiring.test.ts`.
- M2 (provider options unwired): `codexHome` → `CODEX_HOME` child env +
  configurable binary; `profileDir` → explicit `CMM_CLAUDE_PROFILE_DIR`
  opt-in; `agyPath` → both Antigravity spawns via config resolvers in
  `src/index.ts`. Covered by resolver assertions in
  `tests/config/bootstrap-wiring.test.ts`.
- M3 (entitlement exclusion advertised): `discoverModels()` skips
  `goatIncluded === false`; tri-state `entitlementOf()` + request-time
  fail-closed `MODEL_NOT_IN_PLAN` mapping retained. Covered by adapter
  entitlement tests.
- M4 (timeout bypassed with caller signal): new `composeTimeoutSignal()`
  in the Command Code client — timeout always fires, caller abort wins
  early, timeout aborts map to `provider_timeout`. Covered by
  `tests/providers/command-code-timeout.test.ts` (2 tests).
- M5 (weak disconnect cancel): destroyed-socket path now aborts the run
  scope and releases the adapter on both chat and responses streaming
  loops. Covered by `tests/http/disconnect-cancel.test.ts`
  (abort-signal + `cancel()` propagation).
- M6 (Codex finish reason): `normalizeCodexFinishReason()` maps upstream
  statuses to `stop | tool_calls | length`, unknown → `stop`. Contract
  extended in `tests/security/log-hygiene.test.ts`.
- M7 (Antigravity temp accumulation): `run()` removes its per-request
  temp dir best-effort in `finally`. Covered by
  `tests/providers/antigravity-temp-cleanup.test.ts`.
- M8 (weak smoke): `scripts/qoder-smoke.sh` now covers non-streaming chat,
  streaming SSE with `[DONE]` check, Responses, and cancellation
  reachability, each requiring the exact `QODER_SMOKE_OK` marker. Pinned by
  `tests/integration/qoder-smoke-contract.test.ts`.
- M9 (stale evidence/README): this report supersedes the stale live-state
  notes; README preflight wording ("Fails the run on unsafe PAYG state")
  is now true. A final README timestamp pass is left for the human audit
  bundle.
- M10 (security-audit blind spots): `scripts/security-audit.sh` now also
  checks ESM `require()` absence, Claude env-write absence, spending-gate
  invocation, log hygiene, composition presence, and preflight fail-closed
  wiring. Verified: `SECURITY_AUDIT=PASS`.

## Verification (no live quota burned)

```text
npm test → 38 passed | 5 skipped files; 287 passed | 25 skipped tests
npm run build → PASS
dist/index.js ESM import probe → DIST_ESM_OK
bash scripts/security-audit.sh → SECURITY_AUDIT=PASS
bash scripts/preflight.sh (clean) → PREFLIGHT=PASS, rc=0
bash scripts/preflight.sh (dummy PAYG) → PREFLIGHT=FAIL, rc=1
npx tsc -p tsconfig.json --noEmit → clean
```

Excluded from re-proof here (prior evidence stands, live-gated):
Codex/Claude/Antigravity/Command Code live inference suites
(`CMM_RUN_LIVE=1`, skipped in this run).

## Residual scope decisions for the human

- B10/M8 UI portion: Qoder UI acceptance and iMac live install remain
  `BLOCKED_EXTERNAL_PRECONDITION` (no UI automation / iMac reachability
  from here).
- Command Code GOAT live inference needs human secret injection; hooks
  block agent-side secret handling. Request-time entitlement enforcement
  is proven by contract tests, not by a fresh live call in this pass.
- Task 13 DoD (`QODER_TOOL_ROUNDTRIP=PASS`) is unmet by provider
  capability; either the human revises v1 scope to `CHAT_ONLY` or a
  future tool-ownership round trip must be proven per route.

## Standing security constraints (unchanged)

No API PAYG fallback; no cross-provider fallback; no on-demand/extra
spend; no auto-top-up; fail closed always. The Command Code API key from
chat was never written to disk, env, or git. The spend acknowledgement
file is a human attestation and was not created here. The normal Claude
profile / OmniRoute / localhost:20128 were not touched. Antigravity
global settings were not modified.
