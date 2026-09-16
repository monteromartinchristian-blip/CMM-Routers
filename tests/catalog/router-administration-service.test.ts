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
import type {
  SecureCredentialWriteResult,
  SecureCredentialWriter,
} from "../../src/catalog/secure-credential-writer.js";
import type { SecureCredentialResolver } from "../../src/catalog/secure-credential-resolver.js";
import type { ProviderConnection } from "../../src/catalog/types.js";
import type { DiscoveredModel } from "../../src/core/provider.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const policy: CatalogRoutePolicy = (connection, model) => {
  if (connection.providerId !== "openrouter") {
    throw new Error("fixture policy only knows configured provider-wave entries");
  }
  return {
    canonicalName: `${connection.providerId}:${model.providerModelId.replaceAll("/", "-")}`,
    executionProfile: "default",
    capabilities: {
      chat: true,
      tools: model.capabilities?.tools === true,
      streaming: true,
    },
    billingClass: "api",
    routable: true,
    visibility: { visibleOn: ["cmmchat_model_picker", "admin_console"] },
  };
};

class TestSecureCredentialWriter implements SecureCredentialWriter {
  readonly values = new Map<string, string>();
  readonly writes: Array<{ bindingId: string; secret: string; secretRef: string }> = [];
  readonly removals: string[] = [];

  async write(bindingId: string, secret: string): Promise<SecureCredentialWriteResult> {
    const secretRef = `keychain://CMM%20Usage/${encodeURIComponent(bindingId)}`;
    this.values.set(secretRef, secret);
    this.writes.push({ bindingId, secret, secretRef });
    return { secretRef, hint: "••••test" };
  }

  async remove(secretRef: string): Promise<void> {
    this.removals.push(secretRef);
    this.values.delete(secretRef);
  }
}

class FailingRouterAdminConfigStore extends RouterAdminConfigStore {
  override async write(): Promise<void> {
    throw new Error("fixture persistence failure");
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

function setup(options: { failPersistence?: boolean; models?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cmm-router-admin-service-"));
  roots.push(root);

  const directory = new ProviderDirectory();
  directory.register({
    providerId: "openrouter",
    displayName: "OpenRouter",
    adapterKind: "openai-compatible",
    supportedConnectionKinds: ["openai-chat-completions"],
    discoveryCapabilities: ["models"],
  });

  const bindings = new CredentialBindingStore();
  const credentialWriter = new TestSecureCredentialWriter();
  const credentialResolver: SecureCredentialResolver = {
    async resolve(secretRef) {
      const value = credentialWriter.values.get(secretRef);
      if (value === undefined) throw new Error("missing fixture secret");
      return { value };
    },
  };
  const models = options.models ?? ["model-a"];
  const connections = new ProviderConnectionService({
    directory,
    credentialBindings: bindings,
    credentialResolver,
    administrativeDiscovery: new Map([
      ["openrouter", async () => models.map(discoveredModel)],
    ]),
  });
  const modelIdentities = new ModelIdentityStore();
  const routeCatalog = new RouteCatalog({ connections, modelIdentities });
  const reconciler = new CatalogReconciler({
    connections,
    modelIdentities,
    routeCatalog,
    routePolicy: policy,
    minRefreshIntervalMs: 0,
  });
  const configStore = options.failPersistence
    ? new FailingRouterAdminConfigStore(root)
    : new RouterAdminConfigStore(root);
  const service = new RouterAdministrationService({
    directory,
    connections,
    credentialBindings: bindings,
    routeCatalog,
    catalogReconciler: reconciler,
    configStore,
    credentialWriter,
  });

  return {
    bindings,
    configStore,
    connections,
    credentialWriter,
    directory,
    routeCatalog,
    service,
  };
}

function connectInput(overrides: Partial<Parameters<RouterAdministrationService["connect"]>[0]> = {}) {
  return {
    providerId: "openrouter",
    connectionId: "openrouter-primary",
    connectionKind: "openai-chat-completions",
    secret: "raw-super-secret",
    accountId: "account-main",
    productId: "product-api",
    endpointRef: "https://openrouter.ai/api/v1",
    authorizeExecution: true,
    authorizeObservability: true,
    ...overrides,
  };
}

describe("RouterAdministrationService", () => {
  it("fails unknown providers without secure writes or Router persistence", async () => {
    const state = setup();
    const before = state.configStore.read();

    await expect(
      state.service.connect(connectInput({ providerId: "missing-provider" })),
    ).rejects.toThrow(/unknown provider/i);

    expect(state.credentialWriter.writes).toEqual([]);
    expect(state.connections.list()).toEqual([]);
    expect(state.configStore.read()).toEqual(before);
  });

  it("fails unsupported connection kinds without secure writes or Router persistence", async () => {
    const state = setup();
    const before = state.configStore.read();

    await expect(
      state.service.connect(connectInput({ connectionKind: "unsupported-kind" })),
    ).rejects.toThrow(/does not support connection kind/i);

    expect(state.credentialWriter.writes).toEqual([]);
    expect(state.connections.list()).toEqual([]);
    expect(state.configStore.read()).toEqual(before);
  });

  it("stores raw credentials securely and persists only secure references", async () => {
    const state = setup();

    const summary = await state.service.connect(connectInput());

    expect(summary).toMatchObject({
      connectionId: "openrouter-primary",
      providerId: "openrouter",
      enabled: true,
      executionAuthorized: true,
      observabilityAuthorized: true,
    });
    expect(state.credentialWriter.writes).toHaveLength(1);
    const secretRef = state.credentialWriter.writes[0]!.secretRef;
    expect(state.bindings.getExecution("execution:openrouter-primary")).toMatchObject({
      purpose: "execution",
      secretRef,
    });
    expect(state.bindings.getObservability("observability:openrouter-primary")).toMatchObject({
      purpose: "observability",
      secretRef,
    });
    const persisted = state.configStore.read();
    expect(persisted.administrativeConnections).toEqual([
      expect.objectContaining({
        connectionId: "openrouter-primary",
        executionSecretRef: secretRef,
        observabilitySecretRef: secretRef,
      }),
    ]);
    expect(JSON.stringify(persisted)).not.toContain("raw-super-secret");
    expect(JSON.stringify(summary)).not.toContain("raw-super-secret");
    expect(JSON.stringify(summary)).not.toContain(secretRef);
  });

  it("creates execution and observability authorization independently", async () => {
    const executionOnly = setup();
    await executionOnly.service.connect(connectInput({ authorizeObservability: false }));
    expect(executionOnly.bindings.getExecution("execution:openrouter-primary")).toMatchObject({
      purpose: "execution",
    });
    expect(
      executionOnly.bindings.getObservability("observability:openrouter-primary"),
    ).toBeUndefined();

    const observabilityOnly = setup();
    await observabilityOnly.service.connect(connectInput({ authorizeExecution: false }));
    expect(
      observabilityOnly.bindings.getExecution("execution:openrouter-primary"),
    ).toBeUndefined();
    expect(
      observabilityOnly.bindings.getObservability("observability:openrouter-primary"),
    ).toMatchObject({ purpose: "observability" });
  });

  it("keeps execution valid when observability authorization is removed", async () => {
    const state = setup();
    await state.service.connect(connectInput());

    expect(state.bindings.removeObservability("observability:openrouter-primary")).toBe(true);

    expect(state.connections.authorizeExecution("openrouter-primary")).toMatchObject({
      connectionId: "openrouter-primary",
      executionCredentialBindingId: "execution:openrouter-primary",
    });
  });

  it("disconnect removes only Router connection authority", async () => {
    const state = setup();
    await state.service.connect(connectInput());
    const writtenRef = state.credentialWriter.writes[0]!.secretRef;

    await state.service.disconnect("openrouter-primary");

    expect(state.connections.get("openrouter-primary")).toBeUndefined();
    expect(state.bindings.getExecution("execution:openrouter-primary")).toBeUndefined();
    expect(
      state.bindings.getObservability("observability:openrouter-primary"),
    ).toBeUndefined();
    expect(state.configStore.read().administrativeConnections).toEqual([]);
    expect(state.credentialWriter.removals).toContain(writtenRef);
  });

  it("changes visibility for exactly one route without changing routability or connection state", async () => {
    const state = setup({ models: ["model-a", "model-b"] });
    await state.service.connect(connectInput());
    const [target, sibling] = state.routeCatalog.list();
    const connectionBefore = state.connections.get("openrouter-primary");
    expect(target).toBeDefined();
    expect(sibling).toBeDefined();

    const changed = await state.service.setRouteVisibility(target!.routeId, ["admin_console"]);

    expect(changed.visibility.visibleOn).toEqual(["admin_console"]);
    expect(changed.routable).toBe(target!.routable);
    expect(state.routeCatalog.get(sibling!.routeId)).toEqual(sibling);
    expect(state.connections.get("openrouter-primary")).toEqual(connectionBefore);
    expect(state.configStore.read().routeVisibility).toEqual([
      { routeId: target!.routeId, visibleOn: ["admin_console"] },
    ]);
  });

  it("creates custom endpoints with Router canonical connection and route identities", async () => {
    const state = setup();

    const summary = await state.service.addCustomEndpoint({
      connectionId: "my-custom-endpoint",
      displayName: "Local compatible endpoint",
      endpointUrl: "https://example.invalid/v1",
      apiKey: "custom-raw-secret",
      defaultModel: "Vendor/Model-A",
      visibleOn: ["cmmcode_model_picker", "admin_console"],
    });

    expect(summary.connectionId).toMatch(/^conn_[a-f0-9]{16}$/u);
    expect(summary.connectionId).not.toBe("my-custom-endpoint");
    expect(summary.providerId).not.toMatch(/^provider:custom:/u);
    const route = state.routeCatalog.list().find((entry) => entry.connectionId === summary.connectionId);
    expect(route).toMatchObject({
      connectionId: summary.connectionId,
      providerModelId: "Vendor/Model-A",
      visibility: { visibleOn: ["cmmcode_model_picker", "admin_console"] },
      routable: true,
    });
    expect(route?.routeId).toMatch(/^route_[a-f0-9]{16}$/u);
    expect(route?.routeId).not.toMatch(/^route:custom:/u);
    expect(JSON.stringify(state.configStore.read())).not.toContain("custom-raw-secret");
  });

  it("rolls back only newly created Router state and the newly written secret when persistence fails", async () => {
    const state = setup({ failPersistence: true });

    await expect(state.service.connect(connectInput())).rejects.toThrow(/persistence failure/i);

    expect(state.connections.get("openrouter-primary")).toBeUndefined();
    expect(state.bindings.getExecution("execution:openrouter-primary")).toBeUndefined();
    expect(
      state.bindings.getObservability("observability:openrouter-primary"),
    ).toBeUndefined();
    expect(state.credentialWriter.writes).toHaveLength(1);
    expect(state.credentialWriter.removals).toEqual([
      state.credentialWriter.writes[0]!.secretRef,
    ]);
    expect(state.credentialWriter.values.size).toBe(0);
  });
});
