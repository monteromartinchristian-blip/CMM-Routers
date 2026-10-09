# P3.4 upstream connectivity recovery — 2026-10-09

Status: runtime recovery VERIFIED for the tested Router and Vikey routes; direct Python Command Code discovery remains BLOCKED. This is not an all-provider inference PASS.

## Scope and preserved state

Read CMMChat's `docs/evidence/p3-4-2026-10-09/upstream-handoff.md` and acceptance evidence before investigation. CMMChat source stayed at `901d4b0e197369af6e3432478f71a1c51ecff6fc`, with no tracked diff. Existing untracked files were retained.

Canonical Router checkout: `/Users/chris/CMM-Routers`, starting HEAD `ff88129cdb70b76feb1c5c9a3edff6886086d24d`, branch `fix/antigravity-client-owned-tool-agent`. Registry preflight v3.1 confirmed canonical macbook and WRITE_ALLOWED=YES. Existing worktrees, twelve modified tracked files and existing untracked tests/cache were preserved. SHA-256 comparison of all twelve existing modified files was unchanged at final verification; receipt `/tmp/router-p34-preserved-work.json`. No source edits or rebuild of the existing Router `dist` were performed. This evidence file is the only owned Git change.

No credentials were changed or printed. No providers/accounts were merged; no favorites, visibility, Usage UI or reasoning semantics were edited. CMM Auto was restored as the new-chat default after inference QA. Test conversations were retained.

## 1. Missing Router listener — root cause and correction

Authoritative runtime is LaunchAgent `com.cmm.subscription-router`, whose plist runs `/Users/chris/CMM-Routers/scripts/macos/run-router.sh` from the canonical checkout. `config/shared.json` declares `127.0.0.1:8790`; the wrapper launches the existing compiled `dist/index.js` with the configured absolute Node executable and existing Keychain-backed authentication. RunAtLoad and failure restart are enabled.

Before recovery, launchd reported a scheduled respawn / exit 1, with no listener. `~/Library/Logs/CMM-Subscription-Router/router.err.log` contained `ERR_MODULE_NOT_FOUND` for `zod` imported by `dist/config/schema.js`. `node_modules` contained only `.vite`, so runtime dependencies were absent. This establishes the startup failure; it does not establish who removed the dependencies or why.

Recovery used unchanged package manifest and lock in an isolated temporary install directory, `/tmp/cmm-router-p34-dependencies`:

```sh
/opt/homebrew/bin/node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js ci --ignore-scripts --no-audit --no-fund --workspaces=false
```

The install ran with that directory as cwd. 191 locked packages installed; 170 missing top-level entries were copied into canonical node_modules, retaining existing entries/cache. No install scripts, dependency upgrades, tracked lock edits or compilation of someone else's dirty source occurred. Lock SHA-256 remained `b978efe4d438842ff2c63c880e1bddf899570dd0dc6b406fd5da64fe6b21f5f6`. Existing compiled imports then loaded. The existing LaunchAgent was restarted; its process recovered.

Final live observation, approximately 19:35 CEST:

- Router PID 76650, launchd state running, TCP `127.0.0.1:8790` LISTEN.
- Authenticated GET `/health`: HTTP 200, status `ok`.
- Authenticated GET `/ready`: HTTP 200, status `ready`.
- Authenticated GET `/v1/models`: HTTP 200, 129 models; observed provider distribution ChatGPT 8, Claude 16, Google 18, Command Code 87.

The Hub had started while Routers was absent and lacked a usable `CMM_ROUTER_TOKEN` in its process environment. Restoring Routers alone did not repair that already-running Hub process. After checking no queued/running Hub requests, restarting the existing Hub LaunchAgent reloaded the existing bearer through the canonical launcher. No alternate credential store or source implementation was introduced. Automatic repair of this startup ordering dependency was not added.

## 2. Command Code discovery 403 — separate transports

Configured Router endpoint is `https://api.commandcode.ai/provider/v1`. Python urllib probes to `/models`, both unauthenticated and with the existing Router credential, returned HTTP 403, `text/plain`, Cloudflare, and exactly the closed diagnostic `error code: 1010`. There was no evidence that this result meant an expired session or invalid credential. No proxy was configured for those probes.

Cloudflare documents 1010 as the site owner denying a client signature; resolution belongs to the owner rather than a credential reset. [Cloudflare error 1010 documentation](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/).

The existing Router Node client successfully discovered 87 Command Code models through its configured path. In the signed CMMChat app, AX selected the Command Code collection's Deepseek V4 Flash and sent `P3.4 upstream connectivity QA. Reply only: OK.` The app received **OK**, preserving provenance `command-code/deepseek/deepseek-v4-flash`. This is actual inference evidence for that route, independent of discovery. Existing spending guards/acknowledgments were retained.

The direct custom-provider Python discovery failure remains unresolved. No client impersonation, authentication bypass or Cloudflare evasion was attempted. A provider-approved direct API policy/interface is needed to resolve that path. The successful Router path must not be confused with a repair of every independently configured Command Code account/source.

## 3. Vikey TLS — secure Hub runtime correction

Exact Hub virtualenv Python used its default `/private/etc/ssl/cert.pem` and failed with `SSLCertVerificationError`, verify code 19, `self-signed certificate in certificate chain`. The same endpoint validated with the updated Homebrew CA bundle `/opt/homebrew/etc/openssl@3/cert.pem`. Observed public chain: Sectigo Public Server Authentication Root R46 → Sectigo Public Server Authentication CA DV R36 → api.vikey.ai; OpenSSL verification returned OK. This was a trust-bundle mismatch, not evidence that hostname verification should be disabled.

The user explicitly authorized a scoped Hub runtime correction to use the updated CA bundle, retaining certificate and hostname verification and leaving system trust untouched.

Only `~/Library/LaunchAgents/com.cmm.hub-8765.plist` was changed: `EnvironmentVariables.SSL_CERT_FILE=/opt/homebrew/etc/openssl@3/cert.pem`. Original plist backup: `/tmp/router-p34-hub-launchagent-before.plist` (mode 600). The existing Hub LaunchAgent was reloaded. No CMMChat source edit or global environment/trust change occurred. The override applies to this Hub process's standard TLS contexts; it does not disable validation for Vikey or other providers.

Final checks:

- Hub PID 83985 running, TCP `127.0.0.1:8765` LISTEN; live process has the configured CA path and existing Router bearer (only presence was reported).
- Exact virtualenv `ssl.create_default_context()` with that bundle: `CERT_REQUIRED=True`, `check_hostname=True`; credential-free Vikey probe completed TLS and returned expected HTTP 401.
- Authenticated discovery through the running Hub: Vikey `last_status=ok`, 32 models, `last_error=null`, `allow_self_signed=false`.
- Saved provider state remained secure after recovery.
- Signed-app AX selected **Vikey** Deepseek V4 Flash, sent `P3.4 Vikey secure TLS QA. Reply only: OK.`, and received **OK**. Saved selected source: `custom/01a111e1501f71be9386b8d7c5670ee4/deepseek/deepseek-v4-flash`, origin Vikey. No provider TLS exception was enabled.

Both QA replies identify the requested/selected route; the app correctly reports that the model actually served is not independently confirmed. This evidence does not attest to exact server-side model identity.

## 4. Signed CMMChat integration

Existing app `/tmp/cmmchat-p34-delivery/Build/Products/Debug/CMMChat.app`, CMMChat HEAD above, was used without rebuilding. `codesign --verify --deep --strict` exited 0. Executable SHA-256: `4db1b48a7ad0c459bd3a95562fe29505d7d7ae320805c422a7c8367c3a0ea20e`.

Native Computer Use / AX validated provider-qualified selection, both real responses and saved provenance. After quitting and reopening the app, both replies/provenance remained; a new chat had CMM Auto selected, and the model selector loaded Router collections and the pre-existing Google favorite. Running Hub `/v1/models` returned HTTP 200 with 160 models. Its list response was counted as a list, not assumed to be an OpenAI data envelope. Router health/readiness/listener remained available after this app relaunch.

This is runtime and AX validation, not a claim that every catalog model can infer, every visibility/favorite setting has been exhaustively retested, or earlier upstream Claude availability issues have been resolved. RecordAndPlay/Girdha: NOT_AVAILABLE in this session.

## 5. Targeted verification receipts

Tests ran against canonical Router source with its preserved pre-existing dirty inputs, restored locked dependencies, Node `/opt/homebrew/bin/node`, Vitest 5.0.0. These receipts do not represent clean HEAD source or a fresh build of dirty code.

```sh
/opt/homebrew/bin/node node_modules/vitest/vitest.mjs run --exclude '.worktrees/**' \
  tests/integration/launchd-deterministic.test.ts \
  tests/integration/launchagent.test.ts \
  tests/integration/launchd-fail-closed.test.ts \
  tests/providers/command-code-adapter.test.ts
```

4 files / 52 tests passed; receipt `/tmp/router-p34-targeted-canonical.log`, 19:23 CEST.

```sh
/opt/homebrew/bin/node node_modules/vitest/vitest.mjs run --exclude '.worktrees/**' \
  tests/providers/command-code-spend-guard.test.ts \
  tests/providers/command-code-timeout.test.ts \
  tests/providers/command-code-body-timeout.test.ts
```

3 files / 13 tests passed; receipt `/tmp/router-p34-guards.log`, 19:29 CEST. Total directed canonical scope: 65 passing tests. Expected fail-closed diagnostics in the launchd suite are tested failure paths.

An earlier invocation omitted the worktree exclusion and unintentionally collected other checkouts: 251 passed, 2 failed, 7 skipped. The two failures concerned missing fixtures/dist in another worktree; that run is not accepted as canonical verification. No edits were made to those worktrees. Full-suite/build PASS is not claimed for this runtime-only repair.

## Remaining blockers and operational limits

- Direct Python Command Code discovery remains Cloudflare 1010 / HTTP 403; owner-approved access is required. Working inference through Routers remains separately verified.
- Missing-dependency incident's originating action is unknown. Locked dependencies were restored; no automatic self-healing installer was added to startup.
- Hub bootstrap still depends on the Router bearer being available through its existing launcher at startup. Current process was corrected by restart; no startup architecture change was authorized/implemented.
- The process CA override depends on the existing Homebrew CA bundle staying readable/current. No system trust modifications or insecure fallback exist.
- Existing upstream model/effort handoffs and other agents' Router changes remain outside this recovery.

Runtime changes are machine-local and are described here; this evidence commit alone does not install dependencies or update LaunchAgents on another machine. No Router remote push was requested in this mission.
