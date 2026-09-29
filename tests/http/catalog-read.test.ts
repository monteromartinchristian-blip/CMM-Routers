import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildServer, type ServerOptions } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import {
  buildRouterCatalogProjection,
  type RouterCatalogProjectionInput,
} from "../../src/catalog/projection.js";
import type {
  ProviderAdapter,
  DiscoveredModel,
  ProviderHealth,
  RouterRequest,
} from "../../src/core/provider.js";
import type { RouterEvent } from "../../src/core/events.js";
import type { ProviderId } from "../../src/core/model.js";
import { CONSUMER_CMMCHAT } from "../../src/core/consumer-capability.js";

const CMMCHAT_TOKEN = "catalog-test-cmmchat-token";
const QODER_TOKEN = "catalog-test-qoder-token";
/**
 * Fake-only sentinel, built from a fresh UUID: never a real credential, never
 * written to a tracked file, and asserted to never appear in a response body.
 */
const READ_ONLY_SENTINEL = `catalog-test-reader-token-${randomUUID()}`;

function authHeader(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

class FakeProvider implements ProviderAdapter {
  discoverCalls = 0;
  healthCalls = 0;
  runCalls = 0;

  constructor(
    readonly id: ProviderId,
    private readonly models: DiscoveredModel[],
    private readonly failDiscovery = false,
  ) {}

  async discoverModels(): Promise<DiscoveredModel[]> {
    this.discoverCalls += 1;
    if (this.failDiscovery) throw new Error("discovery is unavailable");
    return this.models;
  }

  async health(): Promise<ProviderHealth> {
    this.healthCalls += 1;
    return { status: "ready" };
  }

  async *run(request: RouterRequest, _signal: AbortSignal): AsyncIterable<RouterEvent> {
    this.runCalls += 1;
    void request;
    yield { type: "text_delta", text: "hi" };
    yield { type: "completed", finishReason: "stop" };
  }

  async cancel(): Promise<void> {}
}

const CHATGPT_MODELS: DiscoveredModel[] = [
  {
    id: "chatgpt/gpt-5",
    provider: "chatgpt",
    upstreamModel: "gpt-5",
    displayName: "GPT-5",
    capability: "CHAT_AND_TOOLS",
  },
  {
    id: "chatgpt/gpt-5-mini",
    provider: "chatgpt",
    upstreamModel: "gpt-5-mini",
    displayName: "GPT-5 Mini",
    capability: "CHAT_AND_TOOLS",
  },
];

/** The catalog shapes this projection is allowed to produce. */
interface ProjectionBody {
  providers: Array<{ providerId: string; displayName: string }>;
  accounts: unknown[];
  products: unknown[];
  connections: unknown[];
  models: Array<{
    modelIdentityId: string;
    canonicalName: string;
    family?: string;
    aliases: string[];
  }>;
  routes: unknown[];
}

async function serverWith(
  providers: ProviderAdapter[],
  usageReaderToken: string | undefined = READ_ONLY_SENTINEL,
): Promise<ReturnType<typeof buildServer>> {
  const registry = new ProviderRegistry();
  for (const provider of providers) {
    await registry.register(provider);
  }
  await registry.refresh();
  const options: ServerOptions = {
    host: "127.0.0.1",
    port: 0,
    bearerSecret: CMMCHAT_TOKEN,
    qoderToken: QODER_TOKEN,
    registry,
  };
  if (usageReaderToken !== undefined) options.usageReaderToken = usageReaderToken;
  const server = buildServer(options);
  await server.ready();
  return server;
}

async function readCatalog(
  server: ReturnType<typeof buildServer>,
  token: string,
): Promise<{ status: number; body: ProjectionBody }> {
  const response = await server.inject({
    method: "GET",
    url: "/v1/cmm/catalog",
    headers: authHeader(token),
  });
  return { status: response.statusCode, body: response.json() as ProjectionBody };
}

describe("GET /v1/cmm/catalog (ported read-only catalog projection)", () => {
  it("serves the read-only principal the projection this branch's data can produce", async () => {
    const server = await serverWith([new FakeProvider("chatgpt", CHATGPT_MODELS)]);
    const { status, body } = await readCatalog(server, READ_ONLY_SENTINEL);

    expect(status).toBe(200);
    // Exactly the six-array catalog contract CMM Usage parses.
    expect(Object.keys(body).sort()).toEqual([
      "accounts",
      "connections",
      "models",
      "products",
      "providers",
      "routes",
    ]);
    expect(body.providers).toEqual([{ providerId: "chatgpt", displayName: "chatgpt" }]);
    expect(body.models).toEqual([
      {
        modelIdentityId: "chatgpt/gpt-5",
        canonicalName: "GPT-5",
        aliases: ["chatgpt/gpt-5", "gpt-5"],
      },
      {
        modelIdentityId: "chatgpt/gpt-5-mini",
        canonicalName: "GPT-5 Mini",
        aliases: ["chatgpt/gpt-5-mini", "gpt-5-mini"],
      },
    ]);
  });

  it("leaves every section without a source of truth on this branch empty instead of inventing entries", async () => {
    const server = await serverWith([new FakeProvider("chatgpt", CHATGPT_MODELS)]);
    const { body } = await readCatalog(server, READ_ONLY_SENTINEL);

    // Accounts, products, connections and routes are produced by the
    // credential/manifest/reconciler graph and the administration surface that
    // were deliberately NOT ported. An empty array is the honest answer.
    expect(body.accounts).toEqual([]);
    expect(body.products).toEqual([]);
    expect(body.connections).toEqual([]);
    expect(body.routes).toEqual([]);
  });

  it("reports only registered providers, and a provider whose discovery failed contributes no models", async () => {
    const broken = new FakeProvider("claude", [], true);
    const server = await serverWith([new FakeProvider("chatgpt", CHATGPT_MODELS), broken]);
    const { body } = await readCatalog(server, READ_ONLY_SENTINEL);

    // Registration order, runtime truth: nothing from config, nothing guessed.
    expect(body.providers.map((provider) => provider.providerId)).toEqual(["chatgpt", "claude"]);
    // The failed provider is listed because it is registered, but no model is
    // attributed to it: discovery errored, so there is nothing to report.
    expect(body.models.map((model) => model.modelIdentityId)).toEqual([
      "chatgpt/gpt-5",
      "chatgpt/gpt-5-mini",
    ]);
  });

  it("agrees with GET /v1/models, which is the routing contract of this branch", async () => {
    const server = await serverWith([new FakeProvider("chatgpt", CHATGPT_MODELS)]);
    const { body } = await readCatalog(server, READ_ONLY_SENTINEL);
    const models = await server.inject({
      method: "GET",
      url: "/v1/models",
      headers: authHeader(CMMCHAT_TOKEN),
    });

    expect(body.models.map((model) => model.modelIdentityId).sort()).toEqual(
      (models.json().data as Array<{ id: string }>).map((entry) => entry.id).sort(),
    );
  });

  it("reads without performing provider work, so a polling monitor cannot spawn provider runtimes", async () => {
    const provider = new FakeProvider("chatgpt", CHATGPT_MODELS);
    const server = await serverWith([provider]);

    const discoveryAfterBoot = provider.discoverCalls;
    const healthAfterBoot = provider.healthCalls;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await readCatalog(server, READ_ONLY_SENTINEL)).status).toBe(200);
    }
    expect(provider.discoverCalls).toBe(discoveryAfterBoot);
    expect(provider.healthCalls).toBe(healthAfterBoot);
    expect(provider.runCalls).toBe(0);
  });

  it("answers an existing consumer exactly as an authenticated read, and refuses an unauthenticated one", async () => {
    const server = await serverWith([new FakeProvider("chatgpt", CHATGPT_MODELS)]);
    const asConsumer = await readCatalog(server, CMMCHAT_TOKEN);
    const asQoder = await readCatalog(server, QODER_TOKEN);
    const asReader = await readCatalog(server, READ_ONLY_SENTINEL);

    expect(asConsumer.status).toBe(200);
    expect(asQoder.status).toBe(200);
    expect(asConsumer.body).toEqual(asReader.body);

    const anonymous = await server.inject({ method: "GET", url: "/v1/cmm/catalog" });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().error.type).toBe("router_unauthorized");
  });

  it("mounts no catalog mutation surface: every administration identity has no route", async () => {
    const server = await serverWith([new FakeProvider("chatgpt", CHATGPT_MODELS)]);
    const mutations: Array<["POST" | "PUT" | "PATCH" | "DELETE", string]> = [
      ["POST", "/v1/cmm/catalog"],
      ["PUT", "/v1/cmm/catalog"],
      ["PATCH", "/v1/cmm/catalog"],
      ["DELETE", "/v1/cmm/catalog"],
      ["POST", "/v1/cmm/catalog/connections"],
      ["PATCH", "/v1/cmm/catalog/connections/c1"],
      ["DELETE", "/v1/cmm/catalog/connections/c1"],
      ["POST", "/v1/cmm/catalog/connections/c1/validate"],
      ["POST", "/v1/cmm/catalog/connections/c1/refresh"],
      ["POST", "/v1/cmm/catalog/custom-endpoints"],
      ["PATCH", "/v1/cmm/catalog/routes/r1/visibility"],
      ["POST", "/v1/cmm/routing/state"],
    ];
    for (const [method, url] of mutations) {
      const asConsumer = await server.inject({
        method,
        url,
        headers: authHeader(CMMCHAT_TOKEN),
        payload: {},
      });
      // 404: the route genuinely does not exist on this branch, so no consumer
      // can reach a mutation either.
      expect(`${method} ${url} -> ${asConsumer.statusCode}`).toBe(`${method} ${url} -> 404`);

      const asReader = await server.inject({
        method,
        url,
        headers: authHeader(READ_ONLY_SENTINEL),
        payload: {},
      });
      // The read-only boundary answers before the router would have to say
      // whether a route exists: authenticated, never authorized.
      expect(`${method} ${url} reader -> ${asReader.statusCode}`).toBe(
        `${method} ${url} reader -> 403`,
      );
      expect(asReader.json().error.type).toBe("router_forbidden");
    }
  });

  it("carries no credential material in the projection", async () => {
    const server = await serverWith([new FakeProvider("chatgpt", CHATGPT_MODELS)]);
    const response = await server.inject({
      method: "GET",
      url: "/v1/cmm/catalog",
      headers: authHeader(READ_ONLY_SENTINEL),
    });
    const serialized = JSON.stringify(response.json());
    for (const secret of [READ_ONLY_SENTINEL, CMMCHAT_TOKEN, QODER_TOKEN]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized.toLowerCase()).not.toMatch(/"(authorization|api_?key|secret|token)"/);
  });

  it("keeps the projection a pure snapshot of its input", () => {
    // The ported projection module has no I/O and no store of its own: the same
    // input always yields the same snapshot, and a mutated result never feeds
    // back into the source.
    const input: RouterCatalogProjectionInput = {
      directory: { list: () => [{
        providerId: "chatgpt",
        displayName: "chatgpt",
        adapterKind: "chatgpt",
        supportedConnectionKinds: [],
        discoveryCapabilities: [],
      }] },
      accounts: [],
      products: [],
      connections: { list: () => [] },
      modelIdentities: {
        list: () => [
          { modelIdentityId: "chatgpt/gpt-5", canonicalName: "GPT-5", aliases: ["gpt-5"] },
        ],
      },
      routeCatalog: { list: () => [] },
    };
    const first = buildRouterCatalogProjection(input);
    const second = buildRouterCatalogProjection(input);
    expect(second).toEqual(first);
    (first.models[0]!.aliases as string[]).push("mutated");
    expect(buildRouterCatalogProjection(input).models[0]!.aliases).toEqual(["gpt-5"]);
  });

  it("does not alter any pre-existing route of this branch", async () => {
    const provider = new FakeProvider("chatgpt", CHATGPT_MODELS);
    const server = await serverWith([provider]);
    for (const url of ["/health", "/ready", "/v1/models", "/v1/cmm/providers", "/v1/cmm/health"]) {
      const anonymous = await server.inject({ method: "GET", url });
      // /health and /ready stay open on loopback; the /v1 reads stay 401.
      expect(`${url} -> ${anonymous.statusCode}`).toBe(
        `${url} -> ${url === "/health" || url === "/ready" ? 200 : 401}`,
      );
    }
    const chat = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(CONSUMER_CMMCHAT === "cmmchat" ? CMMCHAT_TOKEN : QODER_TOKEN),
      payload: { model: "chatgpt/gpt-5", messages: [{ role: "user", content: "hi" }] },
    });
    expect(chat.statusCode).toBe(200);
    expect(provider.runCalls).toBe(1);
  });
});
