import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { UsageAdapterManager } from "../../../src/usage/adapters/adapter-manager.js";
import { DeepSeekUsageAdapter } from "../../../src/usage/adapters/deepseek/adapter.js";

interface SeenRequest {
  method: string;
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

async function fixtureBaseUrl(seen: SeenRequest[]): Promise<string> {
  return fakeServer((request, response) => {
    const path = request.url ?? "";
    const authHeader = request.headers.authorization;
    seen.push({
      method: request.method ?? "",
      path,
      ...(typeof authHeader === "string" ? { authorization: `${authHeader}` } : {}),
    });
    if (path === "/user/balance") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          is_available: true,
          balance_infos: [
            {
              currency: "CNY",
              total_balance: "110.00",
              granted_balance: "10.00",
              topped_up_balance: "100.00",
            },
          ],
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });
}

function adapter(baseUrl: string): DeepSeekUsageAdapter {
  return new DeepSeekUsageAdapter({
    baseUrl,
    credential: {
      reference: "keychain://deepseek",
      resolve: async () => "test-deepseek-key",
    },
    routes: [
      { providerModelId: "deepseek-chat", displayName: "DeepSeek Chat" },
      { providerModelId: "deepseek-reasoner", displayName: "DeepSeek Reasoner" },
    ],
    now: () => new Date("2026-09-13T12:00:00.000Z"),
  });
}

describe("DeepSeekUsageAdapter", () => {
  it("discovers an API billing product whose balance has no invented reset", async () => {
    const seen: SeenRequest[] = [];
    const value = adapter(await fixtureBaseUrl(seen));

    const discovery = await value.discover();
    expect(discovery.status).toBe("ok");
    if (discovery.status !== "ok") throw new Error("expected discovery");

    expect(discovery.providers.map((provider) => provider.id)).toEqual(["provider:deepseek"]);
    expect(discovery.products[0]).toMatchObject({ kind: "api" });
    expect(discovery.accessRoutes.map((route) => route.providerModelId).sort()).toEqual([
      "deepseek-chat",
      "deepseek-reasoner",
    ]);
    const buckets = new Map((discovery.quotaBuckets ?? []).map((bucket) => [bucket.providerKey, bucket]));
    expect(buckets.get("balance:total:CNY")).toMatchObject({
      metric: { kind: "currency", currency: "CNY" },
      windowPolicy: { kind: "none" },
      enforcement: "hard",
    });
    expect(buckets.has("balance:granted:CNY")).toBe(true);
    expect(buckets.has("balance:topped_up:CNY")).toBe(true);
  });

  it("emits provider balance snapshots with exact decimal amounts and no reset times", async () => {
    const seen: SeenRequest[] = [];
    const value = adapter(await fixtureBaseUrl(seen));
    const discovery = await value.discover();
    if (discovery.status !== "ok") throw new Error("expected discovery");
    const buckets = new Map((discovery.quotaBuckets ?? []).map((bucket) => [bucket.providerKey, bucket]));

    const snapshots = await value.collectQuotaSnapshots();
    expect(snapshots.status).toBe("ok");
    if (snapshots.status !== "ok") throw new Error("expected snapshots");
    const byBucket = new Map(snapshots.values.map((snapshot) => [snapshot.quotaBucketId, snapshot]));
    const total = byBucket.get(buckets.get("balance:total:CNY")?.id ?? "");
    expect(total).toMatchObject({
      remainingValue: 110,
      source: "provider_official_api",
      confidence: "exact",
    });
    expect(total).not.toHaveProperty("resetAt");
    expect(total).not.toHaveProperty("usedValue");
    expect(total).not.toHaveProperty("limitValue");
    expect(byBucket.get(buckets.get("balance:granted:CNY")?.id ?? "")?.remainingValue).toBe(10);
    expect(byBucket.get(buckets.get("balance:topped_up:CNY")?.id ?? "")?.remainingValue).toBe(100);
  });

  it("never claims usage events, keeping router telemetry ownership separate", async () => {
    const seen: SeenRequest[] = [];
    const value = adapter(await fixtureBaseUrl(seen));
    const events = await value.collectUsageEvents();
    expect(events).toEqual({ status: "unsupported", capability: "collect_usage_events" });
    expect(seen).toEqual([]);
    const discovery = await value.discover();
    expect(seen.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /user/balance",
    ]);
    const serialized = JSON.stringify({ discovery, events });
    expect(serialized).not.toContain("test-deepseek-key");
    expect(serialized).not.toContain("keychain://deepseek");
  });

  it("reports exhausted funding conservatively when the provider marks balance unavailable", async () => {
    const baseUrl = await fakeServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ is_available: false, balance_infos: [] }));
    });
    const value = adapter(baseUrl);
    const discovery = await value.discover();
    expect(discovery.status).toBe("ok");
    if (discovery.status !== "ok") throw new Error("expected discovery");
    expect(discovery.quotaBuckets ?? []).toEqual([]);
    const snapshots = await value.collectQuotaSnapshots();
    expect(snapshots.status).toBe("ok");
    if (snapshots.status === "ok") expect(snapshots.values).toEqual([]);
  });

  it("normalizes authentication failures through the adapter manager", async () => {
    const baseUrl = await fakeServer((_request, response) => response.writeHead(401).end());
    const manager = new UsageAdapterManager();
    const value = adapter(baseUrl);
    manager.register(value);

    const result = await manager.collectQuotaSnapshots(value.id);
    expect(result).toEqual({
      status: "error",
      error: { kind: "auth", message: "Usage adapter failed: auth" },
    });
  });
});
