# CMM Subscription Router — Implementation Evidence (2026-09-09)

**Status:** `IMPLEMENTED_PENDING_INDEPENDENT_AUDIT`

This is NOT an independent audit. The human audits after this run.

## Heads

- Starting HEAD: `1b470916a228a35fe10cf74ad45f0d75eb3cf46f`
- Final HEAD: recorded at bundle time (see `git log`).

## Per-task commits (overnight run)

- `21c73d4` feat: add Command Code GOAT provider adapter (Task 10)
- `69ef7f8` feat: add OpenAI-compatible chat completions (Task 11)
- `7e352f3` feat: add OpenAI-compatible responses API (Task 12)
- `dbd6113` feat: add external tool round-trip contract (Task 13)
- `d085d55` feat: add router observability and usage diagnostics (Task 14)
- `7c7a2e5` feat: add subscription router preflight (Task 15)
- `b02aa9a` docs: record Qoder router acceptance (Task 16)
- `9c9d69c` feat: add macOS standalone service installation (Task 17)
- `db3d815` feat: freeze remote-worker-compatible wire contract (Task 18)
- Task 19 changes: E2E suite, README, security-audit script, this report

Task 9.1 reconciliation: audited all `writeFileSync` uses in `src/` —
only Antigravity canary files in temp dirs. `GLOBAL_SETTINGS_PATH` is
read-only in repo code. Historical pre-task hash drift is
`PRETASK_HASH_DRIFT_CAUSE=UNATTRIBUTED` (CLI-owned `trustedWorkspaces`
mutation); overnight baseline `3b0b3e14...` stable start-to-end.
No `fix:` commit needed (no repo-code bug found).

## Test counts (final freeze)

- Unit/contract: 221 passed, 24 skipped (live-gated suites skip without `CMM_RUN_LIVE=1`)
- Typecheck: PASS (`npm run typecheck`)
- Build: PASS (`npm run build`)
- Post-build tests: PASS

## Live provider results (final freeze, minimal prompts)

- Codex: 5/5 PASS (discovery, streaming inference, Astra inference,
  turn/interrupt cancellation, canary).
- Claude: 6/6 PASS (auth, OmniRoute unchanged, inference
  `CMM_CLAUDE_SUBSCRIPTION_OK`, canary, cancellation, dynamic discovery).
- Antigravity: 6/6 PASS (auth, 14 discovered models, inference
  `CMM_ANTIGRAVITY_SUBSCRIPTION_OK` on `google/gemini-3.8-flash-low`,
  canary, cancellation, settings unchanged).
- Command Code: spend ack now VALID locally; secret remains ABSENT in this
environment so live inference stays `BLOCKED_EXTERNAL_PRECONDITION`.
Adapter + spend-guard fully unit-tested (23 tests). The key pasted in
chat was never written to disk, env, or git.
- Tool round-trip probes: chatgpt/claude/google all
  `CHAT_ONLY_NO_TOOL_EMITTED`; workspace mutation `BLOCKED`.

## Blocked external gates

- `COMMAND_CODE_LIVE=BLOCKED_EXTERNAL_PRECONDITION`
  (`COMMAND_CODE_SPENDING_ACK=MISSING`, secret `ABSENT` here).
- Qoder UI acceptance `BLOCKED_EXTERNAL_PRECONDITION` (no UI automation
  in this environment; router-side harness complete).
- `IMAC_LIVE_INSTALL=NOT_EXECUTED` (iMac unreachable; installer dry-run tested).

## Provider capability matrix

| Route | Capability | External tools |
|---|---|---|
| chatgpt/* | CHAT_ONLY | BLOCKED |
| claude/* | CHAT_ONLY | BLOCKED |
| google/* | CHAT_ONLY | BLOCKED |
| command-code/* | CHAT_ONLY | BLOCKED |

## Security invariants

```text
API_PAYG_FALLBACK=NO
CROSS_PROVIDER_FALLBACK=NO
UNKNOWN_MODEL_FALLBACK=NO
OAUTH_EXTRACTION=NO
OAUTH_COPY=NO
OAUTH_SYNC=NO
ROUTER_BIND=127.0.0.1
ROUTER_PORT=8790
PROVIDER_NATIVE_REPO_MUTATION=NO
TOOL_EXECUTOR=QODER
QWEN_NATIVE_PLAN=UNTOUCHED
```

Scans: `NO_TRACKED_SECRETS=PASS`, `LOOPBACK_ONLY=PASS`,
`BUILD_ARTIFACT_TEST_DUPLICATION=NONE` (`scripts/security-audit.sh`).

## Global-state hashes/status

- Antigravity overnight: `3b0b3e14...` unchanged start-to-end
  (`modelProvider=ABSENT`, `useG1Credits=ABSENT`).
- Claude OmniRoute: unchanged (live test).
- Codex ChatGPT auth mode: untouched.
- Qwen native provider: untouched (no router code path).

## Qoder acceptance state

Router-side harness complete (`scripts/qoder-smoke.sh`,
`docs/qoder-setup.md`). UI portion blocked (external precondition).
Recorded in `docs/qoder-acceptance.md`.

## MacBook/iMac state

MacBook installer + LaunchAgent template + Keychain-based secret
resolution implemented and dry-run tested. iMac procedure documented in
`docs/macos-install.md`; live iMac install not executed.

## Known limitations

- Command Code live unproven until the human confirms GOAT preconditions
  and provides the spend ack + secret locally.
- External tool ownership unproven for all routes: Codex auto-declines
approvals with no external-tool channel in its app-server protocol;
Claude SDK runs with native tools disallowed; agy headless has no
external-tool channel (plan+sandbox only); Command Code passes tools
through but live ownership is unproven while live is blocked. All routes
report `CHAT_ONLY` (Task 13 closure).
- Plan tiers not programmatically exposed (reported honestly).
- agy 1.1.16 quirks documented in README (duration unit, envelope shape).
