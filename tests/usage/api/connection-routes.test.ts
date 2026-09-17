import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CatalogReconciler,
  type CatalogRoutePolicy,
} from "../../../src/catalog/catalog-reconciler.js";
import { CredentialBindingStore } from "../../../src/catalog/credential-bindings.js";
import { ModelIdentityStore } from "../../../src/catalog/model-identities.js";
import { buildRouterCatalogProjection } from "../../../src/catalog/projection.js";
import { ProviderConnectionService } from "../../../src/catalog/provider-connections.js";
import { ProviderDirectory } from "../../../src/catalog/provider-directory.js";
import { RouteCatalog } from "../../../src/catalog/route-catalog.js";
import { RouteVisibilityPolicy } from "../../../src/catalog/route-visibility-policy.js";
import { RouterAdminConfigStore } from "../../../src/catalog/router-admin-config-store.js";
import { RouterAdministrationService } from "../../../src/catalog/router-administration-service.js";
import type { SecureCredentialResolver } from "../../../src/catalog/secure-credential-resolver.js";
import type {
  SecureCredentialWriteResult,
  SecureCredentialWriter,
} from "../../../src/catalog/secure-credential-writer.js";
import type { DiscoveredModel } from "../../../src/core/provider.js";
import { buildServer } from "../../../src/http/server.js";
import { ProviderRegistry } from "../../../src/registry/provider-registry.js";
import { ConfiguredUsageRuntime, UsageIntegrationCatalog } from "../../../src/usage/runtime/configured-runtime.js";
import { ManagedConfigStore } from "../../../src/usage/runtime/managed-config-store.js";
import { VisibilityStore } from "../../../src/usage/presentation/visibility-store.js";
import { ConnectionManagementService } from "../../../src/usage/service/connection-management-service.js";
import { SqliteUsageStore } from "../../../src/usage/storage/sqlite-usage-store.js";

const dirs: string[] = [];
const stores: SqliteUsageStore[] = [];
const readToken = "usage-read-token";
const managementToken = "usage-management-token";
const RAW_SECRET = "secret-value";

const USAGE_JSON = `${JSON.stringify({ version: 1, integrations: [] }, null, 2)}\n`;

class MemorySecureCredentialWriter implements SecureCredentialWriter {
  readonly values = new Map<string, string>();

  async write(bindingId: string, secret: string): Promise<SecureCredentialWriteResult> {
    const secretRef = `keychain://CMM%20Usage/${encodeURIComponent(bindingId)}`;
    this.values.set(secretRef, secret);
    return { secretRef, hint: "••••test" };
  }

  async remove(secretRef: string): Promise<void> {
    this.values.delete(secretRef);
  }
}

function discoveredModel(
  upstreamModel: string,
  capability: NonNullable<DiscoveredModel["capability"]>,
): DiscoveredModel {
  return {
    id: `openrouter/${upstreamModel}`,
    provider: "openrouter",
    upstreamModel,
    displayName: upstreamModel,
    capability,
  };
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "cmm-connection-api-"));
  dirs.push(dir);
  writeFileSync(join(dir, "usage.json"), USAGE_JSON);

  const directory = new ProviderDirectory();
  directory.register({
    providerId: "openrouter",
    displayName: "OpenRouter",
    adapterKind: "openai-compatible",
    supportedConnectionKinds: ["openai-chat-completions"],
    discoveryCapabilities: ["models"],
  });

  const credentialBindings = new CredentialBindingStore();
  const credentialWriter = new MemorySecureCredentialWriter();
  const credentialResolver: SecureCredentialResolver = {
    async resolve(secretRef) {
      const value = credentialWriter.values.get(secretRef);
      if (value === undefined) throw new Error("missing fixture secret");
      return { value };
    },
  };
  const providerConnections = new ProviderConnectionService({
    directory,
    credentialBindings,
    credentialResolver,
    administrativeDiscovery: new Map([
      [
        "openrouter",
        async () => [
          discoveredModel("model-tools", "CHAT_AND_TOOLS"),
          discoveredModel("model-chat", "CHAT_ONLY"),
        ],
      ],
    ]),
  });
  const modelIdentities = new ModelIdentityStore();
  const routeCatalog = new RouteCatalog({ connections: providerConnections, modelIdentities });
  const routeVisibilityPolicy = new RouteVisibilityPolicy();
  const routePolicy: CatalogRoutePolicy = (connection, model) => {
    const toolCapable = model.capabilities?.tools === true;
    return {
      canonicalName: `${connection.providerId}:${model.providerModelId}`,
      executionProfile: "default",
      capabilities: { chat: true, tools: toolCapable, streaming: true },
      billingClass: "api",
      routable: true,
      visibility: routeVisibilityPolicy.resolve({
        providerId: connection.providerId,
        providerModelId: model.providerModelId,
        toolCapable,
        exactRouteExecutable: true,
      }),
    };
  };
  const catalogReconciler = new CatalogReconciler({
    connections: providerConnections,
    modelIdentities,
    routeCatalog,
    routePolicy,
    minRefreshIntervalMs: 0,
  });
  const administration = new RouterAdministrationService({
    directory,
    connections: providerConnections,
    credentialBindings,
    routeCatalog,
    catalogReconciler,
    configStore: new RouterAdminConfigStore(dir),
    credentialWriter,
    routeVisibilityPolicy,
  });

  const store = new SqliteUsageStore(":memory:");
  stores.push(store);
  await store.initialize();
  const usageRuntime = new ConfiguredUsageRuntime(store, new UsageIntegrationCatalog());
  const visibility = new VisibilityStore(store);
  const connections = new ConnectionManagementService(administration, {
    collectorRefresh: usageRuntime.service,
    routerCatalog: {
      read: () =>
        buildRouterCatalogProjection({
          directory,
          accounts: [],
          products: [],
          connections: providerConnections,
          modelIdentities,
          routeCatalog,
        }),
    },
  });

  const server = buildServer({
    host: "127.0.0.1",
    port: 0,
    bearerSecret: "chat-secret",
    usageToken: readToken,
    usageManagementToken: managementToken,
    registry: new ProviderRegistry(),
    cmmUsageService: usageRuntime.service,
    cmmUsageConnections: connections,
    cmmUsageVisibility: visibility,
    routerAdministration: administration,
    catalogProjectionInput: {
      directory,
      accounts: [],
      products: [],
      connections: providerConnections,
      modelIdentities,
      routeCatalog,
    },
  });

  return {
    dir,
    administration,
    providerConnections,
    routeCatalog,
    visibility,
    server,
  };
}

function usageJson(dir: string): string {
  return readFileSync(join(dir, "usage.json"), "utf8");
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CMM Usage privileged connection API", () => {
  it("rejects provider mutation with the read-only Usage bearer", async () => {
    const { server, providerConnections, dir } = await setup();
    const connect = vi.spyOn(RouterAdministrationService.prototype, "connect");

    const response = await server.inject({
      method: "POST",
      url: "/v1/cmm/usage/connections/api-key",
      headers: { authorization: `Bearer ${readToken}`, "content-type": "application/json" },
      payload: { integrationType: "openrouter", instanceId: "openrouter-primary", secret: RAW_SECRET },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { type: "usage_scope_forbidden" } });
    expect(connect).not.toHaveBeenCalled();
    expect(providerConnections.list()).toEqual([]);
    expect(usageJson(dir)).toBe(USAGE_JSON);
    await server.close();
  });

  it("delegates an api-key connect to Router administration exactly once", async () => {
    const { server, administration, providerConnections, visibility, dir } = await setup();
    const connect = vi.spyOn(RouterAdministrationService.prototype, "connect");
    const configUpdate = vi.spyOn(ManagedConfigStore.prototype, "update");

    const response = await server.inject({
      method: "POST",
      url: "/v1/cmm/usage/connections/api-key",
      headers: { authorization: `Bearer ${managementToken}`, "content-type": "application/json" },
      payload: { integrationType: "openrouter", instanceId: "openrouter-primary", secret: RAW_SECRET },
    });

    expect(response.statusCode).toBe(200);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith({
      providerId: "openrouter",
      connectionId: "openrouter-primary",
      connectionKind: "openai-chat-completions",
      secret: RAW_SECRET,
      authorizeExecution: true,
      authorizeObservability: true,
    });
    // Router owns the connection: the canonical graph is the only writer.
    expect(providerConnections.get("openrouter-primary")?.providerId).toBe("openrouter");
    expect(administration.connectionKindFor("openrouter")).toBe("openai-chat-completions");
    // No compatibility operation writes Router-owned state to Usage storage.
    expect(configUpdate).not.toHaveBeenCalled();
    expect(await visibility.list()).toEqual([]);
    expect(usageJson(dir)).toBe(USAGE_JSON);

    expect(response.json()).toMatchObject({
      id: "openrouter-primary",
      type: "openrouter",
      enabled: true,
      executionAuthorized: true,
      observabilityAuthorized: true,
    });
    expect(response.body).not.toContain(RAW_SECRET);
    expect(response.body).not.toContain("keychain://");
    expect(response.body).not.toContain("credentialRef");
    expect(response.body).not.toContain("secretRef");
    await server.close();
  });

  it("delegates the legacy visibility mutation to Router administration", async () => {
    const { server, routeCatalog, visibility, dir } = await setup();
    await server.inject({
      method: "POST",
      url: "/v1/cmm/usage/connections/api-key",
      headers: { authorization: `Bearer ${managementToken}`, "content-type": "application/json" },
      payload: { integrationType: "openrouter", instanceId: "openrouter-primary", secret: RAW_SECRET },
    });
    const route = routeCatalog.list().find((entry) => entry.providerModelId === "model-tools");
    expect(route).toBeDefined();
    const setRouteVisibility = vi.spyOn(RouterAdministrationService.prototype, "setRouteVisibility");

    const response = await server.inject({
      method: "PATCH",
      url: "/v1/cmm/usage/catalog/visibility",
      headers: { authorization: `Bearer ${managementToken}`, "content-type": "application/json" },
      payload: { routeId: route!.routeId, state: "hidden" },
    });

    expect(response.statusCode).toBe(200);
    expect(setRouteVisibility).toHaveBeenCalledTimes(1);
    expect(setRouteVisibility).toHaveBeenCalledWith(route!.routeId, ["admin_console"]);
    expect(routeCatalog.get(route!.routeId)?.visibility.visibleOn).toEqual(["admin_console"]);
    // Hiding is a visibility-only change: routability and siblings are untouched.
    expect(routeCatalog.get(route!.routeId)?.routable).toBe(true);
    expect(await visibility.list()).toEqual([]);
    expect(usageJson(dir)).toBe(USAGE_JSON);
    await server.close();
  });

  it("fails closed on an inherit visibility mutation instead of pinning a default", async () => {
    const { server, routeCatalog, visibility } = await setup();
    await server.inject({
      method: "POST",
      url: "/v1/cmm/usage/connections/api-key",
      headers: { authorization: `Bearer ${managementToken}`, "content-type": "application/json" },
      payload: { integrationType: "openrouter", instanceId: "openrouter-primary", secret: RAW_SECRET },
    });
    const route = routeCatalog.list().find((entry) => entry.providerModelId === "model-tools")!;
    await server.inject({
      method: "PATCH",
      url: "/v1/cmm/usage/catalog/visibility",
      headers: { authorization: `Bearer ${managementToken}`, "content-type": "application/json" },
      payload: { routeId: route.routeId, state: "hidden" },
    });
    const hidden = routeCatalog.get(route.routeId)!.visibility.visibleOn;

    const response = await server.inject({
      method: "PATCH",
      url: "/v1/cmm/usage/catalog/visibility",
      headers: { authorization: `Bearer ${managementToken}`, "content-type": "application/json" },
      payload: { routeId: route.routeId, state: "inherit" },
    });

    expect(response.statusCode).toBe(400);
    expect(routeCatalog.get(route.routeId)!.visibility.visibleOn).toEqual(hidden);
    expect(await visibility.list()).toEqual([]);
    await server.close();
  });

  it("restores canonical executable surfaces for visible, honouring per-route capability", async () => {
    const { server, routeCatalog } = await setup();
    await server.inject({
      method: "POST",
      url: "/v1/cmm/usage/connections/api-key",
      headers: { authorization: `Bearer ${managementToken}`, "content-type": "application/json" },
      payload: { integrationType: "openrouter", instanceId: "openrouter-primary", secret: RAW_SECRET },
    });
    const toolRoute = routeCatalog.list().find((entry) => entry.providerModelId === "model-tools")!;
    const chatRoute = routeCatalog.list().find((entry) => entry.providerModelId === "model-chat")!;

    for (const state of ["hidden", "visible"]) {
      const response = await server.inject({
        method: "PATCH",
        url: "/v1/cmm/usage/catalog/visibility",
        headers: { authorization: `Bearer ${managementToken}`, "content-type": "application/json" },
        payload: { routeId: toolRoute.routeId, state },
      });
      expect(response.statusCode).toBe(200);
    }
    expect(routeCatalog.get(toolRoute.routeId)?.visibility.visibleOn).toEqual([
      "cmmchat_model_picker",
      "cmmcode_model_picker",
      "admin_console",
    ]);

    const chatResponse = await server.inject({
      method: "PATCH",
      url: "/v1/cmm/usage/catalog/visibility",
      headers: { authorization: `Bearer ${managementToken}`, "content-type": "application/json" },
      payload: { routeId: chatRoute.routeId, state: "visible" },
    });
    expect(chatResponse.statusCode).toBe(200);
    // A route that is not tool-capable must never be restored onto the tool surface.
    expect(routeCatalog.get(chatRoute.routeId)?.visibility.visibleOn).toEqual([
      "cmmchat_model_picker",
      "admin_console",
    ]);
    await server.close();
  });

  it("fails closed instead of inventing visibility for an unknown route", async () => {
    const { server, routeCatalog, visibility } = await setup();
    const before = routeCatalog.list().map((route) => route.visibility.visibleOn);

    const response = await server.inject({
      method: "PATCH",
      url: "/v1/cmm/usage/catalog/visibility",
      headers: { authorization: `Bearer ${managementToken}`, "content-type": "application/json" },
      payload: { routeId: "route:does-not-exist", state: "visible" },
    });

    expect(response.statusCode).toBe(404);
    expect(routeCatalog.list().map((route) => route.visibility.visibleOn)).toEqual(before);
    expect(await visibility.list()).toEqual([]);
    await server.close();
  });

  it("rejects an unknown Router provider instead of fabricating a connection", async () => {
    const { server, providerConnections } = await setup();

    const response = await server.inject({
      method: "POST",
      url: "/v1/cmm/usage/connections/api-key",
      headers: { authorization: `Bearer ${managementToken}`, "content-type": "application/json" },
      payload: { integrationType: "mystery", instanceId: "mystery-primary", secret: RAW_SECRET },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { type: "usage_connection_unknown_target" } });
    expect(response.body).not.toContain(RAW_SECRET);
    expect(providerConnections.list()).toEqual([]);
    await server.close();
  });

  it("reports unavailable Router administration instead of writing a second state graph", async () => {
    const isolated = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: "chat-secret",
      usageManagementToken: managementToken,
      registry: new ProviderRegistry(),
      cmmUsageConnections: new ConnectionManagementService(undefined),
    });

    const response = await isolated.inject({
      method: "POST",
      url: "/v1/cmm/usage/connections/api-key",
      headers: { authorization: `Bearer ${managementToken}`, "content-type": "application/json" },
      payload: { integrationType: "openrouter", instanceId: "openrouter-primary", secret: RAW_SECRET },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { type: "usage_connection_authority_unavailable" },
    });
    expect(response.body).not.toContain(RAW_SECRET);
    await isolated.close();
  });
});
