# CMM Code Router — Phase 3 Implementation Evidence (Broker / Provider Neutrality)

**Date:** 2026-09-22
**Scope:** Phase 3 of the client-agnostic CMM Code Router completion.
**Nature:** Implementation evidence for the current branch. Not a rewrite of any
historical audit; earlier evidence under `docs/audits/` is unchanged.

## Starting point

- Branch: `feature/cmm-code-router-client-agnostic`
- Starting HEAD: `373262d989a2ab999e82a885a5281ffe0e5b5249` (Phase 2 closed)
- Working tree: clean

## What changed

Client identity was removed from shared broker state and from provider/bridge
prose, and the security audit now asserts architecture instead of client names.

| Commit | Content |
|---|---|
| `74f4172` | `refactor: make the deferred tool broker client-neutral` |
| `07e0bb1` | `refactor: neutralize provider/bridge execution-owner wording` |
| `173c114` | `test: assert provider neutrality by architecture, and fix the wire provider list` |

### Broker neutrality

`BrokerKey.consumer` (typed as the literal `"qoder"`) and the
`createPendingCall` guard that rejected any other value were removed, together
with the three adapter call sites that passed the literal. The broker is
internal correlation state with no client-facing surface: authorization happens
at the HTTP boundary on the authenticated profile, and the execution owner is
the client/harness.

Correlation semantics are unchanged and directly asserted: composite
`provider|sessionId|turnId|toolCallId` keys, public-id resolution,
duplicate/stale classification, pending bound, TTL, cancellation scope, and
concurrent-entry isolation.

### Wording

Comments, doc strings and error text that treated Qoder as the only possible
execution owner now name the client/harness. Model-visible tool descriptions
(`client-owned tool …`) were neutralized. No behaviour changed.

### Architecture assertions in `scripts/security-audit.sh`

- Provider-native execution: no accepted approval (`decision: "accept"` count 0),
  exactly **one** affirmative Codex tool-call answer site, at least one decline
  site. Replaces a check that only looked for client names in comments.
- `BROKER_CLIENT_NEUTRAL`: no client identity declared in the broker or in any
  park-and-await adapter's entry key.
- `ANTIGRAVITY_SCOPED_MCP_ACL_PRESERVED`: the persisted `mcp(cmm-qoder-tools/*)`
  rule is unchanged and never widened; the provisioner still refuses `mcp(*)`.
- `PERSISTED_LEGACY_NAMES_PRESERVED` / `LEGACY_PERSISTED_IDENTIFIERS_CHANGED=NO`.
- Latent drift fixed: the remote-worker wire allowlist omitted `cavoti`; provider
  ids now come from one runtime mirror (`PROVIDER_IDS` / `isProviderId`).

## Verification

| Gate | Result |
|---|---|
| `tests/core/broker-client-neutrality.test.ts` | PASS (6) |
| broker + isolation + cancellation + codex-adversarial + bounded-pending | PASS (30) |
| `tests/bridge` + `tests/providers` + `tests/core` | PASS (78 files / 453 tests) |
| `tests/core/wire.test.ts` | PASS (11) |
| `npm run typecheck` | PASS |
| `bash scripts/security-audit.sh` | `SECURITY_AUDIT=PASS` |
| `git diff --check` | clean |

## Evidence markers

```text
BROKER_CLIENT_NEUTRAL=PASS
BROKER_CORRELATION_ISOLATION=PASS
GENERIC_OPENAI_TOOL_ROUNDTRIP=PASS
GENERIC_MULTISTEP_ROUNDTRIP=PASS
QODER_LEGACY_COMPATIBILITY=PASS
LEGACY_PERSISTED_IDENTIFIERS_CHANGED=NO
PERSISTED_LEGACY_NAMES_PRESERVED=YES
ANTIGRAVITY_SCOPED_MCP_ACL_PRESERVED=PASS
CODEX_AFFIRMATIVE_TOOL_ANSWER_SITES=1
CODEX_DECLINE_TOOL_ANSWER_SITES=2
PROVIDER_NATIVE_TOOL_EXECUTION=NONE
PROVIDER_NATIVE_REPO_MUTATION=NONE
WIRE_PROVIDER_LIST_MATCHES_PROVIDER_ID=PASS
```

`GENERIC_OPENAI_TOOL_ROUNDTRIP` / `GENERIC_MULTISTEP_ROUNDTRIP` are emitted by
the Phase 2 generic-client proofs, which remained green throughout Phase 3.

## Legacy identifiers preserved (not renamed)

```text
cmm-qoder-tools
mcp(cmm-qoder-tools/*)
cmm_qoder
mcp__cmm_qoder__
qoder-bearer
qoder-custom-cmm-router
QODER_SMOKE_OK
com.cmm.subscription-router
cmm-subscription-router
CMM_QODER_TOKEN / qoderToken / legacyQoderToken
```

`QODER_SMOKE_OK` is intentionally left unchanged: it is a frozen legacy
identifier, so the planned "test-double marker neutrality" item was dropped
rather than violated.

## Deferred to Phase 6 (hardening, not neutralization)

Codex continuation ACL re-derivation on thread-ACL eviction
(`src/providers/codex/adapter.ts`) is a robustness hardening item, not a Phase 3
neutrality requirement; it is tracked for Phase 6.

## Notes

- No live provider inference was run during Phase 3.
- No push, merge, tag, publication or PR was performed.
