# Task 13 — MCP Hardening & Provider Policy (delta design)

**Date:** 2026-09-10
**Base HEAD:** `b439378c47c0764bb4c651e48b94bbe752c2c3f2`
**Authoritative input:** `docs/audits/2026-09-10-independent-task13-protocol-truth-reaudit-cab1060.md`
**Supersedes nothing historical.** Historical audit documents are not edited.

## 0. Purpose and scope

The independent re-audit at `cab1060` found genuine progress (Codex dynamic tools,
broker production wiring, Command Code OpenAI body forwarding, Responses
lifecycle, 1 MiB bound) and a narrow set of remaining production gaps concentrated
in two areas:

1. the Claude/Antigravity MCP architecture and its deterministic proofs, and
2. provider-by-provider control policy (`tool_choice` / `parallel_tool_calls`).

This design covers **only** those gaps plus the P1 hardening explicitly required
by the prompt. It does **not** reopen the product requirement, does not redesign
the Codex path, and does not touch anything listed under
`CURRENT VERIFIED BASELINE — PRESERVE`.

### 0.1 Non-negotiable product requirement (unchanged)

| Consumer | chatgpt/* | claude/* | google/* | command-code/* |
| --- | --- | --- | --- | --- |
| CMMChat | CHAT_ONLY | CHAT_ONLY | CHAT_ONLY | CHAT_ONLY |
| Qoder | CHAT_AND_TOOLS | CHAT_AND_TOOLS | CHAT_AND_TOOLS | CHAT_AND_TOOLS |

`PROVIDER_OWNS_REASONING=YES`, `QODER_OWNS_TOOLS=YES`,
`ROUTER_EXECUTES_QODER_SIDE_EFFECTS=NO`,
`PROVIDER_NATIVE_TOOL_EXECUTION=NO`.

### 0.2 Economic / privacy invariants (unchanged)

`API_PAYG_FALLBACK=NO`, `CROSS_PROVIDER_FALLBACK=NO`, `UNKNOWN_MODEL_FALLBACK=NO`,
`OAUTH_EXTRACTION=NO`, `COMMAND_CODE_ON_DEMAND=NO`, `PROMPT_LOGGING=NO`,
`COMPLETION_LOGGING=NO`, `TOOL_ARGUMENT_LOGGING=NO`, `TOOL_RESULT_LOGGING=NO`,
`LOOPBACK_ONLY=YES`, no tracked secrets.

## 1. Runtime version revalidation (P0 #1)

### 1.1 Measured facts (non-inference, captured in this session)

```text
command -v agy   -> /Users/example/.local/bin/agy
agy --version    -> 1.2.0
```

`agy 1.2.0` CLI surface (verbatim, non-inference):

```text
Usage: agy mcp add [flags] <name> <commandOrUrl> [args...]
Flags: -e/--env KEY=value (repeatable), -t/--type stdio|http,
       -H/--header "K: V" (repeatable), -h/--help
Notes: Flags must come before <name>; a flag placed after it is rejected.
```

`agy --help` exposes **no** tool-selection or parallel-execution control. The
full flag set is: `--add-dir --agent -c/--continue --conversation
--dangerously-skip-permissions --disable-slash-commands --effort
-i/--prompt-interactive --input-format --json-schema --log-file --mode --model
--new-project --output-format -p/--print --print-timeout --project --prompt
--prompt-interactive --sandbox`.

Persistent MCP config path (from the installed binary):

```text
~/.gemini/config/mcp_config.json
```

`agy mcp list` currently reports `No MCP servers configured.` Persistent
registration is therefore **global**, not per-run. This is the root cause of the
concurrency defect in §5.

### 1.2 Stale version constants — classification

| Location | Value | Classification | Action |
| --- | --- | --- | --- |
| `src/providers/antigravity/process-client.ts:8` `AGY_VERSION` | `"1.1.16"` | dead runtime constant (never read) | **delete**; no consumer |
| `README.md:97` | `agy 1.1.16` note | documentation | rewrite against 1.2.0 |
| `docs/audits/*` | `1.1.28` references | historical evidence | **do not touch** |
| prior design/evidence docs (`2026-09-10-task13-protocol-truth-*`) | `1.1.28` | superseded evidence | **do not touch**; superseded by this delta |

`AGY_VERSION` is not referenced anywhere in `src/` or `tests/`. It is a stale
constant, not a runtime gate. Removing it removes the three-way disagreement
(`1.1.16` constant / `1.1.28` docs / `1.2.0` runtime).

**Decision:** no runtime version pin. Antigravity behaviour is gated by observed
protocol results (parse failures fail closed), not by a version string. The only
version-derived assumption that mattered — the anchor mechanism in §5 — is
replaced by a mechanism that does not depend on the CLI version at all.

## 2. Claude: single authoritative provider-facing MCP owner (P0 #2)

### 2.1 Current defect

`ClaudeAdapter.run()` does two things when `request.tools.length > 0`:

1. `this.spawnFn(this.bridgeCommand, [this.bridgeEntryPath], …)` — a Router-spawned
   provider-facing MCP stdio process, and
2. passes the *same* command to the SDK as `options.mcpServers.cmm_qoder`.

That is two independent provider-facing bridge instances. It also lets the
deterministic tests bypass the SDK entirely: the test grabs the Router-spawned
child and writes `tools/call` to its stdin, then unblocks the fake SDK with an
unrelated `release()` Promise. The claimed causal chain is not exercised.

### 2.2 Target architecture

```text
ClaudeAdapter
  ├─ BridgeControlServer.listen()          (Router-side CONTROL channel, Unix socket)
  │     └─ onToolCall -> bounded session queue  (Router-facing, not MCP)
  ├─ options.mcpServers.cmm_qoder = { type:"stdio", command, args, env }  (ONE config)
  └─ queryFn({ prompt, options })          (the SDK owns the provider-facing child)
        SDK spawns the MCP stdio bridge process
          └─ bridge connects back to the Router control socket
```

* The Router creates **one** `BridgeControlServer` per tool-capable request. This
  is a Router-side control channel, not a provider-facing MCP server.
* The Router creates **zero** provider-facing MCP processes. The SDK owns and
  spawns the single MCP stdio child from `options.mcpServers`.
* `CLAUDE_PROVIDER_FACING_MCP_OWNER=claude-agent-sdk`
* `CLAUDE_DUPLICATE_MCP_BRIDGE_PROCESS=NONE`

Removed: the `spawnFn` seam, the `bridge` `ChildProcess` field on the session,
and the manual spawn code path. There is no second owner to reconcile.

### 2.3 Protocol-faithful deterministic fake SDK

`tests/helpers/fake-claude-sdk.ts` implements a transport-faithful
`queryFn` replacement that **consumes the production `options.mcpServers`
configuration**. It:

1. reads `options.mcpServers` (the exact object production builds);
2. spawns the configured stdio command with the configured `env` — a real child;
3. performs `initialize`, `notifications/initialized`, `tools/list`;
4. selects one tool from the `tools/list` result (must be a declared tool);
5. sends `tools/call` over MCP stdio;
6. **awaits** the `tools/call` response;
7. extracts the textual result and derives its final answer from it
   (`final text` contains the exact result string);
8. emits `result`/`subtype:"success"` only after step 7.

The emitted final text is a **function of the actual tool-result wire value**, so
the test asserts `CLAUDE_MCP_RESULT_CAUSED_PROVIDER_CONTINUATION=PASS` by
comparing the provider's final text to a canary that only exists in the Qoder
tool result.

Forbidden in the new tests (and asserted absent by static check):

```text
fake.release()            direct test -> bridge stdin write
manualResolve()           test-owned Promise gate as the continuation cause
test-only callback that bypasses the adapter
```

## 3. Claude provider lifecycle / TTL / abort (P0 #3)

### 3.1 Model

```text
ACTIVE_PROVIDER  --(MCP tools/call)-->  PARKED_WAITING_QODER
PARKED_WAITING_QODER --(tool result accepted)--> RESUMING_PROVIDER
RESUMING_PROVIDER --(terminal)--> TERMINATED
any --(TTL | cancel | fatal | malformed | teardown)--> TERMINATED
```

### 3.2 Retained cancellation handle

`LiveClaudeSession` keeps `abortController: AbortController` — the **same**
controller passed to `options.abortController`. SDK 0.3.266 documents that
`Options.abortController` aborts the running query; the SDK owns the MCP child
and tears it down on query abort. No invented SDK method is used.

### 3.3 Cleanup order (race-free)

```text
1. clear TTL timer
2. abortController.abort()            <- provider run / SDK query / MCP child
3. reject pending bridge control request   (control.reject)
4. broker.cancelScope({provider, sessionId})
5. iterator.return?.()                (release the async iterator)
6. control.close()                    (socket + dir removal)
7. session map cleanup                (sessions / sessionsByRequest)
```

### 3.4 Request-id rebinding (post-result cancel)

Today a continuation request never registers its `requestId` with the adapter, so
`adapter.cancel(continuationRequestId)` is a no-op and a client disconnect during
continuation cannot abort the provider. Fix: the session tracks
`activeRequestId`, rebound on park and on continuation. `cancel(id)` resolves
`activeRequests` **or** `sessionsByRequest` and aborts the live controller.

### 3.5 Distinguishing normal completion from cancellation (HTTP layer)

Required semantics:

```text
NORMAL FIRST tool_calls RESPONSE COMPLETION  != cancellation (park must survive)
CONTINUATION CLIENT DISCONNECT               == cancellation (provider must abort)
```

Both surfaces (`openai-chat.ts`, `openai-responses.ts`) gain a
`responseCompleted` flag, set only after the handler has delivered a terminal
outcome (non-streaming reply sent, or the SSE stream reached `completed`/`error`
and ended). `reply.raw.on("close", …)` tears down **only when
`responseCompleted === false`**. The first `tool_calls` response completes
normally, so the parked session survives with no special-casing inside the
adapter's `cancel()`.

## 4. Antigravity concurrency: per-run anchor (P0 #4)

### 4.1 Current defect

`discoverBridgeSession()` returns a descriptor only when exactly one live
descriptor exists globally (`live.length !== 1 → null`). Two legitimate
concurrent Google tool runs therefore both fail closed. Fail-closed ambiguity is
not cross-run isolation; it is a concurrency failure.

### 4.2 Env-propagation question

The prompt prefers `CMM_BRIDGE_SESSION_ID` in the agy child environment **if**
agy propagates its environment to MCP children. This cannot be verified in this
pass: verification requires spawning an MCP server from a real agy run, and the
live-inference policy forbids any model turn. Therefore the design must not
*depend* on that behaviour.

### 4.3 Chosen mechanism — process-identity anchor (no CLI assumption)

The MCP child is, by definition, a descendant of the agy process that spawned it.
`SpawnInferenceRunner` spawns agy, so the Router knows agy's exact pid
(`child.pid`). The launcher can therefore identify its own agy ancestor without
any assumption about environment propagation:

1. `SpawnInferenceRunner` reports the spawned agy pid to the adapter (a small
   `onSpawn(pid)` hook) — read synchronously from `child.pid` inside the promise
   executor, so the pid is available before the session descriptor is published.
2. The Router publishes the rendezvous descriptor at
   `<registry>/agy-<pid>.json`, mode `0600`; the directory is `0700`.
3. The launcher resolves its selector:
   * if `CMM_BRIDGE_SESSION_ID` is present **and** a matching descriptor exists and
     its `agyPid` is one of the launcher's ancestors → use it (exact, if agy does
     propagate env);
   * otherwise walk the ancestor chain (`process.ppid`, up to
     `MAX_ANCESTOR_DEPTH = 4`) and read `<registry>/agy-<pid>.json` for the first
     ancestor that has one.
4. A direct file read, not a directory scan: no "find whichever live session
   exists" logic remains.

Ambiguity is structurally impossible: a pid identifies exactly one live process,
and the file name is the pid. Two concurrent sessions live in two different
files with two different pids.

Rejections (all fail closed, no fallback to global discovery):

| Case | Result |
| --- | --- |
| no descriptor for any ancestor | MCP error `-32000`, no Router call |
| descriptor present but socket gone | descriptor is stale → MCP error |
| descriptor `sessionId` mismatch vs `CMM_BRIDGE_SESSION_ID` | MCP error (cross-session) |
| two descriptors resolve to the same `sessionId` | refused at registration (`duplicate selector`) |
| registry at `SESSION_REGISTRY_MAX_LIVE` | registration fails closed before spawning agy |

### 4.4 Selector security

* The selector (pid / session id) is **not** the secret. The per-session random
  32-byte control token in the `0600` descriptor remains the secret.
* The selector is removed on terminal cleanup (`unregister()`), rejected when
  stale, and never written into persistent agy MCP config.
* `agy mcp add` registration stays secret-free (`--env` unused).

### 4.5 Concurrency proof

Two fake agy runs, each spawning the **real launcher** as a child process, with
overlapping lifetimes, same tool name and same arguments. Each descriptor is
registered against its own fake-agy pid. Assertions: launcher A reaches only
socket A, launcher B only socket B, A's result cannot release B, B's cannot
release A, both complete successfully.

## 5. Antigravity provider lifecycle / TTL / abort (P0 #5)

`closeToolSession()` currently removes Router state (broker entry, registry
descriptor, control socket, temp cwd) but never terminates the in-flight agy
process. Fix: call `session.abortController.abort()` **first**. The runner already
wires `abortController.signal` to `child.kill("SIGINT")`, with `SIGKILL` after
2 s in the timeout path; the abort path gains the same escalation so a live agy
cannot survive cleanup.

Cleanup order (same shape as §3.3):

```text
1. clear TTL timer
2. abortController.abort()        -> agy SIGINT (SIGKILL escalation)
3. reject pending bridge control request
4. broker.cancelScope
5. unregister rendezvous descriptor
6. control.close()
7. rmSync(cwd)
8. session map cleanup
```

## 6. Bounded pending tool state (P0 #6)

Every tool-related container gets a documented maximum, TTL and overflow
behaviour. No container grows without bound on provider-controlled input.

| Container | Max | TTL | Overflow behaviour | Owner |
| --- | --- | --- | --- | --- |
| `DeferredToolBroker.entries` | 64 (`maxPending`) | 120 s | `provider_rate_limited`, refuse new | broker |
| `DeferredToolBroker.terminal` / `publicTerminal` | 64 each | n/a (FIFO evict) | evict oldest terminal | broker |
| `BridgeControlServer.pending` | 16 per control server | 120 s per entry | socket-level `-32000` error frame, no Router surface | control server |
| Claude tool-call queue | 1 (parked-call bound) | session TTL | extra call rejected `-32000`, session closed fail-closed | adapter |
| Claude `sessions` / `sessionsByRequest` | `MAX_LIVE_TOOL_SESSIONS` | session TTL | `provider_rate_limited`, refuse to park | adapter |
| Antigravity tool-call queue | 1 | session TTL | as Claude | adapter |
| Antigravity `toolSessions` | `MAX_LIVE_TOOL_SESSIONS` | session TTL | `provider_rate_limited`, refuse to park | adapter |
| Session registry (rendezvous) | `SESSION_REGISTRY_MAX_LIVE` | descriptor removed on cleanup | registration fails closed before spawning agy | registry |
| `StreamEventQueue` (agy events) | `MAX_STREAM_EVENTS` | run lifetime | protocol error, terminal | adapter |

`MAX_PENDING_TOOL_CALLS_PER_MCP_SESSION=1` is enforced deliberately: the split
HTTP round-trip supports exactly one parked tool call per provider session. A
second concurrent `tools/call` on the same session fails closed (`-32000` over
MCP **and** a normalised router error), which is a tested, deliberate limitation,
not a silent drop.

`SESSION_REGISTRY_MAX_LIVE` aligns with the broker global maximum (64), since a
live parked provider session maps 1:1 onto a broker entry.

Overflow always produces a deterministic safe error. There is no silent eviction
of an active call.

## 7. Declared tool ACL at every provider boundary (P0 #7)

Authentication is not authorization. Each boundary gets an immutable
per-session declared-tool ACL (name set, plus the declared schema where useful).

| Boundary | ACL source | Undeclared name behaviour |
| --- | --- | --- |
| MCP bridge `tools/call` | `CMM_BRIDGE_TOOLS` | MCP error `-32602`; **no** control-channel forward; no broker entry |
| Codex `item/tool/call` | `dynamicTools` sent on that exact `thread/start` | `provider_protocol_error`; no Qoder surface; no broker insert; original JSON-RPC request answered `success:false` |
| Command Code OpenAI wire | `request.tools` | `provider_protocol_error` before yielding any `tool_call_delta` |
| Command Code Anthropic wire | `request.tools` | `provider_protocol_error` before yielding any `tool_call_delta` |

Adversarial names used in tests: `run_command`, `write_file`, `apply_patch`,
`totally_unknown_tool`. Provider-native execution count stays zero.

## 8. Provider tool_choice / parallel policy (P0 #8)

Rule: **faithfully map, or explicitly reject. Never silently ignore.**
Implemented in one shared module (`src/core/tool-policy.ts`) invoked by **both**
HTTP surfaces so `/v1/chat/completions` and `/v1/responses` cannot diverge.

| Provider | `tool_choice` | `parallel_tool_calls` |
| --- | --- | --- |
| chatgpt (Codex 0.153.4) | `auto`/absent ok; else reject | `false` reject; `true`/absent ok (preserve current) |
| claude (SDK 0.3.266) | `auto`/absent ok; else reject | `true` reject; `false`/absent ok |
| google (agy 1.2.0) | `auto`/absent ok; else reject | `true` reject; `false`/absent ok |
| command-code OpenAI | forward unchanged | forward unchanged (preserve) |
| command-code Anthropic | map exactly | map exactly |

### 8.1 Claude

SDK 0.3.266 `Options` exposes `allowedTools`, `disallowedTools`, `permissionMode`,
`canUseTool`, `hooks`, `maxTurns` — verified by grep of `sdk.d.ts`:
**no `tool_choice` and no `parallel_tool_calls` anywhere.** There is no exact
mapping. `tool_choice:"auto"` is the SDK's only behaviour and is therefore
faithful; everything else is rejected before provider invocation.
`parallel_tool_calls:true` cannot be represented (this pass deliberately enforces
one parked call per session), so it is rejected; `false`/absent is exactly what
the enforced behaviour provides, so it is accepted.

### 8.2 Antigravity

`agy --help` (1.2.0) exposes no tool-selection or parallel flag. Any explicit
`tool_choice !== "auto"` is rejected before spawning agy; `parallel_tool_calls:true`
is rejected; `false`/absent accepted.

### 8.3 Command Code Anthropic

`/provider/v1/messages` follows the Anthropic Messages schema. Exact mapping
added to the request body builder:

| OpenAI input | Anthropic wire |
| --- | --- |
| `tool_choice:"auto"` | `{type:"auto"}` |
| `tool_choice:"none"` | `{type:"none"}` |
| `tool_choice:"required"` | `{type:"any"}` |
| `tool_choice:{type:"function",function:{name}}` | `{type:"tool",name}` |
| `parallel_tool_calls:false` | `tool_choice.disable_parallel_tool_use=true` |
| `parallel_tool_calls:true` | omitted (parallel allowed by default) |

A `tool_choice` input that cannot be represented in that table is rejected
explicitly, never dropped.

## 9. Production cancellation matrix (P0 #9)

Both MCP providers must satisfy all ten scenarios. `PRODUCTION_CANCEL_POST_RESULT`
must be a true PASS, not PARTIAL.

| # | Scenario | Expected |
| --- | --- | --- |
| 1 | cancel before provider emits a tool call | provider aborted, all counters 0 |
| 2 | cancel while MCP arguments are assembling | provider aborted, all counters 0 |
| 3 | first `tool_calls` HTTP response completes normally | parked session **survives** |
| 4 | parked TTL expires before Qoder result | provider run aborted |
| 5 | result accepted, continuation client disconnects | provider run aborted |
| 6 | result accepted, provider process dies | all Router/MCP state cleaned |
| 7 | bridge process dies while provider waits | parked request rejected, session closed |
| 8 | broker entry expires while provider waits | provider run aborted |
| 9 | unrelated concurrent session remains alive | untouched |
| 10 | normal final completion | all counters 0 |

Terminal invariant (both providers):

```text
ACTIVE_PROVIDER_RUNS=0  ACTIVE_TOOL_SESSIONS=0  ACTIVE_BROKER_CALLS=0
ACTIVE_BRIDGE_PENDING=0 ACTIVE_BRIDGE_PROCESSES=0 ACTIVE_CONTROL_SOCKETS=0
ACTIVE_RENDEZVOUS_FILES=0
```

## 10. P1 — selector/IPC security and registry bound

Preserved properties: Unix-domain-only control channel; `0700` session directory;
`0600` socket and rendezvous metadata; per-session random control token; no
Internet bind; no provider credential in the bridge; no tracked token; no tool
content logging.

New tests: wrong selector, stale selector, missing selector, duplicate selector,
cross-session selector.

`SESSION_REGISTRY_MAX_LIVE=64`; overflow fails closed before any provider-side
bridge state is created.

## 11. P1 — remove test escape hatches

E2E tests must prove the causal chain
`PROVIDER_GENERATES_TOOL_REQUEST → ROUTER SURFACES CALL → QODER RESULT →
SAME PROVIDER FLOW CONSUMES RESULT → PROVIDER GENERATES FINAL RESPONSE`, with the
final response causally depending on the tool result (canary-valued assertion).

Tests that currently manufacture the round-trip are rewritten:

| File | Current escape hatch | Replacement |
| --- | --- | --- |
| `tests/providers/claude-bridge-roundtrip.test.ts` | test writes `tools/call` to the Router-spawned bridge; `fake.release()` gate | protocol-faithful fake SDK (§2.3) owns the MCP client; canary causality |
| `tests/http/tool-roundtrip-production.test.ts` | same structure over HTTP | same fake SDK, production `mcpServers`, canary causality |
| `tests/providers/antigravity-bridge-roundtrip.test.ts` | artificial `releaseCompletion` gate | fake agy emits its terminal result only after it has read the MCP response, and its final text is canary-derived |

Helper-only tests may complement these but never replace them.

## 12. Router-level E2E requirement

After the provider-specific deterministic tests, Router-level HTTP E2Es traverse
for Claude and Antigravity:

```text
HTTP Qoder bearer → capability boundary → real provider adapter → production
broker → real bridge-control server → provider-owned / protocol-faithful MCP
client → tool request → HTTP tool-call response → simulated Qoder execution →
second HTTP request with tool result → exact same provider run/session →
final response derived from the Qoder result
```

For Claude the protocol-faithful fake SDK **is** the MCP client. For Antigravity
the fake agy process itself spawns/uses the production launcher mechanism. The
harness may replace provider inference; it may not replace the provider→MCP
causal path.

## 13. Regression protection (must not regress)

Codex experimental dynamicTools; Codex same-thread/same-turn continuation; Codex
public/internal call-ID split; broker TTL/max; Command Code both tool wires;
Responses canonical lifecycle; 1 MiB result bound; Qoder bearer provisioning;
PAYG poison protection; CMMChat CHAT_ONLY; loopback-only server; OAuth isolation;
Command Code spend gates; re-audit 6 fixes; logging hygiene. No unrelated
refactors.

## 14. Live test policy

No live provider inference in this pass. Allowed: `agy --version`, `agy --help`,
`agy mcp --help`, `agy mcp add --help`, `agy mcp list`, local fake agy
subprocesses, local fake Claude SDK, MCP stdio protocol tests, Unix-socket tests,
Codex schema generation without a model turn, and all deterministic non-live
tests.

## 15. Limitations this design cannot close

1. `ANTIGRAVITY_PROVIDER_SIDE_MCP_INVOCATION` — that the real `agy` 1.2.0 actually
   consumes the registered MCP server during a headless `--print` run still needs
   a live canary. The design removes the CLI-version dependency but cannot
   substitute for a real provider turn.
2. Whether agy 1.2.0 propagates parent environment to MCP children is unverified;
   §4.3 is deliberately constructed so the answer does not matter.
3. Claude SDK MCP-invocation behaviour against the real SDK is proven through a
   protocol-faithful fake, not a live model turn.

These are documented as remaining live canaries. They are not claimed as PASS.
