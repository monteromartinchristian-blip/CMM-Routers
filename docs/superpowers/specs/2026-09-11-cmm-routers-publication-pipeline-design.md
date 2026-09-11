# CMM Routers — Sanitized Public Publication Pipeline Design

**Date:** 2026-09-11
**Status:** Approved design
**Scope:** Publication architecture for CMM Routers
**Internal source repository:** `$HOME/CMM-Routers`
**Public staging repository:** `$HOME/CMM-Routers-Public-Staging`
**Public GitHub repository:** `monteromartinchristian-blip/CMM-Routers`

## 1. Purpose

CMM Routers has two different requirements that must coexist permanently:

1. the internal development repository must preserve the complete engineering history, evidence, audits, local operational context, and private development metadata required for continued work; and
2. the public repository must expose only a sanitized, reproducible, reviewable history that is safe to publish.

These requirements are intentionally implemented as two independent Git histories.

The publication system must make it easy to publish the current verified product without ever making the internal Git history part of the public repository.

## 2. Core Architecture

The architecture has one development source of truth and one publication history.

### 2.1 Internal repository

`$HOME/CMM-Routers` is the sole development source of truth.

It owns:

- implementation work;
- tests;
- design documents;
- audit evidence;
- internal commit history;
- provider integration work;
- local-only operational documentation;
- Task 15 and Task 16B development;
- all normal engineering branches.

The internal repository is never pushed directly to the public GitHub repository.

### 2.2 Public staging repository

`$HOME/CMM-Routers-Public-Staging` owns the public Git history.

It exists only to:

- receive a sanitized export of the internal tracked tree;
- preserve the already-published public history;
- create reviewable public commits;
- execute the public release gate;
- push approved public commits to GitHub.

It is not an independent development source.

Changes must not be authored manually in public staging and then backported to the internal repository.

### 2.3 Public GitHub repository

`monteromartinchristian-blip/CMM-Routers` is the public distribution surface.

Its history originates only from the public staging repository.

The current public root is:

`2aed44e6273dbb36c2ed0673374665d2d6b99ad8`

The internal 208-commit history that preceded the public release remains private and is not an ancestor of the public root.

## 3. Direction of Data Flow

The only supported publication direction is:

`Internal repository -> sanitized export -> public staging -> verification -> explicit push -> GitHub`

There is no reverse synchronization from public staging into the internal source repository.

There is no Git merge between the internal and public histories.

There is no subtree, rebase, graft, replace-ref, history-filter, or force-push mechanism connecting the two histories.

This deliberately avoids creating an accidental ancestry path from the public history back to private commits.

## 4. Publication Unit

A publication is based on one explicit internal source commit.

Every public publication operation must record:

- internal source commit SHA;
- previous public staging commit SHA;
- resulting public staging commit SHA;
- exact tracked-file set;
- sanitization transformations applied;
- build/test/typecheck/security results;
- privacy-scan result;
- whether any manual review was required;
- whether a push was performed.

The exported public tree must be traceable to a single internal commit even though the Git histories are unrelated.

## 5. Export Model

The publication pipeline must export the tracked tree from the selected internal commit rather than copy the working directory.

The conceptual source is:

`git archive <internal-source-sha>`

This guarantees that:

- untracked local files are excluded;
- ignored files are excluded;
- worktree-only artifacts are excluded;
- `.git` internals are excluded;
- publication input is immutable and commit-addressable.

The pipeline must fail closed if the internal worktree is dirty unless a future design explicitly introduces a reviewed exception.

## 6. Sanitization Model

Sanitization is an explicit transformation layer between export and public staging.

The pipeline must not use an unrestricted heuristic rewrite of arbitrary repository content.

Sanitization consists of two classes.

### 6.1 Mandatory privacy transformations

Known private machine identity must be replaced with stable public placeholders, including:

- personal absolute home paths;
- personal shell prompts;
- personal hostnames;
- other explicitly enumerated local-machine identifiers.

The canonical public path placeholder is:

`/Users/example/`

### 6.2 Text normalization

Text files may receive deterministic publication-safe normalization such as:

- trailing ASCII whitespace removal;
- trailing non-breaking-space removal where already identified as formatting debt;
- canonical final newline normalization.

Normalization must not alter program semantics.

### 6.3 No secret substitution

Real credentials must never be made publishable by automatically replacing detected secret values.

If a high-confidence secret is detected, publication stops.

The source must be fixed or the public export policy explicitly redesigned and reviewed.

## 7. Allowed-Difference Proof

Before a public commit can be created, the pipeline must prove that the public candidate tree differs from the selected internal tracked tree only through approved transformations.

The proof must include:

- identical tracked-file sets unless an explicit publication allowlist says otherwise;
- bytewise comparison;
- canonical comparison after approved privacy sanitization and text normalization;
- zero unexplained binary differences;
- zero unexplained textual differences.

Any unexplained difference blocks publication.

This prevents public staging from becoming a hidden fork of the product.

## 8. Secret and Privacy Gate

Every publication candidate must pass a tracked-tree scan before commit and again before push.

### 8.1 Blocking findings

Publication fails for:

- personal absolute paths or machine identifiers covered by policy;
- private-key material;
- known provider credential formats;
- GitHub tokens;
- cloud access keys;
- high-confidence bearer/API secrets;
- non-noreply public commit metadata;
- any newly defined high-confidence secret rule.

### 8.2 Review-only findings

Secret-like literals that are plausible fixtures may enter manual review.

A review finding is acceptable only when evidence establishes that it is a deliberate test fixture, including checks such as:

- occurrence only under `tests/`;
- no known credential-provider shape;
- no occurrence outside tests;
- deterministic human-readable fixture structure;
- contextual use as an authentication or failure-path fixture.

The literal value itself must not be printed by review tooling when it can be classified safely without doing so.

## 9. Public Commit Policy

Public staging preserves its own linear public history.

After the initial root release, each publication creates a normal descendant commit.

Public commits must:

- use a GitHub noreply author email;
- use a GitHub noreply committer email;
- have a clean `git diff --check`;
- contain only the verified candidate tree;
- include no merge ancestry from the internal repository.

Public commit messages should describe the user-visible publication change rather than mirror internal task-by-task history.

The public history is therefore a curated release history, not a mirrored engineering diary.

## 10. Push Policy

Publication and push are separate operations.

A successful local public commit does not authorize network publication.

The pipeline must stop at a state equivalent to:

`READY_FOR_EXPLICIT_PUSH_APPROVAL`

A push occurs only after explicit human approval.

Push safeguards must verify immediately before transmission:

- expected public staging HEAD;
- expected public branch;
- clean public staging worktree;
- noreply metadata;
- public privacy gate;
- security audit;
- expected remote;
- expected remote predecessor;
- no force push.

The initial HTTPS transport failure demonstrated that transport errors must never be interpreted as publication success without independently querying the remote ref.

SSH is an accepted push transport when HTTPS pack upload is unreliable.

## 11. Post-Push Verification

Every push must be followed by independent remote verification.

At minimum:

- `ls-remote` over the configured remote;
- GitHub API ref verification when available;
- remote SHA equality with the expected public commit.

For release-grade changes, the pipeline must additionally perform a fresh clone from GitHub into a temporary directory and verify:

- expected HEAD;
- expected branch;
- public-history ancestry;
- clean install;
- build;
- full deterministic test suite;
- typecheck;
- security audit;
- privacy/history hygiene;
- clean worktree.

The fresh clone is the authoritative proof that the published repository is reproducible independently of local staging state.

## 12. Evidence

Publication operations should generate machine-readable evidence in the canonical iCloud Downloads directory.

Evidence should include:

- pre-push gate report;
- manual-review report when required;
- post-push verification report;
- fresh-clone verification report;
- SHA-256 digests for durable evidence artifacts;
- optional source/archive bundle for milestone releases.

Evidence artifacts are not automatically committed to the public repository.

## 13. Open-Source Project Files

The publication architecture will later support normal public-project metadata such as:

- `LICENSE`;
- `SECURITY.md`;
- `CONTRIBUTING.md`;
- GitHub Actions CI;
- repository topics and description;
- tagged releases.

These files are authored first in the internal source repository and reach GitHub only through the same sanitized publication pipeline.

No GitHub-only manual file editing is part of the normal workflow.

## 14. Release Policy

The current public `main` branch is a published baseline but does not require an immediate tagged release.

The first formal tagged release should occur after the remaining planned compatibility work is complete:

- Task 15 — Command Code live enablement/re-proof;
- Task 16B — bidirectional Qoder model synchronization across the MacBook and iMac.

This keeps the first named release aligned with the first intentionally complete public baseline.

## 15. Failure Handling

The pipeline fails closed.

Examples:

- dirty internal worktree -> stop;
- unknown source commit -> stop;
- dirty public staging worktree -> stop;
- unexpected public predecessor -> stop;
- unexplained tree difference -> stop;
- privacy blocker -> stop;
- secret blocker -> stop;
- build/test/typecheck/security failure -> stop;
- public commit metadata not noreply -> stop;
- remote divergence -> stop;
- ambiguous push outcome -> query remote before any retry;
- fresh-clone mismatch -> release remains unverified.

The pipeline must never attempt an automatic force push.

## 16. Non-Goals

This design does not:

- synchronize Qoder between Macs; that is Task 16B;
- enable or live-test Command Code; that is Task 15;
- rewrite the internal Git history;
- make public staging a second development repository;
- automate credential distribution;
- publish local machine configuration;
- introduce PAYG or provider fallback behavior;
- create a tagged release yet.

## 17. Security Invariants

The publication system preserves the existing CMM Routers product invariants:

- no API PAYG fallback;
- no cross-provider fallback;
- no unknown-model fallback;
- loopback-only Router runtime;
- client/harness owns tools;
- provider owns reasoning;
- no provider-native repository mutation;
- no prompt/completion/tool-argument/tool-result logging in normal runtime;
- no tracked credentials;
- local credentials remain local.

Publication adds these additional invariants:

- internal Git ancestry never enters public history;
- public Git metadata is noreply-only;
- publication is derived from tracked committed input;
- transformations are explicit and auditable;
- pushes require explicit approval;
- remote state is independently verified after push.

## 18. Acceptance Criteria

The implementation is complete when a deterministic publication command can:

1. select an explicit internal source SHA;
2. verify the internal repository is safe to export;
3. export only the tracked tree;
4. apply the approved sanitization policy;
5. prove all public/internal tree differences are allowed;
6. update public staging without importing internal Git ancestry;
7. run privacy, secret, build, test, typecheck, and security gates;
8. create a noreply public commit;
9. stop before push pending explicit approval;
10. push only after explicit approval without force;
11. verify the exact remote SHA;
12. fresh-clone GitHub and re-run the release verification;
13. emit durable machine-readable evidence;
14. leave the internal repository and public staging worktrees clean.

## 19. Chosen Approach

CMM Routers adopts:

**one internal development source of truth + one sanitized public staging history + an explicit, gated, one-way publication pipeline.**

This architecture is intentionally more conservative than automatically rewriting and pushing internal history. The extra boundary is the mechanism that protects the public project from private-history leakage.
