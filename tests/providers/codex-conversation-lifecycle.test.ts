import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { queryMock, duplexSendMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  duplexSendMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({
    stdin: { write: duplexSendMock },
    stdout: { on: vi.fn() },
  })),
}));

import { CodexAdapter, buildCodexThreadSeeds } from "../../src/providers/codex/adapter.js";
import type { RouterRequest } from "../../src/core/model.js";

function generatedInjectMethod(): string {
  const schema = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../fixtures/generated/codex/ClientRequest.json"),
      "utf-8",
    ),
  ) as {
    oneOf?: Array<{ properties?: { method?: { enum?: string[] } }; title?: string }>;
  };
  const entry = (schema.oneOf ?? []).find((e) => e.title === "Thread/injectItemsRequest");
  const method = entry?.properties?.method?.enum?.[0];
  expect(method).toBe("thread/inject_items");
  return method ?? "thread/inject_items";
}

function conversationRequest(): RouterRequest {
  return {
    requestId: "codex-ctx-001",
    model: {
      id: "chatgpt/gpt-5",
      provider: "chatgpt",
      upstreamModel: "gpt-5",
      displayName: "GPT-5",
    },
    messages: [
      { role: "system", content: "SYSTEM_MARKER_CODEX" },
      { role: "user", content: "USER_ONE_CODEX" },
      { role: "assistant", content: "ASSISTANT_HISTORY_CODEX" },
      { role: "user", content: "USER_TWO_CODEX" },
    ],
    tools: [],
    stream: true,
  };
}

/** Minimal scripted app-server speaking the SCHEMA shapes. */
function scriptedServer(handle: (msg: Record<string, unknown>) => void) {
  const { Duplex } = require("node:stream") as typeof import("node:stream");
  const duplex = new Duplex({
    read: () => {},
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      handle(JSON.parse(chunk.toString()));
      callback();
    },
  });
  return duplex;
}

function send(duplex: { push: (c: string) => void }, message: object): void {
  duplex.push(`${JSON.stringify(message)}\n`);
}

describe("Codex conversation roles and thread lifecycle", () => {
  beforeEach(() => {
    queryMock.mockReset();
    duplexSendMock.mockClear();
    void queryMock;
  });

  it("splits system, history, and current turn without flattening", () => {
    const seeds = buildCodexThreadSeeds(conversationRequest().messages);
    expect(seeds.developerInstructions).toContain("SYSTEM_MARKER_CODEX");
    console.log("CODEX_SYSTEM_PRESERVED=YES");
    const historyText = JSON.stringify(seeds.historyItems);
    expect(historyText).toContain("USER_ONE_CODEX");
    expect(historyText).toContain("ASSISTANT_HISTORY_CODEX");
    console.log("CODEX_USER_HISTORY_PRESERVED=YES");
    console.log("CODEX_ASSISTANT_HISTORY_PRESERVED=YES");
    expect(
      seeds.turnInput.filter((i) => i.type === "text").map((i) => i.text),
    ).toEqual(["USER_TWO_CODEX"]);
    // Ordering: history holds ONE then ASSISTANT, turn holds TWO.
    expect(historyText.indexOf("USER_ONE_CODEX")).toBeLessThan(
      historyText.indexOf("ASSISTANT_HISTORY_CODEX"),
    );
    console.log("CODEX_MESSAGE_ORDER_PRESERVED=YES");
    console.log("CODEX_ROLE_FLATTENING=NONE");
  });

  it("emits ephemeral thread/start, inject_items, and schema turn/start over JSON-RPC", async () => {
    const expectedInject = generatedInjectMethod();
    const seen: Array<{ method: string; params: Record<string, unknown>; id?: unknown }> = [];
    const duplex = scriptedServer((msg: Record<string, unknown>) => {
      seen.push(msg as { method: string; params: Record<string, unknown>; id?: unknown });
      const params = msg.params as Record<string, unknown>;
      if (msg.method === "initialize") {
        send(duplex, { jsonrpc: "2.0", id: msg.id, result: {} });
      } else if (msg.method === "thread/start") {
        send(duplex, { jsonrpc: "2.0", id: msg.id, result: { thread: { id: "thread-X" } } });
      } else if (msg.method === expectedInject) {
        send(duplex, { jsonrpc: "2.0", id: msg.id, result: {} });
      } else if (msg.method === "turn/start") {
        send(duplex, {
          jsonrpc: "2.0",
          id: msg.id,
          result: { turn: { id: "turn-X", status: "inProgress", items: [] } },
        });
        // Complete the turn AFTER start, scoped to our ids.
        setTimeout(() => {
          send(duplex, {
            jsonrpc: "2.0",
            method: "turn/completed",
            params: {
              threadId: "thread-X",
              turn: { id: "turn-X", status: "completed", items: [] },
            },
          });
          void params;
        }, 10);
      }
    });

    // Drive the adapter with an injected fake client transport.
    const adapter = new CodexAdapter();
    const { CodexAppServerClient } = await import(
      "../../src/providers/codex/app-server-client.js"
    );
    const client = new CodexAppServerClient(duplex);
    (adapter as unknown as { client: unknown }).client = client;
    await client.initialize({ clientInfo: { name: "t", version: "0" } });
    await client.sendInitializedNotification();

    const events: unknown[] = [];
    for await (const event of adapter.run(conversationRequest(), new AbortController().signal)) {
      events.push(event);
    }
    const threadStart = seen.find((m) => m.method === "thread/start");
    expect(threadStart?.params.ephemeral).toBe(true);
    console.log("CODEX_THREAD_EPHEMERAL_EXPLICIT=YES");
    console.log("CODEX_THREAD_EPHEMERAL_VALUE=true");
    expect(String(threadStart?.params.developerInstructions)).toContain("SYSTEM_MARKER_CODEX");
    const inject = seen.find((m) => m.method === expectedInject);
    expect(inject).toBeDefined();
    expect(expectedInject).toBe("thread/inject_items");
    expect(seen.some((m) => m.method === "thread/injectItems")).toBe(false);
    console.log(`CODEX_THREAD_INJECT_METHOD=${expectedInject}`);
    console.log("CODEX_THREAD_INJECT_ITEMS_WIRE=PASS");
    console.log("CODEX_STALE_INJECTITEMS_METHOD=ABSENT");
    expect(JSON.stringify(inject?.params)).toContain("USER_ONE_CODEX");
    expect(JSON.stringify(inject?.params)).toContain("ASSISTANT_HISTORY_CODEX");
    const turnStart = seen.find((m) => m.method === "turn/start");
    expect(JSON.stringify(turnStart?.params)).toContain("USER_TWO_CODEX");
    expect(JSON.stringify(turnStart?.params)).not.toContain("SYSTEM_MARKER_CODEX");
    expect(events.map((e) => (e as { type: string }).type)).toContain("completed");
  });

  it("cancels with the real schema turn id", async () => {
    const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
    const duplex = scriptedServer((msg: Record<string, unknown>) => {
      seen.push(msg as { method: string; params: Record<string, unknown> });
      if (msg.method === "initialize") {
        send(duplex, { jsonrpc: "2.0", id: msg.id, result: {} });
      } else if (msg.method === "thread/start") {
        send(duplex, { jsonrpc: "2.0", id: msg.id, result: { thread: { id: "thread-C" } } });
      } else if (msg.method === "thread/inject_items") {
        send(duplex, { jsonrpc: "2.0", id: msg.id, result: {} });
      } else if (msg.method === "turn/start") {
        send(duplex, {
          jsonrpc: "2.0",
          id: msg.id,
          result: { turn: { id: "turn-C", status: "inProgress", items: [] } },
        });
      } else if (msg.method === "turn/interrupt") {
        send(duplex, { jsonrpc: "2.0", id: msg.id, result: {} });
      }
    });
    const adapter = new CodexAdapter();
    const { CodexAppServerClient } = await import(
      "../../src/providers/codex/app-server-client.js"
    );
    const client = new CodexAppServerClient(duplex);
    (adapter as unknown as { client: unknown }).client = client;
    await client.initialize({ clientInfo: { name: "t", version: "0" } });
    await client.sendInitializedNotification();

    const runPromise = (async () => {
      const out: unknown[] = [];
      for await (const event of adapter.run(
        { ...conversationRequest(), requestId: "cancel-C" },
        new AbortController().signal,
      )) {
        out.push(event);
      }
      return out;
    })();
    // Wait until turn/start was sent, then cancel by request id.
    for (let i = 0; i < 100 && !seen.some((m) => m.method === "turn/start"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await adapter.cancel("cancel-C");
    const interrupt = seen.find((m) => m.method === "turn/interrupt");
    expect(interrupt?.params.turnId).toBe("turn-C");
    expect(interrupt?.params.threadId).toBe("thread-C");
    console.log("CODEX_CANCEL_USES_REAL_TURN_ID=PASS");
    // Release the hanging run.
    (adapter as unknown as { activeTurns: Map<string, unknown> }).activeTurns.clear();
    void runPromise;
  });

  it("fails an active run on a malformed frame and cleans up its state", async () => {
    const duplex = scriptedServer((msg: Record<string, unknown>) => {
      if (msg.method === "initialize") {
        send(duplex, { jsonrpc: "2.0", id: msg.id, result: {} });
      } else if (msg.method === "thread/start") {
        send(duplex, { jsonrpc: "2.0", id: msg.id, result: { thread: { id: "thread-BAD" } } });
      } else if (msg.method === "thread/inject_items") {
        send(duplex, { jsonrpc: "2.0", id: msg.id, result: {} });
      } else if (msg.method === "turn/start") {
        send(duplex, {
          jsonrpc: "2.0",
          id: msg.id,
          result: { turn: { id: "turn-BAD", status: "inProgress", items: [] } },
        });
        // Corrupted app-server stdout while the turn is live.
        duplex.push("CORRUPTED_FRAME_SECRET_MARKER not json\n");
      }
    });
    const adapter = new CodexAdapter();
    const { CodexAppServerClient } = await import(
      "../../src/providers/codex/app-server-client.js"
    );
    const client = new CodexAppServerClient(duplex);
    (adapter as unknown as { client: unknown }).client = client;
    await client.initialize({ clientInfo: { name: "t", version: "0" } });
    await client.sendInitializedNotification();

    const logged: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    const events: Array<{ type: string; error?: { code?: string; message?: string } }> = [];
    try {
      for await (const event of adapter.run(
        { ...conversationRequest(), requestId: "malformed-1" },
        new AbortController().signal,
      )) {
        events.push(event as { type: string; error?: { code?: string; message?: string } });
      }
    } finally {
      console.error = origError;
    }
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent?.error?.code).toBe("provider_protocol_error");
    expect(events.some((e) => e.type === "completed")).toBe(false);
    const activeTurns = (adapter as unknown as { activeTurns: Map<string, unknown> }).activeTurns;
    expect(activeTurns.size).toBe(0);
    expect(logged.join("\n")).not.toContain("CORRUPTED_FRAME_SECRET_MARKER");
    console.log("CODEX_MALFORMED_STDOUT=PROVIDER_PROTOCOL_ERROR");
    console.log("CODEX_REQUEST_TERMINATES=YES");
    console.log("CODEX_ACTIVE_RUN_CLEANUP=PASS");
    console.log("CODEX_MALFORMED_CONTENT_LOGGING=NONE");
  });
});
