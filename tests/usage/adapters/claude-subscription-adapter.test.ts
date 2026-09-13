import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { UsageAdapterManager } from "../../../src/usage/adapters/adapter-manager.js";
import { ClaudeSubscriptionUsageAdapter } from "../../../src/usage/adapters/claude-subscription/adapter.js";

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

async function fakeServer(body: unknown, status = 200): Promise<string> {
  const server = createServer((_request, response) => {
    if (status !== 200) {
      response.writeHead(status).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing fake server port");
  return `http://127.0.0.1:${address.port}`;
}

function trackingServer(body: unknown, seen: SeenRequest[]): Promise<string> {
  const server = createServer((request, response) => {
    seen.push({
      method: request.method ?? "",
      path: request.url ?? "",
      ...(typeof request.headers.authorization === "string"
        ? { authorization: request.headers.authorization }
        : {}),
    });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
  });
  servers.push(server);
  return new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing fake server port");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

const usageFixture = {
  account_uuid: "acct-secret-uuid",
  utilization: {
    five_hour: {
      utilization: 80,
      resets_at: "2026-09-13T18:00:00+00:00",
      limit_dollars: null,
      used_dollars: null,
      remaining_dollars: null,
    },
    seven_day: {
      utilization: 46,
      resets_at: "2026-09-15T04:59:59+00:00",
      limit_dollars: null,
      used_dollars: null,
      remaining_dollars: null,
    },
    seven_day_opus: {
      utilization: 12,
      resets_at: "2026-09-16T04:59:59+00:00",
    },
    seven_day_sonnet: null,
    seven_day_cowork: null,
    extra_usage: {
      is_enabled: true,
      monthly_limit: 6000,
      used_credits: 5752,
      utilization: 95.86666666666666,
      currency: "EUR",
      decimal_places: 2,
      user_disabled: false,
    },
    limits: [
      { kind: "session", group: "session", percent: 80, resets_at: "2026-09-13T18:00:00+00:00" },
    ],
  },
};

function adapter(
  baseUrl: string,
  overrides: Partial<ConstructorParameters<typeof ClaudeSubscriptionUsageAdapter>[0]> = {},
) {
  return new ClaudeSubscriptionUsageAdapter({
    baseUrl,
    credential: {
      reference: "keychain://claude-oauth",
      resolve: async () => "test-claude-oauth-token",
    },
    routes: [
      { providerModelId: "claude-opus-4-8", displayName: "Claude Opus 4.8" },
      { providerModelId: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
    ],
    now: () => new Date("2026-09-13T12:00:00.000Z"),
    ...overrides,
  });
}

describe("ClaudeSubscriptionUsageAdapter", () => {
  it("discovers plan, weekly-global, and model-scoped windows as independent buckets", async () => {
    const value = adapter(await fakeServer(usageFixture));

    const discovery = await value.discover();
    expect(discovery.status).toBe("ok");
    if (discovery.status !== "ok") throw new Error("expected discovery");

    const buckets = new Map((discovery.quotaBuckets ?? []).map((bucket) => [bucket.providerKey, bucket]));
    expect(buckets.get("window:five_hour")).toMatchObject({
      metric: { kind: "percentage" },
      windowPolicy: { kind: "rolling_duration", durationSeconds: 18_000 },
      status: "warning",
    });
    expect(buckets.get("window:five_hour")).not.toHaveProperty("limitValue");
    expect(buckets.get("window:seven_day")).toMatchObject({
      metric: { kind: "percentage" },
      windowPolicy: { kind: "rolling_duration", durationSeconds: 604_800 },
      status: "healthy",
    });
    expect(buckets.get("window:seven_day_opus")).toMatchObject({
      metric: { kind: "percentage" },
      windowPolicy: { kind: "rolling_duration", durationSeconds: 604_800 },
      status: "healthy",
    });
    expect(buckets.has("window:seven_day_sonnet")).toBe(false);
    expect(buckets.has("window:seven_day_cowork")).toBe(false);
    expect(buckets.has("limits")).toBe(false);

    const routes = discovery.accessRoutes;
    expect(routes.map((route) => route.providerModelId).sort()).toEqual([
      "claude-opus-4-8",
      "claude-sonnet-5",
    ]);
    const bindings = discovery.quotaBindings ?? [];
    const routeIds = new Set(routes.map((route) => route.id));
    for (const key of ["window:five_hour", "window:seven_day"]) {
      const bucketId = buckets.get(key)?.id;
      expect(bindings.filter((binding) => binding.quotaBucketId === bucketId).map((b) => b.accessRouteId).sort())
        .toEqual([...routeIds].sort());
    }
    const opusRoute = routes.find((route) => route.providerModelId === "claude-opus-4-8");
    expect(bindings.filter((binding) => binding.quotaBucketId === buckets.get("window:seven_day_opus")?.id)).toEqual([
      expect.objectContaining({ accessRouteId: opusRoute?.id }),
    ]);
  });

  it("keeps subscription windows separate from extra-usage credits with the provider's own units", async () => {
    const value = adapter(await fakeServer(usageFixture));

    const discovery = await value.discover();
    if (discovery.status !== "ok") throw new Error("expected discovery");
    const buckets = new Map((discovery.quotaBuckets ?? []).map((bucket) => [bucket.providerKey, bucket]));
    const credits = buckets.get("credits:extra_usage");
    expect(credits).toMatchObject({
      metric: { kind: "currency", currency: "EUR" },
      unit: "EUR",
      limitValue: 60,
    });
    expect(credits?.id).not.toMatch(/window/);

    const snapshots = await value.collectQuotaSnapshots();
    expect(snapshots.status).toBe("ok");
    if (snapshots.status !== "ok") throw new Error("expected snapshots");
    const byBucket = new Map(snapshots.values.map((snapshot) => [snapshot.quotaBucketId, snapshot]));

    const fiveHour = byBucket.get(buckets.get("window:five_hour")?.id ?? "");
    expect(fiveHour).toMatchObject({
      usedFraction: 0.8,
      remainingFraction: 0.2,
      resetAt: "2026-09-13T18:00:00.000Z",
      source: "provider_official_api",
      confidence: "exact",
      stalenessAfter: "2026-09-13T12:01:00.000Z",
    });
    expect(fiveHour).not.toHaveProperty("usedValue");
    expect(fiveHour).not.toHaveProperty("limitValue");

    const sevenDay = byBucket.get(buckets.get("window:seven_day")?.id ?? "");
    expect(sevenDay).toMatchObject({
      usedFraction: 0.46,
      resetAt: "2026-09-15T04:59:59.000Z",
    });

    const extra = byBucket.get(credits?.id ?? "");
    expect(extra).toMatchObject({
      usedValue: 57.52,
      remainingValue: 2.48,
      limitValue: 60,
    });
    expect(extra).not.toHaveProperty("resetAt");
  });

  it("reports exhausted state for over-100 percent windows without inventing absolutes", async () => {
    const value = adapter(
      await fakeServer({
        utilization: {
          five_hour: { utilization: 120, resets_at: "2026-09-13T18:00:00+00:00" },
          seven_day: null,
        },
      }),
    );

    const discovery = await value.discover();
    if (discovery.status !== "ok") throw new Error("expected discovery");
    const buckets = new Map((discovery.quotaBuckets ?? []).map((bucket) => [bucket.providerKey, bucket]));
    expect(buckets.get("window:five_hour")).toMatchObject({ status: "exhausted" });

    const snapshots = await value.collectQuotaSnapshots();
    if (snapshots.status !== "ok") throw new Error("expected snapshots");
    expect(snapshots.values).toHaveLength(1);
    expect(snapshots.values[0]).toMatchObject({ usedFraction: 1, remainingFraction: 0 });
    expect(snapshots.values[0]).not.toHaveProperty("limitValue");
  });

  it("omits the credits bucket when extra usage is disabled", async () => {
    const value = adapter(
      await fakeServer({
        utilization: {
          five_hour: { utilization: 10, resets_at: "2026-09-13T18:00:00+00:00" },
          extra_usage: { is_enabled: false, monthly_limit: 6000, used_credits: 0, currency: "EUR", decimal_places: 2 },
        },
      }),
    );
    const discovery = await value.discover();
    if (discovery.status !== "ok") throw new Error("expected discovery");
    const keys = (discovery.quotaBuckets ?? []).map((bucket) => bucket.providerKey);
    expect(keys).not.toContain("credits:extra_usage");
  });

  it("calls only the OAuth usage metadata endpoint and leaks no credential or account identity", async () => {
    const seen: SeenRequest[] = [];
    const value = adapter(await trackingServer(usageFixture, seen));

    const discovery = await value.discover();
    const snapshots = await value.collectQuotaSnapshots();
    expect(discovery.status).toBe("ok");
    expect(snapshots.status).toBe("ok");

    const bearerPrefix = "Bearer";
    expect(seen).toEqual([
      {
        method: "GET",
        path: "/api/oauth/usage",
        authorization: `${bearerPrefix} ${"test-claude-oauth-token"}`,
      },
    ]);
    const serialized = JSON.stringify({ discovery, snapshots });
    expect(serialized).not.toContain("test-claude-oauth-token");
    expect(serialized).not.toContain("keychain://claude-oauth");
    expect(serialized).not.toContain("acct-secret-uuid");
  });

  it("treats a response without utilization data as a protocol failure, never inference", async () => {
    const value = adapter(await fakeServer({ unexpected: true }));

    await expect(value.discover()).rejects.toMatchObject({ kind: "protocol" });
  });

  it("normalizes authentication failures through the adapter manager", async () => {
    const baseUrl = await fakeServer({}, 401);
    const manager = new UsageAdapterManager();
    const value = adapter(baseUrl);
    manager.register(value);

    const result = await manager.discover(value.id);

    expect(result).toEqual({
      status: "error",
      error: { kind: "auth", message: "Usage adapter failed: auth" },
    });
  });
});
