# CMM Code Router — Phase 6 Implementation Evidence (Verification / Hardening)

**Date:** 2026-09-22
**Nature:** Implementation evidence. Historical audits are not rewritten.

## What changed

| Commit | Content |
|---|---|
| `f3e4f67` | `test: recover the compiled-process Code Router E2E with exact test-only injection` |
| `c60075e` | `test: repair the vacuous capability test and reconcile the Codex record` |

### Compiled-process Code Router E2E (recovered deferred T2.8)

`tests/http/dist-generic-client-e2e.test.ts` boots the **built**
`dist/index.js`, serves it over real loopback HTTP, and proves the whole
canonical contract with no live provider:

```text
built process -> /v1/models capability publication -> exact CHAT_AND_TOOLS model
-> tool declaration -> structured tool call -> client-owned execution
-> structured result -> same model continuation -> final answer
-> CMMChat still rejected -> clean shutdown
```

The provider is a deterministic double injected **only** through
`CMM_TEST_PROVIDER`, now accepting exactly `scripted` and `scripted-tools`. The
audit asserts the gate stays exact and that the double has no execution surface
(no `child_process`, `fs`, `exec` or `spawn`).

### Test repairs

- `tests/providers/capability-truthfulness.test.ts` was vacuous
  (`void adapters;`). It now asserts that every production adapter declares only
  `CHAT_ONLY` or `CHAT_AND_TOOLS` (and requires the scan to actually find
  declarations), plus a registry-level assertion that `/v1/models` publishes
  exactly the verified values and nothing for an unverified model.
- `tests/providers/codex-dynamic-tool.test.ts` claimed the dynamic-tool
  declaration channel does not exist, contradicting
  `codex-dynamic-tool-declaration.test.ts`. The comment now records the real
  split (declaration on `thread/start`, server-initiated `item/tool/call` here)
  and the neutral `CODEX_CLIENT_TOOL_DEFINITIONS_SENT` marker is emitted
  alongside the legacy one.

## Architecture audit (source scan)

| Check | Result |
|---|---|
| Qoder authorization semantics in `src/` | Only the deprecated `CONSUMER_QODER = PROFILE_CODE` alias in the compatibility shim; no authorization branch keyed on it |
| Capability decision inputs | Both surfaces call `effectiveProfileToolCapability(identity.profile, model.capability)` |
| Client identity in a gate | None |
| Provider-native approvals (`decision: "accept"`) | None |
| Fallback logic (cross-provider / unknown-model) | None present; PAYG guard still wired at config load |
| Secret logging in providers/http | None |
| Rigid client-owned model layout in `src/` | None |

`child_process` usage under `src/providers/` is Router-side provider process
management (spawning the provider CLI, the MCP bridge, the `agy` MCP
registration, and a repo-tree hash helper) — not provider-native tool execution.

## Verification

| Gate | Result |
|---|---|
| Phase 1 focused | PASS |
| Phase 2 generic protocol | PASS |
| Phase 3 broker neutrality | PASS |
| Phase 4 compatibility contracts | PASS |
| Install/auth tests | PASS |
| Broker adversarial / concurrency / cancellation | PASS |
| Provider focused tests (`tests/bridge` + `tests/providers` + `tests/core`) | PASS (78 files / 453 tests) |
| Compiled-process E2E | PASS (4) |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `bash scripts/security-audit.sh` | `SECURITY_AUDIT=PASS` |
| `git diff --check` | clean |
| Full suite | see the final completion evidence for the classified result |

## Evidence markers

```text
COMPILED_PROCESS_CODE_ROUTER_E2E=PASS
COMPILED_PROCESS_MODEL_CAPABILITY=PASS
COMPILED_PROCESS_CMMCHAT_CHAT_ONLY=PASS
TEST_PROVIDER_INJECTION_EXACT=PASS
TEST_PROVIDER_EXECUTION_SURFACE=NONE
CAPABILITY_PUBLICATION_TRUTHFUL=PASS
BUILD=PASS
TYPECHECK=PASS
SECURITY_AUDIT=PASS
```

## Notes

- No live provider inference was run during Phase 6.
- Codex continuation-ACL hardening on thread-ACL eviction was considered and
  deliberately **not** changed: it is a behaviour change in a provider bridge,
  it is not required by any phase objective, and the theoretical widening is not
  reachable without a >64-thread eviction plus a client-supplied continuation.
  It is recorded as a known hardening candidate rather than smuggled in.
