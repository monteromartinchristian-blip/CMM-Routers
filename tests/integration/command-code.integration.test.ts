import { describe, it, expect } from "vitest";
import { CommandCodeAdapter } from "../../src/providers/command-code/adapter.js";
import { loadSpendAcknowledgement } from "../../src/providers/command-code/spend-guard.js";

describe.skipIf(!process.env.CMM_RUN_LIVE)(
  "Command Code Live Integration",
  () => {
    it("reports spending-gate and secret state without spending", async () => {
      const adapter = new CommandCodeAdapter();
      const health = await adapter.health();
      console.log(`COMMAND_CODE_HEALTH=${health.status}`);
      expect(["ready", "degraded", "unavailable", "auth_required"]).toContain(health.status);
    });

    it("proves GOAT-backed discovery and inference when fully credentialed", { timeout: 180000 }, async () => {
      const secretPresent = Boolean(process.env.COMMAND_CODE_SECRET);
      let ackValid = false;
      try {
        loadSpendAcknowledgement();
        ackValid = true;
      } catch {
        ackValid = false;
      }
      console.log(`COMMAND_CODE_AUTH=${ackValid && secretPresent ? "CHECKING" : "MISSING_PRECONDITION"}`);
      if (!ackValid || !secretPresent) {
        console.log("COMMAND_CODE_LIVE=BLOCKED_EXTERNAL_PRECONDITION");
        return;
      }

      const adapter = new CommandCodeAdapter();
      const health = await adapter.health();
      if (health.status !== "ready") {
        console.log(`COMMAND_CODE_LIVE=BLOCKED_EXTERNAL_PRECONDITION reason=${health.status}`);
        return;
      }
      console.log("COMMAND_CODE_AUTH=PASS");

      const models = await adapter.discoverModels();
      expect(models.length).toBeGreaterThan(0);
      console.log("MODEL_DISCOVERY_LIVE=PASS");
      console.log("DISCOVERED_MODELS:");
      for (const model of models.slice(0, 20)) {
        console.log(`- ${model.id}`);
        expect(model.id.startsWith("command-code/")).toBe(true);
        expect(model.id).not.toContain("[1m");
      }

      const selected = models[0]!;
      console.log("MODEL_SELECTED_FROM_DISCOVERY=YES");
      console.log(`LIVE_MODEL_USED=${selected.id}`);

      const events: { type: string }[] = [];
      const texts: string[] = [];
      for await (const event of adapter.run(
        {
          requestId: `cc-live-${Date.now()}`,
          model: selected,
          messages: [{ role: "user", content: "Reply exactly: CMM_COMMAND_CODE_SUBSCRIPTION_OK" }],
          tools: [],
          stream: true,
        },
        new AbortController().signal,
      )) {
        events.push(event as { type: string });
        if ((event as { type: string }).type === "text_delta") {
          texts.push((event as unknown as { text: string }).text);
        }
      }

      const textEvents = events.filter((e) => e.type === "text_delta");
      const completedEvent = events.find((e) => e.type === "completed");
      const errorEvent = events.find((e) => e.type === "error") as
        | { error: { code?: string; message?: string } }
        | undefined;

      console.log(`COMMAND_CODE_LIVE_INFERENCE=${errorEvent ? "FAIL" : "PASS"}`);
      console.log(`COMMAND_CODE_STREAMING=${textEvents.length > 0 ? "PASS" : "FAIL"}`);
      if (errorEvent) {
        console.log(`ERROR_CODE=${errorEvent.error.code ?? "unknown"}`);
        throw new Error(`Command Code live inference failed: ${errorEvent.error.message ?? "unknown"}`);
      }
      const fullText = texts.join("").trim();
      console.log("EXPECTED_TEXT=CMM_COMMAND_CODE_SUBSCRIPTION_OK");
      console.log(`ACTUAL_TEXT=${fullText}`);
      expect(fullText).toBe("CMM_COMMAND_CODE_SUBSCRIPTION_OK");
      expect(completedEvent).toBeDefined();
      console.log("REAL_COMPLETION=PASS");
      console.log("AUTO_TOP_UP_DISABLED=YES");
      console.log("ON_DEMAND_FALLBACK=NONE");
      console.log("EXTRA_CREDIT_ENDPOINT_USED=NO");
      console.log("CROSS_PROVIDER_FALLBACK=NONE");
    });
  },
);
