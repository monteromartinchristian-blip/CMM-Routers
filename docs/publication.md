# Safe public publication workflow

CMM Routers is developed in a private-history repository and published through a separate sanitized public-history repository. The publication pipeline is intentionally one-way:

```text
private development history
        |
        v
exact tracked tree at an approved SHA
        |
        v
deterministic sanitization + privacy/secret gates
        |
        v
sanitized public staging history
        |
        v
explicit guarded push
        |
        v
fresh-clone verification
```

The private Git history is never merged, mirrored, or pushed into the public repository.

## Safety invariants

Every public update must preserve these rules:

- The source repository must be clean and identified by an exact 40-character commit SHA.
- Publication uses the tracked tree from that exact SHA, not arbitrary working-tree contents.
- Personal macOS home paths are normalized to `/Users/example/`.
- High-confidence secrets block publication; they are never automatically substituted.
- Candidate differences must be completely explained by the sanitization policy.
- The public repository keeps a separate linear history with GitHub noreply author and committer metadata.
- `prepare-publication.sh` creates a local public commit and stops before any network push.
- `push-publication.sh` requires the exact approved local HEAD and exact expected remote predecessor.
- Force pushes and force refspecs are not part of the publication workflow.
- A failed or ambiguous push is never automatically retried. The remote is queried first.
- A published commit is accepted only after verification from a fresh clone.
- Evidence reports contain hashes and status markers, not secret values.

## 1. Prepare a sanitized public commit

Set the private source repository, public staging repository, exact private source SHA, and public commit subject:

```bash
INTERNAL_REPO="/path/to/private/CMM-Routers"
PUBLIC_STAGING="/path/to/CMM-Routers-Public-Staging"
SOURCE_SHA="$(git -C "$INTERNAL_REPO" rev-parse HEAD)"

scripts/publication/prepare-publication.sh \
  --internal-repo "$INTERNAL_REPO" \
  --public-staging "$PUBLIC_STAGING" \
  --source-sha "$SOURCE_SHA" \
  --message "Public maintenance update"
```

A successful preparation ends with:

```text
PUSH_PERFORMED=NO
PUBLICATION_PREPARE_STATUS=READY_FOR_EXPLICIT_PUSH_APPROVAL
```

At this point the public staging repository is intentionally ahead of its remote. Review the prepared commit before approving a push.

## 2. Review the prepared commit

Verify at minimum:

```bash
git -C "$PUBLIC_STAGING" status --short
git -C "$PUBLIC_STAGING" log -2 --oneline --decorate
git -C "$PUBLIC_STAGING" diff HEAD^ HEAD --stat
git -C "$PUBLIC_STAGING" remote -v
```

The worktree must be clean, the prepared commit must have exactly one public-history parent, and the configured origin must remain unchanged.

The prepared public repository must not contain the private source commit as ancestry or as a copied Git object. Publication transfers sanitized content, not private Git history.

## 3. Push only after explicit approval

After recording the prepared public HEAD and the remote predecessor:

```bash
PUBLIC_HEAD="$(git -C "$PUBLIC_STAGING" rev-parse HEAD)"
REMOTE_PREDECESSOR="$(git -C "$PUBLIC_STAGING" rev-parse HEAD^)"

scripts/publication/push-publication.sh \
  --public-staging "$PUBLIC_STAGING" \
  --expected-head "$PUBLIC_HEAD" \
  --expected-remote-predecessor "$REMOTE_PREDECESSOR" \
  --transport origin
```

The guarded push checks the exact local HEAD, exact remote predecessor, clean staging state, linear public ancestry, noreply metadata, privacy policy, and remote identity before updating `main`.

`--transport ssh` is available only when the configured origin is an exact GitHub HTTPS repository URL. It derives the SSH destination for that invocation without rewriting the configured origin.

There is no force-push mode and no automatic retry loop.

If the client reports a push error, the script queries the remote:

- If remote `main` already equals the approved HEAD, the result is classified as a successful remote update despite the client error.
- If the remote did not reach the approved HEAD, the operation fails closed and must be reviewed manually.

## 4. Verify the published repository from a fresh clone

After a successful push:

```bash
REMOTE="$(git -C "$PUBLIC_STAGING" remote get-url origin)"
PUBLIC_HEAD="$(git -C "$PUBLIC_STAGING" rev-parse HEAD)"

scripts/publication/verify-publication.sh \
  --remote "$REMOTE" \
  --expected-head "$PUBLIC_HEAD"
```

The verifier independently checks:

- remote `main` equals the approved SHA before cloning;
- the fresh clone is on `main` at that SHA;
- public history has one root and no merge commits;
- all public author and committer emails use GitHub noreply metadata;
- tracked content passes the privacy and secret policy;
- `npm ci`, build, tests, typecheck, and the security audit pass;
- the fresh clone remains clean;
- remote `main` is unchanged when verification finishes.

A successful verification ends with:

```text
PUBLIC_FRESH_CLONE_VERIFICATION=CLOSED_PASS
PUBLIC_RELEASE_REPRODUCIBLE=YES
```

## Publication meta-tests

The preparation and fresh-clone verifier tests are themselves end-to-end publication tests. They launch nested repository-wide verification. A cross-process test lock serializes these heavy meta-tests so a normal full test run cannot start multiple nested full suites simultaneously.

Inside a sanitized candidate or fresh-clone verification, the publication meta-tests themselves are skipped to prevent recursive publication-from-publication. Router, provider, HTTP, security, configuration, and all other non-recursive tests continue to run.

## Evidence

The scripts write machine-readable evidence reports and SHA-256 files. `CMM_ROUTERS_EVIDENCE_DIR` may be set to choose the evidence directory.

Evidence should be retained for meaningful publication events. Do not add local evidence bundles, credentials, tokens, private profiles, or machine-specific logs to the public repository.

## Rehearsal before the first maintenance push

Before using the maintenance pipeline against the public remote for the first time:

1. Run all publication tests and the complete repository test suite.
2. Run build, typecheck, and the security audit.
3. Execute `prepare-publication.sh` against the real public staging repository.
4. Confirm that the local public staging repository is exactly one commit ahead of the remote.
5. Run `verify-publication.sh` against the local prepared staging repository as a clone source.
6. Query the real public remote again and confirm it is unchanged.
7. Stop for explicit human push approval.

The rehearsal deliberately prepares the exact public commit without publishing it.
