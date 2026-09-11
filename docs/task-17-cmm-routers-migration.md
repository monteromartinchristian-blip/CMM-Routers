# Task 17 — CMM Routers Migration

**Date:** 2026-09-11
**Status:** CLOSED_PASS
**Branch:** `feature/task17-cmm-routers-migration`
**Spec:** `docs/superpowers/specs/2026-09-11-cmm-routers-migration-design.md`
**Plan:** `docs/superpowers/plans/2026-09-11-cmm-routers-migration-plan.md`

## Final identity

| Surface | Value |
|---|---|
| Product | CMM Routers |
| Repository | `CMM-Routers` |
| Local path | `$HOME/CMM-Routers` |
| Package | `cmm-routers` |
| Codex client name | `cmm-routers` |
| Codex client title | `CMM Routers` |
| New archive prefix | `cmm-routers/` |
| Startup line | `Starting CMM Routers on <host>:<port>` |

## Profiles

- **CMMChat Router** — `CHAT_ONLY`. Conversational only; never gains tools,
  shell, filesystem access, or repository mutation, even when the selected
  provider/model is technically tool-capable.
- **CMM Code Router** — `CHAT_AND_TOOLS` where the selected provider/model
  truthfully supports the externally-owned tool round-trip. The client/harness
  owns tool execution; the provider owns reasoning; no provider mutates a
  repository directly.
- **Qoder** — the first documented `CMM Code Router` consumer. Qoder is a
  supported client, not the identity of the project or the profile.

All four provider adapters advertise `CHAT_AND_TOOLS`. `google/*` and
`chatgpt/*` were proven live by authorized canaries on 2026-09-11; `claude/*`
is preserved from earlier authorized runs; `command-code/*` ships disabled in the
active runtime (live enablement is Task 15, out of scope here).

## Preserved legacy compatibility identifiers

These remain unchanged by design so existing installations keep working:

- LaunchAgent label `com.cmm.subscription-router`
- plist template `launchd/com.cmm.subscription-router.plist.template`
- Keychain service `cmm-subscription-router`
- Keychain accounts `router-bearer`, `qoder-bearer`, `command-code-secret`
- Qoder provider ID `qoder-custom-cmm-router`
- Environment variable names `CMM_ROUTER_TOKEN`, `CMM_QODER_TOKEN`
- Log directory `~/Library/Logs/CMM-Subscription-Router/`

## Historical evidence

No historical evidence was rebranded. `docs/audits/**`,
`docs/task-13-closure.md`, and `docs/task-14-codex-post-tool-continuation.md`
are byte-identical to the Task 16 baseline, and historical
`CMM_SUBSCRIPTION_ROUTER_*` markers remain intact. Verified with:

```bash
git diff --name-only 725ef1e...HEAD -- docs/audits \
  docs/task-13-closure.md docs/task-14-codex-post-tool-continuation.md
# (empty)
```

## Commits

| Hash | Subject |
|---|---|
| `da1c57dd3e98311ed8a65fb4334ea232eeaf78bb` | chore: rename current product identity to CMM Routers |
| `10632d7e320a393130b3fd75a2b4dee360a88acf` | docs: present CMM Routers public architecture |
| `ee3f7b472407d511d065424c122fffb02416bab6` | test: make router path fixtures public-safe |
| (this commit) | docs: close CMM Routers migration |

Design and plan commits preceding the implementation:
`74f4146a995d8dab37ef7ab64f50c10b221ce31e` (docs: define) and
`5e2909637da23346de485397e76adeff4b6d52fc` (docs: plan).

## Verification

Run from `$HOME/CMM-Routers` after the physical rename:

| Check | Result |
|---|---|
| `npm run build` | PASS (exit 0) |
| `npx vitest run` | 128 files passed, 5 skipped; 703 tests passed, 25 skipped |
| `npm run typecheck` | PASS (exit 0) |
| `bash scripts/security-audit.sh` | `SECURITY_AUDIT=PASS`, `LOOPBACK_ONLY=PASS`, `PAYG_GUARD=PASS`, `CMMCHAT_TOOL_ESCALATION=NONE` |
| `git diff --check` | no whitespace errors |
| focused path-sensitive tests | PASS (47 tests across 5 files) |

Baseline before Task 17 was 127 files / 697 tests passed, 25 skipped. The
increase (+1 file, +6 tests) is the new
`tests/integration/cmm-routers-branding.test.ts`.

## Physical rename

Worktree-safe sequence, per the master implementation prompt:

1. Feature worktree confirmed clean; HEAD recorded as `ee3f7b4`.
2. Linked worktree `.worktrees/task17-cmm-routers-migration` removed with
   `git worktree remove` from the root checkout; branch preserved.
3. Root checkout switched from `main` to `feature/task17-cmm-routers-migration`;
   HEAD re-verified as `ee3f7b4`, tree clean.
4. Directory renamed `$HOME/CMM-Subscription-Router` → `$HOME/CMM-Routers`.
5. Post-rename: same HEAD, clean tree, build/typecheck/full suite/security all
   green from the new path.

The old path `$HOME/CMM-Subscription-Router` no longer exists.

## Path-bound local registrations refreshed

- **LaunchAgent** (`com.cmm.subscription-router`): re-rendered by the supported
  installer from the new repo. `ProgramArguments` and `WorkingDirectory` now
  resolve under `$HOME/CMM-Routers`; the service was reloaded and is running
  (`/health` returns `{"status":"ok"}`, log shows `Starting CMM Routers`). The
  legacy log directory path is intentionally preserved.
- **Antigravity MCP bridge** (`cmm-qoder-tools`): re-registered through the
  Router's own supported `ensureAntigravityMcpRegistration` path (action
  `repaired`). The launcher now resolves to
  `$HOME/CMM-Routers/dist/bridge/mcp-bridge-launcher.js`. No live inference was
  triggered.
- **Qoder provider** (`qoder-custom-cmm-router`): connects over the loopback base
  URL `http://127.0.0.1:8790/v1`, which is path-independent — no refresh needed.
- Remaining old-name references under `~/.qoder` are session logs, search-index
  state, and project history (historical/local; harmless), not active executable
  or bridge paths. No credential-bearing file contents were read or printed.

No genuine hard-coded production path defect was found; no `fix:` commit was
required.

## GitHub / remote

- Inspected real state first: no `git remote` was configured, and neither
  `CMM-Routers` nor `CMM-Subscription-Router` existed under the authenticated
  account `monteromartinchristian-blip`.
- Created the public repository `CMM-Routers` and configured `origin`
  (`https://github.com/monteromartinchristian-blip/CMM-Routers.git`) with
  `gh repo create ... --remote origin` and **no** `--push`.
- `git ls-remote --heads origin` returns empty: the remote has no refs.

```text
PUSH_PERFORMED=NO
```

## Local integration into main

After the closure commit, the feature branch is fast-forward merged into local
`main` with `git merge --ff-only` (no merge commit, no rebase). Final
verification is rerun from `$HOME/CMM-Routers` on `main`. The feature branch is
preserved.

```text
TASK17_STATUS=CLOSED_PASS
```
