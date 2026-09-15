import { describe, expect, it } from "vitest";
import { CredentialBindingStore } from "../../src/catalog/credential-bindings.js";
import { buildRouteId } from "../../src/catalog/ids.js";
import { ModelIdentityStore } from "../../src/catalog/model-identities.js";
import { ProviderConnectionService } from "../../src/catalog/provider-connections.js";
import { ProviderDirectory } from "../../src/catalog/provider-directory.js";
import { RouteCatalog } from "../../src/catalog/route-catalog.js";
import {
  CatalogReconciler,
  type CatalogRoutePolicy,
} from "../../src/catalog/catalog-reconciler.js";
import type { DiscoveredModel } from "../../src/core/model.js";
import { InMemorySecureCredentialResolver } from "../support/in-memory-secure-credential-resolver.js";

const policy: CatalogRoutePolicy = (connection, model) => ({
  canonicalName: `${connection.providerId}:${model.providerModelId}`,
  executionProfile: "default",
  capabilities: {
    chat: true,
    tools: model.capabilities?.tools === true,
    streaming: true,
  },
  billingClass: "subscription",
  routable: true,
  visibility: { visibleOn: ["cmmchat_model_picker", "admin_console"] },
});

function model(provider: "openrouter" | "deepseek", upstreamModel: string): DiscoveredModel {
  return {
    id: `${provider}/${upstreamModel}`,
    provider,
    upstreamModel,
    displayName: upstreamModel,
    capability: "CHAT_ONLY",
  };
}

function setup() {
  const directory = new ProviderDirectory();
  for (const providerId of ["openrouter", "deepseek"] as const) {
    directory.register({
      providerId,
      displayName: providerId,
      adapterKind: "openai-compatible",
      supportedConnectionKinds: ["openai-chat-completions"],
      discoveryCapabilities: ["models"],
    });
  }

  const bindings = new CredentialBindingStore();
  const resolver = new InMemorySecureCredentialResolver(
    new Map([
      ["keychain://openrouter", "or-secret"],
      ["keychain://deepseek", "ds-secret"],
    ]),
  );
  let openrouterModels: DiscoveredModel[] = [
    model("openrouter", "stable-model"),
    model("openrouter", "removed-model"),
  ];
  let openrouterFails = false;
  const deepseekModels: DiscoveredModel[] = [model("deepseek", "deepseek-stable")];

  const connections = new ProviderConnectionService({
    directory,
    credentialBindings: bindings,
    credentialResolver: resolver,
    administrativeDiscovery: new Map([
      [
        "openrouter",
        async () => {
          if (openrouterFails) throw new Error("fixture discovery failure");
          return openrouterModels;
        },
      ],
      ["deepseek", async () => deepseekModels],
    ]),
  });

  for (const providerId of ["openrouter", "deepseek"] as const) {
    const connectionId = `${providerId}-connection`;
    const bindingId = `${providerId}-binding`;
    bindings.addExecution({
      bindingId,
      providerId,
      secretRef: `keychain://${providerId}`,
      purpose: "execution",
      enabled: true,
    });
    connections.add({
      connectionId,
      providerId,
      connectionKind: "openai-chat-completions",
      executionCredentialBindingId: bindingId,
      status: "configured",
    });
  }

  const modelIdentities = new ModelIdentityStore();
  const routeCatalog = new RouteCatalog({ connections, modelIdentities });
  const reconciler = new CatalogReconciler({
    connections,
    modelIdentities,
    routeCatalog,
    routePolicy: policy,
    minRefreshIntervalMs: 0,
  });

  return {
    connections,
    modelIdentities,
    routeCatalog,
    reconciler,
    setOpenrouterModels(models: DiscoveredModel[]) {
      openrouterModels = models;
    },
    setOpenrouterFails(value: boolean) {
      openrouterFails = value;
    },
  };
}

describe("CatalogReconciler", () => {
  it("skips disabled represented connections without attempting discovery", async () => {
    const state = setup();
    state.connections.add({
      connectionId: "openrouter-secondary-disabled",
      providerId: "openrouter",
      connectionKind: "openai-chat-completions",
      status: "disabled",
    });

    const results = await state.reconciler.reconcileAll({ force: true });
    const secondary = results.find(
      (result) => result.connectionId === "openrouter-secondary-disabled",
    );

    expect(secondary).toEqual({
      connectionId: "openrouter-secondary-disabled",
      failed: false,
      skipped: true,
      discoveredCount: 0,
      upsertedRouteIds: [],
      unavailableRouteIds: [],
    });
    expect(state.connections.get("openrouter-secondary-disabled")?.status).toBe("disabled");
    expect(
      state.routeCatalog
        .list()
        .some((route) => route.connectionId === "openrouter-secondary-disabled"),
    ).toBe(false);
  });

  it("preserves stable routes, adds new models and marks missing models unavailable", async () => {
    const state = setup();
    await state.reconciler.reconcileAll({ force: true });

    const stableRouteId = buildRouteId({
      providerId: "openrouter",
      connectionId: "openrouter-connection",
      providerModelId: "stable-model",
      executionProfile: "default",
    });
    const removedRouteId = buildRouteId({
      providerId: "openrouter",
      connectionId: "openrouter-connection",
      providerModelId: "removed-model",
      executionProfile: "default",
    });
    expect(state.routeCatalog.get(stableRouteId)?.routable).toBe(true);
    expect(state.routeCatalog.get(removedRouteId)?.routable).toBe(true);
    const identityCountBefore = state.modelIdentities.list().length;

    state.setOpenrouterModels([
      model("openrouter", "stable-model"),
      model("openrouter", "added-model"),
    ]);
    await state.reconciler.reconcileConnection("openrouter-connection", { force: true });

    const addedRouteId = buildRouteId({
      providerId: "openrouter",
      connectionId: "openrouter-connection",
      providerModelId: "added-model",
      executionProfile: "default",
    });
    expect(state.routeCatalog.get(stableRouteId)?.routeId).toBe(stableRouteId);
    expect(state.routeCatalog.get(stableRouteId)?.routable).toBe(true);
    expect(state.routeCatalog.get(addedRouteId)?.routable).toBe(true);
    expect(state.routeCatalog.get(removedRouteId)?.routable).toBe(false);
    expect(state.modelIdentities.list().length).toBe(identityCountBefore + 1);
    expect(
      state.modelIdentities
        .list()
        .some((identity) => identity.aliases.includes("removed-model")),
    ).toBe(true);
  });

  it("isolates discovery failure to one connection without deleting history", async () => {
    const state = setup();
    await state.reconciler.reconcileAll({ force: true });
    const identitiesBefore = state.modelIdentities.list();
    const deepseekRoute = state.routeCatalog
      .list()
      .find((route) => route.connectionId === "deepseek-connection")!;

    state.setOpenrouterFails(true);
    const results = await state.reconciler.reconcileAll({ force: true });

    expect(results.find((result) => result.connectionId === "openrouter-connection")?.failed).toBe(
      true,
    );
    expect(state.connections.get("openrouter-connection")?.status).toBe("error");
    expect(
      state.routeCatalog
        .list()
        .filter((route) => route.connectionId === "openrouter-connection")
        .every((route) => route.routable === false),
    ).toBe(true);
    expect(state.routeCatalog.get(deepseekRoute.routeId)?.routable).toBe(true);
    expect(state.modelIdentities.list()).toEqual(identitiesBefore);
  });
});
