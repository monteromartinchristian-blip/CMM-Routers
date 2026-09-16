import { describe, expect, it } from "vitest";
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
} from "../../src/catalog/types.js";
import { InMemorySecureCredentialResolver } from "../support/in-memory-secure-credential-resolver.js";

const SECRET_REF = "keychain://route-catalog/main";

function providerDefinition(): ProviderDefinition {
  return {
    providerId: "test-provider",
    displayName: "Test Provider",
    adapterKind: "openai-compatible",
    supportedConnectionKinds: ["openai-chat-completions"],
    discoveryCapabilities: ["models"],
  };
}

function connection(
  connectionId: string,
  bindingId: string | undefined,
): ProviderConnection {
  const result: ProviderConnection = {
    connectionId,
    providerId: "test-provider",
    accountId: "account-main",
    productId: "product-main",
    connectionKind: "openai-chat-completions",
    status: "configured",
  };
  if (bindingId !== undefined) result.executionCredentialBindingId = bindingId;
  return result;
}

function explicitIdentity(canonicalName = "Shared Model"): ModelIdentity {
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
  const routeFields = {
    connectionId: "connection-main",
    providerId: "test-provider",
    providerModelId: "provider/model-a",
    executionProfile: "chat",
    capabilities: {
      chat: true,
      tools: false,
      streaming: true,
    },
    billingClass: "subscription",
    routable: true,
    visibility: {
      visibleOn: ["cmmchat_model_picker" as const],
    },
    ...overrides,
  };
  return {
    routeId: buildRouteId({
      providerId: routeFields.providerId,
      connectionId: routeFields.connectionId,
      providerModelId: routeFields.providerModelId,
      executionProfile: routeFields.executionProfile,
    }),
    modelIdentityId,
    ...routeFields,
  };
}

function setup() {
  const directory = new ProviderDirectory();
  directory.register(providerDefinition());
  const bindings = new CredentialBindingStore();
  const resolver = new InMemorySecureCredentialResolver(
    new Map([[SECRET_REF, "route-catalog-test-secret"]]),
  );
  const connections = new ProviderConnectionService({
    directory,
    credentialBindings: bindings,
    credentialResolver: resolver,
    administrativeDiscovery: new Map(),
  });
  const modelIdentities = new ModelIdentityStore();
  const catalog = new RouteCatalog({ connections, modelIdentities });
  return { bindings, catalog, connections, modelIdentities };
}

function addReadyCapableConnection(
  bindings: CredentialBindingStore,
  connections: ProviderConnectionService,
  connectionId = "connection-main",
): void {
  const bindingId = `execution-${connectionId}`;
  bindings.addExecution({
    bindingId,
    providerId: "test-provider",
    accountId: "account-main",
    productId: "product-main",
    secretRef: SECRET_REF,
    purpose: "execution",
    enabled: true,
  });
  connections.add(connection(connectionId, bindingId));
}

function bindRouteIdentity(
  modelIdentities: ModelIdentityStore,
  identity: ModelIdentity,
  accessRoute: AccessRoute,
): void {
  modelIdentities.bindProviderModel({
    providerId: accessRoute.providerId,
    connectionId: accessRoute.connectionId,
    providerModelId: accessRoute.providerModelId,
    modelIdentityId: identity.modelIdentityId,
  });
}

describe("RouteCatalog", () => {
  it("rejects a route whose exact provider model binding belongs to another identity", () => {
    const { catalog, modelIdentities } = setup();
    const boundIdentity = explicitIdentity("Bound Model");
    const mismatchedIdentity = explicitIdentity("Mismatched Model");
    modelIdentities.upsertExplicit(boundIdentity);
    modelIdentities.upsertExplicit(mismatchedIdentity);
    const mismatchedRoute = route(mismatchedIdentity.modelIdentityId);
    bindRouteIdentity(modelIdentities, boundIdentity, mismatchedRoute);

    expect(() => catalog.upsert(mismatchedRoute)).toThrow(/identity|bound/i);
    expect(catalog.list()).toEqual([]);
  });

  it("keeps multiple exact routes for one model identity with stable route-specific IDs", () => {
    const { catalog, modelIdentities } = setup();
    const identity = explicitIdentity();
    modelIdentities.upsertExplicit(identity);
    const routes = [
      route(identity.modelIdentityId),
      route(identity.modelIdentityId, { connectionId: "connection-secondary" }),
      route(identity.modelIdentityId, { providerModelId: "provider/model-b" }),
      route(identity.modelIdentityId, { executionProfile: "tools" }),
    ];
    for (const accessRoute of routes) {
      bindRouteIdentity(modelIdentities, identity, accessRoute);
      catalog.upsert(accessRoute);
    }

    expect(new Set(routes.map((accessRoute) => accessRoute.routeId))).toHaveLength(4);
    expect(catalog.list()).toEqual(routes);
  });

  it("mutates visibility for exactly one route and leaves siblings untouched", () => {
    const { catalog, modelIdentities } = setup();
    const identity = explicitIdentity();
    modelIdentities.upsertExplicit(identity);
    const routeA = route(identity.modelIdentityId, {
      connectionId: "connection-a",
      visibility: { visibleOn: ["cmmchat_model_picker", "admin_console"] },
    });
    const routeB = route(identity.modelIdentityId, {
      connectionId: "connection-b",
      visibility: { visibleOn: ["cmmchat_model_picker", "admin_console"] },
    });
    for (const accessRoute of [routeA, routeB]) {
      bindRouteIdentity(modelIdentities, identity, accessRoute);
      catalog.upsert(accessRoute);
    }

    catalog.setVisibility(routeA.routeId, ["admin_console"]);

    expect(catalog.get(routeA.routeId)?.visibility.visibleOn).toEqual(["admin_console"]);
    expect(catalog.get(routeB.routeId)?.visibility.visibleOn).toContain("cmmchat_model_picker");
    expect(catalog.get(routeA.routeId)?.routable).toBe(true);
    expect(catalog.get(routeB.routeId)?.routable).toBe(true);
  });

  it("keeps visibility separate from catalog history and routability", () => {
    const { catalog, modelIdentities } = setup();
    const identity = explicitIdentity();
    modelIdentities.upsertExplicit(identity);
    const hidden = route(identity.modelIdentityId, {
      routable: true,
      visibility: { visibleOn: ["admin_console"] },
    });
    const visibleButUnavailable = route(identity.modelIdentityId, {
      providerModelId: "provider/model-b",
      routable: false,
      visibility: { visibleOn: ["cmmchat_model_picker"] },
    });
    for (const accessRoute of [hidden, visibleButUnavailable]) {
      bindRouteIdentity(modelIdentities, identity, accessRoute);
      catalog.upsert(accessRoute);
    }

    expect(catalog.list()).toEqual([hidden, visibleButUnavailable]);
    expect(catalog.listVisible("cmmchat_model_picker")).toEqual([
      visibleButUnavailable,
    ]);
  });

  it("fails closed when a hidden route is manually supplied by a consumer", async () => {
    const { bindings, catalog, connections, modelIdentities } = setup();
    addReadyCapableConnection(bindings, connections);
    const identity = explicitIdentity();
    modelIdentities.upsertExplicit(identity);
    const hidden = route(identity.modelIdentityId, {
      visibility: { visibleOn: ["admin_console"] },
    });
    bindRouteIdentity(modelIdentities, identity, hidden);
    catalog.upsert(hidden);

    await expect(
      catalog.resolveForConsumer(hidden.routeId, "cmmchat_model_picker"),
    ).rejects.toThrow(/visible|hidden/i);
  });

  it("requires exact connection execution readiness before resolving a routable route", async () => {
    const { catalog, connections, modelIdentities } = setup();
    const identity = explicitIdentity();
    modelIdentities.upsertExplicit(identity);

    connections.add(connection("connection-main", undefined));
    const noExecutionAuth = route(identity.modelIdentityId);
    bindRouteIdentity(modelIdentities, identity, noExecutionAuth);
    catalog.upsert(noExecutionAuth);
    await expect(
      catalog.resolveForConsumer(noExecutionAuth.routeId, "cmmchat_model_picker"),
    ).rejects.toThrow(/execution credential|routable|ready/i);

    const disabledConnection = connection("connection-disabled", undefined);
    connections.add(disabledConnection);
    connections.disable(disabledConnection.connectionId);
    const disabledRoute = route(identity.modelIdentityId, {
      connectionId: disabledConnection.connectionId,
    });
    bindRouteIdentity(modelIdentities, identity, disabledRoute);
    catalog.upsert(disabledRoute);
    await expect(
      catalog.resolveForConsumer(disabledRoute.routeId, "cmmchat_model_picker"),
    ).rejects.toThrow(/disabled|routable|ready/i);
  });

  it("preserves CHAT_ONLY capability truth per selected route", async () => {
    const { bindings, catalog, connections, modelIdentities } = setup();
    addReadyCapableConnection(bindings, connections, "connection-chat");
    addReadyCapableConnection(bindings, connections, "connection-tools");
    const identity = explicitIdentity();
    modelIdentities.upsertExplicit(identity);
    const chatOnly = route(identity.modelIdentityId, {
      connectionId: "connection-chat",
      capabilities: { chat: true, tools: false, streaming: true },
    });
    const tools = route(identity.modelIdentityId, {
      connectionId: "connection-tools",
      capabilities: { chat: true, tools: true, streaming: true },
    });
    for (const accessRoute of [chatOnly, tools]) {
      bindRouteIdentity(modelIdentities, identity, accessRoute);
      catalog.upsert(accessRoute);
    }

    await expect(
      catalog.resolveForConsumer(chatOnly.routeId, "cmmchat_model_picker"),
    ).resolves.toEqual(chatOnly);
    await expect(
      catalog.resolveForConsumer(tools.routeId, "cmmchat_model_picker"),
    ).resolves.toEqual(tools);
  });

  it("never falls back to another route sharing the same model identity", async () => {
    const { bindings, catalog, connections, modelIdentities } = setup();
    addReadyCapableConnection(bindings, connections, "connection-ready");
    const identity = explicitIdentity();
    modelIdentities.upsertExplicit(identity);
    const unavailable = route(identity.modelIdentityId, {
      connectionId: "connection-unavailable",
      routable: false,
    });
    const ready = route(identity.modelIdentityId, {
      connectionId: "connection-ready",
    });
    for (const accessRoute of [unavailable, ready]) {
      bindRouteIdentity(modelIdentities, identity, accessRoute);
      catalog.upsert(accessRoute);
    }

    await expect(
      catalog.resolveForConsumer(unavailable.routeId, "cmmchat_model_picker"),
    ).rejects.toThrow(/routable|unavailable/i);
    await expect(
      catalog.resolveForConsumer(ready.routeId, "cmmchat_model_picker"),
    ).resolves.toEqual(ready);
  });

  it("marks a disappeared provider model unavailable while retaining route history", () => {
    const { catalog, modelIdentities } = setup();
    const identity = explicitIdentity();
    modelIdentities.upsertExplicit(identity);
    const disappearing = route(identity.modelIdentityId);
    bindRouteIdentity(modelIdentities, identity, disappearing);
    catalog.upsert(disappearing);

    catalog.markUnavailable(
      disappearing.connectionId,
      disappearing.providerModelId,
    );

    expect(catalog.get(disappearing.routeId)).toEqual({
      ...disappearing,
      routable: false,
    });
    expect(catalog.list()).toHaveLength(1);
  });
});
