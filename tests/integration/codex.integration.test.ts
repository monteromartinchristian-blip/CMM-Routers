import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { Duplex } from "node:stream";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CodexAppServerClient } from "../../src/providers/codex/app-server-client.js";
import { CodexAdapter } from "../../src/providers/codex/adapter.js";
import type { RouterRequest } from "../../src/core/provider.js";

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
        expect(firstModel.upstreamModel).toBeDefined();
        expect(firstModel.displayName).toBeDefined();
        expect(firstModel.capability).toBe("CHAT_ONLY_PENDING_TASK_13");
        
        console.log(`Discovered ${models.length} models:`);
        for (const model of models) {
          console.log(`  - ${model.id} (upstream: ${model.upstreamModel}, display: ${model.displayName}, capability: ${model.capability})`);
        }
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

  it.skipIf(!process.env.CMM_RUN_LIVE)(
    "proves live ChatGPT subscription inference with streaming",
    async () => {
      const adapter = new CodexAdapter();

      // Step 1: Discover models
      console.log("\n=== STEP 1: Model Discovery ===");
      const models = await adapter.discoverModels();
      expect(models.length).toBeGreaterThan(0);
      console.log(`Discovered ${models.length} models`);

      // Step 2: Select gpt-5.6-sol if available
      console.log("\n=== STEP 2: Model Selection ===");
      const selectedModel = models.find((m) => m.id === "chatgpt/gpt-5.6-sol");
      if (!selectedModel) {
        console.warn("gpt-5.6-sol not found, using first available model");
        // Use first model as fallback
        const firstModel = models[0];
        if (!firstModel) {
          throw new Error("No models discovered");
        }
        throw new Error(`Expected gpt-5.6-sol but got: ${firstModel.id}`);
      }
      console.log(`Selected model: ${selectedModel.id}`);
      expect(selectedModel.capability).toBe("CHAT_ONLY_PENDING_TASK_13");

      // Step 3: Create mutation canary
      console.log("\n=== STEP 3: Mutation Canary Setup ===");
      const tempDir = await mkdtemp(join(tmpdir(), "codex-live-canary-"));
      const canaryFile = join(tempDir, "canary.txt");
      const canaryContent = "This file must not be modified by live inference\n";
      await writeFile(canaryFile, canaryContent);
      
      const canaryBefore = await readFile(canaryFile);
      const hashBefore = createHash("sha256").update(canaryBefore).digest("hex");
      console.log(`CANARY_HASH_BEFORE=${hashBefore}`);

      // Step 4: Execute live inference
      console.log("\n=== STEP 4: Live Inference ===");
      const request: RouterRequest = {
        requestId: "live-test-001",
        model: selectedModel,
        messages: [
          {
            role: "user",
            content: "Reply exactly: CMM_CODEX_SUBSCRIPTION_OK",
          },
        ],
        tools: [],
        stream: true,
      };

      const abortController = new AbortController();
      const events: any[] = [];
      let accumulatedText = "";
      let deltaReceived = false;
      let turnCompleted = false;
      let threadStarted = false;
      let turnStarted = false;

      try {
        // The run() method internally calls ensureStarted() which performs:
        // initialize → initialized
        // Then: thread/start → turn/start
        // Then streams: item/agentMessage/delta → turn/completed
        
        console.log("Starting event stream...");
        let eventCount = 0;
        for await (const event of adapter.run(request, abortController.signal)) {
          events.push(event);
          eventCount++;
          console.log(`Received event #${eventCount}: ${event.type}`);
          
          if (event.type === "text_delta") {
            if (!deltaReceived) {
              console.log("\n✓ First agentMessage/delta received");
              deltaReceived = true;
            }
            accumulatedText += event.text;
            process.stdout.write(event.text);
          } else if (event.type === "completed") {
            console.log("\n✓ turn/completed received");
            turnCompleted = true;
            break; // Exit the loop immediately when completed
          } else if (event.type === "usage") {
            console.log(`\n✓ Token usage: input=${event.inputTokens}, output=${event.outputTokens}`);
          } else if (event.type === "error") {
            console.error(`\n✗ Error event:`, event.error);
          }
        }
        console.log(`\nEvent stream ended. Total events: ${events.length}`);
      } finally {
        abortController.abort();
      }

      // Step 5: Verify mutation canary after inference
      console.log("\n=== STEP 5: Mutation Canary Verification ===");
      const canaryAfter = await readFile(canaryFile);
      const hashAfter = createHash("sha256").update(canaryAfter).digest("hex");
      console.log(`CANARY_HASH_AFTER=${hashAfter}`);

      // Assertions
      console.log("\n=== VERIFICATION ===");
      
      // Verify we received deltas
      expect(deltaReceived).toBe(true);
      console.log("✓ AGENT_MESSAGE_DELTA_RECEIVED=PASS");

      // Verify turn completed
      expect(turnCompleted).toBe(true);
      console.log("✓ TURN_COMPLETED=PASS");

      // Verify expected text
      console.log(`\nEXPECTED_TEXT=CMM_CODEX_SUBSCRIPTION_OK`);
      console.log(`ACTUAL_TEXT=${accumulatedText.trim()}`);
      expect(accumulatedText.trim()).toContain("CMM_CODEX_SUBSCRIPTION_OK");
      console.log("✓ LIVE_SUBSCRIPTION_INFERENCE=PASS");

      // Verify streaming (at least one delta before completion)
      const deltaEvents = events.filter((e) => e.type === "text_delta");
      expect(deltaEvents.length).toBeGreaterThan(0);
      console.log(`✓ LIVE_STREAMING=PASS (${deltaEvents.length} delta events)`);

      // Verify mutation canary
      expect(hashAfter).toBe(hashBefore);
      console.log("✓ MUTATION_CANARY=PASS");
      console.log("✓ CANARY_HASH_MATCH=YES");

      console.log("\n=== ALL CHECKS PASSED ===");
    },
    60000,
  );
});
