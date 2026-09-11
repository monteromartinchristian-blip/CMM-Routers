# CMM Routers Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the current project identity from CMM Subscription Router to CMM Routers, publish the two canonical profiles (`CMMChat Router / CHAT_ONLY` and `CMM Code Router / CHAT_AND_TOOLS`), then rename the local and GitHub repository to `CMM-Routers` without changing routing/security semantics or breaking existing installations.

**Architecture:** Treat public/current identity and persistent installation identifiers as separate layers. Rename current product/package/documentation surfaces, preserve legacy Keychain/LaunchAgent/Qoder identifiers as compatibility IDs, verify the runtime before and after the physical directory rename, then configure the GitHub repository/remote without pushing.

**Tech Stack:** TypeScript, Node.js, npm, Vitest, Bash, macOS launchd/Keychain, Git, GitHub CLI (`gh`) when authenticated.

**Spec:** `docs/superpowers/specs/2026-09-11-cmm-routers-migration-design.md`

## Global Constraints

- Canonical public product name: `CMM Routers`.
- Canonical repository name: `CMM-Routers`.
- Canonical final local path: `$HOME/CMM-Routers`.
- Canonical npm package name: `cmm-routers`.
- Canonical public documentation language: English.
- `CMMChat Router` is always `CHAT_ONLY`.
- `CMM Code Router` is `CHAT_AND_TOOLS` where the selected provider/model truthfully supports it.
- Qoder is a supported consumer of CMM Code Router, not the project identity.
- No API PAYG fallback.
- No cross-provider fallback.
- No unknown-model fallback.
- Router remains loopback-only.
- Provider owns reasoning; client/harness owns external tool execution.
- No provider-native repository mutation.
- No tracked secrets.
- No normal-runtime prompt/completion/tool-argument/tool-result logging.
- Preserve legacy compatibility IDs:
  - LaunchAgent label `com.cmm.subscription-router`;
  - plist filename `launchd/com.cmm.subscription-router.plist.template`;
  - Keychain service `cmm-subscription-router`;
  - Keychain account names `router-bearer`, `qoder-bearer`, `command-code-secret`;
  - Qoder provider ID `qoder-custom-cmm-router`;
  - existing `CMM_*` environment variable names;
  - existing log directory `~/Library/Logs/CMM-Subscription-Router/`.
- Historical audit/spec/plan identity and historical machine-readable markers remain historically truthful; do not global-search-and-replace them.
- Personal paths/usernames must not be introduced into new public-facing files or new tests. Existing current/live examples should be generalized where Task 17 touches them. Historical evidence is not rebranded; privacy-only redaction, if needed before publication, must preserve the historical meaning.
- No Command Code live quota work in Task 17.
- No Task 16B multi-Mac Qoder synchronization in Task 17.
- No push unless separately authorized.

---

## File Map

### Current identity surfaces to modify

- `package.json` — npm package identity.
- `package-lock.json` — lockfile package identity.
- `.env.example` — current product comments.
- `src/index.ts` — startup display name.
- `src/providers/codex/adapter.ts` — Codex `clientInfo` identity.
- `scripts/capture-bundle.sh` — prefix for newly generated archives.
- `scripts/macos/install-router.sh` — current human-facing product comments/messages only; compatibility IDs remain.
- `scripts/macos/uninstall-router.sh` — current human-facing product comments/messages only; compatibility IDs remain.
- `scripts/preflight.sh` — current human-facing product comment.
- `scripts/qoder-smoke.sh` — current human-facing product comment.
- `README.md` — public product landing page.
- `docs/macos-install.md` — current installation guide.
- `docs/qoder-setup.md` — current Qoder guide.
- `docs/qoder-acceptance.md` — current acceptance guide.

### Tests to create/modify

- Create: `tests/integration/cmm-routers-branding.test.ts` — single source of truth for current branding vs legacy compatibility IDs.
- Modify: `tests/providers/antigravity-adapter.test.ts` — remove user-specific old-repo path fixture.
- Modify: `tests/providers/antigravity-mcp-registration.test.ts` — replace user-specific old-repo path fixtures with generic canonical path fixtures.
- Modify: `tests/providers/claude-environment.test.ts` — assert repo isolation generically rather than matching the old brand.
- Existing launchd/Keychain tests remain authoritative for legacy compatibility IDs and SHOULD continue to pass unchanged unless only comments/fixtures require adjustment.

### Historical files intentionally not rebranded

- `docs/audits/**`
- closed historical specs/plans under `docs/superpowers/specs/**` and `docs/superpowers/plans/**`, except this Task 17 spec/plan;
- `docs/task-13-closure.md`;
- `docs/task-14-codex-post-tool-continuation.md`;
- historical artifact filenames and historical `CMM_SUBSCRIPTION_ROUTER_*` evidence markers.

### Task 17 closure file

- Create: `docs/task-17-cmm-routers-migration.md` after the physical/local/GitHub migration is known.

---

### Task 1: Lock the branding/compatibility contract in tests and rename code/package identity

**Files:**
- Create: `tests/integration/cmm-routers-branding.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.env.example`
- Modify: `src/index.ts`
- Modify: `src/providers/codex/adapter.ts`
- Modify: `scripts/capture-bundle.sh`
- Modify: `scripts/macos/install-router.sh`
- Modify: `scripts/macos/uninstall-router.sh`
- Modify: `scripts/preflight.sh`
- Modify: `scripts/qoder-smoke.sh`

**Interfaces:**
- Consumes: existing package metadata, Codex adapter client-info object, existing launchd/Keychain/Qoder IDs.
- Produces: current product identity `CMM Routers` / package `cmm-routers` while preserving all persistent legacy IDs.

- [ ] **Step 1: Add a failing branding contract test**

Create `tests/integration/cmm-routers-branding.test.ts` with:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("CMM Routers current identity", () => {
  it("uses the canonical package and runtime-visible product identity", () => {
    const pkg = JSON.parse(read("package.json"));
    const lock = JSON.parse(read("package-lock.json"));
    const index = read("src/index.ts");
    const codex = read("src/providers/codex/adapter.ts");
    const bundle = read("scripts/capture-bundle.sh");

    expect(pkg.name).toBe("cmm-routers");
    expect(lock.name).toBe("cmm-routers");
    expect(lock.packages[""].name).toBe("cmm-routers");
    expect(index).toContain("Starting CMM Routers");
    expect(codex).toContain('name: "cmm-routers"');
    expect(codex).toContain('title: "CMM Routers"');
    expect(bundle).toContain("--prefix=cmm-routers/");
  });

  it("preserves persistent legacy compatibility identifiers", () => {
    const launchd = read("launchd/com.cmm.subscription-router.plist.template");
    const runner = read("scripts/macos/run-router.sh");
    const qoder = read("scripts/qoder/reconcile-qoder-provider.mjs");

    expect(launchd).toContain("com.cmm.subscription-router");
    expect(launchd).toContain("cmm-subscription-router");
    expect(runner).toContain("cmm-subscription-router");
    expect(qoder).toContain('qoder-custom-cmm-router');
  });

  it("does not rewrite historical Task 13 identity", () => {
    expect(read("docs/task-13-closure.md")).toContain("CMM Subscription Router");
  });
});
```

- [ ] **Step 2: Run the new test and verify it fails for the new identity**

Run:

```bash
npx vitest run tests/integration/cmm-routers-branding.test.ts
```

Expected before implementation: FAIL on `cmm-routers`, `Starting CMM Routers`, Codex client identity, and/or archive prefix.

- [ ] **Step 3: Apply the minimal identity rename**

Change exactly these current identity surfaces:

```json
// package.json
{
  "name": "cmm-routers"
}
```

Update the root package name in `package-lock.json` at both the top-level `name`
and `packages[""].name`.

In `src/index.ts`, change only the startup product string:

```ts
console.log(`Starting CMM Routers on ${config.host}:${config.port}`);
```

In `src/providers/codex/adapter.ts`, change the Codex client identity to:

```ts
clientInfo: {
  name: "cmm-routers",
  title: "CMM Routers",
  version: "1.0.0",
},
```

Preserve the actual existing version expression if the adapter currently derives
it differently; only `name` and `title` are Task 17 identity changes.

In `scripts/capture-bundle.sh`, change the archive prefix used for **new**
archives from:

```bash
--prefix=cmm-subscription-router/
```

to:

```bash
--prefix=cmm-routers/
```

Update only human-facing comments/headings in `.env.example`,
`scripts/macos/install-router.sh`, `scripts/macos/uninstall-router.sh`,
`scripts/preflight.sh`, and `scripts/qoder-smoke.sh` from
`CMM Subscription Router` to `CMM Routers`. Do **not** rename the legacy
LaunchAgent/Keychain/Qoder IDs embedded in those scripts.

- [ ] **Step 4: Run focused tests**

Run:

```bash
npx vitest run \
  tests/integration/cmm-routers-branding.test.ts \
  tests/integration/launchagent.test.ts \
  tests/integration/launchd-deterministic.test.ts \
  tests/integration/launchd-fail-closed.test.ts \
  tests/integration/qoder-bearer-provisioning.test.ts
```

Expected: PASS. Existing launchd/Keychain tests prove compatibility IDs were not
accidentally renamed.

- [ ] **Step 5: Run static scope checks**

Run:

```bash
git diff --check
git diff -- package.json package-lock.json .env.example src/index.ts src/providers/codex/adapter.ts scripts/capture-bundle.sh scripts/macos/install-router.sh scripts/macos/uninstall-router.sh scripts/preflight.sh scripts/qoder-smoke.sh tests/integration/cmm-routers-branding.test.ts
```

Expected: only identity/comment changes described above.

- [ ] **Step 6: Commit Task 1**

```bash
git add \
  package.json package-lock.json .env.example \
  src/index.ts src/providers/codex/adapter.ts \
  scripts/capture-bundle.sh scripts/macos/install-router.sh \
  scripts/macos/uninstall-router.sh scripts/preflight.sh scripts/qoder-smoke.sh \
  tests/integration/cmm-routers-branding.test.ts

git commit -m "chore: rename current product identity to CMM Routers"
```

---

### Task 2: Replace the public README and update living documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/macos-install.md`
- Modify: `docs/qoder-setup.md`
- Modify: `docs/qoder-acceptance.md`
- Modify: `tests/integration/cmm-routers-branding.test.ts`

**Interfaces:**
- Consumes: canonical names and compatibility boundary from Task 1.
- Produces: an English public-facing product story where CMMChat Router and CMM Code Router are the two profiles and Qoder is a supported consumer.

- [ ] **Step 1: Extend the branding contract test for living documentation**

Add to `tests/integration/cmm-routers-branding.test.ts`:

```ts
it("documents the two canonical profiles and legacy compatibility boundary", () => {
  const readme = read("README.md");
  const install = read("docs/macos-install.md");
  const qoderSetup = read("docs/qoder-setup.md");
  const qoderAcceptance = read("docs/qoder-acceptance.md");

  expect(readme).toContain("# CMM Routers");
  expect(readme).toContain(
    "Use the AI subscriptions you already pay for, from the tools you actually want to use."
  );
  expect(readme).toContain("CMMChat Router");
  expect(readme).toContain("CHAT_ONLY");
  expect(readme).toContain("CMM Code Router");
  expect(readme).toContain("CHAT_AND_TOOLS");
  expect(readme).toContain("Qoder");
  expect(readme).toContain("legacy compatibility");

  for (const currentDoc of [install, qoderSetup, qoderAcceptance]) {
    expect(currentDoc).toContain("CMM Routers");
  }
});
```

Also add a negative assertion ensuring the README does not present the obsolete
all-provider `CHAT_ONLY` matrix as current truth. Use the exact obsolete table
header/row text that exists in the pre-Task-17 README so the test fails before
the rewrite and passes after it is removed.

- [ ] **Step 2: Run the documentation contract test and verify failure**

```bash
npx vitest run tests/integration/cmm-routers-branding.test.ts
```

Expected: FAIL because the README/living docs still present the old identity.

- [ ] **Step 3: Rewrite `README.md` as the concise public landing page**

Use this exact top-level structure:

```md
# CMM Routers

> Use the AI subscriptions you already pay for, from the tools you actually want to use.

## Profiles
### CMMChat Router — `CHAT_ONLY`
### CMM Code Router — `CHAT_AND_TOOLS`

## Architecture
## Supported providers
## Security invariants
## Supported clients
## Setup
## Legacy compatibility identifiers
## Verification
## Roadmap
```

Required content:

- explain that CMM Routers is local-first and subscription-backed;
- state that CMMChat Router never owns or executes external tools;
- state that CMM Code Router lets the client/harness own tools;
- name Qoder as a supported client, not as the Router identity;
- state no PAYG fallback, no cross-provider fallback, no unknown-model fallback;
- state loopback-only operation and local credential storage;
- state provider reasoning / client tool ownership;
- list ChatGPT/Codex, Claude, Google/Antigravity and Command Code truthfully,
  without claiming Command Code live quota enablement that Task 15 has not
  completed;
- explain that `com.cmm.subscription-router`, `cmm-subscription-router`, and
  `qoder-custom-cmm-router` are retained compatibility identifiers;
- link to the current installation and Qoder setup docs with relative links;
- do not copy historical audit narratives into the README.

- [ ] **Step 4: Update living docs**

In `docs/macos-install.md`:

- title/current product references become `CMM Routers`;
- documented canonical checkout path becomes `$HOME/CMM-Routers`;
- remove user-specific examples such as `/Users/example/...`;
- keep actual Keychain service commands using `cmm-subscription-router`;
- add a note directly beside those commands explaining that this is a legacy
  compatibility service ID.

In `docs/qoder-setup.md`:

- title/current product references become `CMM Routers`;
- describe Qoder as a `CMM Code Router` consumer;
- remove obsolete claims that all routes are currently `CHAT_ONLY`;
- document that the Qoder provider ID `qoder-custom-cmm-router` is intentionally
  retained for compatibility;
- mention that externally editing `~/.qoder/settings.json` requires a complete
  Qoder restart before the UI reflects the changed model metadata.

In `docs/qoder-acceptance.md`:

- rename current product references;
- ensure current acceptance criteria describe Qoder as `CHAT_AND_TOOLS` where
  provider/model capability is actually supported;
- preserve historical evidence links/names when they refer to artifacts created
  under the old project name.

- [ ] **Step 5: Run documentation and relevant Qoder tests**

```bash
npx vitest run \
  tests/integration/cmm-routers-branding.test.ts \
  tests/http/consumer-capability.test.ts \
  tests/http/tool-loop-contract.test.ts \
  tests/http/reasoning-effort-vision-wiring.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```bash
git add README.md docs/macos-install.md docs/qoder-setup.md docs/qoder-acceptance.md tests/integration/cmm-routers-branding.test.ts
git commit -m "docs: present CMM Routers public architecture"
```

---

### Task 3: Remove current user-specific path fixtures without rewriting historical branding

**Files:**
- Modify: `tests/providers/antigravity-adapter.test.ts`
- Modify: `tests/providers/antigravity-mcp-registration.test.ts`
- Modify: `tests/providers/claude-environment.test.ts`
- Modify: `tests/integration/cmm-routers-branding.test.ts`

**Interfaces:**
- Consumes: canonical final path `$HOME/CMM-Routers`.
- Produces: path-independent tests suitable for a public repo and a guard against reintroducing current user-specific paths.

- [ ] **Step 1: Add a current-surface privacy/path guard**

Extend `tests/integration/cmm-routers-branding.test.ts`:

```ts
it("keeps current public surfaces free of user-specific home paths", () => {
  const currentFiles = [
    "README.md",
    "docs/macos-install.md",
    "docs/qoder-setup.md",
    "docs/qoder-acceptance.md",
    "tests/providers/antigravity-adapter.test.ts",
    "tests/providers/antigravity-mcp-registration.test.ts",
    "tests/providers/claude-environment.test.ts",
  ];

  for (const path of currentFiles) {
    const text = read(path);
    expect(text).not.toMatch(/\/Users\/(?:chris|christian)\//i);
  }
});
```

- [ ] **Step 2: Run the test and verify it fails against current fixtures**

```bash
npx vitest run tests/integration/cmm-routers-branding.test.ts
```

Expected: FAIL on the known `/Users/example/...` and `/Users/example/...`
current/live examples.

- [ ] **Step 3: Generalize the three current test fixtures**

In `tests/providers/antigravity-adapter.test.ts`, replace the literal old
personal repository path used only as a negative fixture with a generic path
such as:

```ts
"/Users/example/CMM-Routers"
```

Prefer asserting the semantic property (provider does not run in the Router
repo) rather than matching branding.

In `tests/providers/antigravity-mcp-registration.test.ts`, replace:

```text
/Users/example/CMM-Subscription-Router/dist/bridge/mcp-bridge-launcher.js
```

with a generic fixture:

```text
/Users/example/CMM-Routers/dist/bridge/mcp-bridge-launcher.js
```

in both the CLI-output fixture and expected registration args.

In `tests/providers/claude-environment.test.ts`, replace a brand-specific
negative regex such as:

```ts
expect(env.PWD).not.toMatch(/CMM-Subscription-Router/);
```

with an assertion against the exact generic Router repo fixture used by that
test, or assert that `PWD` equals the intended isolated working directory. Do
not make production behavior depend on the repository name.

- [ ] **Step 4: Run focused provider tests**

```bash
npx vitest run \
  tests/integration/cmm-routers-branding.test.ts \
  tests/providers/antigravity-adapter.test.ts \
  tests/providers/antigravity-mcp-registration.test.ts \
  tests/providers/claude-environment.test.ts
```

Expected: PASS.

- [ ] **Step 5: Confirm historical files were not mass-rebranded**

Run:

```bash
git diff --name-only 725ef1e2a29c2dc5e1f5cce6298a9fef8c6f2224...HEAD -- docs/audits docs/task-13-closure.md docs/task-14-codex-post-tool-continuation.md
```

Expected: no Task 17 branding rewrite of those historical evidence files.

Also run:

```bash
git grep -n "CMM_SUBSCRIPTION_ROUTER_" -- docs/audits docs/task-13-closure.md docs/task-14-codex-post-tool-continuation.md | head -20
```

Expected: historical markers still exist.

- [ ] **Step 6: Commit Task 3**

```bash
git add \
  tests/integration/cmm-routers-branding.test.ts \
  tests/providers/antigravity-adapter.test.ts \
  tests/providers/antigravity-mcp-registration.test.ts \
  tests/providers/claude-environment.test.ts

git commit -m "test: make router path fixtures public-safe"
```

---

### Task 4: Pre-rename full verification gate

**Files:**
- No tracked changes expected.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: evidence that the in-repository migration is green before any physical path or GitHub mutation.

- [ ] **Step 1: Verify branch, clean tree and expected commits**

```bash
git branch --show-current
git status --short
git log --oneline --decorate -5
```

Expected:

- branch `feature/task17-cmm-routers-migration`;
- clean worktree;
- Task 17 design and implementation commits present.

- [ ] **Step 2: Run the complete test suite exactly once from the current repo**

```bash
npx vitest run
```

Expected: all tests pass; existing intentional skips may remain.

- [ ] **Step 3: Run typecheck and build**

```bash
npm run typecheck
npm run build
```

Expected: both exit 0.

- [ ] **Step 4: Run security audit**

```bash
bash scripts/security-audit.sh
```

Expected: PASS markers for fail-closed routing/security invariants, including no
PAYG/cross-provider escalation and CMMChat tool escalation none.

- [ ] **Step 5: Run current-brand and legacy-ID static checks**

```bash
git grep -nE 'CMM Subscription Router|CMM-Subscription-Router' -- \
  README.md .env.example src scripts docs/macos-install.md docs/qoder-setup.md docs/qoder-acceptance.md \
  ':!scripts/macos/run-router.sh'
```

Review every remaining hit. Allowed hits are only explicit compatibility
explanations, the legacy log directory, or references to historical artifact
names. Current product identity must not still be old branding.

Run:

```bash
git grep -nE 'com\.cmm\.subscription-router|cmm-subscription-router|qoder-custom-cmm-router' -- \
  launchd scripts src tests docs/macos-install.md docs/qoder-setup.md README.md
```

Expected: legacy IDs still exist and are documented as compatibility identifiers.

- [ ] **Step 6: Do not continue if any pre-rename gate fails**

No physical rename is permitted until Steps 2–5 are green. Fix only the specific
Task 17 regression, rerun the failing focused test, then rerun this full gate.

---

### Task 5: Rename the local repository and repair path-bound local registrations

**Files:**
- No tracked file changes are expected from the directory rename itself.
- Tracked changes are allowed only if post-rename verification proves a genuine
  hard-coded current-path defect that survived Tasks 1–4.

**Interfaces:**
- Consumes: a clean, fully green feature branch in `$HOME/CMM-Subscription-Router`.
- Produces: the same Git repository at `$HOME/CMM-Routers`, with local launchd and provider registrations referring to valid current paths.

- [ ] **Step 1: Record pre-rename local state without printing secrets**

Record:

```bash
OLD="$HOME/CMM-Subscription-Router"
NEW="$HOME/CMM-Routers"

test -d "$OLD/.git"
test ! -e "$NEW"

git -C "$OLD" rev-parse HEAD
git -C "$OLD" status --porcelain
launchctl print "gui/$(id -u)/com.cmm.subscription-router" >/dev/null 2>&1 && echo "LAUNCHAGENT_LOADED=YES" || echo "LAUNCHAGENT_LOADED=NO"
```

Do not print Keychain values. Do not dump environment variables containing
tokens.

- [ ] **Step 2: Rename the directory atomically**

```bash
mv "$OLD" "$NEW"
cd "$NEW"
```

Verify:

```bash
test -d "$NEW/.git"
test ! -e "$OLD"
git rev-parse HEAD
git status --short
```

Expected: same HEAD, clean tree.

- [ ] **Step 3: Refresh the existing LaunchAgent installation from the new path**

Because the LaunchAgent label intentionally remains
`com.cmm.subscription-router`, use the existing installer from the renamed repo:

```bash
bash scripts/macos/install-router.sh
```

Then verify only metadata/path state, not secrets:

```bash
launchctl print "gui/$(id -u)/com.cmm.subscription-router" >/dev/null
```

If the installer prints a documented manual reload command rather than loading
automatically, follow exactly that script's supported workflow. Do not invent a
new LaunchAgent label.

- [ ] **Step 4: Verify no current local registration still depends on the old repo path**

Use read-only path checks:

```bash
grep -RIl --fixed-strings "$HOME/CMM-Subscription-Router" \
  "$HOME/Library/LaunchAgents" \
  "$HOME/.qoder" \
  2>/dev/null || true
```

Do not print matching file contents because local Qoder files may contain
credentials.

Any hit must be classified:

- historical/local log reference: harmless;
- active executable/bridge path: must be refreshed through the owning supported
  installer/registration code;
- credential file: do not print or copy its secret contents.

For Antigravity MCP registration, invoke the Router's existing supported
registration/discovery path rather than editing provider state manually. Verify
the resulting registration points to `$HOME/CMM-Routers/dist/bridge/...`.

- [ ] **Step 5: Run focused path-sensitive tests from the new directory**

```bash
npx vitest run \
  tests/integration/cmm-routers-branding.test.ts \
  tests/integration/launchagent.test.ts \
  tests/integration/launchd-deterministic.test.ts \
  tests/providers/antigravity-mcp-registration.test.ts \
  tests/providers/claude-environment.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run full verification from `$HOME/CMM-Routers`**

```bash
npx vitest run
npm run typecheck
npm run build
bash scripts/security-audit.sh
```

Expected: all green.

If a test fails solely because production code assumes the literal old repo
path, add the smallest failing regression test, fix that path dependency, commit
it as:

```bash
git commit -m "fix: remove legacy repository path dependency"
```

Then rerun the full Task 5 verification. Do not broaden the fix into identifier
renames.

---

### Task 6: Rename or create the GitHub repository and configure `origin` without pushing

**Files:**
- No tracked file changes expected unless a living document contains an actual
  old canonical GitHub URL that must be changed.

**Interfaces:**
- Consumes: final local repo at `$HOME/CMM-Routers`.
- Produces: GitHub repository name `CMM-Routers` and a verified `origin`, with no push.

- [ ] **Step 1: Verify GitHub CLI state safely**

```bash
cd "$HOME/CMM-Routers"
command -v gh
gh auth status
git remote -v
```

Do not print auth tokens.

- [ ] **Step 2: Branch according to actual remote state**

If `origin` exists and points to the existing Router GitHub repository, rename
that repository through `gh` from repository context:

```bash
gh repo rename CMM-Routers
```

Then refresh/verify the canonical remote URL returned by GitHub and set it only
if Git did not update it automatically:

```bash
git remote -v
```

If no Git remote exists, which was the discovery state at the start of Task 17,
create the public GitHub repository from the authenticated account **without
pushing**:

```bash
gh repo create CMM-Routers --public --source "$HOME/CMM-Routers" --remote origin
```

Do **not** add `--push`.

If `CMM-Routers` already exists under the authenticated account, do not overwrite
or recreate it. Inspect it with:

```bash
gh repo view CMM-Routers
```

and configure `origin` only after confirming it is the intended repository.

- [ ] **Step 3: Verify remote name and no push**

```bash
git remote -v
git status -sb
```

Expected:

- `origin` refers to the real `CMM-Routers` GitHub repository;
- local commits may be ahead because no push is authorized;
- no push has occurred.

- [ ] **Step 4: Update any living canonical repo URL only if one actually exists**

Search:

```bash
git grep -nE 'github\.com/.*/CMM-Subscription-Router' -- README.md docs scripts src package.json || true
```

If there are current living links, replace only those with the verified
`CMM-Routers` remote URL. Do not rewrite historical artifact references.

If a tracked file changes, run:

```bash
npx vitest run tests/integration/cmm-routers-branding.test.ts
git diff --check
git add <only-the-changed-living-files>
git commit -m "docs: point living links to CMM Routers"
```

If there are no living old GitHub URLs, make no commit.

---

### Task 7: Write closure evidence, integrate Task 17 locally, and perform final verification

**Files:**
- Create: `docs/task-17-cmm-routers-migration.md`

**Interfaces:**
- Consumes: verified local rename and verified GitHub remote state.
- Produces: auditable Task 17 closure on local `main`, without push.

- [ ] **Step 1: Create the closure document with actual observed state**

Create `docs/task-17-cmm-routers-migration.md` in English. It must record:

```md
# Task 17 — CMM Routers Migration

## Final identity
- Product: CMM Routers
- Repository: CMM-Routers
- Local path: $HOME/CMM-Routers
- Package: cmm-routers

## Profiles
- CMMChat Router: CHAT_ONLY
- CMM Code Router: CHAT_AND_TOOLS where provider/model capability supports it
- Qoder: supported CMM Code Router consumer

## Preserved compatibility identifiers
- com.cmm.subscription-router
- cmm-subscription-router
- qoder-custom-cmm-router

## Verification
- focused branding tests: PASS
- full suite: PASS
- typecheck: PASS
- build: PASS
- security audit: PASS
- post-directory-rename verification: PASS
- GitHub repository/remote: record actual observed final state
- push performed: NO
```

Add exact commit hashes and exact test counts from the actual final run. Never
invent counts.

- [ ] **Step 2: Commit closure evidence on the feature branch**

```bash
git add docs/task-17-cmm-routers-migration.md
git diff --cached --check
git commit -m "docs: close CMM Routers migration"
```

- [ ] **Step 3: Run final feature-branch verification after the closure commit**

```bash
npx vitest run
npm run typecheck
npm run build
bash scripts/security-audit.sh
git status --short
```

Expected: all green and clean.

- [ ] **Step 4: Integrate locally into `main` with no push**

```bash
FEATURE="feature/task17-cmm-routers-migration"
git switch main
git merge --ff-only "$FEATURE"
```

Expected: fast-forward only. If `main` has diverged, stop; do not create a merge
commit or rebase without reviewing the divergence.

- [ ] **Step 5: Run the final main-only verification from the canonical path**

From `$HOME/CMM-Routers`:

```bash
npx vitest run
npm run typecheck
npm run build
bash scripts/security-audit.sh
git status --short
git log -1 --oneline --decorate
git remote -v
```

Expected:

- full suite PASS;
- typecheck PASS;
- build PASS;
- security audit PASS;
- branch `main`;
- clean working tree;
- repository path `$HOME/CMM-Routers`;
- remote repository named `CMM-Routers`;
- no push performed.

- [ ] **Step 6: Emit Task 17 closure evidence outside the repo**

Create a local verification artifact in:

```text
$HOME/Library/Mobile Documents/com~apple~CloudDocs/Downloads/CMM-Routers-task17-final-verification.txt
```

It should include only non-secret state:

- final path;
- branch;
- HEAD;
- commit subject;
- package name;
- profile names/capabilities;
- preserved compatibility-ID checks;
- focused/full test results and counts;
- typecheck/build/security status;
- remote URL with any userinfo redacted;
- `PUSH_PERFORMED=NO`;
- `TASK17_STATUS=CLOSED_PASS`.

No Keychain secret values, bearer values, OAuth tokens, prompts, tool arguments,
or completion contents may appear.

---

## Plan Self-Review

### Spec coverage

- Product/repo/package identity: Tasks 1, 2, 6.
- CMMChat Router / CMM Code Router public structure: Task 2.
- Legacy compatibility IDs preserved: Tasks 1, 2, 4, 5.
- Historical evidence not rebranded: Tasks 1, 3, 4.
- Public-safe current paths: Task 3.
- Runtime semantics preserved: Tasks 1, 4, 5, 7.
- Physical local rename: Task 5.
- GitHub rename/create + origin: Task 6.
- Final closure and local main integration: Task 7.
- No push: Global Constraints, Tasks 6 and 7.
- Task 15 / Task 16B excluded: Global Constraints.

### Placeholder scan

The plan contains no unresolved placeholders or unspecified error-handling steps. Conditional GitHub/local-registration branches are based on observed state and include exact commands for each supported case.

### Type/interface consistency

No new runtime API or data type is introduced by Task 17. The only runtime-adjacent identity fields are the existing Codex `clientInfo.name` / `clientInfo.title` and startup display string. Existing compatibility IDs and capability types remain unchanged.
