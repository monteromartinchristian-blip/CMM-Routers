import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { UsageAdapter } from "../../../src/usage/adapters/contract.js";
import { UsageIntegrationCatalog } from "../../../src/usage/runtime/configured-runtime.js";
import { createProductionUsageRuntime } from "../../../src/usage/runtime/production-runtime.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtureAdapter(id: string): UsageAdapter {
  return {
    id,
    manifest: () => ({ id, displayName: id, collectionSafety: "non_inference_only", minimumRefreshIntervalMs: 60_000 }),
    capabilities: () => new Set(),
    health: async () => ({ status: "healthy" }),
    discover: async () => ({ status: "ok", providers: [], accounts: [], products: [], models: [], accessRoutes: [] }),
    collectUsageEvents: async () => ({ status: "unsupported", capability: "collect_usage_events" }),
    collectQuotaSnapshots: async () => ({ status: "unsupported", capability: "collect_quota_snapshots" }),
    collectCostEvents: async () => ({ status: "unsupported", capability: "collect_costs" }),
    refresh: async () => ({ status: "unsupported", capability: "manual_refresh" }),
  };
}

describe("production CMM Usage runtime", () => {
  it("loads usage.json, wires enabled integrations, and can close its persistent store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cmm-usage-runtime-"));
    dirs.push(dir);
    writeFileSync(join(dir, "usage.json"), JSON.stringify({
      version: 1,
      integrations: [
        { id: "enabled", type: "fixture", enabled: true, settings: {} },
        { id: "disabled", type: "fixture", enabled: false, settings: {} },
      ],
    }));
    const catalog = new UsageIntegrationCatalog();
    catalog.register("fixture", (definition) => fixtureAdapter(definition.id));

    const production = await createProductionUsageRuntime({
      configDir: dir,
      databasePath: ":memory:",
      catalog,
    });

    expect(production.runtime.adapters.list().map(({ id }) => id)).toEqual(["enabled"]);
    expect(production.config.integrations).toHaveLength(2);
    production.runtime.service.start();
    expect(production.runtime.service.isRunning()).toBe(true);
    await production.close();
    expect(production.runtime.service.isRunning()).toBe(false);
  });
});
