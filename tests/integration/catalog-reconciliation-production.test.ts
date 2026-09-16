import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sharedConfigSchema } from "../../src/config/schema.js";
import { buildCmmChatRouteProjection, type RouterCatalogProjection } from "../../src/catalog/projection.js";
import { createProductionRegistry, createProductionServer } from "../../src/index.js";
import { jsonResponse, recordingFetch } from "../helpers/wave-fixtures.js";

describe("production live catalog reconciliation", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...savedEnv };
    for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]) {
      delete process.env[key];
    }
    process.env.DEEPSEEK_API_KEY = "deepseek-reconcile-test-secret";
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("reconciles A→B through the live management read and isolates discovery failure", async () => {
    let now = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    let models = ["stable-model", "removed-model"];
    let failDiscovery = false;
    const transport = recordingFetch((request) => {
      if (request.method !== "GET" || !request.url.endsWith("/models")) {
        return jsonResponse(500, { error: "unexpected request" });
      }
      if (failDiscovery) throw new Error("fixture discovery unavailable");
      return jsonResponse(200, { data: models.map((id) => ({ id })) });
    });

    const config = {
      ...sharedConfigSchema.parse({
        mode: "standalone",
        host: "127.0.0.1",
        providers: {
          chatgpt: { enabled: false },
          claude: { enabled: false },
          google: { enabled: false },
          "command-code": {
            enabled: false,
            baseUrl: "https://api.commandcode.ai/provider/v1",
            secretEnv: "COMMAND_CODE_SECRET",
          },
          cavoti: { enabled: false },
          deepseek: { enabled: true },
        },
      }),
      machineId: "catalog-reconciliation-production-test",
    };

    const composition = await createProductionRegistry(config, {
      fetchFn: transport.fetchFn,
      catalogReconcileIntervalMs: 0,
    });
    expect(transport.requests.filter((request) => request.url.endsWith("/models"))).toHaveLength(1);
    const initialRoutes = composition.routeCatalog
      .list()
      .filter((route) => route.providerId === "deepseek");
    const stableBefore = initialRoutes.find((route) => route.providerModelId === "stable-model")!;
    const removedBefore = initialRoutes.find((route) => route.providerModelId === "removed-model")!;
    expect(stableBefore.routable).toBe(true);
    expect(removedBefore.routable).toBe(true);

    const server = createProductionServer(composition, "catalog-admin-secret");
    try {
      models = ["stable-model", "added-model"];
      now += 31_000;
      const reconciledResponse = await server.inject({
        method: "GET",
        url: "/v1/cmm/catalog",
        headers: { authorization: "Bearer catalog-admin-secret" },
      });
      expect(transport.requests.filter((request) => request.url.endsWith("/models"))).toHaveLength(2);
      expect(reconciledResponse.statusCode).toBe(200);
      const reconciled = reconciledResponse.json() as RouterCatalogProjection;
      const stableAfter = reconciled.routes.find(
        (route) => route.providerId === "deepseek" && route.providerModelId === "stable-model",
      )!;
      const removedAfter = reconciled.routes.find(
        (route) => route.providerId === "deepseek" && route.providerModelId === "removed-model",
      )!;
      const addedAfter = reconciled.routes.find(
        (route) => route.providerId === "deepseek" && route.providerModelId === "added-model",
      )!;

      expect(stableAfter.routeId).toBe(stableBefore.routeId);
      expect(stableAfter.routable).toBe(true);
      expect(addedAfter.routable).toBe(true);
      expect(removedAfter.routeId).toBe(removedBefore.routeId);
      expect(removedAfter.routable).toBe(false);
      expect(reconciled.models.some((identity) => identity.aliases.includes("removed-model"))).toBe(
        true,
      );

      const cmmChat = buildCmmChatRouteProjection(reconciled);
      expect(cmmChat.find((route) => route.providerModelId === "stable-model")?.routable).toBe(true);
      expect(cmmChat.find((route) => route.providerModelId === "added-model")?.routable).toBe(true);
      expect(cmmChat.find((route) => route.providerModelId === "removed-model")?.routable).toBe(false);

      failDiscovery = true;
      now += 31_000;
      const failedResponse = await server.inject({
        method: "GET",
        url: "/v1/cmm/catalog",
        headers: { authorization: "Bearer catalog-admin-secret" },
      });
      expect(failedResponse.statusCode).toBe(200);
      const failed = failedResponse.json() as RouterCatalogProjection;
      const deepseekConnection = failed.connections.find(
        (connection) => connection.providerId === "deepseek",
      )!;
      expect(deepseekConnection.status).not.toBe("ready");
      expect(
        failed.routes
          .filter((route) => route.providerId === "deepseek")
          .every((route) => route.routable === false),
      ).toBe(true);
      expect(failed.models.some((identity) => identity.aliases.includes("removed-model"))).toBe(true);
      expect(failed.models.some((identity) => identity.aliases.includes("added-model"))).toBe(true);
    } finally {
      await server.close();
      nowSpy.mockRestore();
    }
  });
});
