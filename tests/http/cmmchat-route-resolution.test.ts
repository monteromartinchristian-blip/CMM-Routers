import { describe, expect, it, vi } from "vitest";
import type { CatalogRuntimeBridge } from "../../src/catalog/runtime-bridge.js";
import type { AccessRoute, ProviderConnection } from "../../src/catalog/types.js";
import type {
  DiscoveredModel,
  ProviderAdapter,
  ProviderHealth,
  RouterRequest,
} from "../../src/core/provider.js";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";

const CMMCHAT_TOKEN = "cmmchat-route-token";

class RecordingAdapter implements ProviderAdapter {
  readonly requests: RouterRequest[] = [];

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

  async cancel(): Promise<void> {}
}

function route(
  routeId: string,
  providerId: "openrouter" | "deepseek" = "deepseek",
  providerModelId = "deepseek-exact-provider-model",
  visible = true,
  tools = true,
): AccessRoute {
  return {
    routeId,
    modelIdentityId: "model_test_identity",
    connectionId: `${providerId}-connection-main`,
    providerId,
    providerModelId,
    executionProfile: "default",
    capabilities: { chat: true, tools, streaming: true },
    billingClass: "subscription",
    routable: true,
    visibility: {
      visibleOn: visible ? ["cmmchat_model_picker"] : ["admin_console"],
    },
  };
}

function connection(accessRoute: AccessRoute): ProviderConnection {
  return {
    connectionId: accessRoute.connectionId,
    providerId: accessRoute.providerId,
    connectionKind: "openai-chat-completions",
    executionCredentialBindingId: "execution-test",
    status: "ready",
  };
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
    "route_deepseek_exact_connection_model_default",
    "deepseek",
    "deepseek/provider-native-exact@2026-09-15",
  );
  const hidden = route(
    "route_deepseek_hidden_connection_model_default",
    "deepseek",
    "deepseek/hidden-model",
    false,
  );

  const resolve = vi.fn(async (routeId: string, surface: string) => {
    if (surface !== "cmmchat_model_picker") {
      throw new Error("wrong consumer surface");
    }
    if (routeId === hidden.routeId) {
      throw new Error("Route is not visible on consumer surface: cmmchat_model_picker");
    }
    if (routeId !== exact.routeId) {
      throw new Error(`Unknown route: ${routeId}`);
    }
    return {
      route: exact,
      connection: connection(exact),
      adapter: deepseek,
      providerModelId: exact.providerModelId,
    };
  });

  const runtimeBridge = { resolve } as unknown as CatalogRuntimeBridge;
  const server = buildServer({
    host: "127.0.0.1",
    port: 0,
    bearerSecret: CMMCHAT_TOKEN,
    registry,
    runtimeBridge,
  });

  return { server, registry, openrouter, deepseek, exact, hidden, resolve };
}

function auth() {
  return { authorization: `Bearer ${CMMCHAT_TOKEN}` };
}

describe("CMMChat explicit route resolution", () => {
  it("chat completions execute the exact adapter and provider-native model selected by the route", async () => {
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
  });

  it("responses execute the same exact catalog route without legacy model resolution", async () => {
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
  });

  it("rejects a hidden CMMChat route even when its id is supplied manually", async () => {
    const state = await setup();

    const response = await state.server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: {
        model: `route:${state.hidden.routeId}`,
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("unknown_model");
    expect(state.deepseek.requests).toHaveLength(0);
  });

  it("keeps CMMChat CHAT_ONLY even when the selected route advertises tools", async () => {
    const state = await setup();

    const response = await state.server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: {
        model: `route:${state.exact.routeId}`,
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            type: "function",
            function: { name: "dangerous_escalation", parameters: {} },
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("unsupported_capability");
    expect(state.deepseek.requests).toHaveLength(0);
  });

  it("fails closed for an unknown route with zero legacy/provider fallback", async () => {
    const state = await setup();
    const legacyResolve = vi.spyOn(state.registry, "resolve");

    const response = await state.server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: {
        model: "route:route_missing_exact_route",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("unknown_model");
    expect(legacyResolve).not.toHaveBeenCalled();
    expect(state.openrouter.requests).toHaveLength(0);
    expect(state.deepseek.requests).toHaveLength(0);
  });

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
