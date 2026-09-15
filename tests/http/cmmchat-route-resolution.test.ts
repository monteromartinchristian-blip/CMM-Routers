import { describe, expect, it, vi } from "vitest";
import { CredentialBindingStore } from "../../src/catalog/credential-bindings.js";
import { buildModelIdentityId, buildRouteId } from "../../src/catalog/ids.js";
import { ModelIdentityStore } from "../../src/catalog/model-identities.js";
import { ProviderConnectionService } from "../../src/catalog/provider-connections.js";
import { ProviderDirectory } from "../../src/catalog/provider-directory.js";
import { RouteCatalog } from "../../src/catalog/route-catalog.js";
import { CatalogRuntimeBridge } from "../../src/catalog/runtime-bridge.js";
import type { AccessRoute, ProviderConnection } from "../../src/catalog/types.js";
import type {
  DiscoveredModel,
  ProviderAdapter,
  ProviderHealth,
  RouterRequest,
} from "../../src/core/provider.js";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { recordingFetch, waveAdapter } from "../helpers/wave-fixtures.js";
import { InMemorySecureCredentialResolver } from "../support/in-memory-secure-credential-resolver.js";

const CMMCHAT_TOKEN = "cmmchat-route-token";
const QODER_TOKEN = "qoder-route-token";
const MODEL_IDENTITY_ID = buildModelIdentityId({ canonicalName: "CMMChat route test model" });

type RouterRequestHasExecutionContext = "executionContext" extends keyof RouterRequest
  ? true
  : false;
const ROUTER_REQUEST_HAS_EXECUTION_CONTEXT: RouterRequestHasExecutionContext = false;

interface ExecutionRecord {
  connectionId: string;
  credential: string;
  endpointRef?: string;
  profileRef?: string;
  executionProfile: string;
}

class RecordingAdapter implements ProviderAdapter {
  readonly executionCapabilities = { exactResolvedRoute: true } as const;
  readonly requests: RouterRequest[] = [];
  readonly executions: ExecutionRecord[] = [];

  constructor(
    readonly id: "openrouter" | "deepseek",
    private readonly models: DiscoveredModel[],
    private readonly replyText: string,
  ) {}

  async discoverModels(): Promise<DiscoveredModel[]> {
    return this.models.map((model) => ({ ...model }));
  }

  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }

  async *run(request: RouterRequest): AsyncIterable<any> {
    this.requests.push(request);
    yield { type: "text_delta", text: this.replyText };
    yield { type: "completed", finishReason: "stop" };
  }

  async *runWithResolvedExecution(
    request: RouterRequest,
    _signal: AbortSignal,
    connection: Readonly<ProviderConnection>,
    executionProfile: string,
    credential: Readonly<{ value: string }>,
  ): AsyncIterable<any> {
    this.requests.push(request);
    this.executions.push({
      connectionId: connection.connectionId,
      credential: credential.value,
      ...(connection.endpointRef !== undefined ? { endpointRef: connection.endpointRef } : {}),
      ...(connection.profileRef !== undefined ? { profileRef: connection.profileRef } : {}),
      executionProfile,
    });
    yield {
      type: "text_delta",
      text: [
        connection.connectionId,
        credential.value,
        connection.endpointRef,
        connection.profileRef,
        executionProfile,
      ].join("|"),
    };
    yield { type: "completed", finishReason: "stop" };
  }

  async cancel(): Promise<void> {}
}

function route(
  providerId: "openrouter" | "deepseek" = "deepseek",
  providerModelId = "deepseek-exact-provider-model",
  visible = true,
  tools = true,
  connectionId = `${providerId}-connection-main`,
  executionProfile = "default",
): AccessRoute {
  return {
    routeId: buildRouteId({
      providerId,
      connectionId,
      providerModelId,
      executionProfile,
    }),
    modelIdentityId: MODEL_IDENTITY_ID,
    connectionId,
    providerId,
    providerModelId,
    executionProfile,
    capabilities: { chat: true, tools, streaming: true },
    billingClass: "subscription",
    routable: true,
    visibility: {
      visibleOn: visible ? ["cmmchat_model_picker"] : ["admin_console"],
    },
  };
}

function connection(
  accessRoute: AccessRoute,
  endpointRef: string,
  profileRef: string,
): ProviderConnection {
  return {
    connectionId: accessRoute.connectionId,
    providerId: accessRoute.providerId,
    connectionKind: "openai-chat-completions",
    executionCredentialBindingId: `execution-${accessRoute.connectionId}`,
    endpointRef,
    profileRef,
    status: "configured",
  };
}

function providerDefinition(providerId: "openrouter" | "deepseek") {
  return {
    providerId,
    displayName: providerId,
    adapterKind: "openai-compatible",
    supportedConnectionKinds: ["openai-chat-completions"],
    discoveryCapabilities: ["models"],
  };
}

function addCatalogRoute(
  modelIdentities: ModelIdentityStore,
  catalog: RouteCatalog,
  accessRoute: AccessRoute,
): void {
  modelIdentities.bindProviderModel({
    providerId: accessRoute.providerId,
    connectionId: accessRoute.connectionId,
    providerModelId: accessRoute.providerModelId,
    modelIdentityId: accessRoute.modelIdentityId,
  });
  catalog.upsert(accessRoute);
}

async function setup() {
  const legacyModel: DiscoveredModel = {
    id: "openrouter/legacy-model",
    provider: "openrouter",
    upstreamModel: "legacy-provider-model",
    displayName: "Legacy Model",
    capability: "CHAT_ONLY",
  };
  const openrouter = new RecordingAdapter("openrouter", [legacyModel], "legacy-ok");
  const deepseek = new RecordingAdapter("deepseek", [], "route-ok");
  const registry = new ProviderRegistry();
  await registry.register(openrouter);
  await registry.register(deepseek);
  await registry.refresh();

  const exact = route(
    "deepseek",
    "deepseek/provider-native-exact@2026-09-15",
    true,
    true,
    "deepseek-connection-secondary",
    "batch-priority",
  );
  const primary = route(
    "deepseek",
    "deepseek/provider-native-primary@2026-09-15",
    true,
    true,
    "deepseek-connection-primary",
  );
  const hidden = route(
    "deepseek",
    "deepseek/hidden-model",
    false,
    true,
    "deepseek-connection-primary",
  );

  const directory = new ProviderDirectory();
  directory.register(providerDefinition("openrouter"));
  directory.register(providerDefinition("deepseek"));
  const bindings = new CredentialBindingStore();
  const secondarySecretRef = "keychain://deepseek/secondary";
  const primarySecretRef = "keychain://deepseek/primary";
  bindings.addExecution({
    bindingId: "execution-deepseek-connection-secondary",
    providerId: "deepseek",
    secretRef: secondarySecretRef,
    purpose: "execution",
    enabled: true,
  });
  bindings.addExecution({
    bindingId: "execution-deepseek-connection-primary",
    providerId: "deepseek",
    secretRef: primarySecretRef,
    purpose: "execution",
    enabled: true,
  });
  const connections = new ProviderConnectionService({
    directory,
    credentialBindings: bindings,
    credentialResolver: new InMemorySecureCredentialResolver(
      new Map([
        [secondarySecretRef, "secondary-secret"],
        [primarySecretRef, "primary-secret"],
      ]),
    ),
    administrativeDiscovery: new Map(),
  });
  connections.add(
    connection(exact, "https://secondary.deepseek.example/v1", "profile-secondary"),
  );
  connections.add(
    connection(primary, "https://primary.deepseek.example/v1", "profile-primary"),
  );
  const modelIdentities = new ModelIdentityStore();
  modelIdentities.upsertExplicit({
    modelIdentityId: MODEL_IDENTITY_ID,
    canonicalName: "CMMChat route test model",
    aliases: ["cmmchat-route-test"],
  });
  const catalog = new RouteCatalog({ connections, modelIdentities });
  addCatalogRoute(modelIdentities, catalog, exact);
  addCatalogRoute(modelIdentities, catalog, primary);
  addCatalogRoute(modelIdentities, catalog, hidden);
  const runtimeBridge = new CatalogRuntimeBridge({ catalog, connections, registry });
  const resolve = vi.spyOn(runtimeBridge, "resolve");
  const server = buildServer({
    host: "127.0.0.1",
    port: 0,
    bearerSecret: CMMCHAT_TOKEN,
    qoderToken: QODER_TOKEN,
    registry,
    runtimeBridge,
  });

  return {
    server,
    registry,
    openrouter,
    deepseek,
    exact,
    primary,
    hidden,
    resolve,
  };
}

function auth() {
  return { authorization: `Bearer ${CMMCHAT_TOKEN}` };
}

function qoderAuth() {
  return { authorization: `Bearer ${QODER_TOKEN}` };
}

function responseText(url: "/v1/chat/completions" | "/v1/responses", body: any): string {
  if (url === "/v1/chat/completions") return body.choices[0].message.content;
  return body.output[0].content[0].text;
}

function requestPayload(
  url: "/v1/chat/completions" | "/v1/responses",
  model: string,
  tools?: unknown[],
): Record<string, unknown> {
  return url === "/v1/chat/completions"
    ? { model, messages: [{ role: "user", content: "hello" }], ...(tools ? { tools } : {}) }
    : { model, input: "hello", ...(tools ? { tools } : {}) };
}

describe("CMMChat explicit route resolution", () => {
  it("keeps route credentials out of the canonical RouterRequest", async () => {
    expect(ROUTER_REQUEST_HAS_EXECUTION_CONTEXT).toBe(false);
    const state = await setup();

    const response = await state.server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: requestPayload("/v1/chat/completions", `route:${state.exact.routeId}`),
    });

    expect(response.statusCode).toBe(200);
    expect(state.deepseek.requests).toHaveLength(1);
    expect(state.deepseek.requests[0]).not.toHaveProperty("executionContext");
    expect(JSON.stringify(state.deepseek.requests[0])).not.toContain("secondary-secret");
  });

  it("chat completions bind the selected same-provider connection, credential, endpoint, and non-default profile", async () => {
    const state = await setup();
    const legacyResolve = vi.spyOn(state.registry, "resolve");

    const response = await state.server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: {
        model: `route:${state.exact.routeId}`,
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(state.resolve).toHaveBeenCalledWith(state.exact.routeId, "cmmchat_model_picker");
    expect(legacyResolve).not.toHaveBeenCalled();
    expect(state.openrouter.requests).toHaveLength(0);
    expect(state.deepseek.requests).toHaveLength(1);
    expect(state.deepseek.requests[0]!.model).toMatchObject({
      provider: "deepseek",
      upstreamModel: "deepseek/provider-native-exact@2026-09-15",
      capability: "CHAT_AND_TOOLS",
    });
    expect(responseText("/v1/chat/completions", response.json())).toBe(
      "deepseek-connection-secondary|secondary-secret|https://secondary.deepseek.example/v1|profile-secondary|batch-priority",
    );
  });

  it("responses bind the selected same-provider connection, credential, endpoint, and non-default profile", async () => {
    const state = await setup();
    const legacyResolve = vi.spyOn(state.registry, "resolve");

    const response = await state.server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: auth(),
      payload: {
        model: `route:${state.exact.routeId}`,
        input: "hello",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(state.resolve).toHaveBeenCalledWith(state.exact.routeId, "cmmchat_model_picker");
    expect(legacyResolve).not.toHaveBeenCalled();
    expect(state.deepseek.requests[0]!.model.upstreamModel).toBe(
      "deepseek/provider-native-exact@2026-09-15",
    );
    expect(responseText("/v1/responses", response.json())).toBe(
      "deepseek-connection-secondary|secondary-secret|https://secondary.deepseek.example/v1|profile-secondary|batch-priority",
    );
  });

  it("makes the real OpenAI-compatible adapter use the route endpoint and bearer credential for both HTTP surfaces", async () => {
    const encoder = new TextEncoder();
    const transport = recordingFetch((request) => {
      if (request.method === "GET") {
        return {
          status: 200,
          text: async () => JSON.stringify({ data: [{ id: "deepseek-chat" }] }),
        };
      }
      return {
        status: 200,
        text: async () => "",
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: "bound" }, finish_reason: "stop" }] })}\n\n`,
              ),
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
      };
    });
    const deepseek = waveAdapter("deepseek", {
      fetchFn: transport.fetchFn,
      secret: "constructor-default-secret",
    });
    const registry = new ProviderRegistry();
    await registry.register(deepseek);
    const selected = route(
      "deepseek",
      "deepseek-chat",
      true,
      true,
      "deepseek-connection-secondary",
      "batch-priority",
    );
    const selectedConnection = connection(
      selected,
      "https://secondary.deepseek.com/v1",
      "profile-secondary",
    );
    const directory = new ProviderDirectory();
    directory.register(providerDefinition("deepseek"));
    const bindings = new CredentialBindingStore();
    const secretRef = "keychain://deepseek/route-secondary";
    bindings.addExecution({
      bindingId: selectedConnection.executionCredentialBindingId!,
      providerId: "deepseek",
      secretRef,
      purpose: "execution",
      enabled: true,
    });
    const connections = new ProviderConnectionService({
      directory,
      credentialBindings: bindings,
      credentialResolver: new InMemorySecureCredentialResolver(
        new Map([[secretRef, "route-secondary-secret"]]),
      ),
      administrativeDiscovery: new Map(),
    });
    connections.add(selectedConnection);
    const modelIdentities = new ModelIdentityStore();
    modelIdentities.upsertExplicit({
      modelIdentityId: MODEL_IDENTITY_ID,
      canonicalName: "CMMChat route test model",
      aliases: ["cmmchat-route-test"],
    });
    const catalog = new RouteCatalog({ connections, modelIdentities });
    addCatalogRoute(modelIdentities, catalog, selected);
    const runtimeBridge = new CatalogRuntimeBridge({ catalog, connections, registry });
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: CMMCHAT_TOKEN,
      registry,
      runtimeBridge,
    });

    for (const url of ["/v1/chat/completions", "/v1/responses"] as const) {
      const response = await server.inject({
        method: "POST",
        url,
        headers: auth(),
        payload: requestPayload(url, `route:${selected.routeId}`),
      });
      expect(response.statusCode).toBe(200);
    }

    const generations = transport.requests.filter((request) => request.method === "POST");
    expect(generations).toHaveLength(2);
    for (const generation of generations) {
      expect(generation.url).toBe("https://secondary.deepseek.com/v1/chat/completions");
      expect(generation.headers.Authorization).toBe("Bearer route-secondary-secret");
    }
  });

  for (const url of ["/v1/chat/completions", "/v1/responses"] as const) {
    it(`${url} rejects hidden, unknown, tool-bearing CMMChat, and Qoder route selectors`, async () => {
      const cases = [
        {
          headers: auth(),
          model: (state: Awaited<ReturnType<typeof setup>>) => `route:${state.hidden.routeId}`,
          expected: "unknown_model",
        },
        {
          headers: auth(),
          model: () => "route:route_missing_exact_route",
          expected: "unknown_model",
        },
        {
          headers: auth(),
          model: (state: Awaited<ReturnType<typeof setup>>) => `route:${state.exact.routeId}`,
          tools: [{ type: "function", function: { name: "dangerous_escalation", parameters: {} } }],
          expected: "unsupported_capability",
        },
        {
          headers: qoderAuth(),
          model: (state: Awaited<ReturnType<typeof setup>>) => `route:${state.exact.routeId}`,
          expected: "unknown_model",
        },
      ];

      for (const testCase of cases) {
        const state = await setup();
        const legacyResolve = vi.spyOn(state.registry, "resolve");
        const response = await state.server.inject({
          method: "POST",
          url,
          headers: testCase.headers,
          payload: requestPayload(url, testCase.model(state), testCase.tools),
        });

        expect(response.statusCode).toBe(400);
        expect(response.json().error.type).toBe(testCase.expected);
        expect(legacyResolve).not.toHaveBeenCalled();
        expect(state.openrouter.requests).toHaveLength(0);
        expect(state.deepseek.requests).toHaveLength(0);
      }
    });
  }

  it("preserves the legacy model namespace unchanged for non-route requests", async () => {
    const state = await setup();

    const chat = await state.server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: {
        model: "openrouter/legacy-model",
        messages: [{ role: "user", content: "hello" }],
      },
    });
    const responses = await state.server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: auth(),
      payload: { model: "openrouter/legacy-model", input: "hello" },
    });

    expect(chat.statusCode).toBe(200);
    expect(responses.statusCode).toBe(200);
    expect(state.resolve).not.toHaveBeenCalled();
    expect(state.openrouter.requests).toHaveLength(2);
  });
});
