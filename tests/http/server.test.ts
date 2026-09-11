import { describe, expect, it, beforeEach } from "vitest";
import Fastify from "fastify";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import type { ProviderAdapter, DiscoveredModel, ProviderHealth } from "../../src/core/provider.js";

class FakeProvider implements ProviderAdapter {
  constructor(public readonly id: "chatgpt") {}

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: "chatgpt/test-model",
        provider: "chatgpt",
        upstreamModel: "test-model",
        displayName: "Test Model",
      },
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

describe("HTTP server", () => {
  let registry: ProviderRegistry;
  let bearerSecret: string;

  beforeEach(async () => {
    bearerSecret = "test-secret-123";
    registry = new ProviderRegistry();
    const fakeProvider = new FakeProvider("chatgpt");
    await registry.register(fakeProvider);
    await registry.refresh();
  });

  it("rejects requests without auth to /v1/*", async () => {
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret,
      registry,
    });

    const response = await server.inject({
      method: "GET",
      url: "/v1/models",
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects wrong bearer token", async () => {
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret,
      registry,
    });

    const response = await server.inject({
      method: "GET",
      url: "/v1/models",
      headers: {
        authorization: "Bearer wrong-token",
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it("accepts correct bearer token for /health", async () => {
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret,
      registry,
    });

    const response = await server.inject({
      method: "GET",
      url: "/health",
      headers: {
        authorization: `Bearer ${bearerSecret}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("returns namespaced models with OpenAI-style format", async () => {
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret,
      registry,
    });

    const response = await server.inject({
      method: "GET",
      url: "/v1/models",
      headers: {
        authorization: `Bearer ${bearerSecret}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data[0].id).toBe("chatgpt/test-model");
    expect(body.data[0].object).toBe("model");
    expect(body.data[0].owned_by).toBe("cmm:chatgpt");
  });

  it("returns 503 from /ready if all providers are unavailable", async () => {
    const emptyRegistry = new ProviderRegistry();
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret,
      registry: emptyRegistry,
    });

    const response = await server.inject({
      method: "GET",
      url: "/ready",
      headers: {
        authorization: `Bearer ${bearerSecret}`,
      },
    });

    expect(response.statusCode).toBe(503);
  });

  it("diagnostic responses contain no secrets", async () => {
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret,
      registry,
    });

    const response = await server.inject({
      method: "GET",
      url: "/v1/cmm/providers",
      headers: {
        authorization: `Bearer ${bearerSecret}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain(bearerSecret);
  });

  // Remediation 5: Honest health/readiness semantics
  it("/v1/cmm/health reports actual provider health status", async () => {
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret,
      registry,
    });

    const response = await server.inject({
      method: "GET",
      url: "/v1/cmm/health",
      headers: {
        authorization: `Bearer ${bearerSecret}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.providers).toBeDefined();
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.providers[0].id).toBe("chatgpt");
    expect(body.providers[0].status).toBe("ready");
  });

  it("/ready returns 503 when all registered providers are unavailable", async () => {
    class UnavailableProvider implements ProviderAdapter {
      readonly id = "chatgpt" as const;

      async discoverModels(): Promise<DiscoveredModel[]> {
        return [];
      }

      async health(): Promise<ProviderHealth> {
        return { status: "unavailable" };
      }

      async *run() {
        yield { type: "error" as const, error: "not implemented" };
      }

      async cancel() {}
    }

    const unhealthyRegistry = new ProviderRegistry();
    await unhealthyRegistry.register(new UnavailableProvider());

    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret,
      registry: unhealthyRegistry,
    });

    const response = await server.inject({
      method: "GET",
      url: "/ready",
      headers: {
        authorization: `Bearer ${bearerSecret}`,
      },
    });

    expect(response.statusCode).toBe(503);
  });

  it("/ready returns 200 when at least one provider is ready", async () => {
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret,
      registry,
    });

    const response = await server.inject({
      method: "GET",
      url: "/ready",
      headers: {
        authorization: `Bearer ${bearerSecret}`,
      },
    });

    expect(response.statusCode).toBe(200);
  });
});
