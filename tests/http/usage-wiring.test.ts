import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { UsageStore } from "../../src/observability/usage-store.js";
import type {
  ProviderAdapter,
  DiscoveredModel,
  ProviderHealth,
  RouterRequest,
} from "../../src/core/provider.js";
import type { RouterEvent } from "../../src/core/events.js";

class UsageScriptedProvider implements ProviderAdapter {
  readonly id = "chatgpt" as const;
  constructor(private readonly usageEvents: RouterEvent[]) {}
  async discoverModels(): Promise<DiscoveredModel[]> {
    return [{ id: "chatgpt/m", provider: "chatgpt", upstreamModel: "m", displayName: "M" }];
  }
  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }
  async *run(): AsyncIterable<RouterEvent> {
    for (const event of this.usageEvents) yield event;
  }
  async cancel(): Promise<void> {}
}

const SECRET = "usage-wiring-test-secret";

function authHeader(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

async function chatCompletion(
  server: ReturnType<typeof buildServer>,
  stream: boolean,
): Promise<{ status: number }> {
  const response = await server.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: authHeader(SECRET),
    payload: {
      model: "chatgpt/m",
      messages: [{ role: "user", content: "hi" }],
      ...(stream ? { stream: true } : {}),
    },
  });
  return { status: response.statusCode };
}

describe("production usage wiring", () => {
  it("non-streaming chat records a success with token counts in UsageStore", async () => {
    const registry = new ProviderRegistry();
    await registry.register(
      new UsageScriptedProvider([
        { type: "text_delta", text: "hi" },
        { type: "usage", inputTokens: 3, outputTokens: 2 },
        { type: "completed", finishReason: "stop" },
      ]),
    );
    await registry.refresh();
    const usageStore = new UsageStore();
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: SECRET,
      registry,
      usageStore,
    });
    const { status } = await chatCompletion(server, false);
    expect(status).toBe(200);
    const aggregates = usageStore.aggregates();
    expect(aggregates.totalRequests).toBe(1);
    expect(aggregates.successCount).toBe(1);
    expect(usageStore.listRecent(1)[0]).toMatchObject({
      provider: "chatgpt",
      model: "chatgpt/m",
      status: "success",
      inputTokens: 3,
      outputTokens: 2,
    });
  });

  it("non-streaming chat records a provider error without fallback", async () => {
    const { RouterError } = await import("../../src/core/errors.js");
    const registry = new ProviderRegistry();
    await registry.register(
      new UsageScriptedProvider([
        { type: "error", error: new RouterError("provider_rate_limited", "slow") },
      ]),
    );
    await registry.refresh();
    const usageStore = new UsageStore();
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: SECRET,
      registry,
      usageStore,
    });
    const { status } = await chatCompletion(server, false);
    expect(status).toBe(429);
    expect(usageStore.aggregates().failureCount).toBe(1);
    expect(usageStore.listRecent(1)[0]?.status).toBe("rate_limit_error");
  });

  it("GET /v1/cmm/usage reports recorded traffic instead of disabled", async () => {
    const registry = new ProviderRegistry();
    await registry.register(
      new UsageScriptedProvider([
        { type: "text_delta", text: "hi" },
        { type: "completed", finishReason: "stop" },
      ]),
    );
    await registry.refresh();
    const usageStore = new UsageStore();
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: SECRET,
      registry,
      usageStore,
    });
    await chatCompletion(server, false);
    const response = await server.inject({
      method: "GET",
      url: "/v1/cmm/usage",
      headers: authHeader(SECRET),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("ok");
    expect(response.json().totalRequests).toBe(1);
  });

  it("streaming chat records a success in UsageStore", async () => {
    const registry = new ProviderRegistry();
    await registry.register(
      new UsageScriptedProvider([
        { type: "text_delta", text: "hi" },
        { type: "completed", finishReason: "stop" },
      ]),
    );
    await registry.refresh();
    const usageStore = new UsageStore();
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: SECRET,
      registry,
      usageStore,
    });
    const { status } = await chatCompletion(server, true);
    expect(status).toBe(200);
    expect(usageStore.aggregates().totalRequests).toBe(1);
    expect(usageStore.aggregates().successCount).toBe(1);
  });

  it("non-streaming responses records a success in UsageStore", async () => {
    const registry = new ProviderRegistry();
    await registry.register(
      new UsageScriptedProvider([
        { type: "text_delta", text: "hi" },
        { type: "completed", finishReason: "stop" },
      ]),
    );
    await registry.refresh();
    const usageStore = new UsageStore();
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: SECRET,
      registry,
      usageStore,
    });
    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: authHeader(SECRET),
      payload: { model: "chatgpt/m", input: "hi" },
    });
    expect(response.statusCode).toBe(200);
    expect(usageStore.aggregates().successCount).toBe(1);
  });
});
