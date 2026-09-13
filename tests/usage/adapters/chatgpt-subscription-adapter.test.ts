import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { UsageAdapterManager } from "../../../src/usage/adapters/adapter-manager.js";
import { ChatGptSubscriptionUsageAdapter } from "../../../src/usage/adapters/chatgpt-subscription/adapter.js";

interface SeenRequest {
  method: string;
  path: string;
  authorization?: string;
  accountId?: string;
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

async function serve(handler: (_req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing fake server port");
  return `http://127.0.0.1:${address.port}`;
}

const usageFixture = {
  plan_type: "plus",
  rate_limit_reached_type: null,
  limit_name: "codex",
  primary: {
    used_percent: 80,
    window_minutes: 300,
    resets_at: 1_781_366_400,
  },
  secondary: {
    used_percent: 46,
    window_minutes: 10_080,
    resets_at: null,
    reset_after_seconds: 345_600,
  },
  credits: {
    has_credits: true,
    unlimited: false,
    balance: "4250",
  },
  individual_limits: null,
  spend_control_reached: false,
};

function adapter(baseUrl: string): ChatGptSubscriptionUsageAdapter {
  return new ChatGptSubscriptionUsageAdapter({
    baseUrl,
    credential: {
      reference: "keychain://chatgpt-oauth",
      resolve: async () => "test-chatgpt-oauth-token",
    },
    accountId: "acct-test",
    routes: [
      { providerModelId: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
      { providerModelId: "gpt-5-mini", displayName: "GPT-5 Mini" },
    ],
    now: () => new Date("2026-09-13T12:00:00.000Z"),
  });
}

describe("ChatGptSubscriptionUsageAdapter", () => {
  it("discovers primary and secondary windows as independent percentage buckets with independent resets", async () => {
    const value = adapter(await serve((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(usageFixture));
    }));

    const discovery = await value.discover();
    expect(discovery.status).toBe("ok");
    if (discovery.status !== "ok") throw new Error("expected discovery");

    expect(discovery.providers.map((provider) => provider.id)).toEqual([
      "provider:chatgpt-subscription",
    ]);
    expect(discovery.products.map((product) => product.id)).toEqual([
      "product:chatgpt-subscription",
    ]);
    expect(discovery.products[0]).toMatchObject({ kind: "subscription", displayName: "ChatGPT Plus" });

    const buckets = new Map((discovery.quotaBuckets ?? []).map((bucket) => [bucket.providerKey, bucket]));
    expect(buckets.get("window:primary")).toMatchObject({
      metric: { kind: "percentage" },
      windowPolicy: { kind: "rolling_duration", durationSeconds: 18_000 },
      status: "warning",
    });
    expect(buckets.get("window:primary")).not.toHaveProperty("limitValue");
    expect(buckets.get("window:secondary")).toMatchObject({
      metric: { kind: "percentage" },
      windowPolicy: { kind: "rolling_duration", durationSeconds: 604_800 },
      status: "healthy",
    });
    expect(buckets.get("credits")).toMatchObject({
      metric: { kind: "provider_defined", providerKey: "chatgpt_credits" },
    });

    const snapshots = await value.collectQuotaSnapshots();
    expect(snapshots.status).toBe("ok");
    if (snapshots.status !== "ok") throw new Error("expected snapshots");
    const byBucket = new Map(snapshots.values.map((snapshot) => [snapshot.quotaBucketId, snapshot]));

    const primary = byBucket.get(buckets.get("window:primary")?.id ?? "");
    expect(primary).toMatchObject({
      usedFraction: 0.8,
      remainingFraction: 0.2,
      resetAt: "2026-06-13T16:00:00.000Z",
      source: "provider_official_api",
      confidence: "exact",
    });
    expect(primary).not.toHaveProperty("usedValue");
    expect(primary).not.toHaveProperty("limitValue");

    const secondary = byBucket.get(buckets.get("window:secondary")?.id ?? "");
    expect(secondary).toMatchObject({
      usedFraction: 0.46,
      remainingFraction: 0.54,
    });
    expect(secondary?.resetAt).toBe(new Date(Date.parse("2026-09-13T12:00:00.000Z") + 345_600_000).toISOString());
    expect(secondary?.resetAt).not.toBe(primary?.resetAt);

    const credits = byBucket.get(buckets.get("credits")?.id ?? "");
    expect(credits).toMatchObject({ remainingValue: 4250, source: "provider_official_api" });
    expect(credits).not.toHaveProperty("limitValue");
  });

  it("marks windows exhausted from provider limit flags without inventing absolutes", async () => {
    const value = adapter(
      await serve((_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            plan_type: "pro",
            limit_name: "codex",
            primary: { used_percent: 5, window_minutes: 300 },
            secondary: null,
            credits: null,
            spend_control_reached: false,
            rate_limit_reached_type: "usage_limit_reached",
          }),
        );
      }),
    );
    const discovery = await value.discover();
    if (discovery.status !== "ok") throw new Error("expected discovery");
    const buckets = new Map((discovery.quotaBuckets ?? []).map((bucket) => [bucket.providerKey, bucket]));
    expect(buckets.get("window:primary")?.status).toBe("exhausted");
    expect(buckets.has("window:secondary")).toBe(false);
    expect(buckets.has("credits")).toBe(false);
  });

  it("uses one metadata GET, carries account identity header, and leaks no credential", async () => {
    const seen: SeenRequest[] = [];
    const value = adapter(
      await serve((req, res) => {
        seen.push({
          method: req.method ?? "",
          path: req.url ?? "",
          ...(typeof req.headers.authorization === "string"
            ? { authorization: req.headers.authorization }
            : {}),
          ...(typeof req.headers["chatgpt-account-id"] === "string"
            ? { accountId: req.headers["chatgpt-account-id"] }
            : {}),
        });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(usageFixture));
      }),
    );

    const discovery = await value.discover();
    const snapshots = await value.collectQuotaSnapshots();
    expect(discovery.status).toBe("ok");
    expect(snapshots.status).toBe("ok");
    expect(seen.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /api/codex/usage",
    ]);
    expect(seen[0]?.accountId).toBe("acct-test");
    expect(seen[0]?.authorization).toContain("test-chatgpt-oauth-token");

    const serialized = JSON.stringify({ discovery, snapshots });
    expect(serialized).not.toContain("test-chatgpt-oauth-token");
    expect(serialized).not.toContain("keychain://chatgpt-oauth");
    expect(serialized).not.toContain("acct-test");
  });

  it("stays isolated from the OpenAI API billing namespace", async () => {
    const value = adapter(await serve((_req, res) => res.writeHead(500).end()));
    expect(value.id).toBe("chatgpt-subscription");
    expect(value.id).not.toBe("openai-api");
    const discovery = await value.discover().catch(() => undefined);
    expect(discovery).toBeUndefined();
  });

  it("normalizes unavailable provider state through the adapter manager", async () => {
    const baseUrl = await serve((_req, res) => res.writeHead(503).end());
    const manager = new UsageAdapterManager();
    const value = adapter(baseUrl);
    manager.register(value);

    const result = await manager.discover(value.id);
    expect(result).toEqual({
      status: "error",
      error: { kind: "unavailable", message: "Usage adapter failed: unavailable" },
    });
  });
});
