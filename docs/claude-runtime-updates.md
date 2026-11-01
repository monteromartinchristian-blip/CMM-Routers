# Claude runtime updates (SDK vs Claude Code)

The Router's `claude/*` lane runs the **Claude Code runtime bundled inside the
Agent SDK**, not the `claude` binary on `PATH`. Two different versions describe
that installation and must never be conflated:

| Version | Source | Meaning |
| --- | --- | --- |
| `0.3.316` | `node_modules/@anthropic-ai/claude-agent-sdk/package.json` → `version` | npm package version of the Agent SDK (`@anthropic-ai/claude-agent-sdk`) |
| `2.1.316` | `node_modules/@anthropic-ai/claude-agent-sdk/manifest.json` → `version` | Claude Code runtime version bundled in that SDK (also `claudeCodeVersion` in the package manifest) |

Both numbers are resolved by the updater itself from the installed SDK, never
from a version string typed by hand: `sdk_version()` reads the package
`package.json` and `runtime_version()` reads its `manifest.json`, because the
manifest is the artifact the runtime is launched from. The updater logs and
commits both values explicitly:

```text
current sdk=0.3.316 claudeCodeRuntime=2.1.316
chore(claude): actualizar el SDK de Agent a 0.3.316 (Claude Code 2.1.316)
```

Do not report `0.3.316` as the Claude Code version, or `2.1.316` as the npm
package version.

## Update mechanism

`scripts/macos/update-claude-runtime.sh` validates and (only when authorized)
applies an update. `launchd/com.cmm.claude-runtime-update.plist.template` runs
it daily at 04:40 with `--apply`; the script itself decides whether applying is
allowed.

Phases, none of which can be skipped:

1. **Preflight** — tracked checkout clean, no in-progress Git operation, lock
   (a live PID blocks a second run; a stale lock older than six hours is
   removed).
2. **Resolve** — `npm view` for the newest SDK version, registry integrity and
   tarball origin. Versions older than the pin are ignored.
3. **Policy** — `config/claude-runtime-update-policy.json` decides `apply` vs
   `prepare`. **If the policy is missing or invalid, the updater never applies.**
4. **Validate** — throwaway worktree: bump the pin, `npm install`, verify the
   lock pins the registry integrity, verify registry signatures
   (`npm audit signatures`), check the bundled runtime exists for this platform
   and meets `minimumRuntimeVersion`, then typecheck, build and run the Claude
   provider tests.
5. **Canary** — an isolated Router on a spare port with a fresh random bearer
   (never the live token). `/health`, `/ready`, `/v1/models`: at least one
   available `claude/claude-*` model and any `requiredAliases`.
6. **Apply** (policy `mode: apply` and `--apply`) — back up the current SDK,
   `dist`, `package.json` and lock; merge the validated commit; swap in the
   validated `node_modules`; build; restart the LaunchAgent.
7. **Verify / rollback** — `/health`, `/ready`, the authenticated route and the
   catalog (when a Keychain bearer is available). Any failure restores the
   backup, returns the branch to its previous commit, restarts and re-verifies.

The live Router's credentials are never read from another process; the canary
uses its own random bearer.

Like the other macOS entrypoints, the updater expects a machine-local
`config/shared.json` (the port it reads for the live checks) and
`scripts/macos/run-router.sh` for the canary. `scripts/macos/install-router.sh`
creates `config/shared.json` from the shipped example on a fresh checkout, so
run the installer before scheduling the nightly job.

## Deployment policy

`config/claude-runtime-update-policy.json` is machine-local and gitignored. The
tracked example is
[config/claude-runtime-update-policy.example.json](../config/claude-runtime-update-policy.example.json):

```json
{
  "mode": "prepare",
  "allowedMajorMinor": ["0.3"],
  "requireProvenance": true,
  "minimumRuntimeVersion": "2.1.280",
  "requiredAliases": []
}
```

- `mode: "prepare"` (default, and the only safe default): validate and leave a
  local ref `cmm/prepared-claude-runtime-<version>`, but never touch the running
  Router.
- `mode: "apply"`: allow an authorized `--apply` to deploy after every phase
  passes.
- `allowedMajorMinor`: accepted SDK minor lines. A version outside them is
  blocked.
- `requireProvenance`: require the registry tarball origin, the lock integrity
  and verified registry signatures.
- `minimumRuntimeVersion`: the oldest Claude Code runtime the deployment
  accepts (Opus 5.5 needs 2.1.280).
- `requiredAliases`: optional alias ids (without the `claude/` prefix) the
  canary and live catalog must publish.

Without a policy the nightly job only prepares. Approving explicitly:

```bash
# policy must have mode: "apply"
scripts/macos/update-claude-runtime.sh --apply-prepared cmm/prepared-claude-runtime-0.3.317
```

## Evidence and rollback

Every run appends one JSON line to
`~/Library/Logs/CMM-Subscription-Router/claude-runtime-update-evidence.jsonl`:

```json
{"result":"prepared","reason":"policy-requires-explicit-approval","from_sdk":"0.3.316",
 "to_sdk":"0.3.317","from_runtime":"2.1.316","to_runtime":"2.1.317",
 "rollback_available":false,"policy_mode":"prepare","provenance":"registry-signature+integrity"}
```

Applying also writes a backup directory
`claude-runtime-backup-<timestamp>/` containing the previous SDK directory,
`dist`, `package.json`, `package-lock.json` and `PREV_HEAD`. A failed deployment
records `rolled-back` (or `rollback-failed`) with the exact reason, and restores
the previous operational runtime. No token, bearer, Keychain value or
authorization header is ever written to the log or evidence.

## Installed LaunchAgent

The installed plist at `~/Library/LaunchAgents/com.cmm.claude-runtime-update.plist`
is user configuration and is **not** rewritten by the updater or the installer.
Review it before changing it; the script's policy gate is what keeps the nightly
run safe even when the plist passes `--apply`.
