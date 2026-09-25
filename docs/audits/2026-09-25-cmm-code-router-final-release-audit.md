# CMM Code Router — Final Release Audit

Date: 2026-09-25

## Audited code baseline

- Branch: `feature/cmm-code-router-client-agnostic`
- Code HEAD: `f5d497a018c20b0337db5c5fa76a4db1e55a34ea`
- Code tree: `2d90b7b623a2d014e941a9d064bde2297451826b`
- Live ownership proof: Script 35, downstream-only environment secret
- Productionization commit: `f5d497a018c20b0337db5c5fa76a4db1e55a34ea`
- Provider inference during this release audit: **none**
- PAYG allowed: **no**

## Live proof already closed

The installed Codex 0.147.0 downstream client was previously proven live against
GPT-5.6 Sol with a secret available only in the downstream process environment.
The upstream process and prompt could not know the value. The client-owned
`exec_command` retrieved it, CMM Code Router returned it through a successful
Codex `DynamicToolResponse`, and GPT-5.6 Sol returned the exact value.

This is the authoritative installed-client live gate. The deterministic
`codex-client-readiness` test still prints a historical
`PENDING_INSTALLED_CLIENT_VERIFICATION` marker because that unit test cannot
itself prove an external live run; it does not override the separately closed
Script 35 gate.

## Production upstream ownership boundary

The Router uses a dedicated Codex upstream profile:

`~/Library/Application Support/CMM Routers/codex-upstream`

It is provisioned by
`scripts/macos/provision-codex-upstream-profile.sh` and pinned to
`codex-cli 0.147.0`.

The real iMac profile was verified with:

- ChatGPT subscription auth present;
- PAYG/API-key fields absent from the isolated auth copy;
- global `~/.codex/auth.json` unchanged during Script 37;
- global `~/.codex/config.toml` unchanged during Script 37;
- every upstream model set to `tool_mode=direct`;
- every upstream model set to `shell_type=disabled`;
- upstream search disabled;
- upstream apply-patch disabled;
- upstream multi-agent disabled;
- profile directory mode 0700;
- profile file modes 0600.

## Router protocol invariants

- client-owned upstream namespace: `cmm_client`;
- downstream public tool names preserved;
- canonical OpenAI Responses SSE lifecycle present;
- same thread/turn dynamic-tool continuation preserved;
- Codex-native/default-namespace substitution blocked;
- broker correlation, TTL, cancellation, and bounds preserved;
- CMMChat remains CHAT_ONLY;
- CMM Code Router remains CHAT_AND_TOOLS only on verified-capable models;
- unknown-model fallback forbidden;
- cross-provider fallback forbidden;
- PAYG fallback forbidden.

## Verification results

Script 37 completed every release gate before its original shell-based secret
scan:

- real dedicated profile structural audit: PASS;
- static release invariants: PASS;
- release-specific matrix: **21 files / 121 tests PASS**;
- TypeScript typecheck: PASS;
- production build: PASS;
- broad non-ambient regression: **171 files / 963 tests PASS, 25 skipped**;
- provider inference during the audit: NONE.

The original Script 37 stopped only because its shell-quoted `git grep`
expression produced false positives on innocent paths such as
`docs/task-14-codex-post-tool-continuation.md`. Script 37b replaced that gate
with a value-oriented Python scanner that does not print candidate secret
values.

Corrected tracked-secret scan: **PASS**.

## Independent provider scope

This audit closes the **Codex / GPT-5.6 Sol CMM Code Router path** for real
CHAT_AND_TOOLS usage. Provider-specific manual gates for Hermes, Qoder as a
specific harness, Claude, Google/Antigravity, or Command Code remain independent
where their own tests/documentation say so. This audit does not silently promote
those gates.

## Verdict

**CMM Code Router — Codex / GPT-5.6 Sol path: RELEASE-AUDIT CLOSED.**

No further live inference is required for this gate.
