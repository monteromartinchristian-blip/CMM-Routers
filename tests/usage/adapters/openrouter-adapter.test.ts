import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { UsageAdapterManager } from "../../../src/usage/adapters/adapter-manager.js";
import {
  OpenRouterUsageAdapter,
  type OpenRouterUsageAdapterOptions,
} from "../../../src/usage/adapters/openrouter/adapter.js";

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
  return `http://127.0.0.1:${address.port}/api/v1`;
}

const keyFixture = {
  data: {
    label: "Production API Key",
    limit: 100,
    limit_reset: "monthly",
    limit_remaining: 74.5,
    include_byok_in_limit: false,
    usage: 25.5,
    usage_daily: 3.25,
    usage_weekly: 12.5,
    usage_monthly: 20.75,
    byok_usage: 2,
    byok_usage_daily: 1,
    byok_usage_weekly: 1.5,
    byok_usage_monthly: 2,
    is_free_tier: false,
    rate_limit: { interval: "1h", note: "deprecated", requests: 1000 },
  },
};

const creditsFixture = {
  data: {
    total_credits: 100.5,
    total_usage: 25.75,
  },
};

const keysListFixture = {
  data: [
    {
      hash: "hash-alpha",
      label: "Production API Key",
      name: "prod",
      limit: 100,
      limit_remaining: 74.5,
      limit_reset: "monthly",
      usage: 25.5,
      usage_daily: 3.25,
      usage_weekly: 12.5,
      usage_monthly: 20.75,
      include_byok_in_limit: false,
      workspace_id: "workspace-uuid-1",
    },
    {
      hash: "hash-beta",
      label: "CI key",
      name: "ci",
      limit: null,
      limit_remaining: null,
      limit_reset: null,
      usage: 4.5,
      usage_daily: 0.5,
      usage_weekly: 2.5,
      usage_monthly: 3.5,
      include_byok_in_limit: false,
      workspace_id: "workspace-uuid-1",
    },
  ],
};

const modelsFixture = {
  data: [
    { id: "openai/gpt-4", name: "GPT-4", pricing: { prompt: "0.00003", completion: "0.00006" } },
    { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", pricing: {} },
  ],
};

function route(seen: SeenRequest[], management: boolean) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? "";
    const authHeader = request.headers.authorization;
    seen.push({
      method: request.method ?? "",
      path,
      ...(typeof authHeader === "string" ? { ["authorization"]: authHeader } : {}),
    });
    response.setHeader("content-type", "application/json");
    if (path === "/api/v1/models" || path.startsWith("/api/v1/models?")) {
      response.end(JSON.stringify(modelsFixture));
      return;
    }
    if (path === "/api/v1/key") {
      response.end(JSON.stringify(keyFixture));
      return;
    }
    if (management && path === "/api/v1/credits") {
      response.end(JSON.stringify(creditsFixture));
      return;
    }
    if (management && path.startsWith("/api/v1/keys?")) {
      response.end(JSON.stringify(keysListFixture));
      return;
    }
    response.writeHead(404).end();
  };
}

function adapter(
  baseUrl: string,
  overrides: Partial<OpenRouterUsageAdapterOptions> = {},
): OpenRouterUsageAdapter {
  return new OpenRouterUsageAdapter({
    baseUrl,
    credential: {
      reference: "keychain://openrouter",
      resolve: async () => "test-openrouter-key",
    },
    now: () => new Date("2026-09-13T12:00:00.000Z"),
    ...overrides,
  });
}

describe("OpenRouterUsageAdapter", () => {
  it("discovers model routes and per-key limit/usage buckets from the current key only", async () => {
    const seen: SeenRequest[] = [];
    const value = adapter(await fakeServer(route(seen, false)));

    const discovery = await value.discover();
    expect(discovery.status).toBe("ok");
    if (discovery.status !== "ok") throw new Error("expected discovery");

    expect(discovery.providers[0]).toMatchObject({ kind: "aggregator" });
    expect(discovery.products[0]).toMatchObject({ kind: "api" });
    expect(discovery.accessRoutes.map((route) => route.providerModelId).sort()).toEqual([
      "anthropic/claude-sonnet-5",
      "openai/gpt-4",
    ]);
    expect(discovery.models.map((model) => model.vendor).sort()).toEqual(["anthropic", "openai"]);

    const buckets = new Map(
      (discovery.quotaBuckets ?? []).map((bucket) => [bucket.providerKey, bucket]),
    );
    expect(buckets.get("key:Production API Key:limit")).toMatchObject({
      metric: { kind: "currency", currency: "USD" },
      limitValue: 100,
      windowPolicy: { kind: "fixed_calendar", calendarUnit: "month", timezone: "UTC" },
      status: "healthy",
    });
    expect(buckets.get("key:Production API Key:usage_daily")).toMatchObject({
      windowPolicy: { kind: "fixed_calendar", calendarUnit: "day", timezone: "UTC" },
    });
    expect(buckets.get("key:Production API Key:usage_weekly")).toMatchObject({
      windowPolicy: { kind: "fixed_calendar", calendarUnit: "week", timezone: "UTC" },
    });
    expect(buckets.get("key:Production API Key:usage")).toMatchObject({
      windowPolicy: { kind: "none" },
    });
    expect(buckets.has("org:credits")).toBe(false);
  });

  it("collects exact key-limit consumption from limit_remaining without inventing percentages", async () => {
    const seen: SeenRequest[] = [];
    const value = adapter(await fakeServer(route(seen, false)));
    const discovery = await value.discover();
    if (discovery.status !== "ok") throw new Error("expected discovery");
    const buckets = new Map(
      (discovery.quotaBuckets ?? []).map((bucket) => [bucket.providerKey, bucket]),
    );

    const snapshots = await value.collectQuotaSnapshots();
    expect(snapshots.status).toBe("ok");
    if (snapshots.status !== "ok") throw new Error("expected snapshots");
    const byBucket = new Map(snapshots.values.map((snapshot) => [snapshot.quotaBucketId, snapshot]));

    const limit = byBucket.get(buckets.get("key:Production API Key:limit")?.id ?? "");
    expect(limit).toMatchObject({
      usedValue: 25.5,
      remainingValue: 74.5,
      limitValue: 100,
      usedFraction: 0.255,
      remainingFraction: 0.745,
      source: "provider_official_api",
      confidence: "exact",
      stalenessAfter: "2026-09-13T12:01:00.000Z",
    });
    expect(limit).not.toHaveProperty("resetAt");

    const daily = byBucket.get(buckets.get("key:Production API Key:usage_daily")?.id ?? "");
    expect(daily).toMatchObject({ usedValue: 3.25 });
    expect(daily).not.toHaveProperty("resetAt");
    expect(daily).not.toHaveProperty("limitValue");
    expect(daily).not.toHaveProperty("usedFraction");

    const lifetime = byBucket.get(buckets.get("key:Production API Key:usage")?.id ?? "");
    expect(lifetime).toMatchObject({ usedValue: 25.5 });
  });

  it("adds organization credit pool and per-key hash buckets only with a management key", async () => {
    const seen: SeenRequest[] = [];
    const value = adapter(
      await fakeServer(route(seen, true)),
      {
        managementCredential: {
          reference: "keychain://openrouter-management",
          resolve: async () => "test-openrouter-management-key",
        },
      },
    );

    const discovery = await value.discover();
    expect(discovery.status).toBe("ok");
    if (discovery.status !== "ok") throw new Error("expected discovery");
    const buckets = new Map(
      (discovery.quotaBuckets ?? []).map((bucket) => [bucket.providerKey, bucket]),
    );

    expect(buckets.get("org:credits")).toMatchObject({
      metric: { kind: "currency", currency: "USD" },
      limitValue: 100.5,
    });
    expect(buckets.get("key:hash-alpha:limit")).toBeTruthy();
    expect(buckets.get("key:hash-beta:limit")).toBeUndefined();
    expect(buckets.get("key:hash-beta:usage")).toMatchObject({ windowPolicy: { kind: "none" } });

    const snapshots = await value.collectQuotaSnapshots();
    expect(snapshots.status).toBe("ok");
    if (snapshots.status !== "ok") throw new Error("expected snapshots");
    const byBucket = new Map(snapshots.values.map((snapshot) => [snapshot.quotaBucketId, snapshot]));

    const org = byBucket.get(buckets.get("org:credits")?.id ?? "");
    expect(org).toMatchObject({ usedValue: 25.75, remainingValue: 74.75, limitValue: 100.5 });
    const alphaLimit = byBucket.get(buckets.get("key:hash-alpha:limit")?.id ?? "");
    expect(alphaLimit).toMatchObject({ remainingValue: 74.5, limitValue: 100 });
    expect(org).not.toBe(alphaLimit);
    const alphaUsage = byBucket.get(buckets.get("key:hash-alpha:usage")?.id ?? "");
    expect(alphaUsage).toMatchObject({ usedValue: 25.5 });
  });

  it("keeps shared pool and key cap independent and binds both to model routes", async () => {
    const seen: SeenRequest[] = [];
    const value = adapter(
      await fakeServer(route(seen, true)),
      {
        managementCredential: {
          reference: "keychain://openrouter-management",
          resolve: async () => "test-openrouter-management-key",
        },
      },
    );
    const discovery = await value.discover();
    if (discovery.status !== "ok") throw new Error("expected discovery");
    const buckets = new Map(
      (discovery.quotaBuckets ?? []).map((bucket) => [bucket.providerKey, bucket.id]),
    );
    const bindings = discovery.quotaBindings ?? [];
    const routeIds = new Set(discovery.accessRoutes.map((route) => route.id));
    const orgId = buckets.get("org:credits");
    const capId = buckets.get("key:hash-alpha:limit");
    expect(
      bindings.filter((binding) => binding.quotaBucketId === orgId).map((b) => b.accessRouteId).sort(),
    ).toEqual([...routeIds].sort());
    expect(
      bindings.filter((binding) => binding.quotaBucketId === capId).map((b) => b.accessRouteId).sort(),
    ).toEqual([...routeIds].sort());
  });

  it("uses only documented GET metadata endpoints and leaks no credential or user identity", async () => {
    const seen: SeenRequest[] = [];
    const bearerPrefix = "Bearer";
    const value = adapter(
      await fakeServer(route(seen, true)),
      {
        managementCredential: {
          reference: "keychain://openrouter-management",
          resolve: async () => "test-openrouter-management-key",
        },
      },
    );

    const discovery = await value.discover();
    const snapshots = await value.collectQuotaSnapshots();
    expect(discovery.status).toBe("ok");
    expect(snapshots.status).toBe("ok");

    expect(seen.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /api/v1/models",
      "GET /api/v1/key",
      "GET /api/v1/credits",
      "GET /api/v1/keys?include_disabled=true",
    ]);
    expect(seen[0]?.authorization).toBe(`${bearerPrefix} ${"test-openrouter-key"}`);
    expect(seen[2]?.authorization).toBe(`${bearerPrefix} ${"test-openrouter-management-key"}`);
    const serialized = JSON.stringify({ discovery, snapshots });
    expect(serialized).not.toContain("test-openrouter-key");
    expect(serialized).not.toContain("test-openrouter-management-key");
    expect(serialized).not.toContain("keychain://openrouter");
    expect(serialized).not.toContain("user_2dHF");
  });

  it("treats an unlimited key as usage counters without a fabricated cap", async () => {
    const value = adapter(await fakeServer(route([], false)));
    const discovery = await value.discover();
    if (discovery.status !== "ok") throw new Error("expected discovery");
    const limitBucket = new Map(
      (discovery.quotaBuckets ?? []).map((bucket) => [bucket.providerKey, bucket]),
    ).get("key:Production API Key:limit");
    expect(limitBucket?.limitValue).toBe(100);
  });

  it("preserves a null key limit by emitting only usage buckets for that key", async () => {
    const localKeyFixture = {
      data: {
        ...keyFixture.data,
        limit: null,
        limit_remaining: null,
        limit_reset: null,
        label: "No cap",
      },
    };
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/v1/key") {
        response.end(JSON.stringify(localKeyFixture));
        return;
      }
      if (request.url?.startsWith("/api/v1/models")) {
        response.end(JSON.stringify(modelsFixture));
        return;
      }
      response.writeHead(404).end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing fake server port");

    const value = adapter(`http://127.0.0.1:${address.port}/api/v1`);
    const discovery = await value.discover();
    if (discovery.status !== "ok") throw new Error("expected discovery");
    const keys = (discovery.quotaBuckets ?? []).map((bucket) => bucket.providerKey);
    expect(keys).not.toContain("key:No cap:limit");
    expect(keys).toContain("key:No cap:usage");
    const snapshots = await value.collectQuotaSnapshots();
    if (snapshots.status !== "ok") throw new Error("expected snapshots");
    for (const snapshot of snapshots.values) {
      expect(snapshot).not.toHaveProperty("limitValue");
      expect(snapshot).not.toHaveProperty("usedFraction");
    }
  });

  it("normalizes management-key rejection without losing the standard key surface", async () => {
    const manager = new UsageAdapterManager();
    const server = createServer((request, response) => {
      if (request.url === "/api/v1/key" || request.url?.startsWith("/api/v1/models")) {
        response.setHeader("content-type", "application/json");
        response.end(request.url === "/api/v1/key" ? JSON.stringify(keyFixture) : JSON.stringify(modelsFixture));
        return;
      }
      response.writeHead(403).end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing fake server port");

    const value = adapter(`http://127.0.0.1:${address.port}/api/v1`, {
      managementCredential: {
        reference: "keychain://openrouter-management",
        resolve: async () => "test-openrouter-management-key",
      },
    });
    manager.register(value);
    const discovery = await manager.discover(value.id);
    expect(discovery.status).toBe("ok");
    if (discovery.status !== "ok") throw new Error("expected discovery ok despite mgmt rejection");
    const buckets = new Map(
      (discovery.quotaBuckets ?? []).map((bucket) => [bucket.providerKey, bucket.id]),
    );
    expect(buckets.has("org:credits")).toBe(false);
    expect(buckets.has("key:Production API Key:limit")).toBe(true);
  });

  it("reports unsupported capabilities it cannot honestly back", async () => {
    const seen: SeenRequest[] = [];
    const value = adapter(await fakeServer(route(seen, false)));
    expect(await value.collectUsageEvents()).toEqual({
      status: "unsupported",
      capability: "collect_usage_events",
    });
    expect(await value.collectCostEvents()).toEqual({
      status: "unsupported",
      capability: "collect_costs",
    });
  });
});
