# CMM Routers Sanitized Public Publication Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic one-way publication pipeline that derives the public CMM Routers tree from one committed internal source SHA, proves that only approved sanitization transformations occurred, creates a noreply public-staging commit, stops before network publication, and provides separate guarded push and fresh-clone verification commands.

**Architecture:** `$HOME/CMM-Routers` remains the sole development source and `$HOME/CMM-Routers-Public-Staging` remains an unrelated curated public Git history. A pure Node policy layer performs deterministic text sanitization and privacy classification; shell orchestration uses `git archive` to create immutable candidates, runs all release gates before mutating staging, creates a normal descendant public commit, and leaves push as a separate explicit action. Public verification always reasons from exact SHAs and never imports internal Git ancestry.

**Tech Stack:** Bash 3.2-compatible shell, Node.js ESM (`.mjs`), Git, npm, Vitest 5, existing TypeScript build/typecheck, existing `scripts/security-audit.sh`; no new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-09-11-cmm-routers-publication-pipeline-design.md`

## Global Constraints

- `$HOME/CMM-Routers` is the only development source of truth.
- `$HOME/CMM-Routers-Public-Staging` owns the independent public Git history.
- Never merge, rebase, graft, replace-ref, subtree, filter, or otherwise connect internal Git ancestry to public history.
- Publication input is one explicit committed internal SHA exported with `git archive`.
- Internal and public-staging worktrees must be clean before a publication operation.
- Known personal home paths are normalized generically to `/Users/example/`; high-confidence secrets are blockers, never auto-redacted.
- Unexplained textual or binary tree differences are blockers.
- Public commits must use the existing public GitHub noreply identity.
- Preparation and push are separate commands; preparation must stop at `READY_FOR_EXPLICIT_PUSH_APPROVAL`.
- Push must never use `--force`.
- Ambiguous push outcomes must query the remote before any retry.
- Release verification must support a fresh clone and run clean install, build, deterministic tests, typecheck, security audit, privacy/history checks, and worktree cleanliness.
- Existing Router invariants remain unchanged: no PAYG fallback, no cross-provider fallback, no unknown-model fallback, loopback-only runtime, consumer-owned tools, no provider-native repo mutation, no normal-runtime prompt/completion/tool-content logging, no tracked credentials.
- Task 15 and Task 16B are outside this plan.
- Do not add third-party dependencies for this pipeline.

---

## File Structure

Create a focused publication subsystem:

- `scripts/publication/lib/policy.mjs` — pure deterministic sanitization, text/binary classification, privacy blockers, secret-like review classification.
- `scripts/publication/lib/tree.mjs` — candidate-tree walking, SHA-256 hashing, allowed-difference proof, tracked-file-set comparison.
- `scripts/publication/prepare-publication.sh` — fail-closed internal-SHA export, candidate verification, staging update, public commit, evidence, and mandatory stop-before-push.
- `scripts/publication/push-publication.sh` — explicit guarded publication of one exact prepared public commit.
- `scripts/publication/verify-publication.sh` — independent remote/fresh-clone verification of one exact public SHA.
- `tests/publication/policy.test.ts` — pure policy tests, including secrets and privacy fixtures.
- `tests/publication/tree-proof.test.ts` — allowed-difference and unexplained-difference tests.
- `tests/publication/prepare-publication.test.ts` — temporary internal/staging Git repositories proving ancestry isolation and stop-before-push.
- `tests/publication/push-publication.test.ts` — local bare-remote tests for predecessor guards, exact ref update, and no-force behavior.
- `tests/publication/verify-publication.test.ts` — local fresh-clone tests for exact SHA/history verification.
- `docs/publication.md` — user-facing maintenance workflow and invariant explanation.
- `.gitignore` — add only a repository-local publication scratch/evidence pattern if implementation tests require one; prefer external temp/state paths so this modification is unnecessary.

No production Router source under `src/` needs to change.

---

### Task 1: Deterministic Sanitization and Privacy Policy

**Files:**
- Create: `scripts/publication/lib/policy.mjs`
- Create: `tests/publication/policy.test.ts`

**Interfaces:**
- Produces:
  - `SANITIZATION_POLICY_VERSION: string`
  - `isProbablyText(buffer: Buffer): boolean`
  - `sanitizeText(input: string): { text: string; events: SanitizationEvent[] }`
  - `scanText(path: string, input: string): ScanFinding[]`
  - `classifySecretLikeLiteral(path: string, value: string, context: string): "BLOCK" | "REVIEW_TEST_FIXTURE" | "SAFE_TEST_FIXTURE"`
  - `SanitizationEvent = { rule: string; count: number }`
  - `ScanFinding = { severity: "BLOCK" | "REVIEW"; rule: string; path: string; line: number; valueSha256?: string }`
- Consumes: Node standard library only.

- [ ] **Step 1: Write failing policy tests**

Create `tests/publication/policy.test.ts` with tests equivalent to:

```ts
import { describe, expect, it } from "vitest";
import {
  SANITIZATION_POLICY_VERSION,
  isProbablyText,
  sanitizeText,
  scanText,
  classifySecretLikeLiteral,
} from "../../scripts/publication/lib/policy.mjs";

describe("public publication policy", () => {
  it("normalizes generic macOS home paths without embedding the real username in policy", () => {
    const result = sanitizeText("Path: /Users/example/projects/CMM-Routers\n");
    expect(result.text).toBe("Path: /Users/example/projects/CMM-Routers\n");
    expect(result.events).toContainEqual({ rule: "macos-home-path", count: 1 });
  });

  it("normalizes trailing ASCII/NBSP whitespace and final newline", () => {
    const result = sanitizeText("a  \n" + "b\u00a0\n" + "c");
    expect(result.text).toBe("a\nb\nc\n");
  });

  it("does not rewrite binary buffers", () => {
    expect(isProbablyText(Buffer.from([0, 1, 2, 0, 255]))).toBe(false);
  });

  it("blocks known provider credential shapes rather than redacting them", () => {
    const findings = scanText("docs/example.md", "token=sk-" + "a".repeat(40));
    expect(findings.some((f) => f.severity === "BLOCK")).toBe(true);
  });

  it("permits deterministic human-readable auth fixtures only under tests", () => {
    expect(
      classifySecretLikeLiteral(
        "tests/http/example.test.ts",
        "tool-loop-qoder-secret",
        "const BEARER ="
      )
    ).toBe("SAFE_TEST_FIXTURE");
    expect(
      classifySecretLikeLiteral(
        "src/example.ts",
        "tool-loop-qoder-secret",
        "const BEARER ="
      )
    ).toBe("BLOCK");
  });

  it("publishes a non-empty policy version", () => {
    expect(SANITIZATION_POLICY_VERSION).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}\./);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run tests/publication/policy.test.ts
```

Expected: FAIL because `scripts/publication/lib/policy.mjs` does not exist.

- [ ] **Step 3: Implement the minimal pure policy module**

Implement `policy.mjs` with these exact behavioral rules:

```js
export const SANITIZATION_POLICY_VERSION = "2026-09-11.1";

export function isProbablyText(buffer) {
  return !buffer.subarray(0, 8192).includes(0);
}

export function sanitizeText(input) {
  const events = [];
  let text = input.replace(/\/Users\/[^/\s]+(?=\/)/g, () => {
    events.push({ rule: "macos-home-path", count: 1 });
    return "/Users/example";
  });

  text = text
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\u00a0]+$/u, ""))
    .join("\n")
    .replace(/\n*$/u, "\n");

  const collapsed = new Map();
  for (const event of events) {
    collapsed.set(event.rule, (collapsed.get(event.rule) ?? 0) + event.count);
  }

  return {
    text,
    events: [...collapsed].map(([rule, count]) => ({ rule, count })),
  };
}
```

Extend it with blocker-only credential signatures for private keys, GitHub tokens, OpenAI-style `sk-` tokens, Google API keys, AWS access keys, Slack tokens, and JWT-like bearer material. Do not include or log any real secret values; review findings carry SHA-256 only.

Implement `SAFE_TEST_FIXTURE` only when all of these are true: path begins `tests/`, value has no known vendor-secret shape, value is human-readable word/hyphen material, and context indicates auth/test semantics. Otherwise return `REVIEW_TEST_FIXTURE` or `BLOCK`.

- [ ] **Step 4: Run focused policy tests**

Run:

```bash
npx vitest run tests/publication/policy.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run security audit to prove the policy module itself introduced no tracked secret**

Run:

```bash
bash scripts/security-audit.sh
```

Expected: `SECURITY_AUDIT=PASS`.

- [ ] **Step 6: Commit Task 1**

```bash
git add scripts/publication/lib/policy.mjs tests/publication/policy.test.ts
git commit -m "feat: add public publication sanitization policy"
```

---

### Task 2: Candidate Tree and Allowed-Difference Proof

**Files:**
- Create: `scripts/publication/lib/tree.mjs`
- Create: `tests/publication/tree-proof.test.ts`

**Interfaces:**
- Consumes:
  - `sanitizeText()` and `isProbablyText()` from Task 1.
- Produces:
  - `hashFile(path: string): Promise<string>`
  - `listTreeFiles(root: string): Promise<string[]>`
  - `sanitizeCandidateTree(rawRoot: string, candidateRoot: string): Promise<SanitizeTreeResult>`
  - `proveAllowedDifferences(rawRoot: string, candidateRoot: string): Promise<TreeProof>`
  - `SanitizeTreeResult = { files: number; transformedFiles: number; events: Record<string, number> }`
  - `TreeProof = { sameFileSet: boolean; binaryDifferences: number; canonicalTextDifferences: number; unexplainedDifferences: string[] }`

- [ ] **Step 1: Write failing tree-proof tests**

Create temporary raw/candidate directories and assert:

```ts
it("accepts only policy-derived text differences", async () => {
  await writeRaw("docs/a.md", "Path /Users/example/CMM-Routers  \n");
  await sanitizeCandidateTree(raw, candidate);
  const proof = await proveAllowedDifferences(raw, candidate);
  expect(proof).toMatchObject({
    sameFileSet: true,
    binaryDifferences: 0,
    canonicalTextDifferences: 0,
    unexplainedDifferences: [],
  });
});

it("rejects a candidate-only file", async () => {
  await sanitizeCandidateTree(raw, candidate);
  await fs.writeFile(join(candidate, "extra.txt"), "not from source\n");
  const proof = await proveAllowedDifferences(raw, candidate);
  expect(proof.sameFileSet).toBe(false);
});

it("rejects unexplained binary mutation", async () => {
  await writeRaw("fixture.bin", Buffer.from([1, 2, 3, 0]));
  await sanitizeCandidateTree(raw, candidate);
  await fs.writeFile(join(candidate, "fixture.bin"), Buffer.from([1, 9, 3, 0]));
  const proof = await proveAllowedDifferences(raw, candidate);
  expect(proof.binaryDifferences).toBe(1);
});
```

- [ ] **Step 2: Verify RED**

```bash
npx vitest run tests/publication/tree-proof.test.ts
```

Expected: FAIL because the tree module does not exist.

- [ ] **Step 3: Implement tree sanitization and proof**

Requirements:

1. Recursively enumerate regular files and symlinks in stable byte-sorted relative-path order.
2. Preserve binary bytes exactly.
3. For text files, write exactly `sanitizeText(rawText).text`.
4. Preserve executable bit when copying from the raw export.
5. Refuse sockets/devices/FIFOs.
6. `proveAllowedDifferences()` must re-sanitize every raw text file in memory and compare it to candidate bytes; it must never assume that a changed text file is allowed merely because it is text.
7. File-set differences and binary differences are blockers.
8. Do not follow symlinks outside either tree.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run tests/publication/tree-proof.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add scripts/publication/lib/tree.mjs tests/publication/tree-proof.test.ts
git commit -m "feat: prove sanitized public tree provenance"
```

---

### Task 3: Prepare-Publication Gate and Independent Public Commit

**Files:**
- Create: `scripts/publication/prepare-publication.sh`
- Create: `tests/publication/prepare-publication.test.ts`
- Modify: `package.json` only if a convenience npm script is useful; no dependency changes.

**Interfaces:**
- Consumes:
  - policy and tree modules from Tasks 1–2;
  - existing `scripts/security-audit.sh`;
  - existing npm `build` and `typecheck` scripts.
- Produces CLI:

```text
scripts/publication/prepare-publication.sh \
  --internal-repo <path> \
  --public-staging <path> \
  --source-sha <40-hex> \
  --message <public commit subject>
```

- Produces final marker:
  - `PUBLICATION_PREPARE_STATUS=READY_FOR_EXPLICIT_PUSH_APPROVAL`
- Must never run `git push`.

- [ ] **Step 1: Write the temporary-repository integration test**

The test must create:

1. an internal repo with two commits;
2. an unrelated public-staging repo with one root commit;
3. a local bare remote pointing at the public root;
4. source content containing `/Users/example/...`;
5. a synthetic test bearer fixture under `tests/`.

Assert after invoking prepare:

```ts
expect(result.stdout).toContain(
  "PUBLICATION_PREPARE_STATUS=READY_FOR_EXPLICIT_PUSH_APPROVAL"
);
expect(result.stdout).toContain("PUSH_PERFORMED=NO");
expect(publicCommitCount).toBe(2);
expect(publicParent).toBe(previousPublicHead);
expect(publicHistory).not.toContain(internalCommit1);
expect(publicHistory).not.toContain(internalCommit2);
expect(publishedDoc).toContain("/Users/example/");
expect(remoteHead).toBe(previousPublicHead);
```

Add negative cases for dirty internal worktree, dirty public staging, non-ancestor/unexpected public remote predecessor, and a high-confidence secret in the selected source commit.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run tests/publication/prepare-publication.test.ts
```

Expected: FAIL because the prepare script does not exist.

- [ ] **Step 3: Implement fail-closed prechecks**

`prepare-publication.sh` must:

1. parse all required arguments and reject unknown arguments;
2. verify both repositories exist;
3. require clean internal and public worktrees;
4. resolve `source-sha^{commit}` and require it equals the supplied SHA;
5. require public staging current branch is `main`;
6. require configured public origin exists;
7. query `refs/heads/main` and require it equals current public staging HEAD;
8. require every existing public commit author and committer email ends in `@users.noreply.github.com`;
9. create all scratch directories with `mktemp -d`;
10. install an EXIT trap that removes scratch state.

- [ ] **Step 4: Implement immutable export and candidate gates**

The script must:

```bash
git -C "$INTERNAL" archive --format=tar "$SOURCE_SHA" | tar -xf - -C "$RAW"
node scripts/publication/lib/tree.mjs sanitize "$RAW" "$CANDIDATE"
node scripts/publication/lib/tree.mjs prove "$RAW" "$CANDIDATE"
node scripts/publication/lib/policy.mjs scan-tree "$CANDIDATE"
```

The Node CLIs must emit machine-readable `KEY=VALUE` markers and non-zero status on blockers.

Then run against the candidate, not the internal worktree:

```bash
npm ci
npm run build
npx vitest run
npm run typecheck
bash scripts/security-audit.sh
```

Expected release gates:

```text
PUBLIC_CANDIDATE_ALLOWED_TRANSFORM_ONLY=PASS
PUBLIC_CANDIDATE_PRIVACY_SCAN=PASS
PUBLIC_CANDIDATE_BUILD=PASS
PUBLIC_CANDIDATE_FULL_TEST_SUITE=PASS
PUBLIC_CANDIDATE_TYPECHECK=PASS
PUBLIC_CANDIDATE_SECURITY_AUDIT=PASS
```

- [ ] **Step 5: Implement staging update only after candidate gates pass**

After every candidate gate passes:

1. copy the candidate tracked tree into a second temporary directory;
2. use a delete-capable sync into public staging while explicitly excluding `.git`;
3. verify `.git` directory inode/path still belongs to the original staging repo;
4. run the allowed-difference proof again against staging working-tree bytes;
5. `git add -A`;
6. `git diff --cached --check`;
7. refuse an empty public diff;
8. derive public author name/email from the previous public commit;
9. require the derived email is noreply;
10. create a normal descendant commit with the provided public subject;
11. verify exactly one parent equal to the prior public HEAD.

Do not copy the internal `.git` directory or use `git reset --hard` to an internal object.

- [ ] **Step 6: Emit durable prepare evidence and stop**

Evidence directory:

```bash
EVIDENCE_DIR="${CMM_ROUTERS_EVIDENCE_DIR:-$HOME/.cmm-routers/publication-evidence}"
```

Report must include:

```text
INTERNAL_SOURCE_SHA=<sha>
PUBLIC_PREDECESSOR_SHA=<sha>
PUBLIC_PREPARED_SHA=<sha>
SANITIZATION_POLICY_VERSION=<version>
INTERNAL_GIT_ANCESTRY_IMPORTED=NO
PUBLIC_WORKTREE_CLEAN=YES
PUSH_PERFORMED=NO
PUBLICATION_PREPARE_STATUS=READY_FOR_EXPLICIT_PUSH_APPROVAL
```

Also write a `.sha256` for the report.

- [ ] **Step 7: Verify prepare integration GREEN**

```bash
npx vitest run tests/publication/prepare-publication.test.ts
```

Expected: PASS, including remote still unchanged.

- [ ] **Step 8: Run existing build/security gates**

```bash
npm run build
npm run typecheck
bash scripts/security-audit.sh
```

Expected: PASS.

- [ ] **Step 9: Commit Task 3**

```bash
git add scripts/publication/prepare-publication.sh tests/publication/prepare-publication.test.ts package.json
git commit -m "feat: add guarded public publication preparation"
```

Omit `package.json` from `git add` if no convenience script was added.

---

### Task 4: Explicit Push with Remote-Predecessor and Ambiguous-Outcome Safety

**Files:**
- Create: `scripts/publication/push-publication.sh`
- Create: `tests/publication/push-publication.test.ts`

**Interfaces:**
- Produces CLI:

```text
scripts/publication/push-publication.sh \
  --public-staging <path> \
  --expected-head <40-hex> \
  --expected-remote-predecessor <40-hex> \
  [--transport origin|ssh]
```

- Success marker:
  - `PUBLICATION_PUSH_STATUS=CLOSED_PASS`

- [ ] **Step 1: Write failing local-bare-remote tests**

Use a local bare repository so tests never touch GitHub.

Cases:

1. exact predecessor -> push advances `main`;
2. wrong predecessor -> exit non-zero and remote unchanged;
3. local HEAD differs from `--expected-head` -> exit non-zero;
4. public worktree dirty -> exit non-zero;
5. non-noreply HEAD metadata -> exit non-zero;
6. script contains no `--force`, `--force-with-lease`, or refspec beginning `+`;
7. simulated transport command exits non-zero after updating the remote -> script queries remote and returns success only if exact expected SHA is already present.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run tests/publication/push-publication.test.ts
```

Expected: FAIL because push script does not exist.

- [ ] **Step 3: Implement guarded push**

Before transmission verify:

```text
PUBLIC_HEAD_MATCH=PASS
PUBLIC_WORKTREE_CLEAN=YES
PUBLIC_METADATA_NOREPLY=PASS
REMOTE_PREDECESSOR_MATCH=PASS
FORCE_PUSH_ENABLED=NO
```

For `--transport origin`, push the configured remote.

For `--transport ssh`, only permit GitHub HTTPS origins of the exact form:

```text
https://github.com/<owner>/<repo>.git
```

and derive:

```text
git@github.com:<owner>/<repo>.git
```

Do not mutate the configured `origin` URL.

If `git push` exits non-zero:

1. immediately run `git ls-remote --heads <remote> refs/heads/main`;
2. if it equals expected HEAD, classify `PUSH_TRANSPORT_RESULT=REMOTE_UPDATED_DESPITE_CLIENT_ERROR`;
3. otherwise fail with `PUSH_TRANSPORT_RESULT=FAILED_NO_REMOTE_UPDATE`;
4. never retry automatically.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run tests/publication/push-publication.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add scripts/publication/push-publication.sh tests/publication/push-publication.test.ts
git commit -m "feat: add explicit guarded public push"
```

---

### Task 5: Independent Remote and Fresh-Clone Verification

**Files:**
- Create: `scripts/publication/verify-publication.sh`
- Create: `tests/publication/verify-publication.test.ts`

**Interfaces:**
- Produces CLI:

```text
scripts/publication/verify-publication.sh \
  --remote <url> \
  --expected-head <40-hex>
```

- Success markers:
  - `PUBLIC_REMOTE_HEAD_MATCH=PASS`
  - `PUBLIC_FRESH_CLONE_VERIFICATION=CLOSED_PASS`
  - `PUBLIC_RELEASE_REPRODUCIBLE=YES`

- [ ] **Step 1: Write failing fresh-clone tests**

Use a local bare remote with a two-commit independent public history.

Assert:

```ts
expect(stdout).toContain("PUBLIC_REMOTE_HEAD_MATCH=PASS");
expect(stdout).toContain("PUBLIC_FRESH_CLONE_VERIFICATION=CLOSED_PASS");
expect(stdout).toContain("PUBLIC_RELEASE_REPRODUCIBLE=YES");
```

Negative cases:

- expected SHA mismatch;
- merge commit in public history;
- non-noreply metadata;
- privacy blocker in clone;
- dirty verification worktree after commands.

For the local fixture repository, provide minimal npm scripts so the verifier can prove it invokes each gate without requiring the full CMM Routers product.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run tests/publication/verify-publication.test.ts
```

Expected: FAIL because verifier does not exist.

- [ ] **Step 3: Implement verifier**

The script must:

1. resolve remote `refs/heads/main` and require exact expected SHA;
2. clone into a new `mktemp -d`;
3. require clone HEAD exact expected SHA;
4. require `main`;
5. require a linear history: every commit has at most one parent;
6. require noreply author and committer metadata for every public commit;
7. run privacy/secret scan over tracked clone content;
8. `npm ci`;
9. `npm run build`;
10. `npx vitest run`;
11. `npm run typecheck`;
12. `bash scripts/security-audit.sh`;
13. `git diff --check`;
14. require clean clone worktree;
15. query remote SHA again after verification;
16. emit evidence + SHA-256.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run tests/publication/verify-publication.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

```bash
git add scripts/publication/verify-publication.sh tests/publication/verify-publication.test.ts
git commit -m "feat: verify published repository from fresh clone"
```

---

### Task 6: Public Maintenance Documentation and End-to-End Dry Run

**Files:**
- Create: `docs/publication.md`
- Modify: `README.md`
- Test: `tests/integration/cmm-routers-branding.test.ts`
- Test: all publication tests

**Interfaces:**
- Documents the three-command maintenance lifecycle:
  1. prepare;
  2. explicit push;
  3. verify.
- No new code interface.

- [ ] **Step 1: Extend the documentation test first**

Add assertions to `tests/integration/cmm-routers-branding.test.ts` that:

```ts
expect(readme).toContain("Publication");
expect(readme).toContain("docs/publication.md");
```

Add a check that `docs/publication.md` contains:

```text
Internal source of truth
Public staging
READY_FOR_EXPLICIT_PUSH_APPROVAL
No force push
```

- [ ] **Step 2: Verify RED**

```bash
npx vitest run tests/integration/cmm-routers-branding.test.ts
```

Expected: FAIL because publication documentation is not linked yet.

- [ ] **Step 3: Write `docs/publication.md`**

Explain first, before commands:

> CMM Routers intentionally keeps internal engineering history separate from public release history. The publication pipeline exports one committed internal tree, sanitizes and proves it, commits it to the unrelated public staging history, and requires a separate human-approved push.

Document environment override:

```bash
export CMM_ROUTERS_EVIDENCE_DIR="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Downloads"
```

Document prepare example generically:

```bash
scripts/publication/prepare-publication.sh \
  --internal-repo "$HOME/CMM-Routers" \
  --public-staging "$HOME/CMM-Routers-Public-Staging" \
  --source-sha "$(git -C "$HOME/CMM-Routers" rev-parse HEAD)" \
  --message "Public release: describe the change"
```

State explicitly that users must inspect the evidence and see:

```text
PUBLICATION_PREPARE_STATUS=READY_FOR_EXPLICIT_PUSH_APPROVAL
PUSH_PERFORMED=NO
```

before separately invoking push.

Do not put personal usernames, API keys, bearer values, or machine-specific hostnames in docs.

- [ ] **Step 4: Add concise README pointer**

Add a small `Publication` section linking to `docs/publication.md`; do not turn README into an internal release manual.

- [ ] **Step 5: Verify focused docs test**

```bash
npx vitest run tests/integration/cmm-routers-branding.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run the complete deterministic verification**

```bash
npm ci
npm run build
npx vitest run
npm run typecheck
bash scripts/security-audit.sh
git diff --check
```

Expected:

```text
BUILD=PASS
FULL_TEST_SUITE=PASS
TYPECHECK=PASS
SECURITY_AUDIT=PASS
```

and all publication-specific tests PASS.

- [ ] **Step 7: Perform a real prepare-only rehearsal against the actual repos**

From the internal repo, with the canonical evidence directory override:

```bash
export CMM_ROUTERS_EVIDENCE_DIR="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Downloads"

scripts/publication/prepare-publication.sh \
  --internal-repo "$HOME/CMM-Routers" \
  --public-staging "$HOME/CMM-Routers-Public-Staging" \
  --source-sha "$(git rev-parse HEAD)" \
  --message "Public maintenance: add safe publication pipeline"
```

Expected:

```text
INTERNAL_GIT_ANCESTRY_IMPORTED=NO
PUSH_PERFORMED=NO
PUBLICATION_PREPARE_STATUS=READY_FOR_EXPLICIT_PUSH_APPROVAL
```

This step intentionally creates a local public-staging commit but performs no network push.

- [ ] **Step 8: Independently inspect the prepared public commit before any push**

Verify:

```bash
git -C "$HOME/CMM-Routers-Public-Staging" log --oneline --decorate -3
git -C "$HOME/CMM-Routers-Public-Staging" status --short
git ls-remote --heads https://github.com/monteromartinchristian-blip/CMM-Routers.git refs/heads/main
```

Expected:

- public staging is exactly one commit ahead of GitHub;
- public worktree clean;
- remote still points to the previous published SHA;
- new public commit parent is the previous public SHA;
- internal SHAs are absent from public ancestry.

- [ ] **Step 9: Commit Task 6 internal documentation/tests**

If the real rehearsal does not modify the internal repo:

```bash
git add README.md docs/publication.md tests/integration/cmm-routers-branding.test.ts
git commit -m "docs: document safe public maintenance workflow"
```

- [ ] **Step 10: Stop for explicit human approval**

Do not run `push-publication.sh`.

Report:

```text
INTERNAL_IMPLEMENTATION_VERIFIED=YES
PUBLIC_STAGING_PREPARED=YES
PUBLIC_REMOTE_UNCHANGED=YES
NEXT=EXPLICIT_PUBLIC_PUSH_APPROVAL
```

---

## Final Plan Self-Review

### Spec coverage

- Explicit internal source SHA: Tasks 3 and 6.
- `git archive` committed input: Task 3.
- Deterministic sanitization: Tasks 1–2.
- Allowed-difference proof: Task 2 and Task 3.
- No internal ancestry import: Task 3 tests and rehearsal.
- Privacy/secret blocker behavior: Tasks 1 and 3.
- Build/full tests/typecheck/security before public commit: Task 3.
- Noreply public commit: Task 3.
- Stop-before-push: Task 3.
- Explicit guarded push/no force: Task 4.
- Ambiguous transport handling: Task 4.
- Remote exact-SHA verification: Tasks 4–5.
- Fresh clone: Task 5.
- Durable evidence: Tasks 3–5.
- Clean final worktrees: Tasks 3, 5, 6.
- User-facing maintenance instructions: Task 6.
- Task 15/16B excluded: Global Constraints.

### Placeholder scan

The plan contains no placeholder markers, deferred implementation instructions, or unspecified testing steps.

### Interface consistency

`policy.mjs` is the only source of sanitization/privacy rules. `tree.mjs` consumes that policy. `prepare-publication.sh` consumes both and is the only component allowed to mutate public staging. `push-publication.sh` never derives a candidate and only pushes an exact prepared SHA. `verify-publication.sh` never mutates either source repository.
