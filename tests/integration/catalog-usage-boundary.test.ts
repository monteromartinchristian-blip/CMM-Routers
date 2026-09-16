import { describe, expect, it } from "vitest";
import { CredentialBindingStore } from "../../src/catalog/credential-bindings.js";
import { buildModelIdentityId, buildRouteId } from "../../src/catalog/ids.js";
import { ModelIdentityStore } from "../../src/catalog/model-identities.js";
import { buildRouterCatalogProjection } from "../../src/catalog/projection.js";
import { ProviderConnectionService } from "../../src/catalog/provider-connections.js";
import { ProviderDirectory } from "../../src/catalog/provider-directory.js";
import { RouteCatalog } from "../../src/catalog/route-catalog.js";
import type {
  AccessRoute,
  Account,
  ProviderProduct,
} from "../../src/catalog/types.js";
import { InMemorySecureCredentialResolver } from "../support/in-memory-secure-credential-resolver.js";

const PROVIDER_ID = "openrouter";
const ACCOUNT_ID = "account-openrouter";
const PRODUCT_ID = "product-openrouter";
const CONNECTION_ID = "connection-openrouter";
const EXECUTION_BINDING_ID = "execution-openrouter";
const OBSERVABILITY_BINDING_ID = "observability-openrouter";
const SECRET_REF = "keychain://openrouter/shared-boundary-secret";
const PROVIDER_MODEL_ID = "openrouter/model-boundary";

interface SetupOptions {
  execution?: boolean;
  observability?: boolean;
  hidden?: boolean;
}

function setup(options: SetupOptions = {}) {
  const directory = new ProviderDirectory();
  directory.register({
    providerId: PROVIDER_ID,
    displayName: "OpenRouter",
    adapterKind: "openai-compatible",
    supportedConnectionKinds: ["openai-chat-completions"],
    discoveryCapabilities: ["models"],
  });

  const accounts: Account[] = [
    {
      accountId: ACCOUNT_ID,
      providerId: PROVIDER_ID,
      label: "OpenRouter Account",
      identityStatus: "unresolved",
    },
  ];
  const products: ProviderProduct[] = [
    {
      productId: PRODUCT_ID,
      accountId: ACCOUNT_ID,
      providerId: PROVIDER_ID,
      kind: "api",
      label: "OpenRouter API",
    },
  ];

  const credentialBindings = new CredentialBindingStore();
  if (options.observability ?? true) {
    credentialBindings.addObservability({
      bindingId: OBSERVABILITY_BINDING_ID,
      providerId: PROVIDER_ID,
      accountId: ACCOUNT_ID,
      productId: PRODUCT_ID,
      secretRef: SECRET_REF,
      purpose: "observability",
      enabled: true,
    });
  }
  if (options.execution ?? false) {
    credentialBindings.addExecution({
      bindingId: EXECUTION_BINDING_ID,
      providerId: PROVIDER_ID,
      accountId: ACCOUNT_ID,
      productId: PRODUCT_ID,
      secretRef: SECRET_REF,
      purpose: "execution",
      enabled: true,
    });
  }

  const providerConnections = new ProviderConnectionService({
    directory,
    credentialBindings,
    credentialResolver: new InMemorySecureCredentialResolver(
      new Map([[SECRET_REF, "boundary-fixture-secret"]]),
    ),
    administrativeDiscovery: new Map(),
  });
  providerConnections.add({
    connectionId: CONNECTION_ID,
    providerId: PROVIDER_ID,
    accountId: ACCOUNT_ID,
    productId: PRODUCT_ID,
    connectionKind: "openai-chat-completions",
    executionCredentialBindingId: EXECUTION_BINDING_ID,
    endpointRef: "https://openrouter.example/v1",
    status: "configured",
  });

  const modelIdentities = new ModelIdentityStore();
  const modelIdentityId = buildModelIdentityId({ canonicalName: "Boundary Model" });
  modelIdentities.upsertExplicit({
    modelIdentityId,
    canonicalName: "Boundary Model",
    aliases: ["boundary-model"],
  });
  modelIdentities.bindProviderModel({
    providerId: PROVIDER_ID,
    connectionId: CONNECTION_ID,
    providerModelId: PROVIDER_MODEL_ID,
    modelIdentityId,
  });

  const routeCatalog = new RouteCatalog({
    connections: providerConnections,
    modelIdentities,
  });
  const route: AccessRoute = {
    routeId: buildRouteId({
      providerId: PROVIDER_ID,
      connectionId: CONNECTION_ID,
      providerModelId: PROVIDER_MODEL_ID,
      executionProfile: "default",
    }),
    modelIdentityId,
    connectionId: CONNECTION_ID,
    providerId: PROVIDER_ID,
    providerModelId: PROVIDER_MODEL_ID,
    executionProfile: "default",
    capabilities: { chat: true, tools: false, streaming: true },
    billingClass: "api",
    routable: true,
    visibility: {
      visibleOn: options.hidden
        ? ["admin_console"]
        : ["cmmchat_model_picker", "admin_console"],
    },
  };
  routeCatalog.upsert(route);

  const projectionInput = {
    directory,
    accounts,
    products,
    connections: providerConnections,
    modelIdentities,
    routeCatalog,
  };

  return {
    credentialBindings,
    directory,
    providerConnections,
    projectionInput,
    route,
    routeCatalog,
  };
}

describe("Routers ↔ Usage catalog responsibility boundary", () => {
  it("does not authorize execution from an observability-only OpenRouter credential", async () => {
    const state = setup({ observability: true, execution: false });

    expect(
      state.credentialBindings.getObservability(OBSERVABILITY_BINDING_ID),
    ).toMatchObject({ purpose: "observability", secretRef: SECRET_REF });
    expect(state.credentialBindings.getExecution(EXECUTION_BINDING_ID)).toBeUndefined();
    await expect(
      state.routeCatalog.resolveForConsumer(
        state.route.routeId,
        "cmmchat_model_picker",
      ),
    ).rejects.toThrow(/execution credential/i);
  });

  it("makes execution eligible only after an explicit execution binding exists for the same secretRef", async () => {
    const state = setup({ observability: true, execution: false });

    await expect(
      state.routeCatalog.resolveForConsumer(
        state.route.routeId,
        "cmmchat_model_picker",
      ),
    ).rejects.toThrow(/execution credential/i);

    state.credentialBindings.addExecution({
      bindingId: EXECUTION_BINDING_ID,
      providerId: PROVIDER_ID,
      accountId: ACCOUNT_ID,
      productId: PRODUCT_ID,
      secretRef: SECRET_REF,
      purpose: "execution",
      enabled: true,
    });

    expect(
      state.credentialBindings.getExecution(EXECUTION_BINDING_ID)?.secretRef,
    ).toBe(
      state.credentialBindings.getObservability(OBSERVABILITY_BINDING_ID)?.secretRef,
    );
    await expect(
      state.routeCatalog.resolveForConsumer(
        state.route.routeId,
        "cmmchat_model_picker",
      ),
    ).resolves.toEqual(state.route);
  });

  it("removing observability leaves execution authorization intact", async () => {
    const state = setup({ observability: true, execution: true });

    expect(
      state.credentialBindings.removeObservability(OBSERVABILITY_BINDING_ID),
    ).toBe(true);
    expect(
      state.credentialBindings.getObservability(OBSERVABILITY_BINDING_ID),
    ).toBeUndefined();
    expect(state.credentialBindings.getExecution(EXECUTION_BINDING_ID)).toMatchObject({
      purpose: "execution",
      secretRef: SECRET_REF,
    });
    await expect(
      state.routeCatalog.resolveForConsumer(
        state.route.routeId,
        "cmmchat_model_picker",
      ),
    ).resolves.toEqual(state.route);
  });

  it("removing execution fails the route closed while observability remains", async () => {
    const state = setup({ observability: true, execution: true });

    expect(state.credentialBindings.removeExecution(EXECUTION_BINDING_ID)).toBe(true);
    expect(state.credentialBindings.getExecution(EXECUTION_BINDING_ID)).toBeUndefined();
    expect(
      state.credentialBindings.getObservability(OBSERVABILITY_BINDING_ID),
    ).toMatchObject({ purpose: "observability", secretRef: SECRET_REF });
    await expect(
      state.routeCatalog.resolveForConsumer(
        state.route.routeId,
        "cmmchat_model_picker",
      ),
    ).rejects.toThrow(/execution credential/i);
  });

  it("keeps hidden routes in the read-only Usage/admin projection", () => {
    const state = setup({ observability: true, execution: true });
    state.routeCatalog.setVisibility(state.route.routeId, ["admin_console"]);

    const projection = buildRouterCatalogProjection(state.projectionInput);

    expect(projection.routes).toContainEqual(
      expect.objectContaining({
        routeId: state.route.routeId,
        visibility: { visibleOn: ["admin_console"] },
      }),
    );
  });

  it("does not let a Usage-only fake provider become canonical Router state", () => {
    const state = setup({ observability: true, execution: true });
    const canonical = buildRouterCatalogProjection(state.projectionInput);
    const usageFixture = {
      ...canonical,
      providers: [
        ...canonical.providers,
        { providerId: "demo-provider", displayName: "Demo Provider" },
      ],
    };

    expect(usageFixture.providers.some((entry) => entry.providerId === "demo-provider")).toBe(
      true,
    );
    expect(state.directory.has("demo-provider")).toBe(false);
    expect(
      buildRouterCatalogProjection(state.projectionInput).providers.some(
        (entry) => entry.providerId === "demo-provider",
      ),
    ).toBe(false);
  });

  it("keeps canonical RouteCatalog immutable from consumer projection mutation attempts", () => {
    const state = setup({ observability: true, execution: true });
    const projection = buildRouterCatalogProjection(state.projectionInput);
    const projectedRoute = projection.routes[0] as unknown as {
      routable: boolean;
      visibility: { visibleOn: string[] };
    };

    projectedRoute.routable = false;
    projectedRoute.visibility.visibleOn.push("usage_fixture_only");

    expect(state.routeCatalog.get(state.route.routeId)).toEqual(state.route);
    expect(buildRouterCatalogProjection(state.projectionInput).routes[0]).toEqual(
      expect.objectContaining({
        routeId: state.route.routeId,
        routable: true,
        visibility: {
          visibleOn: ["cmmchat_model_picker", "admin_console"],
        },
      }),
    );
  });
});
