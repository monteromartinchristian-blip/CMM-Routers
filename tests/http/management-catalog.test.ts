import { describe, expect, it } from "vitest";
import { CredentialBindingStore } from "../../src/catalog/credential-bindings.js";
import { buildModelIdentityId, buildRouteId } from "../../src/catalog/ids.js";
import { ModelIdentityStore } from "../../src/catalog/model-identities.js";
import { ProviderConnectionService } from "../../src/catalog/provider-connections.js";
import { ProviderDirectory } from "../../src/catalog/provider-directory.js";
import { RouteCatalog } from "../../src/catalog/route-catalog.js";
import type { AccessRoute } from "../../src/catalog/types.js";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { InMemorySecureCredentialResolver } from "../support/in-memory-secure-credential-resolver.js";

const BEARER = "catalog-management-token";
const SECRET_REF = "keychain://catalog/private";
const RAW_SECRET = "catalog-private-secret";
const PROFILE_PATH = "/Users/example/.config/catalog/private-profile.json";
const AUTH_BLOB = "catalog-private-auth-blob";

function createCatalogState() {
  const directory = new ProviderDirectory();
  directory.register({
    providerId: "catalog-provider",
    displayName: "Catalog Provider",
    adapterKind: "openai-compatible",
    supportedConnectionKinds: ["openai-chat-completions"],
    discoveryCapabilities: ["models"],
  });

  const accounts = [{
    accountId: "account-primary",
    providerId: "catalog-provider",
    label: "Primary Account",
    identityStatus: "resolved" as const,
    externalAccountRef: "private-external-account",
    rawSecret: RAW_SECRET,
    profilePath: PROFILE_PATH,
    auth: { accessToken: AUTH_BLOB },
  }];
  const products = [{
    productId: "product-subscription",
    accountId: "account-primary",
    providerId: "catalog-provider",
    kind: "subscription" as const,
    label: "Subscription",
    secretRef: SECRET_REF,
  }];

  const credentialBindings = new CredentialBindingStore();
  credentialBindings.addExecution({
    bindingId: "execution-private",
    providerId: "catalog-provider",
    accountId: "account-primary",
    productId: "product-subscription",
    secretRef: SECRET_REF,
    purpose: "execution",
    enabled: true,
  });
  const connections = new ProviderConnectionService({
    directory,
    credentialBindings,
    credentialResolver: new InMemorySecureCredentialResolver(
      new Map([[SECRET_REF, RAW_SECRET]]),
    ),
    administrativeDiscovery: new Map(),
  });
  connections.add({
    connectionId: "connection-primary",
    providerId: "catalog-provider",
    accountId: "account-primary",
    productId: "product-subscription",
    connectionKind: "openai-chat-completions",
    executionCredentialBindingId: "execution-private",
    profileRef: PROFILE_PATH,
    endpointRef: "private-endpoint-ref",
    status: "ready",
  });

  const modelIdentityId = buildModelIdentityId({ canonicalName: "Catalog Model" });
  const modelIdentities = new ModelIdentityStore();
  modelIdentities.upsertExplicit({
    modelIdentityId,
    canonicalName: "Catalog Model",
    family: "catalog-family",
    aliases: ["catalog/model"],
  });
  const routeCatalog = new RouteCatalog({ connections, modelIdentities });

  function addRoute(
    providerModelId: string,
    executionProfile: string,
    routable: boolean,
    visibleOn: AccessRoute["visibility"]["visibleOn"],
  ) {
    const route: AccessRoute = {
      routeId: buildRouteId({
        providerId: "catalog-provider",
        connectionId: "connection-primary",
        providerModelId,
        executionProfile,
      }),
      modelIdentityId,
      connectionId: "connection-primary",
      providerId: "catalog-provider",
      providerModelId,
      executionProfile,
      capabilities: { chat: true, tools: false, streaming: true },
      billingClass: "subscription",
      routable,
      visibility: { visibleOn },
    };
    modelIdentities.bindProviderModel({
      providerId: route.providerId,
      connectionId: route.connectionId,
      providerModelId: route.providerModelId,
      modelIdentityId,
    });
    routeCatalog.upsert(route);
    return route;
  }

  const visibleRoute = addRoute(
    "catalog/model-visible",
    "default",
    true,
    ["cmmchat_model_picker", "admin_console"],
  );
  const hiddenRoute = addRoute(
    "catalog/model-hidden",
    "history",
    false,
    ["admin_console"],
  );

  return {
    projectionInput: {
      directory,
      accounts,
      products,
      connections,
      modelIdentities,
      routeCatalog,
    },
    routeCatalog,
    visibleRoute,
    hiddenRoute,
  };
}

function createServer(state = createCatalogState()) {
  return {
    state,
    server: buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: BEARER,
      registry: new ProviderRegistry(),
      catalogProjectionInput: state.projectionInput,
    }),
  };
}

const auth = { authorization: `Bearer ${BEARER}` };
const mutationMethods = ["POST", "PUT", "PATCH", "DELETE"] as const;

describe("GET /v1/cmm/catalog", () => {
  it("returns every safe identity layer, including hidden routes, without private material or demos", async () => {
    const { server, state } = createServer();

    const response = await server.inject({
      method: "GET",
      url: "/v1/cmm/catalog",
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.providers).toEqual([
      { providerId: "catalog-provider", displayName: "Catalog Provider" },
    ]);
    expect(body.accounts).toEqual([
      {
        accountId: "account-primary",
        providerId: "catalog-provider",
        label: "Primary Account",
        identityStatus: "resolved",
      },
    ]);
    expect(body.products).toEqual([
      {
        productId: "product-subscription",
        accountId: "account-primary",
        providerId: "catalog-provider",
        kind: "subscription",
        label: "Subscription",
      },
    ]);
    expect(body.connections).toEqual([
      {
        connectionId: "connection-primary",
        providerId: "catalog-provider",
        accountId: "account-primary",
        productId: "product-subscription",
        connectionKind: "openai-chat-completions",
        status: "configured",
        identityStatus: "resolved",
      },
    ]);
    expect(body.models).toEqual([
      {
        modelIdentityId: state.hiddenRoute.modelIdentityId,
        canonicalName: "Catalog Model",
        family: "catalog-family",
        aliases: ["catalog/model"],
      },
    ]);
    expect(body.routes.map((route: { routeId: string }) => route.routeId)).toEqual([
      state.visibleRoute.routeId,
      state.hiddenRoute.routeId,
    ]);

    const serialized = response.body;
    expect(serialized).not.toContain(SECRET_REF);
    expect(serialized).not.toContain(RAW_SECRET);
    expect(serialized).not.toContain(PROFILE_PATH);
    expect(serialized).not.toContain(AUTH_BLOB);
    expect(serialized).not.toContain("demo");
    expect(serialized).not.toMatch(
      /secretRef|rawSecret|profileRef|profilePath|executionCredentialBindingId|externalAccountRef|endpointRef|auth|accessToken/i,
    );
  });

  it("rebuilds the projection from current catalog state on every request", async () => {
    const { server, state } = createServer();
    const first = await server.inject({
      method: "GET",
      url: "/v1/cmm/catalog",
      headers: auth,
    });
    expect(first.json().routes[0].routable).toBe(true);

    state.routeCatalog.markUnavailable(
      state.visibleRoute.connectionId,
      state.visibleRoute.providerModelId,
    );

    const second = await server.inject({
      method: "GET",
      url: "/v1/cmm/catalog",
      headers: auth,
    });
    expect(second.json().routes[0].routable).toBe(false);
  });

  it("uses the existing /v1 bearer authentication", async () => {
    const { server } = createServer();
    const response = await server.inject({ method: "GET", url: "/v1/cmm/catalog" });

    expect(response.statusCode).toBe(401);
  });

  it.each(mutationMethods)(
    "registers no %s mutation method",
    async (method) => {
      const { server } = createServer();
      const response = await server.inject({
        method,
        url: "/v1/cmm/catalog",
        headers: auth,
      });

      expect(response.statusCode).toBe(404);
    },
  );
});
