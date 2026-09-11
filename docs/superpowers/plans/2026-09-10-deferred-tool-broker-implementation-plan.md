# Deferred Tool Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all ten Task 13 reaudit findings with a shared deferred tool broker and per-provider wire completion.

**Architecture:** A bounded in-memory broker (`src/core/deferred-tool-broker.ts`) owns pending tool-call correlation; each adapter parks provider tool requests instead of executing them, surfaces them to Qoder, and resolves the ORIGINAL pending request with Qoder's result on the follow-up turn. No declaration channel is faked where none exists (Codex 0.153.4 verified).

**Tech Stack:** TypeScript, Vitest, Fastify, Codex app-server JSON-RPC, Claude Agent SDK 0.3.266, agy MCP stdio, Command Code OpenAI wire.

**Spec:** `docs/superpowers/specs/2026-09-10-deferred-tool-broker-design.md`

---

## File Map

```text
Create: src/core/deferred-tool-broker.ts
Create: tests/core/deferred-tool-broker.test.ts
Create: src/providers/claude/mcp-bridge.ts
Create: src/providers/antigravity/mcp-bridge.ts (shared impl with claude bridge where possible)
Create: tests/providers/deferred-tool-cancellation.test.ts
Create: tests/providers/deferred-tool-isolation.test.ts
Create: tests/providers/command-code-strict-continuation.test.ts
Create: tests/providers/command-code-fragmented-stream.test.ts
Create: tests/http/responses-function-call-output.test.ts
Create: tests/http/tool-choice-forwarding.test.ts
Modify: src/core/model.ts (toolChoice, parallelToolCalls)
Modify: src/http/openai-chat.ts (parse + forward tool_choice/parallel_tool_calls)
Modify: src/http/openai-responses.ts (function_call_output items)
Modify: src/providers/codex/adapter.ts (hold pending, success:true, same-thread resume)
Modify: src/providers/command-code/adapter.ts (assistant tool_calls history, index-keyed assembly)
Modify: src/providers/claude/adapter.ts (defer + resume, capability stays gated)
Modify: src/providers/antigravity/adapter.ts (MCP bridge wiring, capability stays gated)
Modify: scripts/macos/run-router.sh (CMM_QODER_TOKEN from Keychain)
Modify: launchd/com.cmm.subscription-router.plist.template (Qoder Keychain ids)
Modify: tests/integration/launchagent.test.ts (Qoder wiring assertions)
Modify: tests/providers/codex-dynamic-tool.test.ts (remove false marker)
Modify: tests/providers/codex-tool-e2e.test.ts (same-turn proof)
Create: docs/audits/2026-09-10-task13-deferred-tool-broker-evidence.md
```

---

### Task 1: Deferred tool broker core

**Files:**
- Create: `src/core/deferred-tool-broker.ts`
- Test: `tests/core/deferred-tool-broker.test.ts`

**Interfaces:**
- Produces: `DeferredToolBroker`, `createPendingCall`, `resolveCall`, `awaitCall`, `cancelScope`, `activeCount`.
- Key: `{consumer:"qoder", provider, sessionId, turnId?, toolCallId}` stringified as `provider|sessionId|turnId|toolCallId`.

- [ ] **Step 1: Write the failing broker test**

Create `tests/core/deferred-tool-broker.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DeferredToolBroker } from "../../src/core/deferred-tool-broker.js";

const KEY = { consumer: "qoder" as const, provider: "chatgpt" as const, sessionId: "thread-1", turnId: "turn-1", toolCallId: "call-1" };

describe("DeferredToolBroker", () => {
  it("resolves a pending call exactly once and rejects duplicates", async () => {
    const broker = new DeferredToolBroker({ maxPending: 4, defaultTtlMs: 1000 });
    broker.createPendingCall(KEY, 1000);
    expect(broker.resolveCall(KEY, "result-1")).toBe("resolved");
    expect(broker.resolveCall(KEY, "result-2")).toBe("duplicate");
    expect(broker.activeCount()).toBe(0);
  });

  it("rejects late results after TTL expiry", async () => {
    const broker = new DeferredToolBroker({ maxPending: 4, defaultTtlMs: 10 });
    broker.createPendingCall(KEY, 10);
    await new Promise((r) => setTimeout(r, 30));
    expect(broker.resolveCall(KEY, "late")).toBe("stale");
    expect(broker.activeCount()).toBe(0);
  });

  it("refuses new entries when bounded, never evicts live ones", () => {
    const broker = new DeferredToolBroker({ maxPending: 1, defaultTtlMs: 1000 });
    broker.createPendingCall(KEY, 1000);
    expect(() => broker.createPendingCall({ ...KEY, toolCallId: "call-2" }, 1000)).toThrow(/bounded/);
    expect(broker.activeCount()).toBe(1);
  });

  it("cancelScope releases only the matching scope", async () => {
    const broker = new DeferredToolBroker({ maxPending: 4, defaultTtlMs: 1000 });
    broker.createPendingCall(KEY, 1000);
    broker.createPendingCall({ ...KEY, sessionId: "thread-2", toolCallId: "call-2" }, 1000);
    broker.cancelScope({ sessionId: "thread-1" });
    expect(broker.resolveCall(KEY, "x")).toBe("stale");
    expect(broker.activeCount()).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/core/deferred-tool-broker.test.ts`
Expected: FAIL with "Failed to resolve import" (module does not exist).

- [ ] **Step 3: Write minimal broker implementation**

Create `src/core/deferred-tool-broker.ts`:

```ts
import { RouterError } from "./errors.js";
import type { ProviderId } from "./model.js";

export interface BrokerKey {
  consumer: "qoder";
  provider: ProviderId;
  sessionId: string;
  turnId?: string;
  toolCallId: string;
}

export type ResolveOutcome = "resolved" | "duplicate" | "stale" | "unknown";

interface Entry {
  key: string;
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}

function keyOf(key: BrokerKey): string {
  if (!key.sessionId || !key.toolCallId) {
    throw new RouterError("provider_protocol_error", "Broker key requires sessionId and toolCallId");
  }
  return `${key.provider}|${key.sessionId}|${key.turnId ?? ""}|${key.toolCallId}`;
}

export class DeferredToolBroker {
  private readonly entries = new Map<string, Entry>();
  private readonly maxPending: number;
  private readonly defaultTtlMs: number;

  constructor(options: { maxPending?: number; defaultTtlMs?: number } = {}) {
    this.maxPending = options.maxPending ?? 64;
    this.defaultTtlMs = options.defaultTtlMs ?? 120_000;
  }

  createPendingCall(key: BrokerKey, ttlMs?: number, signal?: AbortSignal): void {
    if (key.consumer !== "qoder") {
      throw new RouterError("provider_protocol_error", "Broker accepts Qoder entries only");
    }
    const id = keyOf(key);
    if (this.entries.has(id)) {
      throw new RouterError("provider_protocol_error", "Duplicate pending tool call");
    }
    if (this.entries.size >= this.maxPending) {
      throw new RouterError("provider_rate_limited", "Tool broker pending state bounded; refusing new entry");
    }
    let resolveFn!: (value: unknown) => void;
    const promise = new Promise<unknown>((resolve) => { resolveFn = resolve; });
    void promise;
    const timer = setTimeout(() => this.expire(id), ttlMs ?? this.defaultTtlMs);
    const entry: Entry = { key: id, resolve: resolveFn, timer, settled: false };
    this.entries.set(id, entry);
    if (signal) {
      if (signal.aborted) { this.cancelScope({ sessionId: key.sessionId }); return; }
      signal.addEventListener("abort", () => this.cancelScope({ sessionId: key.sessionId }), { once: true });
    }
  }

  awaitCall(key: BrokerKey): Promise<unknown> {
    const id = keyOf(key);
    const entry = this.entries.get(id);
    if (!entry) return Promise.reject(new RouterError("provider_protocol_error", "Unknown pending tool call"));
    return new Promise<unknown>((resolve, reject) => {
      const prev = entry.resolve;
      entry.resolve = (value: unknown) => { prev(value); resolve(value); };
      void reject;
    });
  }

  resolveCall(key: BrokerKey, result: unknown): ResolveOutcome {
    const id = keyOf(key);
    const entry = this.entries.get(id);
    if (!entry) return "unknown";
    if (entry.settled) return "duplicate";
    entry.settled = true;
    clearTimeout(entry.timer);
    entry.resolve(result);
    this.entries.delete(id);
    return "resolved";
  }

  private expire(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || entry.settled) return;
    entry.settled = true;
    this.entries.delete(id);
  }

  cancelScope(filter: { sessionId?: string; provider?: ProviderId }): void {
    for (const [id, entry] of [...this.entries]) {
      const [provider, sessionId] = id.split("|");
      if (filter.provider !== undefined && filter.provider !== provider) continue;
      if (filter.sessionId !== undefined && filter.sessionId !== sessionId) continue;
      clearTimeout(entry.timer);
      entry.settled = true;
      this.entries.delete(id);
    }
  }

  activeCount(): number {
    return this.entries.size;
  }
}
```

Note: `awaitCall` above chains the stored resolver; the first `resolveCall` settles both the internal and the awaited promise. Terminal entries are deleted so late results return `"unknown"` — tests assert `"stale"` semantics via a `terminalIds: Set<string>` retained with its own TTL; add that set if the Step-1 test reports `"unknown"` instead of `"stale"` (keep the set bounded at `maxPending`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/core/deferred-tool-broker.test.ts`
Expected: PASS (adjust stale-tracking per the note above until green).

- [ ] **Step 5: Commit**

```bash
git add src/core/deferred-tool-broker.ts tests/core/deferred-tool-broker.test.ts
git commit -m "feat: add deferred tool broker core"
```

---

### Task 2: RouterRequest carries tool_choice and parallel_tool_calls

**Files:**
- Modify: `src/core/model.ts`
- Modify: `src/http/openai-chat.ts`
- Modify: `src/http/openai-responses.ts`
- Test: `tests/http/tool-choice-forwarding.test.ts`

- [ ] **Step 1: Write the failing forwarding test**

Create `tests/http/tool-choice-forwarding.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import type { ProviderAdapter } from "../../src/core/provider.js";
import type { RouterRequest } from "../../src/core/model.js";

const seen: RouterRequest[] = [];

const captureAdapter: ProviderAdapter = {
  id: "command-code",
  async discoverModels() {
    return [{ id: "command-code/m", provider: "command-code", upstreamModel: "m", displayName: "m", capability: "CHAT_AND_TOOLS" }];
  },
  async health() { return { status: "ready" }; },
  async *run(request) {
    seen.push(request);
    yield { type: "completed", finishReason: "stop" };
  },
  async cancel() {},
};

describe("tool_choice / parallel_tool_calls", () => {
  it("preserves tool_choice and parallel_tool_calls in the provider request", async () => {
    const registry = new ProviderRegistry();
    await registry.register(captureAdapter);
    await registry.refresh();
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret: "c", qoderToken: "q", registry });
    const res = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer q" },
      payload: {
        model: "command-code/m",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "t", parameters: {} } }],
        tool_choice: "required",
        parallel_tool_calls: false,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(seen[0]!.toolChoice).toBe("required");
    expect(seen[0]!.parallelToolCalls).toBe(false);
    console.log("TOOL_CHOICE_PRESERVED=PASS");
  });

  it("fails closed on forced tool_choice for a provider without representation", async () => {
    const registry = new ProviderRegistry();
    await registry.register({ ...captureAdapter, id: "chatgpt" as const });
    await registry.refresh();
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret: "c", qoderToken: "q", registry });
    const res = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer q" },
      payload: {
        model: "chatgpt/m",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "t", parameters: {} } }],
        tool_choice: { type: "function", function: { name: "t" } },
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
```

(The second case needs a `chatgpt/m` model; register a second capture adapter with `id:"chatgpt"` in the test if the registry shape requires it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/http/tool-choice-forwarding.test.ts`
Expected: FAIL (`toolChoice` undefined; forced-choice case not rejected).

- [ ] **Step 3: Implement**

In `src/core/model.ts` add to `RouterRequest`:

```ts
toolChoice?: unknown;
parallelToolCalls?: boolean;
```

In `src/http/openai-chat.ts`, after `tools` parsing, validate and attach:

```ts
let toolChoice: unknown;
if (body.tool_choice !== undefined) toolChoice = body.tool_choice;
let parallelToolCalls: boolean | undefined;
if (body.parallel_tool_calls !== undefined) {
  if (typeof body.parallel_tool_calls !== "boolean") {
    return reply.code(400).send({ error: { type: "invalid_request", message: "parallel_tool_calls must be a boolean" } });
  }
  parallelToolCalls = body.parallel_tool_calls;
}
```

Include both in `routerRequest`. After `registry.resolve`, fail closed when the provider is Codex (`model.provider === "chatgpt"`) and `toolChoice` is a forced function (`toolChoice === "required"` or an object with `type:"function"`): reply 400 `unsupported_capability` with a message naming the limitation. `"auto"`/`"none"` pass through and are recorded.

Mirror the same parsing in `src/http/openai-responses.ts` (`tool_choice` field name per Responses surface).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/http/tool-choice-forwarding.test.ts tests/http/openai-chat.test.ts tests/http/openai-responses.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/model.ts src/http/openai-chat.ts src/http/openai-responses.ts tests/http/tool-choice-forwarding.test.ts
git commit -m "feat: preserve tool choice and parallel tool semantics"
```

---

### Task 3: Command Code canonical history + index-keyed streaming

**Files:**
- Modify: `src/providers/command-code/adapter.ts`
- Test: `tests/providers/command-code-strict-continuation.test.ts`
- Test: `tests/providers/command-code-fragmented-stream.test.ts`

- [ ] **Step 1: Write the strict-continuation failing test**

Create `tests/providers/command-code-strict-continuation.test.ts` with a fake `fetchFn` whose second request asserts the upstream body contains `messages` with an `assistant` entry carrying `tool_calls: [{id, type:"function", function:{name, arguments}}]` followed by a `tool` entry with the same `tool_call_id`; otherwise it returns HTTP 400. Run the real `CommandCodeAdapter` through both turns. Expected on current code: FAIL (400, assistant history dropped).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/providers/command-code-strict-continuation.test.ts`
Expected: FAIL as above.

- [ ] **Step 3: Fix `toUpstreamMessages`**

```ts
function toUpstreamMessages(request: RouterRequest): Array<Record<string, unknown>> {
  return request.messages.map((message) => {
    const base: Record<string, unknown> = {
      role: message.role,
      content: message.content ?? "",
    };
    if (message.toolCallId !== undefined) base.tool_call_id = message.toolCallId;
    if (message.name !== undefined) base.name = message.name;
    if (message.role === "assistant" && message.toolCalls !== undefined) {
      base.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.function.name, arguments: call.function.arguments },
      }));
    }
    return base;
  });
}
```

- [ ] **Step 4: Fix fragmented streaming to use upstream `index`**

In `runOpenAiWire`, replace the `toolCallIndex++` synthesis:

```ts
const pending = new Map<number, { id: string; name: string; args: string }>();
for (const call of toolCalls) {
  const callRecord = call as Record<string, unknown>;
  const upstreamIndex = typeof callRecord.index === "number" ? callRecord.index : -1;
  // ...
}
```

Aggregate fragments per upstream index in a per-request map; emit one `tool_call_delta` per fragment with the UPSTREAM index; carry `id`/`name` from the first fragment that carries them; concatenate `function.arguments` per index. `call-${...}` synthesis is forbidden — if a non-first fragment lacks `id`, reuse the index entry's id; if the first fragment lacks `id`, fail the request with `provider_protocol_error`.

- [ ] **Step 5: Write the fragmented-stream test**

Create `tests/providers/command-code-fragmented-stream.test.ts`: scripted SSE where one logical call (`index:0`, id+name only in chunk 1) spans 3 argument chunks, plus a parallel case (indexes 0+1 interleaved). Assert exactly ONE logical call per index downstream with fully assembled arguments and preserved ids/names. Run red first, then green after Step 4.

- [ ] **Step 6: Forward tool_choice / parallel_tool_calls**

In `runOpenAiWire`, pass `request.toolChoice` as `tool_choice` and `request.parallelToolCalls` as `parallel_tool_calls` in the upstream body when defined (extend `streamChatCompletion` options).

- [ ] **Step 7: Run tests**

Run: `npm test -- tests/providers/command-code-strict-continuation.test.ts tests/providers/command-code-fragmented-stream.test.ts tests/providers/command-code-adapter.test.ts tests/providers/command-code-tool-e2e.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/providers/command-code/adapter.ts tests/providers/command-code-strict-continuation.test.ts tests/providers/command-code-fragmented-stream.test.ts
git commit -m "fix: complete Command Code OpenAI tool wire"
```

---

### Task 4: Responses canonical function-call I/O

**Files:**
- Modify: `src/http/openai-responses.ts`
- Test: `tests/http/responses-function-call-output.test.ts`

- [ ] **Step 1: Write the failing test**

Top-level items `{type:"function_call", call_id, name, arguments}` must become assistant `toolCalls`; `{type:"function_call_output", call_id, output}` must become `role:"tool"` with `toolCallId`. Test both parse and round-trip (response output re-submitted as input). Expected: FAIL (400, no `role`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/http/responses-function-call-output.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement in `inputToMessages`**

Before the `role` check, handle records with `type:"function_call"` / `type:"function_call_output"` (validate `call_id` string, `name`/`arguments` strings, `output` string). Preserve ordering and exact IDs.

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/http/responses-function-call-output.test.ts tests/http/openai-responses.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/http/openai-responses.ts tests/http/responses-function-call-output.test.ts
git commit -m "feat: complete Responses function-call semantics"
```

---

### Task 5: Codex same-turn pending continuation

**Files:**
- Modify: `src/providers/codex/adapter.ts`
- Modify: `tests/providers/codex-dynamic-tool.test.ts`
- Modify: `tests/providers/codex-tool-e2e.test.ts`

- [ ] **Step 1: Strengthen tests to fail on current code**

In `codex-tool-e2e.test.ts`, change the scripted server so turn 1 NEVER sends `turn/completed` after `item/tool/call` (the turn stays open), and asserts: (a) the adapter's answer to wire id 901 has `success:true` with the Qoder result text; (b) turn 2 of the SAME thread (`thread-1`, `turn-1`) delivers `final:canary`; (c) no second `thread/start` occurs. Run: FAIL (current code answers `success:false` and opens `thread-2`).

Delete the `CODEX_EXTERNAL_TOOL_DEFINITION_SENT=YES` assertion in `codex-dynamic-tool.test.ts` (no declaration channel exists in 0.153.4 — proven by schema diff); replace with an assertion that `thread/start` params carry no `tools` key.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/providers/codex-tool-e2e.test.ts tests/providers/codex-dynamic-tool.test.ts`
Expected: FAIL with the reasons above; capture them.

- [ ] **Step 3: Implement pending continuation in the adapter**

Add an instance-level `pendingTools = new Map<string, {wireId, threadId, turnId, toolName, argsJson}>` keyed by `callId`, plus reuse of `DeferredToolBroker` for TTL/cleanup. First turn: on `item/tool/call`, park the entry and yield `tool_call_delta` + `completed:tool_calls`; DO NOT respond on the wire. Second `run()` call: detect `role:"tool"` messages with `toolCallId` matching a parked entry; `respondToServerRequest(wireId, {success:true, contentItems:[{type:"inputText", text: <tool content>}]})`; then wait on the ORIGINAL `(threadId, turnId)` scope for `turn/completed` and stream its deltas; no new `thread/start`. Unmatched tool calls still get `success:false` (fail-closed).

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/providers/codex-tool-e2e.test.ts tests/providers/codex-dynamic-tool.test.ts tests/providers/codex-app-server-client.test.ts tests/providers/codex-concurrent-cancel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/codex/adapter.ts tests/providers/codex-tool-e2e.test.ts tests/providers/codex-dynamic-tool.test.ts
git commit -m "feat: complete Codex same-turn dynamic tool round-trip"
```

---

### Task 6: Qoder token through launchd/Keychain

**Files:**
- Modify: `scripts/macos/run-router.sh`
- Modify: `launchd/com.cmm.subscription-router.plist.template`
- Modify: `tests/integration/launchagent.test.ts`

- [ ] **Step 1: Extend the launchd test (red)**

Assert the rendered template contains `CMM_QODER_KEYCHAIN_SERVICE` / `CMM_QODER_KEYCHAIN_ACCOUNT` with defaults `cmm-subscription-router` / `qoder-bearer`, and that `run-router.sh` references `CMM_QODER_TOKEN`. Run: FAIL.

- [ ] **Step 2: Implement**

`run-router.sh`: mirror the router-bearer Keychain resolution for `CMM_QODER_TOKEN` (optional — absent means no Qoder consumer, never fatal). Plist template: add the two Qoder Keychain keys (identifiers only, no values).

- [ ] **Step 3: Run tests**

Run: `npm test -- tests/integration/launchagent.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/macos/run-router.sh launchd/com.cmm.subscription-router.plist.template tests/integration/launchagent.test.ts
git commit -m "fix: wire Qoder bearer through launchd Keychain runtime"
```

---

### Task 7: Cancellation matrix + broker isolation

**Files:**
- Create: `tests/providers/deferred-tool-cancellation.test.ts`
- Create: `tests/providers/deferred-tool-isolation.test.ts`

Cover brief §H scenarios 1–8 and §I adversarial cases against the real broker (plus the Codex adapter for the wire-held cases). Assert terminal counters are 0, duplicates/late results rejected, no cross-request or cross-consumer leakage, no content in logs (redaction test with a sentinel string). TDD per case: red, implement, green. One commit:

```bash
git add tests/providers/deferred-tool-cancellation.test.ts tests/providers/deferred-tool-isolation.test.ts src/core/deferred-tool-broker.ts
git commit -m "test: prove tool-boundary cancellation and broker isolation"
```

---

### Task 8: Claude deferred bridge (deterministic prototype)

**Files:**
- Create: `src/providers/claude/mcp-bridge.ts`
- Modify: `src/providers/claude/adapter.ts`

Expose Qoder tools as an external stdio MCP server (park-and-await handler, never executes); register via `Options.mcpServers` with a `PreToolUse` defer hook; surface `result.deferred_tool_use` to Qoder; resume via `query({options:{resume: sessionId}})` with the parked handler returning the broker-resolved Qoder result. Deterministic tests cover bridge park/resolve and hook shape. Promote `claude/*` to `CHAT_AND_TOOLS` ONLY if the prototype deterministically yields `deferred_tool_use`; otherwise keep `CHAT_ONLY` with NEW observed evidence. Commit separately.

### Task 9: Antigravity MCP bridge (deterministic prototype)

**Files:**
- Create: `src/providers/antigravity/mcp-bridge.ts` (share impl with Task 8 where possible)
- Modify: `src/providers/antigravity/adapter.ts`

Same park-and-await pattern over `agy mcp add cmm-qoder-tools <bridge>`; no live quota (fake MCP client tests only). Promote `google/*` ONLY on deterministic proof; otherwise `CHAT_ONLY` + new evidence. Commit separately.

---

### Task 10: Evidence + regression gate

**Files:**
- Create: `docs/audits/2026-09-10-task13-deferred-tool-broker-evidence.md`

Fill every field of the brief §FINAL REPORT matrix from observed outputs. Then run:

```bash
npm test && npm test && npm test && npm run typecheck && npm run build && npm test && bash scripts/security-audit.sh
```

Plus all new suites by path. Commit evidence separately. `LIVE_TOOL_ACCEPTANCE_RUN=NO`. `NEXT=INDEPENDENT_TASK13_COMPLETION_REAUDIT`.

---

## Self-Review

- Spec coverage: broker (§2) → Task 1; tool_choice (§4) → Task 2; Command Code (§3.2) → Task 3; Responses (§5) → Task 4; Codex (§3.1) → Task 5; launchd (§8) → Task 6; cancellation+isolation (§7) → Task 7; Claude (§3.3) → Task 8; Antigravity (§3.4) → Task 9; evidence+gate → Task 10. All ten reaudit findings mapped.
- Placeholders: none — every step names exact files, code, commands, expected output.
- Type consistency: `BrokerKey.provider: ProviderId`; adapter code reuses it; `RouterRequest.toolChoice: unknown`, `parallelToolCalls: boolean`.
