import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalSecureCredentialWriter } from "../../../src/catalog/local-secure-credential-writer.js";
import { createProductionRegistry, createProductionServer } from "../../../src/index.js";
import {
  PUBLIC_SAFE_DEMO_MANAGEMENT_TOKEN,
  PUBLIC_SAFE_DEMO_READ_TOKEN,
} from "../../../src/usage/demo/public-safe-catalog-fixture.js";
import { createProductionUsageRuntime } from "../../../src/usage/runtime/production-runtime.js";

const dirs: string[] = [];

/**
 * Minimal Router config for the real composition factory. Mirrors the shape
 * `src/index.ts` loads in production; the scripted test provider keeps the
 * registry offline and deterministic.
 */
function writeRouterConfig(dir: string): void {
  writeFileSync(
    join(dir, "shared.json"),
    JSON.stringify({
      mode: "standalone",
      host: "127.0.0.1",
      port: 8790,
      bearerSecretEnv: "CMM_ROUTER_TOKEN",
      providers: {
        chatgpt: { enabled: true },
        claude: { enabled: false },
        google: { enabled: false },
        "command-code": {
          enabled: false,
          baseUrl: "https://api.commandcode.ai/provider/v1",
          secretEnv: "COMMAND_CODE_SECRET",
        },
      },
    }),
  );
  writeFileSync(join(dir, "local.json"), JSON.stringify({}));
}

/**
 * The exact composition `main()` performs, under demo mode: the real
 * `createProductionRegistry` factory supplies the real Router administration,
 * the real Usage runtime receives it, and the real `createProductionServer`
 * composition root builds the HTTP surface. Only the OS keychain writer is
 * mocked, so a regression can never write to the developer's keychain while
 * the test asserts that no write happened.
 */
async function demoIsolationHarness(dir: string) {
  vi.stubEnv("CMM_USAGE_DEMO_FIXTURE", "1");
  vi.stubEnv("CMM_TEST_PROVIDER", "scripted");
  writeRouterConfig(dir);

  const keychainWrites = vi
    .spyOn(LocalSecureCredentialWriter.prototype, "write")
    .mockImplementation(async (bindingId: string) => ({
      // Canonical CMM Usage Keychain reference shape, so a successful write
      // still satisfies the Router config schema — the assertion is about
      // reachability, not about a malformed reference.
      secretRef: `keychain://CMM%20Usage/${encodeURIComponent(bindingId)}`,
      hint: "••••guard",
    }));

  const { loadConfig } = await import("../../../src/config/load-config.js");
  const composition = await createProductionRegistry(loadConfig(dir), {
    configDir: dir,
    catalogReconcileIntervalMs: 0,
  });
  const connect = vi.spyOn(composition.routerAdministration, "connect");
  const disconnect = vi.spyOn(composition.routerAdministration, "disconnect");

  const usage = await createProductionUsageRuntime({
    configDir: dir,
    routerAdministration: composition.routerAdministration,
  });
  const server = createProductionServer(composition, "chat-bearer", undefined, {
    service: usage.runtime.service,
    token: PUBLIC_SAFE_DEMO_READ_TOKEN,
    catalog: usage.presentationCatalog,
    visibility: usage.visibility,
    managementToken: PUBLIC_SAFE_DEMO_MANAGEMENT_TOKEN,
    connections: usage.connections,
  });

  return {
    composition,
    usage,
    server,
    connect,
    disconnect,
    keychainWrites,
    managementAuth: {
      authorization: `Bearer ${PUBLIC_SAFE_DEMO_MANAGEMENT_TOKEN}`,
      "content-type": "application/json",
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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

  it("fails closed on the canonical Router administration surface in demo mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cmm-usage-demo-canonical-"));
    dirs.push(dir);
    const { composition, usage, server, managementAuth } = await demoIsolationHarness(dir);

    const sharedBefore = readFileSync(join(dir, "shared.json"), "utf8");
    const connectionsBefore = composition.providerConnections
      .list()
      .map((connection) => connection.connectionId)
      .sort();

    try {
      // The canonical administration surface is the surface the public demo
      // management bearer previously reached: it returned 200 and persisted a
      // real `administrativeConnections` entry.
      const canonical = await server.inject({
        method: "POST",
        url: "/v1/cmm/catalog/connections",
        headers: managementAuth,
        payload: {
          providerId: "chatgpt",
          connectionId: "demo-canonical-breach",
          connectionKind: "codex-app-server",
          authorizeExecution: false,
          authorizeObservability: false,
        },
      });
      expect(canonical.statusCode).toBeGreaterThanOrEqual(400);

      // Destructive and refresh canonical verbs must fail closed the same way.
      for (const request of [
        { method: "DELETE" as const, url: "/v1/cmm/catalog/connections/demo-canonical-breach" },
        { method: "POST" as const, url: "/v1/cmm/catalog/connections/demo-canonical-breach/refresh" },
        { method: "POST" as const, url: "/v1/cmm/catalog/connections/demo-canonical-breach/validate" },
      ]) {
        const response = await server.inject({ ...request, headers: managementAuth });
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
      }

      // The canonical catalog read must not project real Router state into a
      // demo process either.
      const canonicalRead = await server.inject({
        method: "GET",
        url: "/v1/cmm/catalog",
        headers: { authorization: "Bearer chat-bearer" },
      });
      expect(canonicalRead.statusCode).toBeGreaterThanOrEqual(400);

      // No real Router connection was created, and no real administrative
      // state was persisted. `shared.json` is the real Router config file, so
      // the proof is byte-identity plus an empty administrative connection
      // list.
      expect(
        composition.providerConnections.list().map((connection) => connection.connectionId).sort(),
      ).toEqual(connectionsBefore);
      expect(readFileSync(join(dir, "shared.json"), "utf8")).toBe(sharedBefore);
      expect(
        (JSON.parse(sharedBefore) as { administrativeConnections?: unknown[] })
          .administrativeConnections ?? [],
      ).toEqual([]);
    } finally {
      await server.close();
      await usage.close();
    }
  });

  it("never reaches the real Router authority or credential writer from demo mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cmm-usage-demo-authority-"));
    dirs.push(dir);
    const { composition, usage, server, connect, disconnect, keychainWrites, managementAuth } =
      await demoIsolationHarness(dir);

    const sharedBefore = readFileSync(join(dir, "shared.json"), "utf8");

    try {
      // Both surfaces, both with credential material supplied. The demo bearer
      // is a public constant, so neither may reach the real authority.
      const compatibility = await server.inject({
        method: "POST",
        url: "/v1/cmm/usage/connections/api-key",
        headers: managementAuth,
        payload: {
          integrationType: "chatgpt",
          instanceId: "demo-compat-breach",
          secret: "demo-entered-secret",
        },
      });
      const canonical = await server.inject({
        method: "POST",
        url: "/v1/cmm/catalog/connections",
        headers: managementAuth,
        payload: {
          providerId: "chatgpt",
          connectionId: "demo-canonical-breach",
          connectionKind: "codex-app-server",
          secret: "demo-entered-secret",
          authorizeExecution: true,
          authorizeObservability: true,
        },
      });

      // Neither mutation may invoke the real administration, and neither may
      // reach the real OS keychain writer.
      expect(keychainWrites).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
      expect(disconnect).not.toHaveBeenCalled();

      // The compatibility surface keeps its documented fail-closed 503; the
      // canonical surface is not registered for a demo composition at all.
      expect(compatibility.statusCode).toBe(503);
      expect(canonical.statusCode).toBeGreaterThanOrEqual(400);
      expect(readFileSync(join(dir, "shared.json"), "utf8")).toBe(sharedBefore);
    } finally {
      await server.close();
      await usage.close();
    }
  });
});
