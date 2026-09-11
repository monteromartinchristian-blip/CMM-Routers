# Task 17 — CMM Routers Migration Design

**Date:** 2026-09-11
**Status:** Approved design, implementation not started
**Canonical public language:** English
**Current repository name:** `CMM-Subscription-Router`
**Target repository name:** `CMM-Routers`
**Target local path:** `$HOME/CMM-Routers`

## 1. Purpose

Task 17 migrates the project from the product identity **CMM Subscription Router**
to the umbrella product **CMM Routers** without destabilizing the runtime that was
validated through Task 16.

CMM Routers is a reusable, local-first routing platform for connecting compatible
AI subscriptions to the clients and harnesses users actually want to use, without
requiring accidental PAYG fallback.

The public identity is intentionally broader than Qoder or any one client.

Tagline:

> **CMM Routers — Use the AI subscriptions you already pay for, from the tools you actually want to use.**

## 2. Product structure

CMM Routers exposes two product profiles.

### 2.1 CMMChat Router — `CHAT_ONLY`

`CMMChat Router` is the conversational profile.

Properties:

- no external tool execution;
- no shell execution;
- no filesystem or repository mutation;
- the consumer remains `CHAT_ONLY` even when the selected provider/model is
  technically capable of tool calling;
- intended for CMMChat and equivalent chat-only consumers.

### 2.2 CMM Code Router — `CHAT_AND_TOOLS`

`CMM Code Router` is the coding/agent profile.

Properties:

- the client or harness owns tools;
- the provider owns reasoning, not native repository mutation;
- tool calls are surfaced back to the client/harness;
- tool results are returned to the same logical provider run where supported;
- Qoder is the first documented consumer, but it is not the identity of the
  profile;
- the architecture remains open to additional compatible clients.

## 3. Security and routing invariants

Task 17 MUST preserve the existing runtime invariants:

- no API PAYG fallback;
- no cross-provider fallback;
- no unknown-model fallback;
- loopback-only Router binding;
- local credential storage;
- no tracked secrets;
- no normal-runtime prompt/completion/tool-argument/tool-result logging;
- provider owns reasoning;
- client/harness owns external tool execution;
- no provider-native repository mutation;
- live quota canaries remain explicit/manual;
- no push unless separately authorized.

Task 17 is primarily an identity, documentation and repository migration. It MUST
NOT use branding work as an excuse for unrelated runtime refactors.

## 4. Canonical naming

After migration:

| Surface | Canonical value |
|---|---|
| Product name | `CMM Routers` |
| Repository | `CMM-Routers` |
| Local repository path | `$HOME/CMM-Routers` |
| npm package name | `cmm-routers` |
| Codex client name | `cmm-routers` |
| Codex client title | `CMM Routers` |
| Chat profile | `CMMChat Router` |
| Coding/agent profile | `CMM Code Router` |
| Chat profile capability | `CHAT_ONLY` |
| Coding/agent profile capability | `CHAT_AND_TOOLS` |

All new Task 17+ artifacts SHOULD use the `CMM-Routers-...` prefix where a
human-readable artifact name is appropriate.

## 5. Compatibility-first migration boundary

The migration distinguishes between **current product identity** and
**persistent installation identifiers**.

### 5.1 Rename current identity

The following current surfaces move to the new branding:

- `package.json` and `package-lock.json` package name;
- `README.md`;
- current, living installation/setup/acceptance documentation;
- `.env.example` human-readable product comments;
- runtime startup text;
- Codex client identity (`name`/`title`);
- bundle archive prefix for newly generated bundles;
- current script comments and human-facing messages;
- current documented local path;
- new evidence and closure artifact names.

### 5.2 Preserve legacy compatibility identifiers

The following identifiers remain unchanged in Task 17:

- LaunchAgent label `com.cmm.subscription-router`;
- plist template filename `launchd/com.cmm.subscription-router.plist.template`;
- Keychain service `cmm-subscription-router`;
- Keychain account names including `router-bearer`, `qoder-bearer` and
  `command-code-secret`;
- Qoder provider ID `qoder-custom-cmm-router`;
- existing environment variable names such as `CMM_ROUTER_TOKEN` and
  `CMM_QODER_TOKEN`;
- existing local log directory `~/Library/Logs/CMM-Subscription-Router/`,
  unless a later explicit compatibility migration replaces it safely.

These strings are **legacy compatibility IDs**, not current product branding.

Living documentation MUST explain this explicitly so users do not interpret them
as stale public identity.

## 6. Historical evidence is immutable

Task 17 MUST NOT rewrite historical evidence merely to make old documents use the
new branding.

Preserve, unless an actual factual correction is needed:

- `docs/audits/*`;
- closed design specs and implementation plans from earlier tasks;
- historical evidence documents;
- historical bundle names;
- historical machine-readable markers such as
  `CMM_SUBSCRIPTION_ROUTER_*`;
- references to the old repository name that accurately describe the artifact or
  state that existed at the time.

This preserves audit provenance and avoids retroactively changing historical
records.

## 7. README and public documentation design

The new `README.md` should be concise, product-oriented and written in English.

Recommended structure:

1. **Hero**
   - `# CMM Routers`
   - tagline;
   - 2–3 sentence explanation of local subscription routing.

2. **Profiles**
   - `CMMChat Router — CHAT_ONLY`;
   - `CMM Code Router — CHAT_AND_TOOLS`.

3. **Architecture**
   - client → CMM Routers → subscription-backed provider;
   - client/harness owns tools;
   - provider owns reasoning;
   - loopback/local boundary.

4. **Supported providers**
   - ChatGPT/Codex;
   - Claude;
   - Google/Antigravity;
   - Command Code only to the extent currently enabled and truthfully supported.

5. **Security**
   - no PAYG fallback;
   - no cross-provider fallback;
   - no unknown-model fallback;
   - local credentials;
   - no tracked secrets;
   - logging hygiene.

6. **Clients**
   - CMMChat as `CHAT_ONLY`;
   - Qoder as a supported `CMM Code Router` consumer;
   - room for other compatible clients.

7. **Setup**
   - local installation;
   - credentials;
   - provider registration;
   - Qoder setup.

8. **Legacy compatibility IDs**
   - explain why some internal identifiers still use
     `cmm-subscription-router`.

9. **Verification**
   - tests;
   - security checks;
   - provider/model capability checks.

10. **Roadmap**
    - additional clients/harnesses;
    - multi-Mac synchronization;
    - additional compatible subscription providers.

The README MUST NOT continue to present historical `CHAT_ONLY` matrices as current
runtime truth after providers have been promoted and validated. Historical
capability states remain in the evidence documents where they belong.

## 8. Living documentation

Task 17 should update living documentation that describes current operation,
including at least:

- `docs/macos-install.md`;
- `docs/qoder-setup.md`;
- `docs/qoder-acceptance.md`;
- any other current guide discovered during implementation that still presents
  the old product identity as current.

Historical audit/spec/plan files are excluded from branding cleanup.

## 9. Runtime/code changes permitted by Task 17

Task 17 may make only narrow runtime-adjacent identity changes, such as:

- startup display name;
- Codex `clientInfo.name`;
- Codex `clientInfo.title`;
- archive prefixes;
- human-facing script comments/messages.

It MUST NOT alter provider selection, tool semantics, security boundaries,
capability policy, spend policy, fallback behavior or model routing merely as part
of the rename.

Any hidden dependency discovered during implementation that would require a real
runtime architecture change MUST be treated as a separate finding and reviewed
before implementation continues.

## 10. Physical repository migration

Physical rename happens only after the in-repository migration is green.

Sequence:

1. complete and verify all tracked-file migration work while the repository is
   still at `$HOME/CMM-Subscription-Router`;
2. verify focused tests, full suite, typecheck, build and security checks;
3. rename the local directory:
   - from `$HOME/CMM-Subscription-Router`
   - to `$HOME/CMM-Routers`;
4. rerun relevant verification from the new physical path;
5. detect and repair any real path dependency that was missed;
6. rename/create the GitHub repository as `CMM-Routers`;
7. configure/update `origin` only from verified real repository state;
8. perform final verification with no push unless explicitly authorized.

The Task 17 discovery inventory found no configured `git remote -v` output at the
start of the task. The implementation MUST therefore detect remote state instead
of inventing a GitHub URL.

## 11. GitHub/public migration

The GitHub repository should ultimately be named `CMM-Routers`.

Requirements:

- repository title and description use the new product identity;
- README links use the canonical repository after rename;
- no secrets, personal configuration, local profiles, user-specific logs or
  credential material are introduced;
- remote setup is explicit and verified;
- push remains prohibited until separately authorized.

If the GitHub repository does not yet exist under the new name, Task 17 may
prepare the local repository completely before the remote-side operation.

## 12. Testing and verification

Before Task 17 can close, verification must prove both identity migration and
runtime preservation.

Minimum checks:

- expected current branding changed to `CMM Routers`;
- package name is `cmm-routers`;
- historical audit artifacts remain unchanged except for deliberately added
  cross-references, if any;
- legacy compatibility identifiers remain present and intentional;
- no accidental global search-and-replace of historical evidence;
- no tracked secrets;
- focused tests for renamed live surfaces pass;
- full test suite passes;
- `npm run typecheck` passes;
- `npm run build` passes;
- security audit passes;
- Router still binds loopback-only;
- no PAYG fallback;
- no cross-provider fallback;
- no unknown-model fallback;
- Qoder integration remains functional;
- tests pass from the final `$HOME/CMM-Routers` path;
- final working tree is clean;
- no push was performed without explicit authorization.

## 13. Explicit non-goals

Task 17 does NOT include:

- Command Code live enablement / quota work from Task 15;
- Task 16B bidirectional Qoder model synchronization;
- changing provider/model capability semantics;
- redesigning tool ownership;
- replacing current authentication architecture;
- rotating/migrating Keychain identifiers solely for aesthetics;
- renaming the LaunchAgent label solely for aesthetics;
- changing Qoder's provider ID solely for aesthetics;
- broad refactors unrelated to product migration.

## 14. Completion state

Task 17 is complete only when:

1. public/current identity is **CMM Routers**;
2. `CMMChat Router` and `CMM Code Router` are documented as the two product
   profiles;
3. the npm/package and runtime-visible identity are updated;
4. compatibility identifiers remain operational and explicitly documented;
5. historical evidence remains truthful and traceable;
6. the repository runs and passes verification from `$HOME/CMM-Routers`;
7. the GitHub repository is named `CMM-Routers` or the exact remaining
   remote-side blocker is explicitly documented;
8. no unauthorized push has occurred.
