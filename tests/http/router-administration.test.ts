import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogReconciler, type CatalogRoutePolicy } from "../../src/catalog/catalog-reconciler.js";
import { CredentialBindingStore } from "../../src/catalog/credential-bindings.js";
import { ModelIdentityStore } from "../../src/catalog/model-identities.js";
import { ProviderConnectionService } from "../../src/catalog/provider-connections.js";
import { ProviderDirectory } from "../../src/catalog/provider-directory.js";
import { RouteCatalog } from "../../src/catalog/route-catalog.js";
import { RouterAdminConfigStore } from "../../src/catalog/router-admin-config-store.js";
import { RouterAdministrationService } from "../../src/catalog/router-administration-service.js";
import type { SecureCredentialResolver } from "../../src/catalog/secure-credential-resolver.js";
import type {
  SecureCredentialWriteResult,
  SecureCredentialWriter,
} from "../../src/catalog/secure-credential-writer.js";
import type { DiscoveredModel } from "../../src/core/provider.js";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";

const READ_BEARER = "router-read-bearer";
const USAGE_READ_TOKEN = "usage-read-token";
const MANAGEMENT_TOKEN = "router-management-token";
const RAW_SECRET = "raw-super-secret-value";

const readAuth = { authorization: `Bearer ${READ_BEARER}` };
const usageReadAuth = { authorization: `Bearer ${USAGE_READ_TOKEN}` };
const managementAuth = { authorization: `Bearer ${MANAGEMENT_TOKEN}` };

const mutationMethods = ["POST", "PUT", "PATCH", "DELETE"] as const;

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const routePolicy: CatalogRoutePolicy = (connection, model) => ({
  canonicalName: `${connection.providerId}:${model.providerModelId.replaceAll("/", "-")}`,
  executionProfile: "default",
  capabilities: { chat: true, tools: false, streaming: true },
  billingClass: "api",
  routable: true,
  visibility: { visibleOn: ["cmmchat_model_picker", "admin_console"] },
});

class TestSecureCredentialWriter implements SecureCredentialWriter {
  readonly values = new Map<string, string>();
  readonly writes: Array<{ bindingId: string; secret: string; secretRef: string }> = [];

  async write(bindingId: string, secret: string): Promise<SecureCredentialWriteResult> {
    const secretRef = `keychain://CMM%20Usage/${encodeURIComponent(bindingId)}`;
    this.values.set(secretRef, secret);
    this.writes.push({ bindingId, secret, secretRef });
    return { secretRef, hint: "••••test" };
  }

  async remove(secretRef: string): Promise<void> {
    this.values.delete(secretRef);
  }
}

function discoveredModel(upstreamModel: string): DiscoveredModel {
  return {
    id: `openrouter/${upstreamModel}`,
    provider: "openrouter",
    upstreamModel,
    displayName: upstreamModel,
    capability: "CHAT_AND_TOOLS",
  };
}

function connectPayload(overrides: Record<string, unknown> = {}) {
  return {
    providerId: "openrouter",
    connectionId: "openrouter-primary",
    connectionKind: "openai-chat-completions",
    secret: RAW_SECRET,
    accountId: "account-main",
    productId: "product-api",
    endpointRef: "https://openrouter.ai/api/v1",
    authorizeExecution: true,
    authorizeObservability: true,
    ...overrides,
  };
}

function createRouterState() {
  const root = mkdtempSync(join(tmpdir(), "cmm-router-admin-http-"));
  roots.push(root);

  const directory = new ProviderDirectory();
  directory.register({
    providerId: "openrouter",
    displayName: "OpenRouter",
    adapterKind: "openai-compatible",
    supportedConnectionKinds: ["openai-chat-completions"],
    discoveryCapabilities: ["models"],
  });

  const credentialBindings = new CredentialBindingStore();
  const credentialWriter = new TestSecureCredentialWriter();
  const credentialResolver: SecureCredentialResolver = {
    async resolve(secretRef) {
      const value = credentialWriter.values.get(secretRef);
      if (value === undefined) throw new Error("missing fixture secret");
      return { value };
    },
  };
  const connections = new ProviderConnectionService({
    directory,
    credentialBindings,
    credentialResolver,
    administrativeDiscovery: new Map([
      ["openrouter", async () => [discoveredModel("model-a"), discoveredModel("model-b")]],
    ]),
  });
  const modelIdentities = new ModelIdentityStore();
  const routeCatalog = new RouteCatalog({ connections, modelIdentities });
  const catalogReconciler = new CatalogReconciler({
    connections,
    modelIdentities,
    routeCatalog,
    routePolicy,
    minRefreshIntervalMs: 0,
  });
  const configStore = new RouterAdminConfigStore(root);
  const administration = new RouterAdministrationService({
    directory,
    connections,
    credentialBindings,
    routeCatalog,
    catalogReconciler,
    configStore,
    credentialWriter,
  });

  const server = buildServer({
    host: "127.0.0.1",
    port: 0,
    bearerSecret: READ_BEARER,
    usageToken: USAGE_READ_TOKEN,
    usageManagementToken: MANAGEMENT_TOKEN,
    registry: new ProviderRegistry(),
    routerAdministration: administration,
    catalogProjectionInput: {
      directory,
      accounts: [],
      products: [],
      connections,
      modelIdentities,
      routeCatalog,
    },
  });

  return {
    administration,
    catalogReconciler,
    configStore,
    connections,
    credentialBindings,
    credentialWriter,
    directory,
    modelIdentities,
    routeCatalog,
    server,
  };
}

async function connectProvider(state: ReturnType<typeof createRouterState>) {
  const response = await state.server.inject({
    method: "POST",
    url: "/v1/cmm/catalog/connections",
    headers: managementAuth,
    payload: connectPayload(),
  });
  expect(response.statusCode).toBe(200);
  return response;
}

describe("Router administration HTTP API", () => {
  it("serves the canonical catalog projection to the read bearer", async () => {
    const state = createRouterState();
    await connectProvider(state);

    const response = await state.server.inject({
      method: "GET",
      url: "/v1/cmm/catalog",
      headers: readAuth,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.providers).toEqual([
      { providerId: "openrouter", displayName: "OpenRouter" },
    ]);
    expect(body.connections).toHaveLength(1);
    expect(body.routes).toHaveLength(2);
    expect(response.body).not.toMatch(/secret|keychain/i);
  });

  it("rejects router administration mutation from the read bearer", async () => {
    const state = createRouterState();

    const response = await state.server.inject({
      method: "POST",
      url: "/v1/cmm/catalog/connections",
      headers: readAuth,
      payload: connectPayload(),
    });

    expect([401, 403]).toContain(response.statusCode);
    expect(state.connections.list()).toEqual([]);
    expect(state.credentialWriter.writes).toEqual([]);
    expect(response.body).not.toContain(RAW_SECRET);
  });

  it("rejects router administration mutation from the Usage read token", async () => {
    const state = createRouterState();

    const response = await state.server.inject({
      method: "POST",
      url: "/v1/cmm/catalog/connections",
      headers: usageReadAuth,
      payload: connectPayload(),
    });

    expect([401, 403]).toContain(response.statusCode);
    expect(state.connections.list()).toEqual([]);
    expect(state.credentialWriter.writes).toEqual([]);
    expect(response.body).not.toContain(RAW_SECRET);
  });

  it("connects a provider with the management credential without echoing the secret", async () => {
    const state = createRouterState();

    const response = await connectProvider(state);

    expect(response.json()).toMatchObject({
      connectionId: "openrouter-primary",
      providerId: "openrouter",
      connectionKind: "openai-chat-completions",
      enabled: true,
      executionAuthorized: true,
      observabilityAuthorized: true,
    });
    expect(response.body).not.toContain(RAW_SECRET);
    expect(response.body).not.toMatch(/secretRef|keychain/i);

    expect(state.credentialWriter.writes).toHaveLength(1);
    const secretRef = state.credentialWriter.writes[0]!.secretRef;
    expect(state.credentialBindings.getExecution("execution:openrouter-primary")).toMatchObject({
      purpose: "execution",
      secretRef,
    });
    expect(
      state.credentialBindings.getObservability("observability:openrouter-primary"),
    ).toMatchObject({ purpose: "observability", secretRef });
    expect(JSON.stringify(state.configStore.read())).not.toContain(RAW_SECRET);
  });

  it("changes visibility for exactly one route with the management credential", async () => {
    const state = createRouterState();
    await connectProvider(state);
    const [routeA, routeB] = state.routeCatalog.list();
    expect(routeA).toBeDefined();
    expect(routeB).toBeDefined();
    const connectionBefore = state.connections.get("openrouter-primary");

    const response = await state.server.inject({
      method: "PATCH",
      url: `/v1/cmm/catalog/routes/${encodeURIComponent(routeA!.routeId)}/visibility`,
      headers: managementAuth,
      payload: { visibleOn: ["admin_console"] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toMatch(/secret|keychain/i);
    expect(state.routeCatalog.get(routeA!.routeId)?.visibility.visibleOn).toEqual([
      "admin_console",
    ]);
    expect(state.routeCatalog.get(routeB!.routeId)?.visibility.visibleOn).toContain(
      "cmmchat_model_picker",
    );
    expect(state.routeCatalog.get(routeA!.routeId)?.routable).toBe(routeA!.routable);
    expect(state.connections.get("openrouter-primary")).toEqual(connectionBefore);
    expect(state.configStore.read().routeVisibility).toEqual([
      { routeId: routeA!.routeId, visibleOn: ["admin_console"] },
    ]);
  });

  it("enables and disables a connection with the management credential", async () => {
    const state = createRouterState();
    await connectProvider(state);

    const disabled = await state.server.inject({
      method: "PATCH",
      url: "/v1/cmm/catalog/connections/openrouter-primary",
      headers: managementAuth,
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ enabled: false, status: "disabled" });
    expect(state.connections.get("openrouter-primary")?.status).toBe("disabled");

    const enabled = await state.server.inject({
      method: "PATCH",
      url: "/v1/cmm/catalog/connections/openrouter-primary",
      headers: managementAuth,
      payload: { enabled: true },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ enabled: true, status: "configured" });
  });

  it("validates and refreshes a connection with the management credential", async () => {
    const state = createRouterState();
    await connectProvider(state);

    const validated = await state.server.inject({
      method: "POST",
      url: "/v1/cmm/catalog/connections/openrouter-primary/validate",
      headers: managementAuth,
    });
    expect(validated.statusCode).toBe(200);
    expect(validated.json()).toMatchObject({
      connectionId: "openrouter-primary",
      status: "ready",
    });
    expect(validated.body).not.toMatch(/secret|keychain/i);

    const refreshed = await state.server.inject({
      method: "POST",
      url: "/v1/cmm/catalog/connections/openrouter-primary/refresh",
      headers: managementAuth,
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({
      connectionId: "openrouter-primary",
      failed: false,
    });
    expect(refreshed.body).not.toMatch(/secret|keychain/i);
  });

  it("disconnects a connection with the management credential", async () => {
    const state = createRouterState();
    await connectProvider(state);

    const response = await state.server.inject({
      method: "DELETE",
      url: "/v1/cmm/catalog/connections/openrouter-primary",
      headers: managementAuth,
    });

    expect(response.statusCode).toBe(204);
    expect(state.connections.get("openrouter-primary")).toBeUndefined();
    expect(state.configStore.read().administrativeConnections).toEqual([]);
  });

  it("adds a custom endpoint with the management credential", async () => {
    const state = createRouterState();

    const response = await state.server.inject({
      method: "POST",
      url: "/v1/cmm/catalog/custom-endpoints",
      headers: managementAuth,
      payload: {
        connectionId: "my-custom-endpoint",
        displayName: "Local compatible endpoint",
        endpointUrl: "https://example.invalid/v1",
        apiKey: RAW_SECRET,
        defaultModel: "Vendor/Model-A",
        visibleOn: ["cmmcode_model_picker", "admin_console"],
      },
    });

    expect(response.statusCode).toBe(200);
    const summary = response.json() as { connectionId: string; providerId: string };
    expect(summary.connectionId).toMatch(/^conn_[a-f0-9]{16}$/u);
    expect(summary.providerId).not.toMatch(/^provider:custom:/u);
    expect(response.body).not.toContain(RAW_SECRET);
    expect(response.body).not.toMatch(/secretRef|keychain/i);
    const route = state.routeCatalog
      .list()
      .find((entry) => entry.connectionId === summary.connectionId);
    expect(route).toMatchObject({
      providerModelId: "Vendor/Model-A",
      visibility: { visibleOn: ["cmmcode_model_picker", "admin_console"] },
    });
  });

  it("rejects an unknown provider without mutating Router state", async () => {
    const state = createRouterState();
    const beforeConnections = state.connections.list();
    const beforeConfig = state.configStore.read();

    const response = await state.server.inject({
      method: "POST",
      url: "/v1/cmm/catalog/connections",
      headers: managementAuth,
      payload: connectPayload({ providerId: "missing-provider" }),
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
    expect(state.connections.list()).toEqual(beforeConnections);
    expect(state.configStore.read()).toEqual(beforeConfig);
    expect(state.credentialWriter.writes).toEqual([]);
    expect(response.body).not.toContain(RAW_SECRET);
  });

  it("rejects an unsupported connection kind without mutating Router state", async () => {
    const state = createRouterState();
    const beforeConnections = state.connections.list();
    const beforeConfig = state.configStore.read();

    const response = await state.server.inject({
      method: "POST",
      url: "/v1/cmm/catalog/connections",
      headers: managementAuth,
      payload: connectPayload({ connectionKind: "unsupported-kind" }),
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
    expect(state.connections.list()).toEqual(beforeConnections);
    expect(state.configStore.read()).toEqual(beforeConfig);
    expect(state.credentialWriter.writes).toEqual([]);
    expect(response.body).not.toContain(RAW_SECRET);
  });

  it("rejects an invalid request body without mutating Router state", async () => {
    const state = createRouterState();

    const response = await state.server.inject({
      method: "POST",
      url: "/v1/cmm/catalog/connections",
      headers: managementAuth,
      payload: { providerId: "openrouter" },
    });

    expect(response.statusCode).toBe(400);
    expect(state.connections.list()).toEqual([]);
    expect(state.credentialWriter.writes).toEqual([]);
  });

  it.each(mutationMethods)(
    "registers no %s mutation on the base catalog path",
    async (method) => {
      const state = createRouterState();

      const response = await state.server.inject({
        method,
        url: "/v1/cmm/catalog",
        headers: readAuth,
      });

      expect(response.statusCode).toBe(404);
    },
  );

  it("accepts the privileged credential on administration paths with a query string", async () => {
    const state = createRouterState();

    const response = await state.server.inject({
      method: "POST",
      url: "/v1/cmm/catalog/connections?source=probe",
      headers: managementAuth,
      payload: connectPayload(),
    });

    expect(response.statusCode).toBe(200);
    expect(state.connections.list()).toHaveLength(1);
  });

  it("keeps the privileged credential out of inference endpoints", async () => {
    const state = createRouterState();

    const response = await state.server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { ...managementAuth, "content-type": "application/json" },
      payload: { model: "anything", messages: [{ role: "user", content: "hi" }] },
    });

    expect(response.statusCode).toBe(403);
  });
});
