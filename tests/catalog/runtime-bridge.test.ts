import { describe, expect, it, vi } from "vitest";
import { CredentialBindingStore } from "../../src/catalog/credential-bindings.js";
import { buildModelIdentityId, buildRouteId } from "../../src/catalog/ids.js";
import { ModelIdentityStore } from "../../src/catalog/model-identities.js";
import { ProviderConnectionService } from "../../src/catalog/provider-connections.js";
import { ProviderDirectory } from "../../src/catalog/provider-directory.js";
import { RouteCatalog } from "../../src/catalog/route-catalog.js";
import type {
  AccessRoute,
  ModelIdentity,
  ProviderConnection,
  ProviderDefinition,
  RouteSurface,
} from "../../src/catalog/types.js";
import type {
  DiscoveredModel,
  ProviderAdapter,
  ProviderHealth,
  RouterRequest,
} from "../../src/core/provider.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { CatalogRuntimeBridge } from "../../src/catalog/runtime-bridge.js";
import { InMemorySecureCredentialResolver } from "../support/in-memory-secure-credential-resolver.js";

const SECRET_REF = "keychain://runtime-bridge/main";
const SURFACE: RouteSurface = "cmmchat_model_picker";

class TrackingAdapter implements ProviderAdapter {
  public readonly runCalls: string[] = [];

  constructor(public readonly id: "openrouter" | "deepseek") {}

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [];
  }

  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }

  async *run(request: { requestId: string }, _signal: AbortSignal) {
    this.runCalls.push(request.requestId);
    yield { type: "completed" as const, finishReason: "stop" as const };
  }

  async cancel(): Promise<void> {}
}

function providerDefinition(providerId: "openrouter" | "deepseek"): ProviderDefinition {
  return {
    providerId,
    displayName: providerId === "openrouter" ? "OpenRouter" : "DeepSeek",
    adapterKind: "openai-compatible",
    supportedConnectionKinds: ["openai-chat-completions"],
    discoveryCapabilities: ["models"],
  };
}

function connection(
  connectionId: string,
  providerId: "openrouter" | "deepseek" = "openrouter",
  executionCredentialBindingId?: string,
): ProviderConnection {
  const result: ProviderConnection = {
    connectionId,
    providerId,
    accountId: "account-main",
    productId: "product-main",
    connectionKind: "openai-chat-completions",
    status: "configured",
  };
  if (executionCredentialBindingId !== undefined) {
    result.executionCredentialBindingId = executionCredentialBindingId;
  }
  return result;
}

function identity(canonicalName = "Claude Sonnet Display Name"): ModelIdentity {
  return {
    modelIdentityId: buildModelIdentityId({ canonicalName }),
    canonicalName,
    aliases: [canonicalName.toLowerCase()],
  };
}

function route(
  modelIdentityId: string,
  overrides: Partial<Omit<AccessRoute, "routeId" | "modelIdentityId">> = {},
): AccessRoute {
  const fields = {
    connectionId: "connection-main",
    providerId: "openrouter" as const,
    providerModelId: "Vendor/Claude-Sonnet@2026-09-15",
    executionProfile: "chat",
    capabilities: { chat: true, tools: false, streaming: true },
    billingClass: "subscription",
    routable: true,
    visibility: { visibleOn: [SURFACE] },
    ...overrides,
  };
  return {
    routeId: buildRouteId({
      providerId: fields.providerId,
      connectionId: fields.connectionId,
      providerModelId: fields.providerModelId,
      executionProfile: fields.executionProfile,
    }),
    modelIdentityId,
    ...fields,
  };
}

function setup() {
  const directory = new ProviderDirectory();
  directory.register(providerDefinition("openrouter"));
  directory.register(providerDefinition("deepseek"));

  const bindings = new CredentialBindingStore();
  const credentialResolver = new InMemorySecureCredentialResolver(
    new Map([[SECRET_REF, "runtime-bridge-test-secret"]]),
  );
  const resolveSecret = vi.spyOn(credentialResolver, "resolve");
  const connections = new ProviderConnectionService({
    directory,
    credentialBindings: bindings,
    credentialResolver,
    administrativeDiscovery: new Map(),
  });
  const modelIdentities = new ModelIdentityStore();
  const catalog = new RouteCatalog({ connections, modelIdentities });
  const registry = new ProviderRegistry();
  const openrouter = new TrackingAdapter("openrouter");
  const deepseek = new TrackingAdapter("deepseek");

  return {
    bindings,
    catalog,
    connections,
    deepseek,
    modelIdentities,
    openrouter,
    registry,
    resolveSecret,
  };
}

function addExecutionReadyConnection(
  bindings: CredentialBindingStore,
  connections: ProviderConnectionService,
  connectionId = "connection-main",
  providerId: "openrouter" | "deepseek" = "openrouter",
): void {
  const bindingId = `execution-${connectionId}`;
  bindings.addExecution({
    bindingId,
    providerId,
    accountId: "account-main",
    productId: "product-main",
    secretRef: SECRET_REF,
    purpose: "execution",
    enabled: true,
  });
  connections.add(connection(connectionId, providerId, bindingId));
}

function addRoute(
  modelIdentities: ModelIdentityStore,
  catalog: RouteCatalog,
  accessRoute: AccessRoute,
  modelIdentity: ModelIdentity,
): void {
  modelIdentities.upsertExplicit(modelIdentity);
  modelIdentities.bindProviderModel({
    providerId: accessRoute.providerId,
    connectionId: accessRoute.connectionId,
    providerModelId: accessRoute.providerModelId,
    modelIdentityId: modelIdentity.modelIdentityId,
  });
  catalog.upsert(accessRoute);
}

async function bridgeFor(state: ReturnType<typeof setup>): Promise<CatalogRuntimeBridge> {
  await state.registry.register(state.openrouter);
  await state.registry.register(state.deepseek);
  return new CatalogRuntimeBridge({
    catalog: state.catalog,
    connections: state.connections,
    registry: state.registry,
  });
}

describe("CatalogRuntimeBridge", () => {
  it("resolves the exact catalog provider, connection and provider-native model without materializing the secret", async () => {
    const state = setup();
    const model = identity();
    const accessRoute = route(model.modelIdentityId);
    addExecutionReadyConnection(state.bindings, state.connections);
    addRoute(state.modelIdentities, state.catalog, accessRoute, model);
    const bridge = await bridgeFor(state);

    const resolved = await bridge.resolve(accessRoute.routeId, SURFACE);

    expect(resolved).toMatchObject({
      route: accessRoute,
      connection: {
        connectionId: "connection-main",
        providerId: "openrouter",
        status: "configured",
      },
      providerModelId: "Vendor/Claude-Sonnet@2026-09-15",
    });
    expect(resolved.adapter.id).toBe("openrouter");
    expect(resolved.adapter).not.toBe(state.openrouter);
    expect(state.resolveSecret).not.toHaveBeenCalled();
    expect(JSON.stringify(resolved)).not.toContain("runtime-bridge-test-secret");
  });

  it("fails closed without ordinary run when the selected adapter cannot consume resolved execution binding", async () => {
    const state = setup();
    const model = identity();
    const accessRoute = route(model.modelIdentityId);
    addExecutionReadyConnection(state.bindings, state.connections);
    addRoute(state.modelIdentities, state.catalog, accessRoute, model);
    const bridge = await bridgeFor(state);
    const resolved = await bridge.resolve(accessRoute.routeId, SURFACE);

    const request: RouterRequest = {
      requestId: "route-unsupported-binding-fail-closed",
      model: {
        id: `route:${accessRoute.routeId}`,
        provider: "openrouter",
        upstreamModel: accessRoute.providerModelId,
        displayName: accessRoute.providerModelId,
        capability: "CHAT_ONLY",
      },
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      stream: false,
    };
    const events = [];
    for await (const event of resolved.adapter.run(request, new AbortController().signal)) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      error: { code: "unknown_model" },
    });
    expect(state.openrouter.runCalls).toEqual([]);
    expect(state.resolveSecret).not.toHaveBeenCalled();
  });

  it("uses the route provider even when canonical and native names suggest another provider", async () => {
    const state = setup();
    const model = identity("Claude Sonnet");
    const accessRoute = route(model.modelIdentityId, {
      providerModelId: "deepseek/claude-sonnet-compatible",
    });
    addExecutionReadyConnection(state.bindings, state.connections);
    addRoute(state.modelIdentities, state.catalog, accessRoute, model);
    const bridge = await bridgeFor(state);

    const resolved = await bridge.resolve(accessRoute.routeId, SURFACE);

    expect(resolved.adapter.id).toBe("openrouter");
    expect(resolved.adapter).not.toBe(state.openrouter);
    expect(resolved.connection.providerId).toBe("openrouter");
    expect(resolved.providerModelId).toBe("deepseek/claude-sonnet-compatible");
    expect(state.deepseek.runCalls).toEqual([]);
  });

  it("fails before exact adapter lookup for a hidden route", async () => {
    const state = setup();
    const model = identity();
    const accessRoute = route(model.modelIdentityId, {
      visibility: { visibleOn: ["admin_console"] },
    });
    addExecutionReadyConnection(state.bindings, state.connections);
    addRoute(state.modelIdentities, state.catalog, accessRoute, model);
    const bridge = await bridgeFor(state);
    const getAdapter = vi.spyOn(state.registry, "getAdapter");

    await expect(bridge.resolve(accessRoute.routeId, SURFACE)).rejects.toThrow(/visible|hidden/i);

    expect(getAdapter).not.toHaveBeenCalled();
    expect(state.openrouter.runCalls).toEqual([]);
  });

  it("fails before exact adapter lookup for a non-routable route", async () => {
    const state = setup();
    const model = identity();
    const accessRoute = route(model.modelIdentityId, { routable: false });
    addExecutionReadyConnection(state.bindings, state.connections);
    addRoute(state.modelIdentities, state.catalog, accessRoute, model);
    const bridge = await bridgeFor(state);
    const getAdapter = vi.spyOn(state.registry, "getAdapter");

    await expect(bridge.resolve(accessRoute.routeId, SURFACE)).rejects.toThrow(/routable/i);

    expect(getAdapter).not.toHaveBeenCalled();
    expect(state.openrouter.runCalls).toEqual([]);
  });

  it("fails before exact adapter lookup when execution authorization is missing", async () => {
    const state = setup();
    const model = identity();
    const accessRoute = route(model.modelIdentityId);
    state.connections.add(connection("connection-main"));
    addRoute(state.modelIdentities, state.catalog, accessRoute, model);
    const bridge = await bridgeFor(state);
    const getAdapter = vi.spyOn(state.registry, "getAdapter");

    await expect(bridge.resolve(accessRoute.routeId, SURFACE)).rejects.toThrow(
      /execution credential|auth_required|ready/i,
    );

    expect(getAdapter).not.toHaveBeenCalled();
    expect(state.openrouter.runCalls).toEqual([]);
  });

  it("does not fall back to another route or provider when the selected route is unavailable", async () => {
    const state = setup();
    const model = identity();
    const unavailable = route(model.modelIdentityId, {
      connectionId: "connection-unavailable",
      routable: false,
    });
    const ready = route(model.modelIdentityId, {
      connectionId: "connection-ready",
    });
    addExecutionReadyConnection(state.bindings, state.connections, "connection-ready");
    addRoute(state.modelIdentities, state.catalog, unavailable, model);
    addRoute(state.modelIdentities, state.catalog, ready, model);
    const bridge = await bridgeFor(state);
    const getAdapter = vi.spyOn(state.registry, "getAdapter");

    await expect(bridge.resolve(unavailable.routeId, SURFACE)).rejects.toThrow(/routable/i);

    expect(getAdapter).not.toHaveBeenCalled();
    expect(state.openrouter.runCalls).toEqual([]);
    await expect(bridge.resolve(ready.routeId, SURFACE)).resolves.toMatchObject({
      route: ready,
      adapter: { id: "openrouter" },
      providerModelId: ready.providerModelId,
    });
  });
});
