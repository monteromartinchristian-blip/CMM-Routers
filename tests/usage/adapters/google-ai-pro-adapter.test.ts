import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { UsageAdapterManager } from "../../../src/usage/adapters/adapter-manager.js";
import { GoogleAiProUsageAdapter } from "../../../src/usage/adapters/google-ai-pro/adapter.js";

interface SeenRequest {
  method: string;
  path: string;
  body: unknown;
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

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(raw) as unknown);
      } catch {
        resolve(null);
      }
    });
  });
}

async function fakeCodeAssistServer(seen: SeenRequest[]): Promise<string> {
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const body = await readJson(request);
    seen.push({
      method: request.method ?? "",
      path: request.url ?? "",
      body,
      ...(typeof request.headers.authorization === "string"
        ? { authorization: request.headers.authorization }
        : {}),
    });
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1internal:loadCodeAssist") {
      response.end(
        JSON.stringify({
          currentTier: { id: "user_tier_google_ai_pro", name: "Google AI Pro" },
          paidTier: {
            id: "user_tier_google_ai_pro",
            name: "Google AI Pro",
            availableCredits: [{ creditType: "GOOGLE_ONE_AI", creditAmount: "1200" }],
          },
          cloudaicompanionProject: "cmm-project-77",
        }),
      );
      return;
    }
    if (request.url === "/v1internal:retrieveUserQuota") {
      response.end(
        JSON.stringify({
          buckets: [
            {
              tokenType: "tokenType.googleapis.com/gemini-pro-model",
              remainingAmount: "15",
              remainingFraction: 0.15,
              resetTime: "2026-09-20T00:00:00Z",
            },
            {
              tokenType: "tokenType.googleapis.com/gemini-flash-model",
              remainingAmount: "5",
              remainingFraction: 0.05,
              resetTime: "2026-09-14T00:00:00Z",
            },
            {
              tokenType: "tokenType.googleapis.com/gemini-pro-model",
              modelId: "claude-sonnet-4-5",
              remainingFraction: 0.2,
              resetTime: "2026-09-18T00:00:00Z",
            },
          ],
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing fake server port");
  return `http://127.0.0.1:${address.port}/`;
}

function adapter(baseUrl: string): GoogleAiProUsageAdapter {
  return new GoogleAiProUsageAdapter({
    baseUrl,
    credential: {
      reference: "keychain://google-oauth",
      resolve: async () => "test-google-oauth-token",
    },
    routes: [{ providerModelId: "gemini-3-pro", displayName: "Gemini 3 Pro" }],
    now: () => new Date("2026-09-13T12:00:00.000Z"),
  });
}

describe("GoogleAiProUsageAdapter", () => {
  it("discovers the subscription tier with split first-party and external pools as ordinary buckets", async () => {
    const seen: SeenRequest[] = [];
    const value = adapter(await fakeCodeAssistServer(seen));

    const discovery = await value.discover();
    expect(discovery.status).toBe("ok");
    if (discovery.status !== "ok") throw new Error("expected discovery");

    expect(discovery.providers.map((provider) => provider.id)).toEqual(["provider:google-ai-pro"]);
    expect(discovery.products[0]).toMatchObject({ kind: "subscription", displayName: "Google AI Pro" });
    expect(discovery.accessRoutes.map((route) => route.providerModelId).sort()).toEqual([
      "claude-sonnet-4-5",
      "gemini-3-pro",
    ]);

    const buckets = new Map((discovery.quotaBuckets ?? []).map((bucket) => [bucket.providerKey, bucket]));
    expect(buckets.get("quota:tokenType.googleapis.com/gemini-pro-model")).toMatchObject({
      metric: { kind: "provider_defined", providerKey: "tokenType.googleapis.com/gemini-pro-model" },
      status: "warning",
    });
    expect(buckets.get("quota:tokenType.googleapis.com/gemini-pro-model")).not.toHaveProperty("limitValue");
    expect(buckets.get("quota:tokenType.googleapis.com/gemini-flash-model")).toMatchObject({
      status: "critical",
    });
    expect(buckets.get("quota:tokenType.googleapis.com/gemini-pro-model:claude-sonnet-4-5")).toBeTruthy();
    expect(buckets.get("credits:GOOGLE_ONE_AI")).toMatchObject({
      metric: { kind: "credits" },
    });

    const bindings = discovery.quotaBindings ?? [];
    const routeIds = new Set(discovery.accessRoutes.map((route) => route.id));
    const proPoolId = buckets.get("quota:tokenType.googleapis.com/gemini-pro-model")?.id;
    expect(bindings.filter((binding) => binding.quotaBucketId === proPoolId).map((b) => b.accessRouteId).sort())
      .toEqual([...routeIds].sort());
    const externalId = buckets.get("quota:tokenType.googleapis.com/gemini-pro-model:claude-sonnet-4-5")?.id;
    const claudeRoute = discovery.accessRoutes.find((route) => route.providerModelId === "claude-sonnet-4-5");
    expect(bindings.filter((binding) => binding.quotaBucketId === externalId)).toEqual([
      expect.objectContaining({ accessRouteId: claudeRoute?.id }),
    ]);
  });

  it("collects quota snapshots with independent resets and no invented absolute limits", async () => {
    const seen: SeenRequest[] = [];
    const value = adapter(await fakeCodeAssistServer(seen));
    await value.discover();
    const snapshots = await value.collectQuotaSnapshots();
    expect(snapshots.status).toBe("ok");
    if (snapshots.status !== "ok") throw new Error("expected snapshots");
    expect(snapshots.values).toHaveLength(4);
    const pro = snapshots.values.find(
      (snapshot) => snapshot.quotaBucketId === "bucket:google-ai-pro:quota%3AtokenType.googleapis.com%2Fgemini-pro-model",
    );
    expect(pro).toMatchObject({
      remainingFraction: 0.15,
      usedFraction: 0.85,
      remainingValue: 15,
      resetAt: "2026-09-20T00:00:00.000Z",
      source: "provider_official_api",
      confidence: "exact",
    });
    expect(pro).not.toHaveProperty("limitValue");
    const flash = snapshots.values.find((snapshot) => snapshot.resetAt === "2026-09-14T00:00:00.000Z");
    expect(flash).toBeTruthy();
    expect(flash?.resetAt).not.toBe(pro?.resetAt);
    const credits = snapshots.values.find(
      (snapshot) => snapshot.quotaBucketId === "bucket:google-ai-pro:credits%3AGOOGLE_ONE_AI",
    );
    expect(credits).toMatchObject({ remainingValue: 1200 });
    expect(credits).not.toHaveProperty("resetAt");
  });

  it("uses only the two metadata POST RPCs and leaks no credential or project identity", async () => {
    const seen: SeenRequest[] = [];
    const value = adapter(await fakeCodeAssistServer(seen));

    const discovery = await value.discover();
    const snapshots = await value.collectQuotaSnapshots();
    expect(discovery.status).toBe("ok");
    expect(snapshots.status).toBe("ok");

    expect(seen.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /v1internal:loadCodeAssist",
      "POST /v1internal:retrieveUserQuota",
    ]);
    expect(seen[0]?.body).toMatchObject({ metadata: { pluginType: "GEMINI" } });
    expect(seen[1]?.body).toMatchObject({ project: "cmm-project-77" });
    const serialized = JSON.stringify({ discovery, snapshots });
    expect(serialized).not.toContain("test-google-oauth-token");
    expect(serialized).not.toContain("keychain://google-oauth");
    expect(serialized).not.toContain("cmm-project-77");
  });

  it("normalizes authentication failures through the adapter manager", async () => {
    const server = createServer((_request, response) => response.writeHead(403).end());
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing fake server port");

    const manager = new UsageAdapterManager();
    const value = adapter(`http://127.0.0.1:${address.port}/`);
    manager.register(value);
    const result = await manager.discover(value.id);
    expect(result).toEqual({
      status: "error",
      error: { kind: "auth", message: "Usage adapter failed: auth" },
    });
  });
});
