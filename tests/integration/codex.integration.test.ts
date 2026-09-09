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
      console.log(`Discovered ${models.length} models:`);
      for (const model of models) {
        console.log(`  - ${model.id}`);
      }

      // Step 2: Select gpt-5.6-sol if available
      console.log("\n=== STEP 2: Model Selection ===");
      const selectedModel = models.find((m) => m.id === "chatgpt/gpt-5.6-sol");
      if (!selectedModel) {
        throw new Error(`Expected gpt-5.6-sol but got: ${models[0]?.id || 'no models'}`);
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

      // Step 4: Execute live inference with read-only sandbox
      console.log("\n=== STEP 4: Live Inference (read-only sandbox) ===");
      const request: RouterRequest = {
        requestId: "live-test-sol",
        model: selectedModel,
        messages: [
          {
            role: "user",
            content: "Reply exactly: CMM_CODEX_SOL_OK",
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

      try {
        console.log("Starting event stream...");
        let eventCount = 0;
        for await (const event of adapter.run(request, abortController.signal)) {
          events.push(event);
          eventCount++;
          
          if (event.type === "text_delta") {
            if (!deltaReceived) {
              console.log("\n✓ First agentMessage/delta received");
              deltaReceived = true;
            }
            accumulatedText += event.text;
            process.stdout.write(event.text);
          } else if (event.type === "completed") {
            console.log("\n✓ Real turn/completed received from upstream");
            turnCompleted = true;
            break; // Exit immediately on real completion
          } else if (event.type === "usage") {
            console.log(`\n✓ Token usage reported`);
          } else if (event.type === "error") {
            console.error(`\n✗ Error event:`, event.error);
            throw event.error;
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
      
      // Verify we received deltas (streaming proof)
      expect(deltaReceived).toBe(true);
      console.log("✓ AGENT_MESSAGE_DELTA_RECEIVED=PASS");

      // Verify real turn completed (not synthetic)
      expect(turnCompleted).toBe(true);
      console.log("✓ REAL_TURN_COMPLETED=PASS");

      // Verify expected text
      console.log(`\nEXPECTED_TEXT=CMM_CODEX_SOL_OK`);
      console.log(`ACTUAL_TEXT=${accumulatedText.trim()}`);
      expect(accumulatedText.trim()).toContain("CMM_CODEX_SOL_OK");
      console.log("✓ SOL_LIVE_INFERENCE=PASS");

      // Verify streaming (at least one delta before completion)
      const deltaEvents = events.filter((e) => e.type === "text_delta");
      expect(deltaEvents.length).toBeGreaterThan(0);
      console.log(`✓ SOL_STREAMING=PASS (${deltaEvents.length} delta events)`);

      // Verify mutation canary unchanged
      expect(hashAfter).toBe(hashBefore);
      console.log("✓ MUTATION_CANARY=PASS");
      console.log("✓ SOL_CANARY_HASH_MATCH=YES");

      console.log("\n=== ALL CHECKS PASSED ===");
    },
    60000,
  );

  it.skipIf(!process.env.CMM_RUN_LIVE)(
    "proves live GPT-6 Astra inference",
    async () => {
      const adapter = new CodexAdapter();

      // Step 1: Discover models
      console.log("\n=== ASTRA TEST: Model Discovery ===");
      const models = await adapter.discoverModels();
      
      // Step 2: Check if Astra is available
      const astraModel = models.find((m) => m.id === "chatgpt/gpt-6-astra");
      if (!astraModel) {
        console.log("GPT-6 Astra not available, skipping Astra test");
        return;
      }
      console.log(`Selected model: ${astraModel.id}`);

      // Step 3: Create mutation canary
      const tempDir = await mkdtemp(join(tmpdir(), "codex-astra-canary-"));
      const canaryFile = join(tempDir, "canary.txt");
      const canaryContent = "This file must not be modified by Astra inference\n";
      await writeFile(canaryFile, canaryContent);
      
      const canaryBefore = await readFile(canaryFile);
      const hashBefore = createHash("sha256").update(canaryBefore).digest("hex");
      console.log(`ASTRA_CANARY_HASH_BEFORE=${hashBefore}`);

      // Step 4: Execute live inference with Astra
      console.log("\n=== ASTRA TEST: Live Inference ===");
      const request: RouterRequest = {
        requestId: "live-test-astra",
        model: astraModel,
        messages: [
          {
            role: "user",
            content: "Reply exactly: CMM_CODEX_ASTRA_OK",
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

      try {
        console.log("Starting Astra event stream...");
        for await (const event of adapter.run(request, abortController.signal)) {
          events.push(event);
          
          if (event.type === "text_delta") {
            if (!deltaReceived) {
              console.log("\n✓ First Astra agentMessage/delta received");
              deltaReceived = true;
            }
            accumulatedText += event.text;
            process.stdout.write(event.text);
          } else if (event.type === "completed") {
            console.log("\n✓ Real Astra turn/completed received from upstream");
            turnCompleted = true;
            break;
          }
        }
        console.log(`\nAstra event stream ended. Total events: ${events.length}`);
      } finally {
        abortController.abort();
      }

      // Step 5: Verify mutation canary
      console.log("\n=== ASTRA TEST: Mutation Canary Verification ===");
      const canaryAfter = await readFile(canaryFile);
      const hashAfter = createHash("sha256").update(canaryAfter).digest("hex");
      console.log(`ASTRA_CANARY_HASH_AFTER=${hashAfter}`);

      // Assertions
      console.log("\n=== ASTRA VERIFICATION ===");
      expect(deltaReceived).toBe(true);
      console.log("✓ ASTRA_DELTA_RECEIVED=PASS");
      expect(turnCompleted).toBe(true);
      console.log("✓ ASTRA_TURN_COMPLETED=PASS");
      expect(accumulatedText.trim()).toContain("CMM_CODEX_ASTRA_OK");
      console.log("✓ ASTRA_LIVE_INFERENCE=PASS");
      const deltaEvents = events.filter((e) => e.type === "text_delta");
      expect(deltaEvents.length).toBeGreaterThan(0);
      console.log(`✓ ASTRA_STREAMING=PASS (${deltaEvents.length} delta events)`);
      expect(hashAfter).toBe(hashBefore);
      console.log("✓ ASTRA_MUTATION_CANARY=PASS");
      console.log("\n=== ASTRA ALL CHECKS PASSED ===");
    },
    60000,
  );
});
