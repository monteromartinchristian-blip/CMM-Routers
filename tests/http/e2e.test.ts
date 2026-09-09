import { describe, expect, it, beforeEach } from "vitest";
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
import { RouterError } from "../../src/core/errors.js";

class TextProvider implements ProviderAdapter {
  constructor(
    public readonly id: "chatgpt" | "claude" | "google" | "command-code",
    private readonly text: string,
  ) {}
  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      { id: `${this.id}/m`, provider: this.id, upstreamModel: "m", displayName: "M" },
    ];
  }
  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }
  async *run(_request: RouterRequest, _signal: AbortSignal): AsyncIterable<RouterEvent> {
    yield { type: "text_delta", text: this.text };
    yield { type: "completed", finishReason: "stop" };
  }
  async cancel() {}
}

class FailingProvider implements ProviderAdapter {
  readonly id = "claude" as const;
  async discoverModels(): Promise<DiscoveredModel[]> {
    return [{ id: "claude/m", provider: "claude", upstreamModel: "m", displayName: "M" }];
  }
  async health(): Promise<ProviderHealth> {
    return { status: "unavailable" };
  }
  async *run(): AsyncIterable<RouterEvent> {
    yield { type: "error", error: new RouterError("provider_unavailable", "down") };
  }
  async cancel() {}
}

describe("HTTP end-to-end (mocked providers)", () => {
  const bearerSecret = "e2e-test-secret";
  let registry: ProviderRegistry;

  beforeEach(async () => {
    registry = new ProviderRegistry();
    await registry.register(new TextProvider("chatgpt", "from-chatgpt"));
    await registry.register(new TextProvider("google", "from-google"));
    await registry.register(new FailingProvider());
    await registry.refresh();
  });

  it("GET /health, /ready, /v1/models, diagnostics, usage", async () => {
    const usageStore = new UsageStore();
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, registry, usageStore });
    const auth = { authorization: `Bearer ${bearerSecret}` };

    expect((await server.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await server.inject({ method: "GET", url: "/ready" })).statusCode).toBe(200);

    const models = await server.inject({ method: "GET", url: "/v1/models", headers: auth });
    expect(models.statusCode).toBe(200);
    expect(models.json().data.length).toBe(3);

    expect(
      (await server.inject({ method: "GET", url: "/v1/cmm/providers", headers: auth })).statusCode,
    ).toBe(200);
    expect(
      (await server.inject({ method: "GET", url: "/v1/cmm/health", headers: auth })).statusCode,
    ).toBe(200);
    expect(
      (await server.inject({ method: "GET", url: "/v1/cmm/usage", headers: auth })).statusCode,
    ).toBe(200);
  });

  it("POST /v1/chat/completions across two providers", async () => {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, registry });
    const auth = { authorization: `Bearer ${bearerSecret}` };
    const [a, b] = await Promise.all([
      server.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: auth,
        payload: { model: "chatgpt/m", messages: [{ role: "user", content: "hi" }] },
      }),
      server.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: auth,
        payload: { model: "google/m", messages: [{ role: "user", content: "hi" }] },
      }),
    ]);
    expect(a.json().choices[0].message.content).toBe("from-chatgpt");
    expect(b.json().choices[0].message.content).toBe("from-google");
  });

  it("POST /v1/responses works", async () => {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, registry });
    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${bearerSecret}` },
      payload: { model: "chatgpt/m", input: "hi" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().object).toBe("response");
  });

  it("one provider failure does not crash another", async () => {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, registry });
    const auth = { authorization: `Bearer ${bearerSecret}` };
    const failing = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: { model: "claude/m", messages: [{ role: "user", content: "hi" }] },
    });
    expect(failing.statusCode).toBe(503);
    const healthy = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: { model: "chatgpt/m", messages: [{ role: "user", content: "hi" }] },
    });
    expect(healthy.statusCode).toBe(200);
  });
});
