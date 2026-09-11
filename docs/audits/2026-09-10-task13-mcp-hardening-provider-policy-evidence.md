# CMM Subscription Router — Task 13 MCP Hardening & Provider Policy — Evidence

**Date:** 2026-09-10
**Status:** `IMPLEMENTED_PENDING_INDEPENDENT_REAUDIT`
**Starting HEAD:** `b439378c47c0764bb4c651e48b94bbe752c2c3f2`
**Final code HEAD:** `970c31b33a21bc21bf1dd470810887f7d6dcdf24` (this evidence document is the documentation-only commit immediately after it; the full gate sequence was re-run on the commit containing this file)
**Worktree after 10 s stability wait:** clean, HEAD unchanged
**Live tool acceptance run:** NO
**Final Task 13 closure:** NO

This document records what was implemented, the evidence for each claim, and the
canaries that remain. It does not edit any historical audit document.

---

## 1. Runtime versions (non-inference)

```text
command -v agy    -> /Users/example/.local/bin/agy
agy --version     -> 1.2.0
node              -> v24.18.0 (this machine)
@anthropic-ai/claude-agent-sdk -> 0.3.266 (node_modules)
```

`agy 1.2.0` CLI surface captured in this pass:

```text
agy mcp add [flags] <name> <commandOrUrl> [args...]
  Flags: -e/--env KEY=value (repeatable), -t/--type stdio|http,
         -H/--header "K: V" (repeatable), -h/--help
  Notes: Flags must come before <name>; a flag placed after it is rejected.
agy mcp list -> "No MCP servers configured."
agy --help   -> no tool-selection and no parallel-execution flag
```

Persistent MCP config path found in the installed binary:
`~/.gemini/config/mcp_config.json`. Registration is therefore **global**, which
is the root cause of the concurrency defect addressed in §5.

### Stale version constants — classification and action

| Location | Value | Classification | Action |
| --- | --- | --- | --- |
| `src/providers/antigravity/process-client.ts` `AGY_VERSION` | `1.1.16` | dead runtime constant (zero references in `src/`, `tests/`, `scripts/`) | deleted |
| `README.md` provider-limitations note | `agy 1.1.16` | documentation | rewritten for 1.2.0 |
| `docs/audits/*` | `1.1.28` | historical evidence | untouched |
| prior design/evidence docs `2026-09-10-task13-protocol-truth-*` | `1.1.28` | superseded evidence | untouched |

```text
ANTIGRAVITY_RUNTIME_VERSION=1.2.0
ANTIGRAVITY_VERSION_ASSUMPTIONS_REVALIDATED=PASS
STALE_PRODUCTION_AGY_VERSION_ASSUMPTION=NONE
```

No runtime version pin was introduced: Antigravity behaviour is gated by observed
protocol results (malformed output fails closed), and the one version-derived
design assumption (the rendezvous anchor) was replaced by a mechanism that does
not depend on the CLI version at all.

---

## 2. RED → GREEN evidence

Genuine RED was captured on the pristine `START_HEAD` in a throw-away git
worktree at `b439378` (worktree removed after capture). The focused RED suites and
their failure modes:

| Suite | RED on `b439378` | Correct GREEN after fix |
| --- | --- | --- |
| `tests/providers/claude-mcp-e2e.test.ts` | `expected 1 to be +0` — the adapter spawned a second, Router-owned provider-facing MCP bridge | 0 Router-owned MCP processes; the SDK-owned child is the only one |
| `tests/providers/antigravity-concurrency.test.ts` | `expected undefined to be defined` — both concurrent runs failed closed because the launcher saw two live descriptors | both runs resolve their own session |
| `tests/providers/claude-lifecycle.test.ts` | `expected false to be true` — `cancel(continuationRequestId)` was a no-op | the exact live provider run is aborted |
| `tests/providers/declared-tool-acl.test.ts` | undeclared names were surfaced (`expected { type: 'tool_call_delta' } to be undefined`) | `-32602` / `provider_protocol_error`, nothing surfaced |
| `tests/providers/tool-policy-matrix.test.ts` | `expected 200 to be 400` — constraints were accepted then dropped | explicit 400 `unsupported_capability` |
| `tests/providers/bounded-pending-state.test.ts` | control pending never rejected a 40-frame burst (timed out) | bounded at 16 with a deterministic error |

The README version row and the `bounded-pending-state` TTL assertions were
finalised with the fix and their RED re-captured on the same pristine worktree.

---

## 3. Claude provider-facing MCP ownership

`ClaudeAdapter` no longer spawns a provider-facing MCP process. It creates one
Router-side `BridgeControlServer` per tool-capable request and hands exactly one
stdio server configuration to the SDK through `options.mcpServers`; the SDK owns
and spawns that single child. The `spawnFn` seam and the session's `ChildProcess`
field were removed (there is not even a `spawn(` call left in the adapter).

```text
CLAUDE_PROVIDER_FACING_MCP_OWNER=claude-agent-sdk
CLAUDE_DUPLICATE_MCP_BRIDGE_PROCESS=NONE
```

The deterministic fake SDK (`tests/helpers/fake-claude-sdk.ts`) is a
protocol-faithful transport: it reads the production `mcpServers` config, spawns
the configured stdio command with the configured environment, performs
`initialize` → `notifications/initialized` → `tools/list` → `tools/call`, blocks
on the call, and derives its final assistant text **only** from the tool-result
wire value. The test never touches the MCP transport.

```text
CLAUDE_FAKE_SDK_CONSUMED_PRODUCTION_MCP_CONFIG=PASS
CLAUDE_FAKE_SDK_SPAWNED_CONFIGURED_MCP=PASS
CLAUDE_FAKE_SDK_SENT_TOOLS_CALL=PASS
CLAUDE_TEST_DIRECT_BRIDGE_INJECTION=NO
CLAUDE_TEST_MANUAL_RELEASE_GATE=NO
CLAUDE_MCP_RESULT_CAUSED_PROVIDER_CONTINUATION=PASS
CLAUDE_SAME_LOGICAL_RUN=PASS
CLAUDE_NATIVE_TOOL_EXECUTION=NONE
E2E_PROVIDER_CONTINUATION_CAUSALLY_DEPENDS_ON_TOOL_RESULT=PASS
```

`tests/http/tool-roundtrip-production.test.ts` proves the same chain through the
HTTP boundary: the second response body contains `answer=<Qoder result sentinel>`
and neither sentinel appears in any captured log sink.

---

## 4. Claude provider lifecycle / TTL / abort

`LiveClaudeSession` retains the SDK `AbortController` that was passed as
`options.abortController` — the documented, supported cancellation handle for SDK
0.3.266. No invented SDK method is used. The session also tracks the Router
request currently driving it, so a continuation cancellation reaches the exact
same provider run.

Cleanup order is fixed and race-free:

```text
clear TTL → abort provider run → reject pending bridge request → broker scope
cancel → iterator.return() → control.close() → session map cleanup
```

Cleanup is performed in a generator `finally`, so it also runs when the HTTP
consumer stops iterating at the terminal event (which it does) instead of
draining the generator to completion. That gap was measured: before the fix a
completed normal run left the session's control socket and registry descriptor
alive.

```text
CLAUDE_TTL_ABORTS_PROVIDER_RUN=PASS
CLAUDE_POST_RESULT_CANCEL_ABORTS_PROVIDER_RUN=PASS
CLAUDE_TERMINAL_STATE_CLEANUP=PASS
CLAUDE_ACTIVE_PROVIDER_RUNS=0
CLAUDE_ACTIVE_TOOL_SESSIONS=0
CLAUDE_ACTIVE_BROKER_CALLS=0
CLAUDE_ACTIVE_BRIDGE_PENDING=0
CLAUDE_ACTIVE_BRIDGE_PROCESSES=0
CLAUDE_ACTIVE_CONTROL_SOCKETS=0
```

Verification boundary: the *Router side* of the SDK contract is asserted
(abort is invoked on the retained controller, the iterator is returned, the
control socket closes, every counter is 0). The fake SDK honours the documented
`Options.abortController` contract by tearing down its child. That the real SDK
tears its MCP child down on the same abort remains a live-canary item (§10).

---

## 5. Antigravity per-run session selection

### Design

The persistent `agy mcp add` registration is global and secret-free, so it can
never carry a per-run selector. The Router therefore files one descriptor per
live run at `<registry>/agy-<agyPid>.json` (mode `0600`, directory `0700`) and
the launcher resolves the descriptor whose owner pid is **one of its own
ancestors** (`process.ppid` chain, bounded depth 4). A pid identifies exactly one
live process, so one launcher can only ever reach its own run; two concurrent
runs live in two different files with two different pids.

The Router learns the exact agy pid synchronously from the runner's `onSpawn`
hook (read from `child.pid` immediately after spawn). A bounded wait (5 s) covers
the small window before the descriptor is published. There is **no** directory
scan and **no** "there must be exactly one live session" inference.

`CMM_BRIDGE_SESSION_ID` is still exported into the agy child environment and used
as a *verification* signal: a selector naming another live session is rejected
rather than honoured. The design deliberately does not depend on environment
propagation into MCP children, because that could not be verified without a live
model turn.

### Rejections (all fail closed)

| Case | Behaviour |
| --- | --- |
| no descriptor for any ancestor | `-32000`, no Router call |
| descriptor present, owner dead or socket gone | stale → removed, `-32000` |
| `CMM_BRIDGE_SESSION_ID` names another live session | `selector-belongs-to-another-session`, `-32000` |
| duplicate pid or duplicate session id | refused at registration |
| registry at `SESSION_REGISTRY_MAX_LIVE` | refused before any provider-side bridge state |

```text
ANTIGRAVITY_SESSION_SELECTOR=agy-ancestor-pid
ANTIGRAVITY_GLOBAL_SINGLE_SESSION_SCAN=REMOVED
ANTIGRAVITY_TWO_CONCURRENT_TOOL_SESSIONS=PASS
ANTIGRAVITY_CROSS_RUN_RESULT_ISOLATION=PASS
ANTIGRAVITY_CONCURRENT_LAUNCHER_ISOLATION=PASS
BRIDGE_SESSION_SELECTOR_ISOLATION=PASS
BRIDGE_STALE_SESSION_REJECTED=PASS
BRIDGE_CROSS_SESSION_SELECTOR_REJECTED=PASS
SESSION_REGISTRY_MAX_LIVE=64
SESSION_REGISTRY_OVERFLOW_FAIL_CLOSED=PASS
```

### Concurrency proof

`tests/providers/antigravity-concurrency.test.ts` runs two overlapping sessions
through the **real** launcher: each fake agy process spawns
`src/bridge/mcp-bridge-launcher.ts` as its own child, drives real MCP stdio, and
its final text contains `final:RESULT-A` / `final:RESULT-B` respectively —
derived only from its own tool result. Neither cross-run result leaks, and the
two spawned pids are distinct.

Registration idempotence across Router restarts was **not** changed in this pass
(it was not a required deterministic family here) and remains as previously
implemented; see §10.

---

## 6. Antigravity provider lifecycle / TTL / abort

`closeToolSession` now aborts the retained controller **first**, which the live
runner wires to `child.kill("SIGINT")`; the timeout path already escalates to
`SIGKILL`. Cleanup order:

```text
clear TTL → abort agy (SIGINT, SIGKILL escalation) → reject pending bridge
request → broker scope cancel → unregister rendezvous descriptor →
control.close() → remove temp cwd → session map cleanup
```

As with Claude, cleanup runs in a generator `finally` so it is guaranteed even
when the consumer stops iterating at the terminal event.

```text
ANTIGRAVITY_TTL_ABORTS_PROVIDER_RUN=PASS
ANTIGRAVITY_POST_RESULT_CANCEL_ABORTS_PROVIDER_RUN=PASS
ANTIGRAVITY_TERMINAL_STATE_CLEANUP=PASS
ANTIGRAVITY_ACTIVE_PROVIDER_RUNS=0
ANTIGRAVITY_ACTIVE_TOOL_SESSIONS=0
ANTIGRAVITY_ACTIVE_BROKER_CALLS=0
ANTIGRAVITY_ACTIVE_BRIDGE_PENDING=0
ANTIGRAVITY_ACTIVE_CONTROL_SOCKETS=0
ANTIGRAVITY_ACTIVE_RENDEZVOUS_FILES=0
```

---

## 7. Bounded pending tool state

Every tool-related container has a declared maximum, a lifetime and a
deterministic overflow behaviour. Overflow is always an explicit safe error; no
active call is silently evicted.

| Container | Max | TTL | Overflow |
| --- | --- | --- | --- |
| `DeferredToolBroker.entries` | 64 | 120 s | `provider_rate_limited`, refuse |
| `DeferredToolBroker.terminal` / `publicTerminal` | 64 each | n/a | FIFO evict of terminals only |
| `BridgeControlServer.pending` | 16 | 120 s | `-32000` on that socket, no Router surface |
| Claude / Antigravity tool-call queue | 1 per MCP session | session TTL | `-32000`, session fails closed |
| Claude / Antigravity live sessions | 64 | session TTL | `provider_rate_limited`, refuse to park |
| Antigravity `StreamEventQueue` | 4096 events | run lifetime | overflow flag, terminal |
| Session registry (rendezvous) | 64 | descriptor removed on cleanup | registration fails closed |

`MAX_PENDING_TOOL_CALLS_PER_MCP_SESSION=1` is a deliberate, tested limitation: the
split HTTP round-trip supports exactly one parked tool call per provider session.
A second concurrent call is refused over MCP and normalised into a router error.

```text
GLOBAL_TOOL_PENDING_STATE_BOUNDED=PASS
BRIDGE_CONTROL_PENDING_BOUND=PASS
CLAUDE_TOOL_QUEUE_BOUND=PASS
ANTIGRAVITY_TOOL_QUEUE_BOUND=PASS
LIVE_PROVIDER_TOOL_SESSION_BOUND=PASS
```

---

## 8. Declared tool ACL at every provider boundary

An immutable per-request/session declared-tool ACL is enforced at four
boundaries. Authentication of the transport is not authorization.

| Boundary | Enforcement | Failure |
| --- | --- | --- |
| MCP bridge `tools/call` | name ∈ `CMM_BRIDGE_TOOLS` | MCP `-32602`, no control forward, no broker entry |
| Codex `item/tool/call` | name ∈ `dynamicTools` declared on that thread | `provider_protocol_error`, wire request answered `success:false` |
| Command Code OpenAI wire | name ∈ `request.tools` | `provider_protocol_error` before yielding |
| Command Code Anthropic wire | `tool_use.name` ∈ `request.tools` | `provider_protocol_error` before yielding |

Adversarial names exercised: `run_command`, `write_file`, `apply_patch`,
`totally_unknown_tool`.

```text
MCP_UNDECLARED_TOOL_CALL_FAIL_CLOSED=PASS
CODEX_UNDECLARED_DYNAMIC_TOOL_FAIL_CLOSED=PASS
COMMAND_CODE_OPENAI_UNDECLARED_TOOL_FAIL_CLOSED=PASS
COMMAND_CODE_ANTHROPIC_UNDECLARED_TOOL_FAIL_CLOSED=PASS
DECLARED_TOOL_ACL_AT_PROVIDER_BOUNDARY=PASS
UNDECLARED_PROVIDER_TOOL_REQUEST_SURFACED_TO_QODER=NONE
```

---

## 9. Provider tool_choice / parallel policy

One shared implementation (`src/core/tool-policy.ts`) is used by **both**
`/v1/chat/completions` and `/v1/responses`, so the two surfaces cannot diverge.
Rule: faithfully map, or explicitly reject; never silently ignore.

| Provider | `tool_choice` | `parallel_tool_calls` |
| --- | --- | --- |
| chatgpt (Codex 0.153.4) | `auto`/absent accepted; else rejected (unchanged) | `false` rejected; `true`/absent accepted (unchanged) |
| claude (SDK 0.3.266) | `auto`/absent accepted; else rejected | `true` rejected; `false`/absent accepted |
| google (agy 1.2.0) | `auto`/absent accepted; else rejected | `true` rejected; `false`/absent accepted |
| command-code OpenAI | forwarded verbatim (unchanged) | forwarded verbatim (unchanged) |
| command-code Anthropic | exact mapping | `disable_parallel_tool_use` when `false` |

Grounding:
* SDK 0.3.266 `Options` exposes `allowedTools`, `disallowedTools`,
  `permissionMode`, `canUseTool`, `hooks`, `maxTurns` — grep of `sdk.d.ts`
  confirms **no** `tool_choice` and **no** `parallel_tool_calls` anywhere.
* `agy --help` (1.2.0) exposes no tool-selection or parallel flag.
* Command Code `/provider/v1/messages` follows the Anthropic Messages schema, so
  `{type: auto|none|any|tool}` plus `disable_parallel_tool_use` is the exact
  representation. Any shape outside that table is rejected, never dropped.

```text
CODEX_TOOL_CHOICE_POLICY=PASS
CODEX_PARALLEL_TOOL_POLICY=PASS
CLAUDE_TOOL_CHOICE_POLICY=PASS
CLAUDE_PARALLEL_TOOL_POLICY=PASS
ANTIGRAVITY_TOOL_CHOICE_POLICY=PASS
ANTIGRAVITY_PARALLEL_TOOL_POLICY=PASS
COMMAND_CODE_OPENAI_TOOL_CHOICE_POLICY=PASS
COMMAND_CODE_OPENAI_PARALLEL_POLICY=PASS
COMMAND_CODE_ANTHROPIC_TOOL_CHOICE_POLICY=PASS
COMMAND_CODE_ANTHROPIC_PARALLEL_POLICY=PASS
CHAT_RESPONSES_TOOL_POLICY_CONSISTENCY=PASS
SILENT_TOOL_CHOICE_DROP=NONE
SILENT_PARALLEL_TOOL_POLICY_DROP=NONE
```

---

## 10. Production cancellation matrix

Both surfaces distinguish a **normal first `tool_calls` reply** (not a
cancellation) from a **client disconnect** (a cancellation) through a
`responseCompleted` flag: teardown only runs when the response had not reached
its terminal outcome. That single change is what makes the parked cross-request
round-trip survive while still honouring real cancellation.

| # | Scenario | Evidence | Result |
| --- | --- | --- | --- |
| 1 | cancel before the provider emits a tool call | `production-cancellation-matrix` (HTTP, real socket) | PASS |
| 2 | cancel while MCP arguments are assembling | same (provider blocked in `tools/call`) | PASS |
| 3 | first `tool_calls` HTTP response completes normally | matrix + round-trip tests | parked session survives |
| 4 | parked-session TTL expires before the result | `claude-lifecycle`, `antigravity-lifecycle` | provider aborted |
| 5 | result accepted, continuation cancelled | `claude-lifecycle`, `antigravity-lifecycle`, matrix | provider aborted |
| 6 | provider process dies | `runVerdict` path + lifecycle cleanup tests | state cleaned |
| 7 | bridge process dies while provider waits | `control-ipc` `onDisconnect` → session closed fail-closed | state cleaned |
| 8 | broker entry expires while provider waits | matrix (broker TTL + session TTL) | provider aborted |
| 9 | unrelated concurrent session | `antigravity-concurrency`, matrix (short/long TTL) | untouched |
| 10 | normal final completion | lifecycle cleanup tests | all counters 0 |

```text
PRODUCTION_CANCEL_PRE_TOOL=PASS
PRODUCTION_CANCEL_DURING_TOOL_CALL=PASS
PRODUCTION_PARK_SURVIVES_FIRST_HTTP_COMPLETION=PASS
PRODUCTION_CANCEL_WAITING_RESULT=PASS
PRODUCTION_CANCEL_POST_RESULT=PASS
PRODUCTION_PROVIDER_DEATH_CLEANUP=PASS
PRODUCTION_BRIDGE_DEATH_CLEANUP=PASS
PRODUCTION_CROSS_RUN_CANCEL_ISOLATION=PASS
PRODUCTION_NORMAL_FINAL_CLEANUP=PASS
```

No `PARTIAL` marker remains.

**Verification boundary (stated explicitly).** Scenarios 1, 2, 3, 5 and 8 are
exercised through the real HTTP boundary. Scenario 4 is exercised at the adapter
boundary using the injectable short session TTL, which drives the identical
`closeSession` / `closeToolSession` path. Scenario 7 is exercised at the control
channel plus adapter layer. The real-socket "abort mid-continuation" variant
proved timing-dependent (the client had to abort inside a sub-millisecond window
after the result was accepted) and was therefore replaced by the deterministic
adapter-level assertion of the same teardown path rather than kept as a flaky
test.

---

## 11. Integrity of the pass

```text
E2E_PROVIDER_CONTINUATION_CAUSALLY_DEPENDS_ON_TOOL_RESULT=PASS
CHATGPT_QODER_CAPABILITY=CHAT_AND_TOOLS
CLAUDE_QODER_CAPABILITY=CHAT_AND_TOOLS
GOOGLE_QODER_CAPABILITY=CHAT_AND_TOOLS
COMMAND_CODE_QODER_CAPABILITY=CHAT_AND_TOOLS
QODER_EXECUTION_OWNER=YES
PROVIDER_NATIVE_TOOL_EXECUTION=NONE
CMMCHAT_TOOL_ESCALATION=NONE
UNAUTHENTICATED_TOOL_ESCALATION=NONE
API_PAYG_FALLBACK=NONE
CROSS_PROVIDER_FALLBACK=NONE
UNKNOWN_MODEL_FALLBACK=NONE
COMMAND_CODE_ON_DEMAND=NONE
NO_TRACKED_SECRETS=PASS
LOOPBACK_ONLY=PASS
TOOL_ARGUMENT_LOGGING=NONE
TOOL_RESULT_LOGGING=NONE
```

Regression protection preserved: Codex experimental dynamicTools; Codex
same-thread/same-turn continuation; Codex public/internal call-ID split; broker
TTL/max; Command Code both tool wires; Responses canonical lifecycle; 1 MiB tool
result bound; Qoder bearer provisioning; PAYG poison protection; CMMChat
CHAT_ONLY; loopback-only server; OAuth isolation; Command Code spend gates;
re-audit 6 fixes; logging hygiene.

---

## 12. Commits

| Commit | Subject |
| --- | --- |
| `d12eee5` | docs: design Task 13 MCP hardening and provider policy |
| `06e099c` | docs: plan Task 13 MCP hardening and provider policy |
| `fa8059c` | test: expose Claude MCP E2E bypass |
| `bac2d06` | fix: make Claude SDK own the provider-facing MCP bridge |
| `506ad8f` | fix: bound bridge and session pending state |
| `c3a6eb3` | fix: revalidate Antigravity 1.2.0 session selection and lifecycle |
| `cd67da7` | fix: enforce declared tool ACL at provider boundaries |
| `589abd7` | fix: enforce provider tool choice and parallel policies |
| `2f4a1d0` | fix: complete Claude provider lifecycle cancellation |
| `970c31b` | security: harden MCP session isolation and bounds |

`START_HEAD` → `FINAL_HEAD`: `b439378…` → `970c31b33a21bc21bf1dd470810887f7d6dcdf24`.

Deviation from the suggested commit structure (documented dependency, not a
merge): the Antigravity selector, lifecycle and bounds work is one commit because
`src/providers/antigravity/adapter.ts` carries all three concerns in one file, and
the Claude bounds/lifecycle work is folded into the Claude lifecycle commit for
the same reason. No commit was squashed and no historical commit was amended.

---

## 13. Verification commands and results

```text
npm test                    # Test Files 103 passed | 5 skipped; Tests 520 passed | 25 skipped
npm test                    # identical
npm test                    # identical
npm run typecheck           # clean
npm run build               # clean
npm test                    # identical (post-build)
bash scripts/security-audit.sh   # SECURITY_AUDIT=PASS
npx vitest run <12 new/updated suites by path>   # 12 files, 39 tests passed
```

The 5 skipped test files are exactly the pre-existing
`describe.skipIf(!process.env.CMM_RUN_LIVE)` provider integration suites. No new
deterministic test is skipped.

---

## 14. Remaining limitations and live canaries

1. **`ANTIGRAVITY_PROVIDER_SIDE_MCP_INVOCATION` is still unproven.** That the real
   `agy 1.2.0` actually consumes the registered `cmm-qoder-tools` MCP server
   during a headless `--print` run needs a live model turn. This pass removes the
   CLI-version dependency and proves the Router contract, but cannot substitute
   for a real provider turn.
2. **Environment propagation from agy to MCP children is unverified.** The
   ancestor-pid anchor in §5 was chosen precisely so the answer does not matter;
   if propagation is later confirmed, `CMM_BRIDGE_SESSION_ID` adds exact
   verification on top.
3. **The Claude side of SDK MCP ownership is asserted through a
   protocol-faithful fake SDK**, which follows the documented
   `Options.mcpServers` / `Options.abortController` contract. Whether the real
   SDK spawns and tears down its MCP child exactly as documented is a live item.
4. **Antigravity MCP registration restart idempotence was not changed.** The
   in-process registration guard remains; reconciliation against a previously
   registered `cmm-qoder-tools` entry after a Router restart is unchanged and
   still needs a non-inference `agy mcp list`/`add` reconciliation canary.
5. **Timing sensitivity of the real-socket post-result abort** (§10) meant that
   scenario is asserted at the adapter boundary rather than through a live
   socket.

### Smallest live canaries still required (NOT run)

1. Register the CMM MCP server, run one headless `agy --print` turn requesting one
   declared Qoder tool, and confirm the tool call reaches the Router control
   channel and the run resumes on the result (`ANTIGRAVITY_PROVIDER_SIDE_MCP_INVOCATION`).
2. Run one Claude subscription turn with one declared tool and confirm the SDK
   spawns the configured MCP child, forwards `tools/call`, and continues on the
   result; then abort and confirm the child exits.
3. `agy mcp list` reconciliation after a Router restart.

None of these were executed. Live inference was not run in this pass.

---

## 15. Verdict

```text
CMM_SUBSCRIPTION_ROUTER_TASK13_MCP_HARDENING=IMPLEMENTED
STATUS=IMPLEMENTED_PENDING_INDEPENDENT_REAUDIT
LIVE_TOOL_ACCEPTANCE_RUN=NO
FINAL_TASK13_CLOSURE=NO
```

Deterministic requirements in this pass all pass. Closure still requires an
independent re-audit of this exact HEAD, authorisation of the minimal live
canaries, and successful live proof without PAYG fallback or provider-native
mutation.
