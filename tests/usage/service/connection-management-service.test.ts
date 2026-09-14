import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { UsageAdapter } from "../../../src/usage/adapters/contract.js";
import { ConnectionManagementService } from "../../../src/usage/service/connection-management-service.js";
import type { CredentialWriter } from "../../../src/usage/runtime/credential-writer.js";
import { ManagedConfigStore } from "../../../src/usage/runtime/managed-config-store.js";
import { ConfiguredUsageRuntime, UsageIntegrationCatalog } from "../../../src/usage/runtime/configured-runtime.js";
import { VisibilityStore } from "../../../src/usage/presentation/visibility-store.js";
import { SqliteUsageStore } from "../../../src/usage/storage/sqlite-usage-store.js";

const dirs: string[] = [];
const stores: SqliteUsageStore[] = [];

class MemoryCredentialWriter implements CredentialWriter {
  readonly secrets = new Map<string, string>();

  async write(instanceId: string, secret: string) {
    this.secrets.set(instanceId, secret);
    return { credentialRef: `keychain://CMM%20Usage/${encodeURIComponent(instanceId)}`, hint: `••••${secret.slice(-4)}` };
  }

  async remove(reference: string) {
    const id = decodeURIComponent(new URL(reference).pathname.replace(/^\//, ""));
    this.secrets.delete(id);
  }
}

function fixtureAdapter(id = "fixture"): UsageAdapter {
  return {
    id,
    manifest: () => ({ id, displayName: "Fixture", collectionSafety: "non_inference_only", minimumRefreshIntervalMs: 1 }),
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
  const dir = mkdtempSync(join(tmpdir(), "cmm-connections-"));
  dirs.push(dir);
  const store = new SqliteUsageStore(":memory:");
  stores.push(store);
  await store.initialize();
  const catalog = new UsageIntegrationCatalog();
  for (const type of ["openrouter", "command-code", "openai-compatible"]) {
    catalog.register(type, () => fixtureAdapter(type));
  }
  const runtime = new ConfiguredUsageRuntime(store, catalog);
  const configStore = new ManagedConfigStore(dir);
  const credentials = new MemoryCredentialWriter();
  const service = new ConnectionManagementService(configStore, credentials, runtime);
  return { dir, store, runtime, configStore, credentials, service, visibility: new VisibilityStore(store) };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ConnectionManagementService", () => {
  it("stores submitted secrets through CredentialWriter and persists only the secure reference", async () => {
    const { service, credentials, configStore, runtime } = await setup();
    const result = await service.connectWithApiKey("openrouter", "secret-value", { instanceId: "openrouter-primary" });

    expect(credentials.secrets.get("openrouter-primary")).toBe("secret-value");
    const serialized = JSON.stringify(await configStore.read());
    expect(serialized).not.toContain("secret-value");
    expect(serialized).toContain("keychain://CMM%20Usage/openrouter-primary");
    expect(result).toEqual(expect.objectContaining({ id: "openrouter-primary", type: "openrouter", enabled: true, hint: "••••alue" }));
    expect(JSON.stringify(result)).not.toContain("credentialRef");
    expect(runtime.adapters.isEnabled("openrouter-primary")).toBe(true);
  });

  it("disconnects active config while preserving history and visibility", async () => {
    const { service, store, visibility } = await setup();
    await service.connectWithApiKey("openrouter", "secret-value", { instanceId: "openrouter-primary" });
    await store.upsertProvider({ id: "provider:kept", displayName: "Kept", kind: "aggregator", status: "enabled", metadata: {}, createdAt: "2026-09-14T18:00:00.000Z", updatedAt: "2026-09-14T18:00:00.000Z" });
    await store.upsertAccount({ id: "account:kept", providerId: "provider:kept", label: "Kept", status: "active", createdAt: "2026-09-14T18:00:00.000Z", updatedAt: "2026-09-14T18:00:00.000Z" });
    await store.upsertProduct({ id: "product:kept", providerId: "provider:kept", displayName: "Kept", kind: "api", metadata: {} });
    await store.upsertAccessRoute({ id: "route:kept", accountId: "account:kept", productId: "product:kept", providerModelId: "kept", displayName: "Kept", status: "available", metadata: {} });
    await visibility.set({ scope: "global", routeId: "route:kept", state: "hidden" });

    await service.disconnect("openrouter-primary");

    expect((await store.listAccessRoutes()).map((route) => route.id)).toContain("route:kept");
    expect(await visibility.list()).toEqual([expect.objectContaining({ routeId: "route:kept", state: "hidden" })]);
  });

  it("disables and re-enables the same configured instance", async () => {
    const { service, runtime } = await setup();
    await service.connectWithApiKey("openrouter", "secret-value", { instanceId: "openrouter-primary" });
    await service.disable("openrouter-primary");
    expect(runtime.adapters.isEnabled("openrouter-primary")).toBe(false);
    await service.enable("openrouter-primary");
    expect(runtime.adapters.isEnabled("openrouter-primary")).toBe(true);
  });
});
