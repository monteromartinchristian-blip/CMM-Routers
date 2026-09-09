import { describe, expect, it, beforeEach } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { UsageStore } from "../../src/observability/usage-store.js";
import type {
  ProviderAdapter,
  DiscoveredModel,
  ProviderHealth,
} from "../../src/core/provider.js";

class ReadyProvider implements ProviderAdapter {
  readonly id = "chatgpt" as const;
  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      { id: "chatgpt/m", provider: "chatgpt", upstreamModel: "m", displayName: "M" },
    ];
  }
  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }
  async *run() {
    yield { type: "error" as const, error: "not implemented" };
  }
  async cancel() {}
}

describe("Diagnostics and usage", () => {
  let registry: ProviderRegistry;
  const bearerSecret = "test-secret-123";

  beforeEach(async () => {
    registry = new ProviderRegistry();
    await registry.register(new ReadyProvider());
    await registry.refresh();
  });

  it("exposes usage aggregates without content", async () => {
    const usageStore = new UsageStore();
    usageStore.beginRequest("r1", "google", "google/m");
    usageStore.endRequest("r1", { status: "success", inputTokens: 2, outputTokens: 1 });
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, registry, usageStore });
    const response = await server.inject({
      method: "GET",
      url: "/v1/cmm/usage",
      headers: { authorization: `Bearer ${bearerSecret}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.totalRequests).toBe(1);
    expect(body.successCount).toBe(1);
    expect(body.recent[0].requestId).toBe("r1");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(bearerSecret);
    for (const forbidden of ["prompt", "completion", "authorization", "secret", "oauth"]) {
      expect(serialized.toLowerCase()).not.toContain(`"${forbidden}"`);
    }
  });

  it("requires auth for usage endpoint", async () => {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, registry });
    const response = await server.inject({ method: "GET", url: "/v1/cmm/usage" });
    expect(response.statusCode).toBe(401);
  });

  it("keeps providers/health working alongside usage", async () => {
    const usageStore = new UsageStore();
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, registry, usageStore });
    const providers = await server.inject({
      method: "GET",
      url: "/v1/cmm/providers",
      headers: { authorization: `Bearer ${bearerSecret}` },
    });
    expect(providers.statusCode).toBe(200);
    const health = await server.inject({
      method: "GET",
      url: "/v1/cmm/health",
      headers: { authorization: `Bearer ${bearerSecret}` },
    });
    expect(health.statusCode).toBe(200);
  });
});
