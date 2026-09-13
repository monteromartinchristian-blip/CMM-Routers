import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { UsageAdapterManager } from "../../../src/usage/adapters/adapter-manager.js";
import {
  QwenModelStudioUsageAdapter,
  type QwenModelStudioUsageAdapterOptions,
} from "../../../src/usage/adapters/qwen-model-studio/adapter.js";

interface SeenRequest {
  method: string;
  path: string;
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

async function modelsServer(models: readonly string[], seen: SeenRequest[]): Promise<string> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const authHeader = request.headers.authorization;
    seen.push({ method: request.method ?? "", path: request.url ?? "" });
    if (request.url !== "/compatible-mode/v1/models") {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        object: "list",
        data: models.map((id) => ({ id, object: "model", owned_by: "qwen" })),
      }),
    );
    void authHeader;
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing fake server port");
  return `http://127.0.0.1:${address.port}/compatible-mode/v1`;
}

function adapter(
  kind: QwenModelStudioUsageAdapterOptions["kind"],
  baseUrl: string,
  overrides: Partial<QwenModelStudioUsageAdapterOptions> = {},
) {
  return new QwenModelStudioUsageAdapter({
    kind,
    baseUrl,
    credential: {
      reference: `keychain://qwen-${kind}`,
      resolve: async () => `test-qwen-${kind}-key`,
    },
    now: () => new Date("2026-09-13T12:00:00.000Z"),
    ...overrides,
  });
}

const qwenModels = ["qwen3.8-max", "qwen3.7-plus", "glm-5.2"];

describe("QwenModelStudioUsageAdapter", () => {
  it("discovers models for the token plan through the non-inference /models surface", async () => {
    const seen: SeenRequest[] = [];
    const value = adapter("token-plan", await modelsServer(qwenModels, seen));

    const discovery = await value.discover();
    expect(discovery.status).toBe("ok");
    if (discovery.status !== "ok") throw new Error("expected discovery");

    expect(seen).toEqual([{ method: "GET", path: "/compatible-mode/v1/models" }]);
    expect(discovery.products[0]).toMatchObject({
      id: "product:qwen-token-plan",
      kind: "subscription",
    });
    expect(discovery.models.map((model) => model.id)).toEqual([
      "model:qwen:glm-5.2",
      "model:qwen:qwen3.7-plus",
      "model:qwen:qwen3.8-max",
    ]);
    expect(discovery.accessRoutes.map((route) => route.id)).toEqual([
      "route:qwen-token-plan:glm-5.2",
      "route:qwen-token-plan:qwen3.7-plus",
      "route:qwen-token-plan:qwen3.8-max",
    ]);
    expect(discovery.accessRoutes.every((route) => route.status === "available")).toBe(true);
  });

  it("represents the token plan credits window from operator evidence without inventing consumption", async () => {
    const seen: SeenRequest[] = [];
    const value = adapter("token-plan", await modelsServer(qwenModels, seen), {
      plan: { edition: "personal", tierLabel: "standard", windowLimitCredits: 10_000 },
    });
    const discovery = await value.discover();
    if (discovery.status !== "ok") throw new Error("expected discovery");

    const buckets = new Map((discovery.quotaBuckets ?? []).map((bucket) => [bucket.providerKey, bucket]));
    const window = buckets.get("credits-window:7day");
    expect(window).toMatchObject({
      metric: { kind: "credits" },
      unit: "credits",
      limitValue: 10_000,
      windowPolicy: { kind: "rolling_duration", durationSeconds: 604_800 },
      status: "unknown",
      enforcement: "hard",
    });
    const snapshots = await value.collectQuotaSnapshots();
    expect(snapshots.status).toBe("ok");
    if (snapshots.status !== "ok") throw new Error("expected snapshots");
    expect(snapshots.values).toEqual([]);
  });

  it("ingests operator quota observations with native units and manual provenance", async () => {
    const seen: SeenRequest[] = [];
    const value = adapter("token-plan", await modelsServer(qwenModels, seen), {
      plan: { edition: "personal", tierLabel: "standard", windowLimitCredits: 10_000 },
      observations: () => [
        {
          usedCredits: 7_500,
          resetAt: "2026-09-16T00:00:00Z",
        },
      ],
    });
    const discovery = await value.discover();
    if (discovery.status !== "ok") throw new Error("expected discovery");
    const bucketId = (discovery.quotaBuckets ?? []).find(
      (bucket) => bucket.providerKey === "credits-window:7day",
    )?.id;

    const snapshots = await value.collectQuotaSnapshots();
    expect(snapshots.status).toBe("ok");
    if (snapshots.status !== "ok") throw new Error("expected snapshots");
    expect(snapshots.values).toEqual([
      expect.objectContaining({
        quotaBucketId: bucketId,
        observedAt: "2026-09-13T12:00:00.000Z",
        usedValue: 7_500,
        remainingValue: 2_500,
        limitValue: 10_000,
        usedFraction: 0.75,
        remainingFraction: 0.25,
        resetAt: "2026-09-16T00:00:00.000Z",
        source: "manual",
        confidence: "measured",
      }),
    ]);
  });

  it("keeps PAYG a separate product with balance/limits unknown and no quota claims", async () => {
    const seen: SeenRequest[] = [];
    const value = adapter("payg", await modelsServer(qwenModels, seen));

    expect(value.capabilities().has("discover_quota_graph")).toBe(false);
    expect(value.capabilities().has("collect_quota_snapshots")).toBe(false);
    const discovery = await value.discover();
    expect(discovery.status).toBe("ok");
    if (discovery.status !== "ok") throw new Error("expected discovery");
    expect(discovery.products[0]).toMatchObject({ id: "product:qwen-payg", kind: "api" });
    expect(discovery.quotaBuckets ?? []).toEqual([]);
    const events = await value.collectUsageEvents();
    expect(events).toEqual({ status: "unsupported", capability: "collect_usage_events" });
    expect(seen).toEqual([{ method: "GET", path: "/compatible-mode/v1/models" }]);
  });

  it("isolates namespaces for identical model lists while sharing ModelIdentity", async () => {
    const tokenPlan = adapter("token-plan", await modelsServer(qwenModels, []), {
      plan: { edition: "personal", windowLimitCredits: 2_500 },
    });
    const payg = adapter("payg", await modelsServer(qwenModels, []));

    const tp = await tokenPlan.discover();
    const pg = await payg.discover();
    if (tp.status !== "ok" || pg.status !== "ok") throw new Error("expected discovery");

    expect(tp.products.map((product) => product.id)).toEqual(["product:qwen-token-plan"]);
    expect(pg.products.map((product) => product.id)).toEqual(["product:qwen-payg"]);
    const sharedModels = tp.models.map((model) => model.id);
    expect(pg.models.map((model) => model.id)).toEqual(sharedModels);
    for (const modelId of sharedModels) {
      const tpRoute = tp.accessRoutes.find((route) => route.modelIdentityId === modelId);
      const pgRoute = pg.accessRoutes.find((route) => route.modelIdentityId === modelId);
      expect(tpRoute?.id).not.toBe(pgRoute?.id);
      expect(tpRoute?.productId).toBe("product:qwen-token-plan");
      expect(pgRoute?.productId).toBe("product:qwen-payg");
    }
  });

  it("carries no credential material in normalized output and normalizes auth failures", async () => {
    const server = createServer((_request, response) => response.writeHead(401).end());
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing fake server port");

    const manager = new UsageAdapterManager();
    const value = adapter("token-plan", `http://127.0.0.1:${address.port}/compatible-mode/v1`);
    manager.register(value);
    const result = await manager.discover(value.id);
    expect(result).toEqual({
      status: "error",
      error: { kind: "auth", message: "Usage adapter failed: auth" },
    });
    expect(JSON.stringify(result)).not.toContain("test-qwen-token-plan-key");
    expect(JSON.stringify(result)).not.toContain("keychain://qwen-token-plan");
  });
});
