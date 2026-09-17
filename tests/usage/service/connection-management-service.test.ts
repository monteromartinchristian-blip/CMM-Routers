import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AccessRouteSummary,
  RouterCatalogProjection,
} from "../../../src/catalog/projection.js";
import type {
  AddCustomEndpointInput as RouterAddCustomEndpointInput,
  ConnectProviderInput,
  SafeConnectionSummary,
} from "../../../src/catalog/router-administration-service.js";
import type { RouteSurface } from "../../../src/catalog/types.js";
import { ConnectionManagementService } from "../../../src/usage/service/connection-management-service.js";

const dirs: string[] = [];

const USAGE_JSON = `${JSON.stringify(
  { version: 1, integrations: [{ id: "legacy", type: "openrouter", enabled: true, settings: {} }] },
  null,
  2,
)}\n`;

function summary(overrides: Partial<SafeConnectionSummary> = {}): SafeConnectionSummary {
  return {
    connectionId: "openrouter-primary",
    providerId: "openrouter",
    connectionKind: "openai-chat-completions",
    status: "configured",
    enabled: true,
    executionAuthorized: true,
    observabilityAuthorized: true,
    ...overrides,
  };
}

interface FakeAdministration {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  setEnabled: ReturnType<typeof vi.fn>;
  validate: ReturnType<typeof vi.fn>;
  addCustomEndpoint: ReturnType<typeof vi.fn>;
  setRouteVisibility: ReturnType<typeof vi.fn>;
  connectionKindFor: ReturnType<typeof vi.fn>;
}

function fakeAdministration(
  overrides: Partial<FakeAdministration> = {},
): FakeAdministration {
  return {
    connect: vi.fn(async (input: ConnectProviderInput) => summary({ connectionId: input.connectionId })),
    disconnect: vi.fn(async () => undefined),
    setEnabled: vi.fn(async (connectionId: string, enabled: boolean) =>
      summary({ connectionId, enabled, status: enabled ? "configured" : "disabled" })),
    validate: vi.fn(async (connectionId: string) => summary({ connectionId, status: "ready" })),
    addCustomEndpoint: vi.fn(async (input: RouterAddCustomEndpointInput) =>
      summary({ connectionId: `custom-connection:${input.connectionId}`, providerId: "custom-openai-compatible" })),
    setRouteVisibility: vi.fn(async (routeId: string) => ({ routeId })),
    connectionKindFor: vi.fn(() => "openai-chat-completions"),
    ...overrides,
  };
}

function route(
  routeId: string,
  tools: boolean,
): AccessRouteSummary {
  return {
    routeId,
    modelIdentityId: `model:${routeId}`,
    connectionId: "connection:openrouter",
    providerId: "openrouter",
    providerModelId: routeId,
    executionProfile: "default",
    capabilities: { chat: true, tools, streaming: true },
    billingClass: "api",
    routable: true,
    visibility: { visibleOn: ["admin_console"] },
  };
}

function catalogSource(routes: readonly AccessRouteSummary[]) {
  const projection: RouterCatalogProjection = {
    providers: [],
    accounts: [],
    products: [],
    connections: [],
    models: [],
    routes,
  };
  return { read: () => projection };
}

function setup(options: {
  administration?: FakeAdministration;
  routes?: readonly AccessRouteSummary[];
  withCatalog?: boolean;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cmm-connections-"));
  dirs.push(dir);
  writeFileSync(join(dir, "usage.json"), USAGE_JSON);
  const administration = options.administration ?? fakeAdministration();
  const service = new ConnectionManagementService(
    administration as unknown as ConstructorParameters<typeof ConnectionManagementService>[0],
    {
      ...(options.withCatalog === false
        ? {}
        : { routerCatalog: catalogSource(options.routes ?? [route("model-tools", true), route("model-chat", false)]) }),
    },
  );
  return { dir, administration, service };
}

function usageJson(dir: string): string {
  return readFileSync(join(dir, "usage.json"), "utf8");
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ConnectionManagementService compatibility delegation", () => {
  it("delegates connectWithApiKey to Router administration without writing Usage storage", async () => {
    const { service, administration, dir } = setup();

    const result = await service.connectWithApiKey("openrouter", "secret-value", {
      instanceId: "openrouter-primary",
    });

    expect(administration.connect).toHaveBeenCalledTimes(1);
    expect(administration.connect).toHaveBeenCalledWith({
      providerId: "openrouter",
      connectionId: "openrouter-primary",
      connectionKind: "openai-chat-completions",
      secret: "secret-value",
      authorizeExecution: true,
      authorizeObservability: true,
    });
    expect(result).toEqual({
      id: "openrouter-primary",
      type: "openrouter",
      enabled: true,
      executionAuthorized: true,
      observabilityAuthorized: true,
    });
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(JSON.stringify(result)).not.toContain("keychain://");
    expect(usageJson(dir)).toBe(USAGE_JSON);
  });

  it("delegates connectAccount through the same Router administration operation", async () => {
    const { service, administration } = setup();

    await service.connectAccount("openrouter", "secret-value", { instanceId: "openrouter-account" });

    expect(administration.connect).toHaveBeenCalledTimes(1);
    expect(administration.connect).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "openrouter-account", authorizeExecution: true }),
    );
  });

  it("refuses to fabricate a connection kind for an unknown Router provider", async () => {
    const administration = fakeAdministration({ connectionKindFor: vi.fn(() => undefined) });
    const { service } = setup({ administration });

    await expect(service.connectWithApiKey("mystery", "secret-value")).rejects.toThrow();
    expect(administration.connect).not.toHaveBeenCalled();
  });

  it("delegates custom endpoints to Router administration", async () => {
    const { service, administration, dir } = setup();

    const result = await service.addCustomEndpoint({
      instanceId: "custom-one",
      name: "Local gateway",
      endpointUrl: "https://gateway.example/v1",
      apiKey: "secret-value",
      defaultModel: "gpt-oss",
      useInCmmChat: false,
    });

    expect(administration.addCustomEndpoint).toHaveBeenCalledTimes(1);
    expect(administration.addCustomEndpoint).toHaveBeenCalledWith({
      connectionId: "custom-one",
      displayName: "Local gateway",
      endpointUrl: "https://gateway.example/v1",
      apiKey: "secret-value",
      defaultModel: "gpt-oss",
      visibleOn: ["admin_console"],
    });
    expect(result.id).toBe("custom-connection:custom-one");
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(usageJson(dir)).toBe(USAGE_JSON);
  });

  it("delegates lifecycle mutations to Router administration", async () => {
    const { service, administration } = setup();

    await service.disconnect("openrouter-primary");
    const disabled = await service.disable("openrouter-primary");
    const enabled = await service.enable("openrouter-primary");
    const tested = await service.testConnection("openrouter-primary");

    expect(administration.disconnect).toHaveBeenCalledWith("openrouter-primary");
    expect(administration.setEnabled).toHaveBeenNthCalledWith(1, "openrouter-primary", false);
    expect(administration.setEnabled).toHaveBeenNthCalledWith(2, "openrouter-primary", true);
    expect(administration.validate).toHaveBeenCalledWith("openrouter-primary");
    expect(disabled.enabled).toBe(false);
    expect(enabled.enabled).toBe(true);
    expect(tested).toEqual({ id: "openrouter-primary", status: "ready" });
  });

  it("maps legacy hidden visibility to the admin-only Router surface", async () => {
    const { service, administration } = setup();

    await service.setVisibility({ scope: "global", routeId: "model-tools", state: "hidden" });

    expect(administration.setRouteVisibility).toHaveBeenCalledTimes(1);
    expect(administration.setRouteVisibility).toHaveBeenCalledWith("model-tools", ["admin_console"]);
  });

  it("restores capability-derived executable surfaces for visible visibility", async () => {
    const { service, administration } = setup();

    await service.setVisibility({ scope: "global", routeId: "model-tools", state: "visible" });
    await service.setVisibility({ scope: "global", routeId: "model-chat", state: "visible" });

    expect(administration.setRouteVisibility).toHaveBeenNthCalledWith(1, "model-tools", [
      "cmmchat_model_picker",
      "cmmcode_model_picker",
      "admin_console",
    ]);
    expect(administration.setRouteVisibility).toHaveBeenNthCalledWith(2, "model-chat", [
      "cmmchat_model_picker",
      "admin_console",
    ]);
  });

  it("fails closed when the canonical route or catalog is unavailable", async () => {
    const unknownRoute = setup({ routes: [route("model-tools", true)] });
    await expect(
      unknownRoute.service.setVisibility({ scope: "global", routeId: "model-missing", state: "visible" }),
    ).rejects.toThrow();
    expect(unknownRoute.administration.setRouteVisibility).not.toHaveBeenCalled();

    const withoutCatalog = setup({ withCatalog: false });
    await expect(
      withoutCatalog.service.setVisibility({ scope: "global", routeId: "model-tools", state: "visible" }),
    ).rejects.toThrow();
    expect(withoutCatalog.administration.setRouteVisibility).not.toHaveBeenCalled();
  });

  it("requires an exact route and never widens a non-route-scoped preference", async () => {
    const { service, administration } = setup();

    await expect(
      service.setVisibility({ scope: "global", providerId: "openrouter", state: "hidden" }),
    ).rejects.toThrow();
    expect(administration.setRouteVisibility).not.toHaveBeenCalled();
  });

  it("reports Router administration as unavailable rather than mutating Usage state", async () => {
    const service = new ConnectionManagementService(undefined, {
      routerCatalog: catalogSource([route("model-tools", true)]),
    });

    await expect(service.connectWithApiKey("openrouter", "secret-value")).rejects.toThrow(
      /Router administration is unavailable/,
    );
    await expect(service.disconnect("openrouter-primary")).rejects.toThrow(
      /Router administration is unavailable/,
    );
    await expect(
      service.setVisibility({ scope: "global", routeId: "model-tools", state: "hidden" }),
    ).rejects.toThrow(/Router administration is unavailable/);
  });

  it("keeps collector refresh as a separate Usage-owned operation", async () => {
    const refresh = vi.fn(async (instanceId: string) => ({
      adapterId: instanceId,
      attempted: true,
      success: true,
    }));
    const administration = fakeAdministration();
    const service = new ConnectionManagementService(
      administration as unknown as ConstructorParameters<typeof ConnectionManagementService>[0],
      { collectorRefresh: { refresh } },
    );

    await expect(service.refresh("openrouter-primary")).resolves.toEqual({
      adapterId: "openrouter-primary",
      attempted: true,
      success: true,
    });
    expect(refresh).toHaveBeenCalledWith("openrouter-primary");
    // A collector refresh is never a Router administrative mutation.
    expect(administration.connect).not.toHaveBeenCalled();
    expect(administration.setEnabled).not.toHaveBeenCalled();
  });

  it("does not roll Router connection state back when the separate collector step is unavailable", async () => {
    const administration = fakeAdministration();
    const service = new ConnectionManagementService(
      administration as unknown as ConstructorParameters<typeof ConnectionManagementService>[0],
    );

    const view = await service.connectWithApiKey("openrouter", "secret-value", {
      instanceId: "openrouter-primary",
    });

    expect(view.executionAuthorized).toBe(true);
    expect(view.observabilityAuthorized).toBe(true);
    expect(administration.connect).toHaveBeenCalledTimes(1);
    expect(administration.disconnect).not.toHaveBeenCalled();
  });
});
