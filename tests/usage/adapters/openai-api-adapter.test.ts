import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { UsageAdapterManager } from "../../../src/usage/adapters/adapter-manager.js";
import { OpenAiApiUsageAdapter } from "../../../src/usage/adapters/openai-api/adapter.js";

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

interface SeenRequest {
  method: string;
  path: string;
}

async function fakeBillingServer(seen: SeenRequest[]): Promise<string> {
  const server = createServer((request, response) => {
    const path = request.url ?? "";
    seen.push({ method: request.method ?? "", path });
    response.setHeader("content-type", "application/json");
    if (path.startsWith("/v1/organization/usage/completions")) {
      response.end(
        JSON.stringify({
          object: "page",
          has_more: true,
          data: [
            {
              object: "bucket",
              start_time: 1_759_913_600,
              end_time: 1_760_000_000,
              results: [
                {
                  object: "organization.usage.completions.result",
                  input_tokens: 150_000,
                  output_tokens: 30_000,
                  num_model_requests: 24,
                  model: "gpt-5.6-sol",
                },
                {
                  object: "organization.usage.completions.result",
                  input_tokens: 9_000,
                  output_tokens: 1_200,
                  num_model_requests: 6,
                  model: "gpt-5-mini",
                },
              ],
            },
          ],
          next_page: "page-token-abc",
        }),
      );
      return;
    }
    if (path.startsWith("/v1/organization/costs")) {
      response.end(
        JSON.stringify({
          object: "page",
          has_more: false,
          data: [
            {
              object: "bucket",
              start_time: 1_759_913_600,
              end_time: 1_760_000_000,
              results: [
                {
                  object: "organization.costs.result",
                  amount: { value: 4.25, currency: "usd" },
                  line_item: "Model inference",
                },
              ],
            },
          ],
          next_page: null,
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

function adapter(baseUrl: string): OpenAiApiUsageAdapter {
  return new OpenAiApiUsageAdapter({
    baseUrl,
    credential: {
      reference: "keychain://openai-admin",
      resolve: async () => "test-openai-admin-key",
    },
    projectId: "proj-test",
    models: [
      { providerModelId: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
      { providerModelId: "gpt-5-mini", displayName: "GPT-5 Mini" },
    ],
    now: () => new Date("2026-09-13T12:00:00.000Z"),
  });
}

describe("OpenAiApiUsageAdapter", () => {
  it("discovers a distinct API billing product with configured routes and no quota buckets", async () => {
    const seen: SeenRequest[] = [];
    const value = adapter(await fakeBillingServer(seen));

    const discovery = await value.discover();
    expect(discovery.status).toBe("ok");
    if (discovery.status !== "ok") throw new Error("expected discovery");

    expect(discovery.providers.map((provider) => provider.id)).toEqual(["provider:openai-api"]);
    expect(discovery.products.map((product) => product.id)).toEqual(["product:openai-api"]);
    expect(discovery.products[0]).toMatchObject({ kind: "api" });
    expect(discovery.accessRoutes.map((route) => route.providerModelId).sort()).toEqual([
      "gpt-5-mini",
      "gpt-5.6-sol",
    ]);
    expect(discovery.quotaBuckets ?? []).toEqual([]);
    expect(value.capabilities().has("collect_quota_snapshots")).toBe(false);
    expect(seen).toEqual([]);
  });

  it("collects provider usage events and cost events from the official GET endpoints with cursor paging", async () => {
    const seen: SeenRequest[] = [];
    const value = adapter(await fakeBillingServer(seen));

    const events = await value.collectUsageEvents();
    expect(events.status).toBe("ok");
    if (events.status !== "ok") throw new Error("expected events");
    expect(events.cursor).toBe("page-token-abc");
    expect(events.values).toHaveLength(2);
    expect(events.values[0]).toMatchObject({
      providerId: "provider:openai-api",
      accessRouteId: "route:openai-api:gpt-5.6-sol",
      inputTokens: 150_000,
      outputTokens: 30_000,
      requests: 24,
      occurredAt: "2025-10-08T08:53:20.000Z",
      source: "provider_official_api",
      confidence: "measured",
    });

    const costs = await value.collectCostEvents();
    expect(costs.status).toBe("ok");
    if (costs.status !== "ok") throw new Error("expected costs");
    expect(costs.values).toEqual([
      expect.objectContaining({
        providerId: "provider:openai-api",
        amount: 4.25,
        currency: "usd",
        kind: "usage",
        source: "provider_official_api",
      }),
    ]);

    const startTime = Math.floor(
      (Date.parse("2026-09-13T12:00:00.000Z") - 30 * 86_400_000) / 1000,
    );
    expect(seen.map((request) => request.method)).toEqual(["GET", "GET"]);
    expect(seen.map((request) => request.path)).toEqual([
      `/v1/organization/usage/completions?start_time=${startTime}&bucket_width=1d&group_by%5B%5D=model&project_ids%5B%5D=proj-test`,
      `/v1/organization/costs?start_time=${startTime}&bucket_width=1d&project_ids%5B%5D=proj-test`,
    ]);
    const serialized = JSON.stringify({ events, costs });
    expect(serialized).not.toContain("test-openai-admin-key");
    expect(serialized).not.toContain("keychain://openai-admin");
  });

  it("rejects inference endpoints as metadata paths and normalizes auth failures", async () => {
    expect(
      () =>
        new OpenAiApiUsageAdapter({
          baseUrl: "https://api.openai.com/v1/",
          credential: { reference: "ref", resolve: async () => undefined },
          usagePath: "/chat/completions",
        }),
    ).toThrow(/inference/i);

    const server = createServer((_request, response) => response.writeHead(401).end());
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing fake server port");

    const manager = new UsageAdapterManager();
    const value = adapter(`http://127.0.0.1:${address.port}/`);
    manager.register(value);
    const result = await manager.collectUsageEvents(value.id);
    expect(result).toEqual({
      status: "error",
      error: { kind: "auth", message: "Usage adapter failed: auth" },
    });
  });
});
