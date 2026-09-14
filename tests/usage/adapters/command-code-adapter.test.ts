import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { UsageAdapterManager } from "../../../src/usage/adapters/adapter-manager.js";
import { CommandCodeUsageAdapter } from "../../../src/usage/adapters/command-code/adapter.js";

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

function usageFixture(path: string): unknown {
  if (path === "/alpha/whoami?limits=1") {
    return {
      user: { id: "user-1", userName: "example" },
      org: {
        id: "org-1",
        login: "example-org",
      },
      orgLimits: [
        {
          scope: "org",
          spent: 40,
          limit: 100,
          resetInterval: "monthly",
          resetAt: "2026-10-01T00:00:00.000Z",
          exceeded: false,
        },
        {
          scope: "model",
          model: "claude-sonnet-5",
          modelLabel: "Claude Sonnet 5",
          spent: 15,
          limit: 25,
          resetInterval: "monthly",
          resetAt: "2026-09-20T00:00:00.000Z",
          exceeded: false,
        },
      ],
    };
  }
  if (path === "/alpha/billing/credits?orgId=org-1") {
    return {
      credits: {
        planId: "individual-pro",
        monthlyCredits: 30,
        purchasedCredits: 12,
        freeCredits: 3,
      },
      windowLimits: {
        limited: true,
        fiveHour: {
          used: 40,
          cap: 100,
          resetAt: Date.parse("2026-09-13T17:00:00.000Z"),
        },
        weekly: {
          used: 220,
          cap: 500,
          resetAt: Date.parse("2026-09-19T00:00:00.000Z"),
        },
      },
    };
  }
  if (path === "/alpha/billing/subscriptions?orgId=org-1") {
    return {
      data: {
        planId: "individual-pro",
        status: "active",
        currentPeriodStart: "2026-09-01T00:00:00.000Z",
        currentPeriodEnd: "2026-10-01T00:00:00.000Z",
      },
    };
  }
  if (path === "/alpha/usage/summary?orgId=org-1&since=2026-09-01T00%3A00%3A00.000Z") {
    return { totalCost: 50, totalCount: 700 };
  }
  return undefined;
}

async function fixtureBaseUrl(seen: SeenRequest[]): Promise<string> {
  return fakeServer((request, response) => {
    const path = request.url ?? "";
    seen.push({
      method: request.method ?? "",
      path,
      ...(typeof request.headers.authorization === "string"
        ? { authorization: request.headers.authorization }
        : {}),
    });
    const body = usageFixture(path);
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
  });
}

function adapter(baseUrl: string): CommandCodeUsageAdapter {
  return new CommandCodeUsageAdapter({
    baseUrl,
    credential: {
      reference: "keychain://command-code",
      resolve: async () => "test-command-code-key",
    },
    routes: [
      { providerModelId: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
      { providerModelId: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
    ],
    now: () => new Date("2026-09-13T12:00:00.000Z"),
  });
}

describe("CommandCodeUsageAdapter", () => {
  it("discovers shared 5-hour, weekly, plan-credit and model-specific quota bindings", async () => {
    const seen: SeenRequest[] = [];
    const value = adapter(await fixtureBaseUrl(seen));

    const discovery = await value.discover();

    expect(discovery.status).toBe("ok");
    if (discovery.status !== "ok") throw new Error("expected discovery");

    expect(discovery.accessRoutes.map((route) => route.providerModelId).sort()).toEqual([
      "claude-sonnet-5",
      "gpt-5.6-sol",
    ]);
    const buckets = new Map((discovery.quotaBuckets ?? []).map((bucket) => [bucket.providerKey, bucket]));
    expect(buckets.get("window:fiveHour")).toMatchObject({
      metric: { kind: "provider_defined", providerKey: "command_code_window_units" },
      windowPolicy: { kind: "rolling_duration", durationSeconds: 18_000 },
      limitValue: 100,
    });
    expect(buckets.get("window:weekly")).toMatchObject({
      metric: { kind: "provider_defined", providerKey: "command_code_window_units" },
      windowPolicy: { kind: "provider_reported" },
      limitValue: 500,
    });
    expect(buckets.get("credits:monthly")).toMatchObject({
      metric: { kind: "credits" },
      windowPolicy: {
        kind: "billing_cycle",
        anchorDate: "2026-09-01T00:00:00.000Z",
        timezone: "UTC",
      },
    });
    expect(buckets.get("org-limit:model:claude-sonnet-5")).toMatchObject({
      metric: { kind: "currency", currency: "USD" },
      limitValue: 25,
    });

    const routeByModel = new Map(discovery.accessRoutes.map((route) => [route.providerModelId, route.id]));
    const bindings = discovery.quotaBindings ?? [];
    const sharedKeys = ["window:fiveHour", "window:weekly", "credits:monthly", "org-limit:org"];
    for (const key of sharedKeys) {
      const bucketId = buckets.get(key)?.id;
      expect(bucketId).toBeTruthy();
      expect(bindings.filter((binding) => binding.quotaBucketId === bucketId)).toHaveLength(2);
    }
    const modelBucketId = buckets.get("org-limit:model:claude-sonnet-5")?.id;
    expect(bindings.filter((binding) => binding.quotaBucketId === modelBucketId)).toEqual([
      expect.objectContaining({ accessRouteId: routeByModel.get("claude-sonnet-5") }),
    ]);
  });

  it("preserves independent resets and does not invent an absolute monthly credit limit", async () => {
    const seen: SeenRequest[] = [];
    const value = adapter(await fixtureBaseUrl(seen));
    const discovery = await value.discover();
    if (discovery.status !== "ok") throw new Error("expected discovery");
    const snapshots = await value.collectQuotaSnapshots();

    expect(snapshots.status).toBe("ok");
    if (snapshots.status !== "ok") throw new Error("expected snapshots");
    const bucketByKey = new Map((discovery.quotaBuckets ?? []).map((bucket) => [bucket.providerKey, bucket.id]));
    const byBucket = new Map(snapshots.values.map((snapshot) => [snapshot.quotaBucketId, snapshot]));

    expect(byBucket.get(bucketByKey.get("window:fiveHour") ?? "")).toMatchObject({
      usedValue: 40,
      remainingValue: 60,
      limitValue: 100,
      usedFraction: 0.4,
      remainingFraction: 0.6,
      resetAt: "2026-09-13T17:00:00.000Z",
      source: "provider_official_cli",
      confidence: "exact",
    });
    expect(byBucket.get(bucketByKey.get("window:weekly") ?? "")).toMatchObject({
      usedValue: 220,
      remainingValue: 280,
      limitValue: 500,
      resetAt: "2026-09-19T00:00:00.000Z",
    });
    expect(byBucket.get(bucketByKey.get("org-limit:model:claude-sonnet-5") ?? "")).toMatchObject({
      usedValue: 15,
      remainingValue: 10,
      limitValue: 25,
      resetAt: "2026-09-20T00:00:00.000Z",
    });
    const monthly = byBucket.get(bucketByKey.get("credits:monthly") ?? "");
    expect(monthly).toMatchObject({
      remainingValue: 30,
      resetAt: "2026-10-01T00:00:00.000Z",
    });
    expect(monthly).not.toHaveProperty("limitValue");
    expect(monthly).not.toHaveProperty("usedValue");
  });

  it("keeps supplemental credit balances observable without binding them as route constraints", async () => {
    const seen: SeenRequest[] = [];
    const value = adapter(await fixtureBaseUrl(seen));

    const discovery = await value.discover();
    const snapshots = await value.collectQuotaSnapshots();

    expect(discovery.status).toBe("ok");
    expect(snapshots.status).toBe("ok");
    if (discovery.status !== "ok" || snapshots.status !== "ok") {
      throw new Error("expected Command Code quota data");
    }

    const buckets = new Map(
      (discovery.quotaBuckets ?? []).map((bucket) => [bucket.providerKey, bucket]),
    );
    const bindings = discovery.quotaBindings ?? [];
    const byBucket = new Map(snapshots.values.map((snapshot) => [snapshot.quotaBucketId, snapshot]));

    for (const [key, remaining] of [
      ["credits:purchased", 12],
      ["credits:free", 3],
    ] as const) {
      const bucket = buckets.get(key);
      expect(bucket).toBeDefined();
      expect(byBucket.get(bucket?.id ?? "")).toMatchObject({
        remainingValue: remaining,
        source: "provider_official_cli",
        confidence: "exact",
      });
      expect(bindings.filter((binding) => binding.quotaBucketId === bucket?.id)).toEqual([]);
    }
  });

  it("keeps a provider reset sentinel of zero unknown instead of rendering the Unix epoch", async () => {
    const baseUrl = await fakeServer((request, response) => {
      const path = request.url ?? "";
      const body = usageFixture(path);
      if (body === undefined) {
        response.writeHead(404).end();
        return;
      }
      if (path.startsWith("/alpha/billing/credits")) {
        const value = structuredClone(body) as {
          windowLimits: { fiveHour: { resetAt?: number } };
        };
        value.windowLimits.fiveHour.resetAt = 0;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(value));
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(body));
    });
    const value = adapter(baseUrl);
    const discovery = await value.discover();
    if (discovery.status !== "ok") throw new Error("expected discovery");
    const snapshots = await value.collectQuotaSnapshots();
    if (snapshots.status !== "ok") throw new Error("expected snapshots");
    const bucketId = discovery.quotaBuckets?.find(
      (bucket) => bucket.providerKey === "window:fiveHour",
    )?.id;
    const fiveHour = snapshots.values.find((snapshot) => snapshot.quotaBucketId === bucketId);

    expect(fiveHour).toBeDefined();
    expect(fiveHour).not.toHaveProperty("resetAt");
  });

  it("uses only the four metadata GET endpoints and keeps credentials out of normalized output", async () => {
    const seen: SeenRequest[] = [];
    const value = adapter(await fixtureBaseUrl(seen));

    const discovery = await value.discover();
    const snapshots = await value.collectQuotaSnapshots();

    expect(discovery.status).toBe("ok");
    expect(snapshots.status).toBe("ok");
    expect(seen).toEqual([
      { method: "GET", path: "/alpha/whoami?limits=1", authorization: "Bearer test-command-code-key" },
      { method: "GET", path: "/alpha/billing/credits?orgId=org-1", authorization: "Bearer test-command-code-key" },
      { method: "GET", path: "/alpha/billing/subscriptions?orgId=org-1", authorization: "Bearer test-command-code-key" },
      {
        method: "GET",
        path: "/alpha/usage/summary?orgId=org-1&since=2026-09-01T00%3A00%3A00.000Z",
        authorization: "Bearer test-command-code-key",
      },
    ]);
    expect(JSON.stringify({ discovery, snapshots })).not.toContain("test-command-code-key");
    expect(JSON.stringify({ discovery, snapshots })).not.toContain("keychain://command-code");
  });

  it("normalizes metadata authentication failures through the adapter manager", async () => {
    const baseUrl = await fakeServer((_request, response) => response.writeHead(401).end());
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
