import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CatalogReconciler,
  type CatalogRoutePolicy,
} from "../../../src/catalog/catalog-reconciler.js";
import { CredentialBindingStore } from "../../../src/catalog/credential-bindings.js";
import { ModelIdentityStore } from "../../../src/catalog/model-identities.js";
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
import { buildServer } from "../../../src/http/server.js";
import { ProviderRegistry } from "../../../src/registry/provider-registry.js";
import {
  PUBLIC_SAFE_DEMO_MANAGEMENT_TOKEN,
  PUBLIC_SAFE_DEMO_READ_TOKEN,
} from "../../../src/usage/demo/public-safe-catalog-fixture.js";
import { createProductionUsageRuntime } from "../../../src/usage/runtime/production-runtime.js";

const dirs: string[] = [];

class GuardCredentialWriter implements SecureCredentialWriter {
  readonly values = new Map<string, string>();

  async write(bindingId: string, secret: string): Promise<SecureCredentialWriteResult> {
    const secretRef = `keychain://CMM%20Usage/${encodeURIComponent(bindingId)}`;
    this.values.set(secretRef, secret);
    return { secretRef, hint: "••••guard" };
  }

  async remove(secretRef: string): Promise<void> {
    this.values.delete(secretRef);
  }
}

/**
 * A real, fully wired Router administration rooted at `dir`.
 *
 * It is the same authority production composition injects, so any invocation
 * writes real `shared.json` administrative state and the real credential
 * writer. The demo-isolation guard must keep it entirely out of reach.
 */
function realRouterAdministration(dir: string, credentialWriter: SecureCredentialWriter) {
  const directory = new ProviderDirectory();
  directory.register({
    providerId: "openrouter",
    displayName: "OpenRouter",
    adapterKind: "openai-compatible",
    supportedConnectionKinds: ["openai-chat-completions"],
    discoveryCapabilities: ["models"],
  });
  const credentialBindings = new CredentialBindingStore();
  const credentialResolver: SecureCredentialResolver = {
    async resolve() {
      return { value: "guard-resolved-secret" };
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
          {
            id: "openrouter/guard-model",
            provider: "openrouter",
            upstreamModel: "guard-model",
            displayName: "guard-model",
            capability: "CHAT_AND_TOOLS" as const,
          },
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
  return { administration, providerConnections };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("public-safe CMM Usage demo fixture", () => {
  it("boots without personal config or credential resolution and exposes representative catalog state", async () => {
    vi.stubEnv("CMM_USAGE_DEMO_FIXTURE", "1");
    const dir = mkdtempSync(join(tmpdir(), "cmm-usage-demo-"));
    dirs.push(dir);
    writeFileSync(join(dir, "usage.json"), "this must never be parsed");
    let credentialReads = 0;

    const production = await createProductionUsageRuntime({
      configDir: dir,
      credentialResolver: {
        resolve() {
          credentialReads += 1;
          throw new Error("demo mode must never call the real credential resolver");
        },
      },
    });

    try {
      expect(credentialReads).toBe(0);
      expect(await production.resolveApiToken()).toBe(PUBLIC_SAFE_DEMO_READ_TOKEN);
      expect(await production.resolveManagementApiToken()).toBe(PUBLIC_SAFE_DEMO_MANAGEMENT_TOKEN);

      const routes = await production.presentationCatalog.listRoutes();
      const providers = await production.presentationCatalog.listProviders();
      const quotas = await production.presentationCatalog.listQuotaSummaries();

      expect(new Set(routes.map((route) => route.offer.kind))).toEqual(
        new Set(["FREE", "PROMO", "INCLUDED", "TRIAL", "PAYG", "UNKNOWN"]),
      );
      expect(providers.find((provider) => provider.directory.integrationType === "command-code")?.directory.state)
        .toBe("connected");

      const commandCode = routes.find((route) => route.routeId === "route:demo:command-code");
      expect(commandCode?.product.displayName).toBe("GOAT");
      expect(commandCode?.quota.map((quota) => quota.displayName)).toEqual(expect.arrayContaining([
        "Monthly plan credits",
        "5-hour window",
        "Weekly window",
      ]));
      expect(commandCode?.quota.some((quota) => quota.displayName === "Purchased credits")).toBe(false);
      expect(commandCode?.quota.some((quota) => quota.displayName === "Free credits")).toBe(false);

      const supplemental = quotas.filter((quota) =>
        quota.displayName === "Purchased credits" || quota.displayName === "Free credits");
      expect(supplemental).toHaveLength(2);
      expect(supplemental.every((quota) => quota.constraining === false)).toBe(true);

      const sharedPool = quotas.find((quota) => quota.displayName === "Shared prepaid pool");
      expect(sharedPool?.affectedRouteIds).toHaveLength(2);
      expect(sharedPool?.resetAt).toBeUndefined();
      expect(sharedPool?.limit).toBeUndefined();

      const kiraFreeRoutes = routes.filter((route) =>
        route.provider.displayName === "Kira AI" && route.offer.kind === "FREE");
      expect(kiraFreeRoutes.map((route) => route.model.displayName)).toEqual([
        "Qwen 3.7-27B Free",
        "Qwen 3.8 Flash Free",
      ]);
      expect(kiraFreeRoutes.every((route) =>
        route.quota.some((quota) => quota.scope.kind === "shared_pool"))).toBe(true);
      expect(kiraFreeRoutes.every((route) =>
        route.quota.some((quota) => quota.scope.kind === "route"))).toBe(true);

      const claimable = quotas.find((quota) => quota.entitlement?.state === "claimable");
      expect(claimable).toMatchObject({
        displayName: "Check-in bonus",
        constraining: false,
        entitlement: {
          amount: 50_000_000,
          unit: "tokens",
          eligibility: "requires_auth",
          requiresExplicitUserAction: true,
        },
      });
      expect(claimable?.entitlement?.appliesToRouteIds).toEqual([
        "route:demo:kira-qwen-37",
        "route:demo:kira-qwen-38",
      ]);

      const safePayload = JSON.stringify({ routes, providers, quotas });
      expect(safePayload).not.toMatch(/credentialRef|keychain:\/\/|managementApiCredentialRef|apiCredentialRef/i);
    } finally {
      await production.close();
    }
  });

  it("keeps a demo-mode mutation off the real Router administration", async () => {
    vi.stubEnv("CMM_USAGE_DEMO_FIXTURE", "1");
    const dir = mkdtempSync(join(tmpdir(), "cmm-usage-demo-isolation-"));
    dirs.push(dir);
    const credentialWriter = new GuardCredentialWriter();
    const { administration, providerConnections } = realRouterAdministration(dir, credentialWriter);
    const connect = vi.spyOn(administration, "connect");

    // Production composition injects the real authority unconditionally; the
    // demo runtime must refuse to hand it to the compatibility surface.
    const production = await createProductionUsageRuntime({
      configDir: dir,
      routerAdministration: administration,
    });
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: "chat-bearer",
      usageToken: PUBLIC_SAFE_DEMO_READ_TOKEN,
      usageManagementToken: PUBLIC_SAFE_DEMO_MANAGEMENT_TOKEN,
      registry: new ProviderRegistry(),
      cmmUsageConnections: production.connections,
      cmmUsageVisibility: production.visibility,
    });

    try {
      const response = await server.inject({
        method: "POST",
        url: "/v1/cmm/usage/connections/api-key",
        headers: {
          authorization: `Bearer ${PUBLIC_SAFE_DEMO_MANAGEMENT_TOKEN}`,
          "content-type": "application/json",
        },
        payload: {
          integrationType: "openrouter",
          instanceId: "demo-breach",
          secret: "demo-entered-secret",
        },
      });

      // The demo bearer is public: the mutation must fail closed rather than
      // reach real Router state.
      expect(response.statusCode).toBe(503);
      expect(connect).not.toHaveBeenCalled();
      expect(providerConnections.list()).toEqual([]);
      // No real administrative config and no real credential write happened.
      expect(existsSync(join(dir, "shared.json"))).toBe(false);
      expect(credentialWriter.values.size).toBe(0);
    } finally {
      await server.close();
      await production.close();
    }
  });
});
