import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sharedConfigSchema } from "../../src/config/schema.js";
import { enforceProviderToolPolicy } from "../../src/core/tool-policy.js";
import { UsageStore } from "../../src/observability/usage-store.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { buildServer } from "../../src/http/server.js";

const MODEL = "deepseek-v4.1-flash";
const BAD_ALIAS = "deepseek-v4.1-flash-0910";

async function dynamicSourceModule(relative: string): Promise<Record<string, unknown> | null> {
  const absolute = join(process.cwd(), relative);
  expect(existsSync(absolute), `${relative} must exist`).toBe(true);
  if (!existsSync(absolute)) return null;
  return import(/* @vite-ignore */ pathToFileURL(absolute).href) as Promise<Record<string, unknown>>;
}

function writeAck(dir: string, overrides: Record<string, unknown> = {}): string {
  const path = join(dir, "ack.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      provider: "cavoti",
      billing: "PAYG",
      model: MODEL,
      automaticFallback: false,
      ...overrides,
    }),
    "utf8",
  );
  return path;
}

function routerRequest(model = MODEL) {
  return {
    requestId: "cavoti-test-request",
    model: {
      id: `cavoti/${model}`,
      provider: "cavoti",
      upstreamModel: model,
      displayName: "DeepSeek V4.1 Flash (Cavoti)",
      capability: "CHAT_AND_TOOLS",
    },
    messages: [{ role: "user", content: "Use calculator." }],
    tools: [
      {
        type: "function",
        function: {
          name: "calculator",
          description: "Add two numbers",
          parameters: { type: "object" },
        },
      },
    ],
    stream: true,
    toolChoice: { kind: "auto" },
    parallelToolCalls: true,
  } as any;
}

async function collect(iterable: AsyncIterable<any>): Promise<any[]> {
  const out: any[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("Cavoti provider contract", () => {
  it("defaults Cavoti to a disabled, exact-model, dedicated-secret route", () => {
    const parsed = sharedConfigSchema.parse({
      mode: "standalone",
      host: "127.0.0.1",
    });
    expect((parsed.providers as any).cavoti).toEqual({
      enabled: false,
      baseUrl: "https://cavoti.com/v1",
      secretEnv: "CAVOTI_API_KEY",
      model: MODEL,
    });
  });

  it("rejects the expensive 0910 alias at config validation", () => {
    const parsed = sharedConfigSchema.parse({
      mode: "standalone",
      host: "127.0.0.1",
    }) as any;
    if (!parsed.providers.cavoti) {
      expect(parsed.providers.cavoti, "Cavoti provider config must exist").toBeDefined();
      return;
    }
    parsed.providers.cavoti = {
      enabled: true,
      baseUrl: "https://cavoti.com/v1",
      secretEnv: "CAVOTI_API_KEY",
      model: BAD_ALIAS,
    };
    expect(() => sharedConfigSchema.parse(parsed)).toThrow();
  });

  it("gives Cavoti the exact OpenAI Chat tool policy, without approximation", () => {
    expect(
      enforceProviderToolPolicy("cavoti" as any, { kind: "required" }, false),
    ).toBeNull();
  });

  it("persists reasoning, cache-read and provider-reported cost in UsageStore", () => {
    const store = new UsageStore();
    store.beginRequest("usage-cavoti", "cavoti" as any, `cavoti/${MODEL}`);
    const record = store.endRequest("usage-cavoti", {
      status: "success",
      inputTokens: 311,
      outputTokens: 68,
      reasoningTokens: 12,
      cacheReadTokens: 128,
      costUsd: 0.00001,
    } as any);
    expect(record).toMatchObject({
      inputTokens: 311,
      outputTokens: 68,
      reasoningTokens: 12,
      cacheReadTokens: 128,
      costUsd: 0.00001,
    });
  });

  it("carries extended usage through the real HTTP usage tracker", async () => {
    const registry = new ProviderRegistry();
    await registry.register({
      id: "cavoti" as any,
      async discoverModels() {
        return [{
          id: `cavoti/${MODEL}`,
          provider: "cavoti" as any,
          upstreamModel: MODEL,
          displayName: "DeepSeek V4.1 Flash (Cavoti)",
          capability: "CHAT_AND_TOOLS" as const,
        }];
      },
      async health() {
        return { status: "ready" as const };
      },
      async *run() {
        yield {
          type: "usage",
          inputTokens: 311,
          outputTokens: 68,
          reasoningTokens: 12,
          cacheReadTokens: 128,
          costUsd: 0.00001,
        } as any;
        yield { type: "completed", finishReason: "stop" } as any;
      },
      async cancel() {},
    } as any);
    await registry.refresh();

    const usageStore = new UsageStore();
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: "cavoti-cmmchat-test",
      qoderToken: "cavoti-qoder-test",
      registry,
      usageStore,
    });
    try {
      const response = await server.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: "Bearer cavoti-qoder-test" },
        payload: {
          model: `cavoti/${MODEL}`,
          messages: [{ role: "user", content: "hi" }],
        },
      });
      expect(response.statusCode).toBe(200);
      expect(usageStore.listRecent(1)[0]).toMatchObject({
        reasoningTokens: 12,
        cacheReadTokens: 128,
        costUsd: 0.00001,
      });
    } finally {
      await server.close();
    }
  });

  it("requires an explicit machine-local PAYG acknowledgement pinned to the cheap alias", async () => {
    const mod = await dynamicSourceModule("src/providers/cavoti/spend-guard.ts");
    if (!mod) return;
    const requireAck = mod.requireCavotiSpendAcknowledgement as (path: string) => void;
    const dir = mkdtempSync(join(tmpdir(), "cmm-cavoti-ack-"));
    try {
      const good = writeAck(dir);
      expect(() => requireAck(good)).not.toThrow();

      const wrongModel = writeAck(dir, { model: BAD_ALIAS });
      expect(() => requireAck(wrongModel)).toThrow();

      const fallback = writeAck(dir, { automaticFallback: true });
      expect(() => requireAck(fallback)).toThrow();

      const extra = writeAck(dir, { unexpected: "field" });
      expect(() => requireAck(extra)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the Cavoti HTTP client always requests usage and never rewrites the pinned model", async () => {
    const mod = await dynamicSourceModule("src/providers/cavoti/client.ts");
    if (!mod) return;
    const CavotiClient = mod.CavotiClient as any;
    const calls: Array<{ url: string; body: any }> = [];

    const fetchFn = async (input: any, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, body });
      return new Response(
        [
          'data: {"choices":[{"delta":{"content":"OK"}}]}',
          "",
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
          "",
          'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":2},"completion_tokens_details":{"reasoning_tokens":1},"cost":0.00001}}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    const client = new CavotiClient({
      baseUrl: "https://unit.invalid/v1",
      secret: "test-only-secret",
      fetchFn,
    });
    const records = await collect(
      client.streamChatCompletion(
        MODEL,
        [{ role: "user", content: "hi" }],
        new AbortController().signal,
        {},
      ),
    );
    expect(records.length).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://unit.invalid/v1/chat/completions");
    expect(calls[0]!.body).toMatchObject({
      model: MODEL,
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(JSON.stringify(calls[0]!.body)).not.toContain(BAD_ALIAS);
  });

  it("discovers only the exact pinned model and refuses 0910-only catalogs", async () => {
    const mod = await dynamicSourceModule("src/providers/cavoti/adapter.ts");
    if (!mod) return;
    const CavotiAdapter = mod.CavotiAdapter as any;
    const dir = mkdtempSync(join(tmpdir(), "cmm-cavoti-discovery-"));
    try {
      const ackPath = writeAck(dir);

      const exactClient = {
        readSecret() { return "test"; },
        async listModels() { return [{ id: MODEL }, { id: BAD_ALIAS }]; },
        async *streamChatCompletion() {},
      };
      const adapter = new CavotiAdapter({ ackPath, client: exactClient });
      await expect(adapter.discoverModels()).resolves.toEqual([
        {
          id: `cavoti/${MODEL}`,
          provider: "cavoti",
          upstreamModel: MODEL,
          displayName: "DeepSeek V4.1 Flash (Cavoti)",
          capability: "CHAT_AND_TOOLS",
        },
      ]);

      const expensiveOnly = new CavotiAdapter({
        ackPath,
        client: {
          readSecret() { return "test"; },
          async listModels() { return [{ id: BAD_ALIAS }]; },
          async *streamChatCompletion() {},
        },
      });
      await expect(expensiveOnly.discoverModels()).rejects.toMatchObject({
        code: "unknown_model",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves fragmented tool calls and waits for the final usage-only chunk before completion", async () => {
    const mod = await dynamicSourceModule("src/providers/cavoti/adapter.ts");
    if (!mod) return;
    const CavotiAdapter = mod.CavotiAdapter as any;
    const dir = mkdtempSync(join(tmpdir(), "cmm-cavoti-stream-"));
    try {
      const ackPath = writeAck(dir);
      const seenOptions: any[] = [];
      const fakeClient = {
        readSecret() { return "test"; },
        async listModels() { return [{ id: MODEL }]; },
        async *streamChatCompletion(_model: string, _messages: unknown[], _signal: AbortSignal, options: any) {
          seenOptions.push(options);
          yield {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: { name: "calculator", arguments: '{"a":' },
                }],
              },
            }],
          };
          yield {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  function: { arguments: '2,"b":2}' },
                }],
              },
            }],
          };
          yield { choices: [{ delta: {}, finish_reason: "tool_calls" }] };
          yield {
            choices: [],
            usage: {
              prompt_tokens: 311,
              completion_tokens: 68,
              prompt_tokens_details: { cached_tokens: 128 },
              completion_tokens_details: { reasoning_tokens: 12 },
              cost: 0.00001,
            },
          };
        },
      };

      const adapter = new CavotiAdapter({ ackPath, client: fakeClient });
      const events = await collect(
        adapter.run(routerRequest(), new AbortController().signal),
      );

      const toolEvents = events.filter((e) => e.type === "tool_call_delta");
      expect(toolEvents).toHaveLength(2);
      expect(toolEvents[0]).toMatchObject({
        index: 0,
        id: "call-1",
        name: "calculator",
        argumentsDelta: '{"a":',
      });
      expect(toolEvents[1]).toMatchObject({
        index: 0,
        id: "call-1",
        argumentsDelta: '2,"b":2}',
      });

      const usageIndex = events.findIndex((e) => e.type === "usage");
      const completionIndex = events.findIndex((e) => e.type === "completed");
      expect(events[usageIndex]).toMatchObject({
        inputTokens: 311,
        outputTokens: 68,
        cacheReadTokens: 128,
        reasoningTokens: 12,
        costUsd: 0.00001,
      });
      expect(completionIndex).toBeGreaterThan(usageIndex);
      expect(events[completionIndex]).toMatchObject({
        finishReason: "tool_calls",
      });
      expect(seenOptions[0]).toMatchObject({
        toolChoice: "auto",
        parallelToolCalls: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed before the network on the 0910 alias and on undeclared tools", async () => {
    const mod = await dynamicSourceModule("src/providers/cavoti/adapter.ts");
    if (!mod) return;
    const CavotiAdapter = mod.CavotiAdapter as any;
    const dir = mkdtempSync(join(tmpdir(), "cmm-cavoti-failclosed-"));
    try {
      const ackPath = writeAck(dir);
      let calls = 0;
      const wrongModelAdapter = new CavotiAdapter({
        ackPath,
        client: {
          readSecret() { return "test"; },
          async listModels() { return [{ id: MODEL }]; },
          async *streamChatCompletion() {
            calls += 1;
            yield {};
          },
        },
      });
      const wrongEvents = await collect(
        wrongModelAdapter.run(routerRequest(BAD_ALIAS), new AbortController().signal),
      );
      expect(calls).toBe(0);
      expect(wrongEvents.find((e) => e.type === "error")?.error).toMatchObject({
        code: "unknown_model",
      });

      const undeclaredAdapter = new CavotiAdapter({
        ackPath,
        client: {
          readSecret() { return "test"; },
          async listModels() { return [{ id: MODEL }]; },
          async *streamChatCompletion() {
            yield {
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: "evil-1",
                    type: "function",
                    function: { name: "run_command", arguments: "{}" },
                  }],
                },
              }],
            };
          },
        },
      });
      const aclEvents = await collect(
        undeclaredAdapter.run(routerRequest(), new AbortController().signal),
      );
      expect(aclEvents.find((e) => e.type === "error")?.error).toMatchObject({
        code: "provider_protocol_error",
      });
      expect(aclEvents.some((e) => e.type === "completed")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Cavoti route hardening", () => {
  it("upgrades a legacy providers block by injecting Cavoti disabled", () => {
    const parsed = sharedConfigSchema.parse({
      mode: "standalone",
      host: "127.0.0.1",
      providers: {
        chatgpt: { enabled: false },
        claude: { enabled: false },
        google: { enabled: false },
        "command-code": {
          enabled: false,
          baseUrl: "https://api.commandcode.ai/provider/v1",
          secretEnv: "COMMAND_CODE_SECRET",
        },
      },
    });
    expect((parsed.providers as any).cavoti).toEqual({
      enabled: false,
      baseUrl: "https://cavoti.com/v1",
      secretEnv: "CAVOTI_API_KEY",
      model: MODEL,
    });
  });

  it("pins Cavoti config to its canonical endpoint and dedicated secret name", () => {
    const base = {
      mode: "standalone",
      host: "127.0.0.1",
      providers: {
        chatgpt: { enabled: false },
        claude: { enabled: false },
        google: { enabled: false },
        "command-code": {
          enabled: false,
          baseUrl: "https://api.commandcode.ai/provider/v1",
          secretEnv: "COMMAND_CODE_SECRET",
        },
      },
    } as const;

    expect(
      sharedConfigSchema.safeParse({
        ...base,
        providers: {
          ...base.providers,
          cavoti: {
            enabled: true,
            baseUrl: "https://evil.invalid/v1",
            secretEnv: "CAVOTI_API_KEY",
            model: MODEL,
          },
        },
      }).success,
    ).toBe(false);

    expect(
      sharedConfigSchema.safeParse({
        ...base,
        providers: {
          ...base.providers,
          cavoti: {
            enabled: true,
            baseUrl: "https://cavoti.com/v1",
            secretEnv: "OPENAI_API_KEY",
            model: MODEL,
          },
        },
      }).success,
    ).toBe(false);
  });

  it("keeps the Cavoti PAYG ack in the legacy-compatible machine-local CMM path", async () => {
    const mod = await dynamicSourceModule("src/providers/cavoti/spend-guard.ts");
    if (!mod) return;
    const defaultPath = mod.defaultCavotiAckPath as () => string;
    expect(defaultPath()).toContain(
      join("CMM", "SubscriptionRouter", "cavoti-payg-ack.json"),
    );
  });

  it("aggregates the extended usage dimensions without deriving tariff", () => {
    const store = new UsageStore();
    store.beginRequest("cavoti-aggregate", "cavoti", `cavoti/${MODEL}`);
    store.endRequest("cavoti-aggregate", {
      status: "success",
      inputTokens: 311,
      outputTokens: 68,
      reasoningTokens: 12,
      cacheReadTokens: 128,
      costUsd: 0.00001,
    } as any);
    expect(store.aggregates()).toMatchObject({
      totalInputTokens: 311,
      totalOutputTokens: 68,
      totalReasoningTokens: 12,
      totalCacheReadTokens: 128,
      totalCostUsd: 0.00001,
    });
  });

  it("never registers enabled Cavoti without the explicit PAYG ack", async () => {
    const { createProductionRegistry } = await import("../../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "cmm-cavoti-no-ack-"));
    const oldAckPath = process.env.CMM_CAVOTI_ACK_PATH;
    const oldSecret = process.env.CAVOTI_API_KEY;
    try {
      process.env.CMM_CAVOTI_ACK_PATH = join(dir, "missing.json");
      delete process.env.CAVOTI_API_KEY;
      const composition = await createProductionRegistry({
        mode: "standalone",
        host: "127.0.0.1",
        port: 8790,
        bearerSecretEnv: "CMM_ROUTER_TOKEN",
        machineId: "test",
        providers: {
          chatgpt: { enabled: false },
          claude: { enabled: false },
          google: { enabled: false },
          "command-code": {
            enabled: false,
            baseUrl: "https://api.commandcode.ai/provider/v1",
            secretEnv: "COMMAND_CODE_SECRET",
          },
          cavoti: {
            enabled: true,
            baseUrl: "https://cavoti.com/v1",
            secretEnv: "CAVOTI_API_KEY",
            model: MODEL,
          },
        },
      } as any);
      expect(composition.registeredProviders).not.toContain("cavoti");
      expect(
        composition.skippedProviders.some(
          (item) =>
            item.id === "cavoti" &&
            item.reason.includes("acknowledgement"),
        ),
      ).toBe(true);
    } finally {
      if (oldAckPath === undefined) delete process.env.CMM_CAVOTI_ACK_PATH;
      else process.env.CMM_CAVOTI_ACK_PATH = oldAckPath;
      if (oldSecret === undefined) delete process.env.CAVOTI_API_KEY;
      else process.env.CAVOTI_API_KEY = oldSecret;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never registers Cavoti with an ack but without CAVOTI_API_KEY", async () => {
    const { createProductionRegistry } = await import("../../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "cmm-cavoti-no-secret-"));
    const oldAckPath = process.env.CMM_CAVOTI_ACK_PATH;
    const oldSecret = process.env.CAVOTI_API_KEY;
    try {
      const ackPath = writeAck(dir);
      process.env.CMM_CAVOTI_ACK_PATH = ackPath;
      delete process.env.CAVOTI_API_KEY;
      const composition = await createProductionRegistry({
        mode: "standalone",
        host: "127.0.0.1",
        port: 8790,
        bearerSecretEnv: "CMM_ROUTER_TOKEN",
        machineId: "test",
        providers: {
          chatgpt: { enabled: false },
          claude: { enabled: false },
          google: { enabled: false },
          "command-code": {
            enabled: false,
            baseUrl: "https://api.commandcode.ai/provider/v1",
            secretEnv: "COMMAND_CODE_SECRET",
          },
          cavoti: {
            enabled: true,
            baseUrl: "https://cavoti.com/v1",
            secretEnv: "CAVOTI_API_KEY",
            model: MODEL,
          },
        },
      } as any);
      expect(composition.registeredProviders).not.toContain("cavoti");
      expect(
        composition.skippedProviders.some(
          (item) =>
            item.id === "cavoti" &&
            item.reason.includes("CAVOTI_API_KEY"),
        ),
      ).toBe(true);
    } finally {
      if (oldAckPath === undefined) delete process.env.CMM_CAVOTI_ACK_PATH;
      else process.env.CMM_CAVOTI_ACK_PATH = oldAckPath;
      if (oldSecret === undefined) delete process.env.CAVOTI_API_KEY;
      else process.env.CAVOTI_API_KEY = oldSecret;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
