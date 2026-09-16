import { describe, expect, it } from "vitest";
import { CredentialBindingStore } from "../../src/catalog/credential-bindings.js";
import { ProviderConnectionService } from "../../src/catalog/provider-connections.js";
import { ProviderDirectory } from "../../src/catalog/provider-directory.js";
import type { ProviderConnection, ProviderDefinition } from "../../src/catalog/types.js";
import type { DiscoveredModel } from "../../src/core/provider.js";
import { InMemorySecureCredentialResolver } from "../support/in-memory-secure-credential-resolver.js";

const SECRET_REF = "keychain://openrouter/main";

function providerDefinition(): ProviderDefinition {
  return {
    providerId: "openrouter",
    displayName: "OpenRouter",
    adapterKind: "openai-compatible",
    supportedConnectionKinds: ["openai-chat-completions"],
    discoveryCapabilities: ["models"],
  };
}

function connection(
  overrides: Partial<ProviderConnection> = {},
): ProviderConnection {
  return {
    connectionId: "connection-main",
    providerId: "openrouter",
    accountId: "account-main",
    productId: "product-api",
    connectionKind: "openai-chat-completions",
    executionCredentialBindingId: "execution-main",
    endpointRef: "https://openrouter.ai/api/v1",
    status: "configured",
    ...overrides,
  };
}

function discoveredModel(
  upstreamModel: string,
  displayName = upstreamModel,
): DiscoveredModel {
  return {
    id: `openrouter/${upstreamModel}`,
    provider: "openrouter",
    upstreamModel,
    displayName,
    capability: "CHAT_AND_TOOLS",
  };
}

function setup(
  discover: (
    connection: Readonly<ProviderConnection>,
    secret: Readonly<{ value: string }>,
  ) => Promise<readonly DiscoveredModel[]> = async () => [],
) {
  const directory = new ProviderDirectory();
  directory.register(providerDefinition());
  const bindings = new CredentialBindingStore();
  const resolver = new InMemorySecureCredentialResolver(
    new Map([[SECRET_REF, "resolved-test-secret"]]),
  );
  const administrativeDiscovery = new Map([["openrouter", discover]]);
  const service = new ProviderConnectionService({
    directory,
    credentialBindings: bindings,
    credentialResolver: resolver,
    administrativeDiscovery,
  });
  return { administrativeDiscovery, bindings, service };
}

function addExecutionBinding(
  bindings: CredentialBindingStore,
  bindingId = "execution-main",
): void {
  bindings.addExecution({
    bindingId,
    providerId: "openrouter",
    accountId: "account-main",
    productId: "product-api",
    secretRef: SECRET_REF,
    purpose: "execution",
    enabled: true,
  });
}

describe("ProviderConnectionService", () => {
  it("stores a configured connection without an execution credential but does not make it execution-ready", async () => {
    const { service } = setup();
    const input = connection();
    delete input.executionCredentialBindingId;

    service.add(input);

    expect(service.get(input.connectionId)).toEqual(input);
    await expect(service.validateExecution(input.connectionId)).rejects.toThrow(
      /execution credential binding/i,
    );
    expect(service.get(input.connectionId)?.status).toBe("auth_required");
  });

  it("never accepts an observability binding as execution authorization", async () => {
    const { bindings, service } = setup();
    bindings.addObservability({
      bindingId: "execution-main",
      providerId: "openrouter",
      accountId: "account-main",
      productId: "product-api",
      secretRef: SECRET_REF,
      purpose: "observability",
      enabled: true,
    });
    service.add(connection());

    await expect(service.validateExecution("connection-main")).rejects.toThrow(
      /execution credential binding/i,
    );
    expect(service.get("connection-main")?.status).toBe("auth_required");
  });

  it("keeps a disabled connection non-routable", async () => {
    const { bindings, service } = setup();
    addExecutionBinding(bindings);
    service.add(connection());

    expect(service.disable("connection-main").status).toBe("disabled");
    await expect(service.validateExecution("connection-main")).rejects.toThrow(
      /disabled/i,
    );
    await expect(service.discoverModels("connection-main")).rejects.toThrow(
      /disabled/i,
    );
    expect(service.get("connection-main")?.status).toBe("disabled");
  });

  it("enables a disabled connection by changing only its status", () => {
    const { bindings, service } = setup();
    addExecutionBinding(bindings);
    const original = connection();
    service.add(original);
    service.disable(original.connectionId);

    expect(service.enable(original.connectionId)).toEqual({
      ...original,
      status: "configured",
    });
    expect(service.get(original.connectionId)).toEqual({
      ...original,
      status: "configured",
    });
  });

  it("removes exactly one connection without deleting credential bindings", () => {
    const { bindings, service } = setup();
    addExecutionBinding(bindings);
    addExecutionBinding(bindings, "execution-secondary");
    service.add(connection());
    service.add(connection({
      connectionId: "connection-secondary",
      executionCredentialBindingId: "execution-secondary",
    }));

    expect(service.remove("connection-main")).toEqual(connection());

    expect(service.get("connection-main")).toBeUndefined();
    expect(service.get("connection-secondary")).toBeDefined();
    expect(bindings.getExecution("execution-main")).toBeDefined();
    expect(bindings.getExecution("execution-secondary")).toBeDefined();
  });

  it("fails closed for missing connections and unknown providers", async () => {
    const { service } = setup();

    expect(() =>
      service.add(connection({ providerId: "unknown-provider" })),
    ).toThrow(/unknown provider/i);
    expect(service.list()).toEqual([]);
    await expect(service.validateExecution("missing-connection")).rejects.toThrow(
      /unknown connection/i,
    );
    await expect(service.discoverModels("missing-connection")).rejects.toThrow(
      /unknown connection/i,
    );
  });

  it("invokes administrative discovery only for the exact specified connection", async () => {
    const seenConnectionIds: string[] = [];
    const { bindings, service } = setup(async (specifiedConnection) => {
      seenConnectionIds.push(specifiedConnection.connectionId);
      return [discoveredModel(`${specifiedConnection.connectionId}/model`)];
    });
    addExecutionBinding(bindings);
    addExecutionBinding(bindings, "execution-secondary");
    service.add(connection());
    service.add(
      connection({
        connectionId: "connection-secondary",
        executionCredentialBindingId: "execution-secondary",
      }),
    );

    const models = await service.discoverModels("connection-secondary");

    expect(seenConnectionIds).toEqual(["connection-secondary"]);
    expect(models.map((model) => model.connectionId)).toEqual([
      "connection-secondary",
    ]);
  });

  it("returns provider-native model IDs unchanged", async () => {
    const nativeIds = [
      "anthropic/claude-sonnet-4.5:1",
      "Vendor/Case-Sensitive@2026-09-15",
    ];
    const { bindings, service } = setup(async () =>
      nativeIds.map((id) => discoveredModel(id, `Display ${id}`)),
    );
    addExecutionBinding(bindings);
    service.add(connection());

    const models = await service.discoverModels("connection-main");

    expect(models.map((model) => model.providerModelId)).toEqual(nativeIds);
    expect(models[0]).toEqual({
      providerId: "openrouter",
      connectionId: "connection-main",
      providerModelId: nativeIds[0],
      displayName: `Display ${nativeIds[0]}`,
      capabilities: { chat: true, tools: true },
    });
  });

  it("does not mutate another connection when one connection discovery fails", async () => {
    const { bindings, service } = setup(async (specifiedConnection) => {
      if (specifiedConnection.connectionId === "connection-main") {
        throw new Error("administrative discovery unavailable");
      }
      return [discoveredModel("provider/model-ok")];
    });
    addExecutionBinding(bindings);
    addExecutionBinding(bindings, "execution-secondary");
    service.add(connection());
    service.add(
      connection({
        connectionId: "connection-secondary",
        executionCredentialBindingId: "execution-secondary",
      }),
    );
    await service.validateExecution("connection-secondary");

    await expect(service.discoverModels("connection-main")).rejects.toThrow(
      /administrative discovery failed/i,
    );

    expect(service.get("connection-main")?.status).toBe("error");
    expect(service.get("connection-secondary")?.status).toBe("ready");
  });

  it("sanitizes administrative discovery errors so resolved credentials cannot escape", async () => {
    const resolvedSecret = "resolved-test-secret";
    const { bindings, service } = setup(async (_connection, credential) => {
      expect(credential.value).toBe(resolvedSecret);
      throw new Error(credential.value);
    });
    addExecutionBinding(bindings);
    service.add(connection());

    let thrown: unknown;
    try {
      await service.discoverModels("connection-main");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const outwardError = thrown as Error;
    expect(outwardError.message).not.toContain(resolvedSecret);
    expect(outwardError.message).toMatch(/administrative discovery failed/i);
    expect(JSON.stringify(Object.fromEntries(Object.entries(outwardError)))).not.toContain(
      resolvedSecret,
    );
    expect(service.get("connection-main")?.status).toBe("error");
  });

  it("defensively snapshots caller connections and returned state", () => {
    const { service } = setup();
    const input = connection();
    service.add(input);

    input.providerId = "mutated-provider";
    input.status = "ready";
    const fromGet = service.get("connection-main")!;
    fromGet.providerId = "mutated-from-get";
    fromGet.status = "disabled";
    const fromList = service.list()[0]!;
    fromList.connectionId = "mutated-from-list";

    expect(service.get("connection-main")).toEqual(connection());
  });

  it("snapshots the administrative discovery registry", async () => {
    const { administrativeDiscovery, bindings, service } = setup(async () => [
      discoveredModel("provider/original"),
    ]);
    administrativeDiscovery.set("openrouter", async () => [
      discoveredModel("provider/mutated"),
    ]);
    addExecutionBinding(bindings);
    service.add(connection());

    const models = await service.discoverModels("connection-main");

    expect(models.map((model) => model.providerModelId)).toEqual([
      "provider/original",
    ]);
  });
});
