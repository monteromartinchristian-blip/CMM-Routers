# Task 13 — Final Protocol Edge Hardening (Executable Plan)

**Date:** 2026-09-10
**START_HEAD:** `3dc457497e749425766e71d82f2c39f83f5c25bb`
**Design:** `docs/superpowers/specs/2026-09-10-task13-final-protocol-edge-hardening-design.md`

Every workstream is TDD: RED (observed failure on current HEAD) → minimal GREEN →
focused re-run → adjacent suite → focused commit. No production change without a
test that fails first. No live provider inference. No push/merge/amend.

## Workstreams and file ownership

| WS | Scope | Owned production files |
|----|-------|------------------------|
| A | D1 API-specific `tool_choice`; D8 literal provider policy | `src/core/tool-policy.ts`, `src/http/openai-chat.ts`, `src/http/openai-responses.ts`, `src/core/provider.ts`, `src/providers/command-code/adapter.ts` |
| B | D4 MCP stdio frame bound; D5 JSON-RPC identity | `src/bridge/mcp-bridge-process.ts` |
| C | D7 registry restart reconciliation + agy MCP registration idempotence | `src/bridge/session-registry.ts`, `src/providers/antigravity/mcp-registration.ts` |
| D | D2 stream overflow fail-closed; D3 termination primitive; D6 raw output bounds; D7 adapter integration | `src/providers/antigravity/adapter.ts`, `src/providers/antigravity/process-client.ts` |
| E | D9 multi-step loops per provider family | `src/providers/codex/*`, `src/providers/claude/*`, `src/providers/command-code/*`, antigravity adapter (coordinated with D) |
| F | D9/D10 router-level loop + cancellation proofs | `tests/http/*`, `tests/providers/*` |

## Commit sequence (focused, unsquashed, adjusted only where dependencies require)

1. `docs: design Task 13 final protocol edge hardening`
2. `docs: plan Task 13 final protocol edge hardening`
3. `fix: normalize API-specific named tool choice`
4. `fix: fail closed on Antigravity event overflow`
5. `fix: guarantee agy abort process termination`
6. `security: bound provider-facing MCP and agy raw buffers`
7. `security: require valid MCP JSON-RPC tool requests`
8. `fix: reconcile Antigravity registry and MCP registration`
9. `fix: make provider policy semantics literal`
10. `feat: support repeated Codex external tool calls`
11. `feat: support repeated Claude MCP tool calls`
12. `feat: support repeated Antigravity MCP tool calls`
13. `test: prove Command Code two-step tool loops`
14. `test: prove Router-level multi-step agent loops`
15. `test: prove multi-step cancellation and cleanup`
16. `security: audit final tool ownership and protocol bounds`
17. `docs: add final protocol edge hardening evidence`

## Step detail

### WS A — tool choice + literal policy
1. RED: add `tests/http/tool-choice-wire-normalization.test.ts` sending the literal
   Chat nested shape to `/v1/chat/completions` and the literal flat shape to
   `/v1/responses`; observe the Responses case fail `invalid_request`.
2. RED: add explicit-`parallel_tool_calls` cases for claude & google to a policy test;
   observe `false` wrongly accepted.
3. Implement `parseChatToolChoice` / `parseResponsesToolChoice`; make
   `enforceProviderToolPolicy` consume the normalized policy; carry the normalized
   policy on `RouterRequest`; update Command Code Anthropic call site.
4. Reject any explicit `parallel_tool_calls` for claude & google.
5. GREEN on the new tests; re-run `tests/http` + `tests/providers/tool-policy-matrix`.

### WS B — MCP bridge bounds + identity
1. Extract the production stdin frame pipeline into a testable helper used by
   `startMcpBridgeProcess` (no test-only bypass).
2. RED: oversize multi-chunk no-newline and single giant line → currently accepted.
3. RED: `tools/call` missing `jsonrpc`/`id`/object `id`/bad params/undeclared name →
   currently can reach the control channel.
4. Add `MAX_MCP_STDIO_FRAME_BYTES=1 MiB` enforced during accumulation; fail closed and
   terminate. Add strict JSON-RPC identity validation before the control channel;
   document the malformed-frame policy.
5. GREEN; re-run `tests/bridge`.

### WS C — registry + registration
1. RED: stale-descriptor reconciliation, effective disk bound, multi-process race,
   malformed descriptor tests.
2. Add reconciliation + effective bound + local exclusive lock (bounded stale-lock
   recovery) to `BridgeSessionRegistry.register`.
3. Investigate real `agy mcp list`/`add` (no model turn), preserve and restore the
   prior `cmm-qoder-tools` state; implement `mcp-registration.ts` + fake-runner tests.
4. GREEN; re-run `tests/bridge`, `tests/providers`.

### WS D — Antigravity
1. RED: tiny-capacity `StreamEventQueue` drives the production adapter path; overflow
   currently silently drops.
2. Make overflow terminal: abort run, `provider_protocol_error` once, no completion
   after, cleanup.
3. Add one `terminateChild` primitive (`SIGINT → grace → SIGKILL → await close`); route
   timeout, `AbortSignal`, TTL, post-result cancel, protocol failure and teardown
   through it. Real fixture child ignores SIGINT.
4. Add capped stdout/stderr diagnostic buffers + bounded NDJSON line buffer; oversize
   NDJSON → protocol error + abort.
5. Integrate WS C's registry/registration modules into the adapter.
6. GREEN; re-run `tests/providers/antigravity-*`.

### WS E/F — multi-step loops + cancellation
1. Codex: reusable per-turn `item/tool/call` waiter on the SAME thread+turn; validate
   ACL, independent broker/public identity, answer the ORIGINAL JSON-RPC request,
   continue draining.
2. Claude: reset the park gate after a completed round-trip; fake SDK emits tool B only
   after consuming result A; final depends on A and B.
3. Antigravity: same gate reset; fake agy spawns the real launcher path.
4. Command Code: prove OpenAI and Anthropic two-step wires with exact ids/ordering.
5. Router-level HTTP two-tool loop per family with two independent canaries; the
   provider-faithful harness decides tool B only after result A crosses production.
6. Cancellation matrix at each lifecycle edge; assert no provider run, broker entry,
   bridge pending, control socket, rendezvous descriptor or stale public tool id
   remains, and unrelated concurrent runs survive.

## Regression gate (after implementation appears complete)

```
npm test ; npm test ; npm test
npm run typecheck
npm run build
npm test
bash scripts/security-audit.sh
```
then execute every NEW deterministic suite by path. Any failure → continue working.

## Adversarial self-review checklist

unbounded Map/Array/string append · one-shot tool waiter · gate never reset · stale
session file · child without kill escalation · `tools/call` without strict id · silent
`catch/continue` · silent event drop · ignored `tool_choice`/`parallel_tool_calls` ·
provider-requested undeclared tool · second sequential tool failure · new thread/run on
continuation · native provider edit capability · PAYG env access · secret logging.

## Deliverables

- `docs/superpowers/specs/2026-09-10-task13-final-protocol-edge-hardening-design.md`
- `docs/superpowers/plans/2026-09-10-task13-final-protocol-edge-hardening-plan.md`
- `docs/audits/2026-09-10-task13-final-protocol-edge-hardening-evidence.md`
- Focused commits 1–17 above.
- Prepared-but-not-executed live canary scripts (Claude, Antigravity, optionally
  Codex/Command Code) that poison PAYG env, verify the subscription route, use one
  harmless synthetic tool and mutate nothing.
