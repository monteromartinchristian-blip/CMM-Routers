# CMM Code Router — Phase 4 Implementation Evidence (Client Compatibility)

**Date:** 2026-09-22
**Nature:** Implementation evidence for the current branch. Historical audits are
not rewritten.

## Starting point

- Branch: `feature/cmm-code-router-client-agnostic`
- Starting HEAD for the overnight run: `373262d989a2ab999e82a885a5281ffe0e5b5249`
  (Phase 3 work sits between that and the Phase 4 commits below)
- Working tree clean at phase start

## What changed

| Commit | Content |
|---|---|
| `106ae8f` | `feat: record profile and client identity in usage diagnostics` |
| `44b522b` | `test: prove Qoder, Hermes and Codex-client compatibility contracts` |
| `987ab5b` | `docs: document client compatibility mechanisms and real-client status` |

### 4E — client metadata observability (recovered deferred T2.2)

`UsageRecord` optionally carries `profile` and `clientId`; `beginRequest` accepts
an optional identity and both HTTP surfaces pass the resolved identity through
`trackProviderStream`. Additive and optional: a record without identity is
byte-identical to before. The identifier stays normalized onto the closed set and
no credential is ever recorded.

### 4B / 4C / 4D — compatibility contracts (Router side)

Qoder (legacy and canonical bearer), Hermes and Codex-client all complete the
canonical tool round trip against the same `code` profile. An unidentified
generic client obtains exactly the same capability as a Qoder-identified one,
which is the direct proof that authorization is the profile and not the client.
The Codex-client identifier is asserted distinct from the `chatgpt` provider
namespace.

## Real-client investigation (read-only, no inference)

Two read-only investigations were run against the installed clients. No secret
value was printed and no model turn was executed.

### Hermes v0.21.3 (installed)

- Custom OpenAI-compatible providers are first-class: a `providers:` map in the
  Hermes config with `base_url`, `api_mode`, `key_env`, `discover_models`.
- Wire: **Chat Completions**, standard OpenAI `tools` shape, streaming on by
  default. Model discovery calls `GET {base_url}/models`.
- Auth: `Authorization: Bearer` from `key_env` (an env var **name**).
- Conclusion: addressable from the Router without any Hermes-specific Router
  code.

### Codex CLI 0.147.0 (installed)

- Custom providers exist via `[model_providers.<id>]` with `base_url`,
  `env_key`, `wire_api`, `requires_openai_auth`.
- `wire_api = "chat"` is **rejected** by this version; only `"responses"` is
  valid. The Router already implements `/v1/responses`, so the transport is
  addressable.
- Codex performs **no model discovery** for custom providers, so exact model ids
  must be supplied explicitly.
- Conclusion: configuration is possible; see Phase 7 for the wire-shape outcome.

## Verification

| Gate | Result |
|---|---|
| Phase 4 focused (4 new files + usage store + generic protocol) | PASS (35) |
| `npm run typecheck` | PASS |
| `bash scripts/security-audit.sh` | `SECURITY_AUDIT=PASS` |
| Phase 1 + Phase 2 regression | PASS |
| `git diff --check` | clean |

## Evidence markers

```text
CLIENT_METADATA_RECORDED=PASS
CLIENT_METADATA_NOT_AUTHORIZATION=PASS
CLIENT_METADATA_NO_SECRETS=PASS
CMMCHAT_IDENTITY_NOT_SPOOFABLE=PASS
QODER_LEGACY_COMPATIBILITY=PASS
QODER_CODE_ROUTER=DETERMINISTIC_PASS_REAL_GATE_PENDING
HERMES_CODE_ROUTER_READINESS=PASS
CODEX_CLIENT_CODE_ROUTER_READINESS=PASS
CODEX_CLIENT_ID_DISTINCT_FROM_PROVIDER=PASS
AUTHORIZATION_IS_PROFILE_NOT_CLIENT=PASS
```

## Notes

- Router-side determinism is not a real-client claim; Phase 7 records the
  real-client outcomes.
- No live provider inference was run during Phase 4.
- No push, merge, tag, publication or PR was performed.
