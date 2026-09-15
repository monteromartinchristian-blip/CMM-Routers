import { describe, expect, it } from "vitest";
import { CredentialBindingStore } from "../../src/catalog/credential-bindings.js";
import { buildModelIdentityId, buildRouteId } from "../../src/catalog/ids.js";
import { ModelIdentityStore } from "../../src/catalog/model-identities.js";
import {
  buildCmmChatRouteProjection,
  buildRouterCatalogProjection,
} from "../../src/catalog/projection.js";
import { ProviderConnectionService } from "../../src/catalog/provider-connections.js";
import { ProviderDirectory } from "../../src/catalog/provider-directory.js";
import { RouteCatalog } from "../../src/catalog/route-catalog.js";
import type {
  AccessRoute,
  Account,
  ModelIdentity,
  ProviderConnection,
  ProviderDefinition,
  ProviderProduct,
} from "../../src/catalog/types.js";
import { InMemorySecureCredentialResolver } from "../support/in-memory-secure-credential-resolver.js";

const SECRET_REF = "keychain://projection/main";
const RAW_SECRET = "projection-raw-secret-value";
const PROFILE_PATH = "/Users/example/.config/provider/private-profile.json";
const AUTH_BLOB = "projection-provider-native-auth-blob";

function providerDefinition(): ProviderDefinition {
  return {
    providerId: "test-provider",
    displayName: "Test Provider",
    adapterKind: "openai-compatible",
    supportedConnectionKinds: ["openai-chat-completions"],
    discoveryCapabilities: ["models"],
  };
}

function account(): Account {
  return {
    accountId: "account-main",
    providerId: "test-provider",
    label: "Primary Account",
    identityStatus: "resolved",
    externalAccountRef: "provider-native-account-123",
    rawSecret: RAW_SECRET,
    profilePath: PROFILE_PATH,
    auth: { accessToken: AUTH_BLOB },
  } as Account & {
    rawSecret: string;
    profilePath: string;
    auth: { accessToken: string };
  };
}

function product(): ProviderProduct {
  return {
    productId: "product-main",
    accountId: "account-main",
    providerId: "test-provider",
    kind: "subscription",
    label: "Pro Plan",
    secretRef: SECRET_REF,
    rawSecret: RAW_SECRET,
  } as ProviderProduct & { secretRef: string; rawSecret: string };
}

function identity(canonicalName = "Shared Model"): ModelIdentity {
  return {
    modelIdentityId: buildModelIdentityId({ canonicalName }),
    canonicalName,
    family: "shared-family",
    aliases: ["shared-model"],
  };
}

function route(
  modelIdentityId: string,
  overrides: Partial<Omit<AccessRoute, "routeId" | "modelIdentityId">> = {},
): AccessRoute {
  const fields = {
    connectionId: "connection-main",
    providerId: "test-provider",
    providerModelId: "provider/model-visible",
    executionProfile: "chat",
    capabilities: {
      chat: true,
      tools: false,
      vision: true,
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
  directory.register(providerDefinition());

  const credentialBindings = new CredentialBindingStore();
  credentialBindings.addExecution({
    bindingId: "execution-main",
    providerId: "test-provider",
    accountId: "account-main",
    productId: "product-main",
    secretRef: SECRET_REF,
    purpose: "execution",
    enabled: true,
  });
  const credentialResolver = new InMemorySecureCredentialResolver(
    new Map([[SECRET_REF, RAW_SECRET]]),
  );
  const connections = new ProviderConnectionService({
    directory,
    credentialBindings,
    credentialResolver,
    administrativeDiscovery: new Map(),
  });
  const connection: ProviderConnection = {
    connectionId: "connection-main",
    providerId: "test-provider",
    accountId: "account-main",
    productId: "product-main",
    connectionKind: "openai-chat-completions",
    executionCredentialBindingId: "execution-main",
    profileRef: PROFILE_PATH,
    endpointRef: "provider-native-endpoint-main",
    status: "configured",
  };
  connections.add(connection);

  const modelIdentities = new ModelIdentityStore();
  const explicitIdentity = identity();
  modelIdentities.upsertExplicit(explicitIdentity);

  const routeCatalog = new RouteCatalog({ connections, modelIdentities });
  const visibleRoute = route(explicitIdentity.modelIdentityId);
  const hiddenRoute = route(explicitIdentity.modelIdentityId, {
    providerModelId: "provider/model-hidden",
    executionProfile: "history",
    routable: false,
    visibility: { visibleOn: ["admin_console"] },
  });
  for (const accessRoute of [visibleRoute, hiddenRoute]) {
    modelIdentities.bindProviderModel({
      providerId: accessRoute.providerId,
      connectionId: accessRoute.connectionId,
      providerModelId: accessRoute.providerModelId,
      modelIdentityId: explicitIdentity.modelIdentityId,
    });
    routeCatalog.upsert(accessRoute);
  }

  return {
    directory,
    accounts: [account()],
    products: [product()],
    connections,
    modelIdentities,
    routeCatalog,
    explicitIdentity,
    visibleRoute,
    hiddenRoute,
  };
}

describe("catalog projections", () => {
  it("exposes stable IDs and labels required by Usage, including hidden route history", () => {
    const input = setup();

    const projection = buildRouterCatalogProjection(input);

    expect(projection.providers).toEqual([
      { providerId: "test-provider", displayName: "Test Provider" },
    ]);
    expect(projection.accounts).toEqual([
      {
        accountId: "account-main",
        providerId: "test-provider",
        label: "Primary Account",
        identityStatus: "resolved",
      },
    ]);
    expect(projection.products).toEqual([
      {
        productId: "product-main",
        accountId: "account-main",
        providerId: "test-provider",
        kind: "subscription",
        label: "Pro Plan",
      },
    ]);
    expect(projection.connections).toEqual([
      {
        connectionId: "connection-main",
        providerId: "test-provider",
        accountId: "account-main",
        productId: "product-main",
        connectionKind: "openai-chat-completions",
        status: "configured",
        identityStatus: "resolved",
      },
    ]);
    expect(projection.models).toEqual([
      {
        modelIdentityId: input.explicitIdentity.modelIdentityId,
        canonicalName: "Shared Model",
        family: "shared-family",
        aliases: ["shared-model"],
      },
    ]);
    expect(projection.routes.map((entry) => entry.routeId)).toEqual([
      input.visibleRoute.routeId,
      input.hiddenRoute.routeId,
    ]);
    expect(projection.routes).toContainEqual({
      routeId: input.hiddenRoute.routeId,
      modelIdentityId: input.explicitIdentity.modelIdentityId,
      connectionId: "connection-main",
      providerId: "test-provider",
      providerModelId: "provider/model-hidden",
      executionProfile: "history",
      capabilities: {
        chat: true,
        tools: false,
        vision: true,
        streaming: true,
      },
      billingClass: "subscription",
      routable: false,
      visibility: { visibleOn: ["admin_console"] },
    });
  });

  it("copies only explicit safe DTO fields and excludes credentials, profile paths and auth blobs", () => {
    const projection = buildRouterCatalogProjection(setup());
    const serialized = JSON.stringify(projection);

    expect(serialized).not.toContain(SECRET_REF);
    expect(serialized).not.toContain(RAW_SECRET);
    expect(serialized).not.toContain(PROFILE_PATH);
    expect(serialized).not.toContain(AUTH_BLOB);
    expect(serialized).not.toMatch(
      /secretRef|rawSecret|profileRef|profilePath|executionCredentialBindingId|externalAccountRef|auth|accessToken/i,
    );
    expect(Object.keys(projection.connections[0]!).sort()).toEqual([
      "accountId",
      "connectionId",
      "connectionKind",
      "identityStatus",
      "productId",
      "providerId",
      "status",
    ]);
  });

  it("projects only routes visible on the CMMChat model picker with safe labels", () => {
    const input = setup();
    const catalog = buildRouterCatalogProjection(input);

    expect(buildCmmChatRouteProjection(catalog)).toEqual([
      {
        routeId: input.visibleRoute.routeId,
        modelIdentityId: input.explicitIdentity.modelIdentityId,
        modelLabel: "Shared Model",
        providerId: "test-provider",
        providerLabel: "Test Provider",
        connectionId: "connection-main",
        accountId: "account-main",
        accountLabel: "Primary Account",
        productId: "product-main",
        productLabel: "Pro Plan",
        providerModelId: "provider/model-visible",
        executionProfile: "chat",
        capabilities: {
          chat: true,
          tools: false,
          vision: true,
          streaming: true,
        },
        billingClass: "subscription",
        routable: true,
      },
    ]);
  });

  it("does not synthesize fixture or demo identities and emits them only when supplied", () => {
    const directory = new ProviderDirectory();
    const credentialBindings = new CredentialBindingStore();
    const connections = new ProviderConnectionService({
      directory,
      credentialBindings,
      credentialResolver: new InMemorySecureCredentialResolver(new Map()),
      administrativeDiscovery: new Map(),
    });
    const modelIdentities = new ModelIdentityStore();
    const routeCatalog = new RouteCatalog({ connections, modelIdentities });

    expect(
      buildRouterCatalogProjection({
        directory,
        accounts: [],
        products: [],
        connections,
        modelIdentities,
        routeCatalog,
      }),
    ).toEqual({
      providers: [],
      accounts: [],
      products: [],
      connections: [],
      models: [],
      routes: [],
    });

    const explicitlySuppliedDemoAccount: Account = {
      accountId: "demo-account",
      providerId: "demo-provider",
      label: "Explicit Demo Account",
      identityStatus: "unresolved",
    };
    expect(
      buildRouterCatalogProjection({
        directory,
        accounts: [explicitlySuppliedDemoAccount],
        products: [],
        connections,
        modelIdentities,
        routeCatalog,
      }).accounts,
    ).toEqual([
      {
        accountId: "demo-account",
        providerId: "demo-provider",
        label: "Explicit Demo Account",
        identityStatus: "unresolved",
      },
    ]);
  });
});
