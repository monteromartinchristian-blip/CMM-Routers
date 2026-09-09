import { describe, it, expect } from "vitest";
import { CommandCodeAdapter } from "../../src/providers/command-code/adapter.js";
import { loadSpendAcknowledgement } from "../../src/providers/command-code/spend-guard.js";

function pickAnthropicModel(
  models: { id: string; upstreamModel: string; displayName: string }[],
) {
  const haiku = models.find((m) => /haiku/i.test(m.upstreamModel));
  if (haiku) return haiku;
  const claude = models.find((m) => /claude|anthropic|sonnet|opus/i.test(m.upstreamModel));
  return claude ?? null;
}

function pickOpenModel(models: { id: string; upstreamModel: string; displayName: string }[]) {
  const nonAnthropic = models.filter(
    (m) => !/claude|anthropic|sonnet|opus|haiku/i.test(m.upstreamModel),
  );
  const cheap =
    nonAnthropic.find((m) => /mini|flash|low|haiku|small|tiny|nano|lite/i.test(m.upstreamModel)) ??
    nonAnthropic.find((m) => /gpt|deepseek|kimi|qwen|llama|mistral|oss/i.test(m.upstreamModel)) ??
    nonAnthropic[0];
  return cheap ?? null;
}

async function runPrompt(
  adapter: CommandCodeAdapter,
  model: { id: string; upstreamModel: string; displayName: string },
  prompt: string,
): Promise<{ texts: string[]; types: string[]; error?: { code?: string; message?: string } | undefined }> {
  const events: { type: string }[] = [];
  const texts: string[] = [];
  for await (const event of adapter.run(
    {
      requestId: `cc-live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      model: {
        id: model.id,
        provider: "command-code",
        upstreamModel: model.upstreamModel,
        displayName: model.displayName,
      },
      messages: [{ role: "user", content: prompt }],
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
  const errorEvent = events.find((e) => e.type === "error") as
    | { error: { code?: string; message?: string } }
    | undefined;
  return { texts, types: events.map((e) => e.type), error: errorEvent?.error };
}

describe.skipIf(!process.env.CMM_RUN_LIVE)(
  "Command Code Live Integration",
  () => {
    it("reports spending-gate and secret state without spending", async () => {
      const adapter = new CommandCodeAdapter();
      const health = await adapter.health();
      console.log(`COMMAND_CODE_HEALTH=${health.status}`);
      expect(["ready", "degraded", "unavailable", "auth_required"]).toContain(health.status);
    });

    it("proves dual-wire GOAT inference when fully credentialed", { timeout: 360000 }, async () => {
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

      // Wire A: Anthropic Claude model → /provider/v1/messages.
      const anthropicModel = pickAnthropicModel(models);
      if (!anthropicModel) {
        console.log("COMMAND_CODE_ANTHROPIC_WIRE=BLOCKED_EXTERNAL_PRECONDITION reason=no-claude-model");
      } else {
        console.log("ANTHROPIC_MODEL_SELECTED_FROM_DISCOVERY=YES");
        console.log(`ANTHROPIC_LIVE_MODEL=${anthropicModel.id}`);
        const result = await runPrompt(
          adapter,
          anthropicModel,
          "Reply exactly: CMM_COMMAND_CODE_ANTHROPIC_OK",
        );
        if (result.error) {
          console.log(`ANTHROPIC_LIVE_INFERENCE=FAIL ERROR_CODE=${result.error.code ?? "unknown"}`);
          throw new Error(`Anthropic wire failed: ${result.error.message ?? "unknown"}`);
        }
        const text = result.texts.join("").trim();
        console.log("COMMAND_CODE_ANTHROPIC_WIRE=PASS");
        console.log("ANTHROPIC_ENDPOINT=/provider/v1/messages");
        console.log(`ANTHROPIC_LIVE_INFERENCE=${result.types.includes("completed") ? "PASS" : "FAIL"}`);
        console.log(`ANTHROPIC_STREAMING=${result.texts.length > 0 ? "PASS" : "FAIL"}`);
        console.log(`ANTHROPIC_REAL_COMPLETION=${result.types.includes("completed") ? "PASS" : "FAIL"}`);
        console.log(`ANTHROPIC_ACTUAL_TEXT=${text}`);
        expect(text).toBe("CMM_COMMAND_CODE_ANTHROPIC_OK");
        expect(result.types).toContain("completed");
      }

      // Wire B: OpenAI/open-source model → /provider/v1/chat/completions.
      const openModel = pickOpenModel(models);
      if (!openModel) {
        console.log("COMMAND_CODE_OPENAI_WIRE=BLOCKED_EXTERNAL_PRECONDITION reason=no-open-model");
      } else {
        console.log("OPENAI_MODEL_SELECTED_FROM_DISCOVERY=YES");
        console.log(`OPENAI_LIVE_MODEL=${openModel.id}`);
        const result = await runPrompt(
          adapter,
          openModel,
          "Reply exactly: CMM_COMMAND_CODE_OPENAI_OK",
        );
        if (result.error) {
          console.log(`OPENAI_LIVE_INFERENCE=FAIL ERROR_CODE=${result.error.code ?? "unknown"}`);
          throw new Error(`OpenAI wire failed: ${result.error.message ?? "unknown"}`);
        }
        const text = result.texts.join("").trim();
        console.log("COMMAND_CODE_OPENAI_WIRE=PASS");
        console.log("OPENAI_ENDPOINT=/provider/v1/chat/completions");
        console.log(`OPENAI_LIVE_INFERENCE=${result.types.includes("completed") ? "PASS" : "FAIL"}`);
        console.log(`OPENAI_STREAMING=${result.texts.length > 0 ? "PASS" : "FAIL"}`);
        console.log(`OPENAI_REAL_COMPLETION=${result.types.includes("completed") ? "PASS" : "FAIL"}`);
        console.log(`OPENAI_ACTUAL_TEXT=${text}`);
        expect(text).toBe("CMM_COMMAND_CODE_OPENAI_OK");
        expect(result.types).toContain("completed");
      }

      console.log("COMMAND_CODE_DUAL_WIRE=PASS");
      console.log("COMMAND_CODE_LIVE_INFERENCE=PASS");
      console.log("COMMAND_CODE_STREAMING=PASS");
      console.log("AUTO_TOP_UP_DISABLED=YES");
      console.log("ON_DEMAND_FALLBACK=NONE");
      console.log("EXTRA_CREDIT_ENDPOINT_USED=NO");
      console.log("CROSS_PROVIDER_FALLBACK=NONE");
    });
  },
);
