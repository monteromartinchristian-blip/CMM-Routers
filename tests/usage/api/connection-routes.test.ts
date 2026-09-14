import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { UsageAdapter } from "../../../src/usage/adapters/contract.js";
import { buildServer } from "../../../src/http/server.js";
import { ProviderRegistry } from "../../../src/registry/provider-registry.js";
import { ConnectionManagementService } from "../../../src/usage/service/connection-management-service.js";
import type { CredentialWriter } from "../../../src/usage/runtime/credential-writer.js";
import { ManagedConfigStore } from "../../../src/usage/runtime/managed-config-store.js";
import { ConfiguredUsageRuntime, UsageIntegrationCatalog } from "../../../src/usage/runtime/configured-runtime.js";
import { VisibilityStore } from "../../../src/usage/presentation/visibility-store.js";
import { SqliteUsageStore } from "../../../src/usage/storage/sqlite-usage-store.js";

const dirs: string[] = [];
const stores: SqliteUsageStore[] = [];
const readToken = "usage-read-token";
const managementToken = "usage-management-token";

class MemoryCredentialWriter implements CredentialWriter {
  async write(instanceId: string, secret: string) {
    return { credentialRef: `keychain://CMM%20Usage/${encodeURIComponent(instanceId)}`, hint: `••••${secret.slice(-4)}` };
  }
  async remove() {}
}

function adapter(id: string): UsageAdapter {
  return {
    id,
    manifest: () => ({ id, displayName: id, collectionSafety: "non_inference_only", minimumRefreshIntervalMs: 1 }),
    capabilities: () => new Set(["manual_refresh"]),
    health: async () => ({ status: "healthy" }),
    discover: async () => ({ status: "ok", providers: [], accounts: [], products: [], models: [], accessRoutes: [] }),
    collectUsageEvents: async () => ({ status: "unsupported", capability: "collect_usage_events" }),
    collectQuotaSnapshots: async () => ({ status: "unsupported", capability: "collect_quota_snapshots" }),
    collectCostEvents: async () => ({ status: "unsupported", capability: "collect_costs" }),
    refresh: async () => ({ status: "ok", refreshedAt: "2026-09-14T18:00:00.000Z" }),
  };
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "cmm-connection-api-"));
  dirs.push(dir);
  const store = new SqliteUsageStore(":memory:");
  stores.push(store);
  await store.initialize();
  const integrationCatalog = new UsageIntegrationCatalog();
  for (const type of ["openrouter", "openai-compatible"]) integrationCatalog.register(type, () => adapter(type));
  const runtime = new ConfiguredUsageRuntime(store, integrationCatalog);
  const visibility = new VisibilityStore(store);
  const connections = new ConnectionManagementService(
    new ManagedConfigStore(dir),
    new MemoryCredentialWriter(),
    runtime,
    visibility,
  );
  const server = buildServer({
    host: "127.0.0.1",
    port: 0,
    bearerSecret: "chat-secret",
    usageToken: readToken,
    usageManagementToken: managementToken,
    registry: new ProviderRegistry(),
    cmmUsageService: runtime.service,
    cmmUsageConnections: connections,
    cmmUsageVisibility: visibility,
  } as Parameters<typeof buildServer>[0]);
  return { server, visibility };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CMM Usage privileged connection API", () => {
  it("rejects provider mutation with the catalog read token", async () => {
    const { server } = await setup();
    const response = await server.inject({
      method: "POST",
      url: "/v1/cmm/usage/connections/api-key",
      headers: { authorization: `Bearer ${readToken}`, "content-type": "application/json" },
      payload: { integrationType: "openrouter", instanceId: "openrouter-primary", secret: "secret-value" },
    });
    expect(response.statusCode).toBe(401);
    await server.close();
  });

  it("connects with management authority without returning the credential reference", async () => {
    const { server } = await setup();
    const response = await server.inject({
      method: "POST",
      url: "/v1/cmm/usage/connections/api-key",
      headers: { authorization: `Bearer ${managementToken}`, "content-type": "application/json" },
      payload: { integrationType: "openrouter", instanceId: "openrouter-primary", secret: "secret-value" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: "openrouter-primary", type: "openrouter", enabled: true });
    expect(response.body).not.toContain("secret-value");
    expect(response.body).not.toContain("keychain://");
    expect(response.body).not.toContain("credentialRef");
    await server.close();
  });

  it("uses management authority for route-scoped visibility mutation", async () => {
    const { server, visibility } = await setup();
    const response = await server.inject({
      method: "PATCH",
      url: "/v1/cmm/usage/catalog/visibility",
      headers: { authorization: `Bearer ${managementToken}`, "content-type": "application/json" },
      payload: { routeId: "route:example", state: "hidden" },
    });
    expect(response.statusCode).toBe(200);
    expect(await visibility.list()).toEqual([expect.objectContaining({ routeId: "route:example", state: "hidden" })]);
    await server.close();
  });
});
