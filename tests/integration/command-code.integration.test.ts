import { describe, it, expect } from "vitest";
import { CommandCodeAdapter } from "../../src/providers/command-code/adapter.js";

describe.skipIf(!process.env.CMM_RUN_LIVE)(
  "Command Code Live Integration",
  () => {
    it("reports spending-gate and secret state without spending", async () => {
      const adapter = new CommandCodeAdapter();
      const health = await adapter.health();
      console.log(`COMMAND_CODE_HEALTH=${health.status}`);
      expect(["ready", "degraded", "unavailable", "auth_required"]).toContain(health.status);
    });
  },
);
