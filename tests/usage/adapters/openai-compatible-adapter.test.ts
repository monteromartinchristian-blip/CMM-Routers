import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { UsageAdapterManager } from "../../../src/usage/adapters/adapter-manager.js";
import { OpenAiCompatibleUsageAdapter } from "../../../src/usage/adapters/openai-compatible/adapter.js";
import type { ManualUsageAdapterDefinition } from "../../../src/usage/adapters/manual/adapter.js";

interface SeenRequest {
  path: string;
  authorization?: string;
}

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function fakeServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing fake server port");
  return `http://127.0.0.1:${address.port}/`;
}

function manualDefinition(id = "openai-compatible:test"): ManualUsageAdapterDefinition {
  return {
    id,
    displayName: "Example compatible API",
    provider: {
      id: "provider:example-compatible",
      displayName: "Example Compatible",
      kind: "generic",
      status: "enabled",
      metadata: {},
      createdAt: "2026-09-13T10:00:00.000Z",
      updatedAt: "2026-09-13T10:00:00.000Z",
    },
    accounts: [
      {
        id: "account:example-compatible",
        providerId: "provider:example-compatible",
        label: "Primary",
        status: "active",
        createdAt: "2026-09-13T10:00:00.000Z",
        updatedAt: "2026-09-13T10:00:00.000Z",
      },
    ],
    products: [
      {
        id: "product:example-compatible",
        providerId: "provider:example-compatible",
        displayName: "Example API",
        kind: "api",
        metadata: {},
      },
    ],
    accessRoutes: [
      {
        id: "route:example-compatible:manual",
        accountId: "account:example-compatible",
        productId: "product:example-compatible",
        providerModelId: "manual-model",
        displayName: "Manual model",
        status: "available",
        metadata: {},
      },
    ],
    quotaBuckets: [
      {
        id: "bucket:example-compatible:monthly",
        accountId: "account:example-compatible",
        productId: "product:example-compatible",
        displayName: "Monthly quota",
        metric: { kind: "requests" },
        windowPolicy: { kind: "billing_cycle", anchorDate: "2026-09-01", timezone: "UTC" },
        limitValue: 1_000,
        unit: "requests",
        enforcement: "hard",
        status: "healthy",
        metadata: {},
      },
    ],
    quotaBindings: [
      {
        id: "binding:example-compatible:manual",
        accessRouteId: "route:example-compatible:manual",
        quotaBucketId: "bucket:example-compatible:monthly",
        activeFrom: "2026-09-01T00:00:00.000Z",
        metadata: {},
      },
    ],
    quotaSnapshots: [
      {
        id: "snapshot:example-compatible:manual",
        quotaBucketId: "bucket:example-compatible:monthly",
        observedAt: "2026-09-13T12:00:00.000Z",
        usedValue: 300,
        remainingValue: 700,
        limitValue: 1_000,
        usedFraction: 0.3,
        remainingFraction: 0.7,
        resetAt: "2026-10-01T00:00:00.000Z",
        source: "manual",
        confidence: "exact",
        stalenessAfter: "2026-10-01T00:00:00.000Z",
      },
    ],
  };
}

describe("OpenAiCompatibleUsageAdapter", () => {
  it("works from a manual quota graph without assuming models or usage endpoints exist", async () => {
    const seen: SeenRequest[] = [];
    const baseUrl = await fakeServer((request, response) => {
      seen.push({ path: request.url ?? "" });
      response.writeHead(500).end();
    });
    const adapter = new OpenAiCompatibleUsageAdapter({
      id: "openai-compatible:test",
      displayName: "Example compatible API",
      baseUrl,
      manual: manualDefinition(),
    });
    const manager = new UsageAdapterManager();
    manager.register(adapter);

    const discovery = await manager.discover(adapter.id);
    const snapshots = await manager.collectQuotaSnapshots(adapter.id);

    expect(discovery.status).toBe("ok");
    expect(snapshots).toMatchObject({ status: "ok", values: [{ usedValue: 300 }] });
    expect(seen).toEqual([]);
  });

  it("discovers OpenAI-shaped models only from an explicitly configured metadata endpoint", async () => {
    const seen: SeenRequest[] = [];
    const baseUrl = await fakeServer((request, response) => {
      seen.push({
        path: request.url ?? "",
        ...(typeof request.headers.authorization === "string"
          ? { authorization: request.headers.authorization }
          : {}),
      });
      if (request.url === "/models") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: [{ id: "alpha" }, { id: "beta" }] }));
        return;
      }
      response.writeHead(500).end();
    });
    const adapter = new OpenAiCompatibleUsageAdapter({
      id: "openai-compatible:test",
      displayName: "Example compatible API",
      baseUrl,
      credential: {
        reference: "keychain://example-compatible",
        resolve: async () => "test-api-key",
      },
      manual: manualDefinition(),
      modelDiscovery: {
        path: "models",
        accountId: "account:example-compatible",
        productId: "product:example-compatible",
      },
    });
    const manager = new UsageAdapterManager();
    manager.register(adapter);

    const result = await manager.discover(adapter.id);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected discovery");
    expect(result.accessRoutes.map((value) => value.providerModelId).sort()).toEqual([
      "alpha",
      "beta",
      "manual-model",
    ]);
    expect(seen).toEqual([{ path: "/models", authorization: "Bearer test-api-key" }]);
  });

  it("calls a configured quota endpoint and validates mapped snapshots without touching inference", async () => {
    const seen: SeenRequest[] = [];
    const baseUrl = await fakeServer((request, response) => {
      seen.push({
        path: request.url ?? "",
        ...(typeof request.headers.authorization === "string"
          ? { authorization: request.headers.authorization }
          : {}),
      });
      if (request.url === "/quota") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ used: 420, remaining: 580, reset: "2026-10-01T00:00:00.000Z" }));
        return;
      }
      response.writeHead(500).end();
    });
    const manual = manualDefinition();
    manual.quotaSnapshots = [];
    const adapter = new OpenAiCompatibleUsageAdapter({
      id: "openai-compatible:test",
      displayName: "Example compatible API",
      baseUrl,
      credential: {
        reference: "keychain://example-compatible",
        resolve: async () => "test-api-key",
      },
      manual,
      quotaEndpoint: {
        path: "quota",
        map: (body) => {
          const value = body as { used: number; remaining: number; reset: string };
          return [
            {
              id: "snapshot:example-compatible:remote",
              quotaBucketId: "bucket:example-compatible:monthly",
              observedAt: "2026-09-13T12:30:00.000Z",
              usedValue: value.used,
              remainingValue: value.remaining,
              limitValue: 1_000,
              usedFraction: value.used / 1_000,
              remainingFraction: value.remaining / 1_000,
              resetAt: value.reset,
              source: "provider_official_api" as const,
              confidence: "exact" as const,
              stalenessAfter: "2026-09-13T12:35:00.000Z",
            },
          ];
        },
      },
    });
    const manager = new UsageAdapterManager();
    manager.register(adapter);

    const result = await manager.collectQuotaSnapshots(adapter.id);

    expect(result).toMatchObject({ status: "ok", values: [{ usedValue: 420, remainingValue: 580 }] });
    expect(seen).toEqual([{ path: "/quota", authorization: "Bearer test-api-key" }]);
  });

  it("rejects common inference paths as metadata endpoints", async () => {
    const baseUrl = await fakeServer((_request, response) => response.writeHead(500).end());

    expect(
      () =>
        new OpenAiCompatibleUsageAdapter({
          id: "openai-compatible:test",
          displayName: "Unsafe compatible API",
          baseUrl,
          manual: manualDefinition(),
          modelDiscovery: {
            path: "v1/chat/completions",
            accountId: "account:example-compatible",
            productId: "product:example-compatible",
          },
        }),
    ).toThrow(/inference|metadata/i);
  });
});
