import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { Duplex } from "node:stream";
import { CodexAppServerClient } from "../../src/providers/codex/app-server-client.js";
import { CodexAdapter } from "../../src/providers/codex/adapter.js";

describe("Codex live integration", () => {
  it.skipIf(!process.env.CMM_RUN_LIVE)("discovers models from authenticated Codex", async () => {
    const adapter = new CodexAdapter();

    try {
      const models = await adapter.discoverModels();
      expect(models.length).toBeGreaterThan(0);
      const firstModel = models[0];
      if (firstModel) {
        expect(firstModel.id).toMatch(/^chatgpt\//);
        expect(firstModel.provider).toBe("chatgpt");
        console.log(`Discovered ${models.length} models:`, models.slice(0, 3).map((m) => m.id));
      }
    } finally {
      // Cleanup would happen here in a real implementation
    }
  }, 30000);

  it.skipIf(!process.env.CMM_RUN_LIVE)("reports healthy status when authenticated", async () => {
    const adapter = new CodexAdapter();

    try {
      const health = await adapter.health();
      expect(health.status).toBe("ready");
    } finally {
      // Cleanup
    }
  }, 15000);
});
