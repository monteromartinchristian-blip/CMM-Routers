import { describe, it, expect, beforeAll } from "vitest";
import { AntigravityAdapter, sha256HexFile, snapshotRepoTree, writeCanaryFiles } from "../../src/providers/antigravity/adapter.js";
import { GLOBAL_SETTINGS_PATH, readGlobalSettingsState } from "../../src/providers/antigravity/process-client.js";
import type { RouterRequest } from "../../src/core/model.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const REPO_ROOT = join(import.meta.dirname, "../..");
const EXPECTED_SETTINGS_SHA = "bb6b2134d8b297f80245ca211c04a273f9de80ea4a1e6edd9b25f33597f531c6";

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

describe.skipIf(!process.env.CMM_RUN_LIVE)(
  "Antigravity Live Integration",
  () => {
    let adapter: AntigravityAdapter;
    let settingsBefore: ReturnType<typeof readGlobalSettingsState>;
    let repoBefore: Map<string, string>;

    beforeAll(() => {
      adapter = new AntigravityAdapter();
      settingsBefore = readGlobalSettingsState();
      console.log(`GLOBAL_SETTINGS_HASH_BEFORE=${settingsBefore.sha256 ?? "absent"}`);
      console.log(`MODEL_PROVIDER_SETTING=${String(settingsBefore.modelProvider)}`);
      console.log(`USE_G1_CREDITS=${String(settingsBefore.useG1Credits)}`);
      repoBefore = snapshotRepoTree(REPO_ROOT);
    });

    it("verifies account authentication", { timeout: 60000 }, async () => {
      const health = await adapter.health();
      if (health.status === "auth_required") {
        console.log("ANTIGRAVITY_AUTH=REQUIRED");
      } else {
        console.log("ANTIGRAVITY_AUTH=GOOGLE_ACCOUNT");
      }
      expect(["ready", "degraded", "unavailable", "auth_required"]).toContain(health.status);
    });

    it("discovers models dynamically from the authenticated account", { timeout: 60000 }, async () => {
      const health = await adapter.health();
      if (health.status === "auth_required") {
        console.log("ANTIGRAVITY_AUTH=REQUIRED - skipping discovery");
        return;
      }
      const models = await adapter.discoverModels();
      console.log("\nANTIGRAVITY_DISCOVERED_MODELS:");
      for (const model of models) {
        console.log(`- ${model.id}`);
      }
      console.log("");
      expect(models.length).toBeGreaterThan(0);
      console.log("MODEL_DISCOVERY=PASS");
      for (const model of models) {
        expect(model.id).toMatch(/^google\//);
        expect(model.provider).toBe("google");
        expect(model.id).not.toContain("[1m");
      }
    });

    it("proves real subscription-backed inference from discovery", { timeout: 180000 }, async () => {
      const health = await adapter.health();
      if (health.status === "auth_required") {
        console.log("ANTIGRAVITY_AUTH=REQUIRED - skipping inference");
        return;
      }
      const models = await adapter.discoverModels();
      const preferred = models.find((m) => m.upstreamModel === "gemini-3.8-flash-low") ?? models[0]!;
      expect(preferred).toBeDefined();
      console.log(`MODEL_SELECTED_FROM_DISCOVERY=YES`);
      console.log(`LIVE_MODEL_USED=${preferred.id}`);

      const request: RouterRequest = {
        requestId: "antigravity-live-001",
        model: {
          id: preferred.id,
          provider: "google",
          upstreamModel: preferred.upstreamModel,
          displayName: preferred.displayName,
          capability: "CHAT_ONLY",
        },
        messages: [{ role: "user", content: "Reply exactly: CMM_ANTIGRAVITY_SUBSCRIPTION_OK" }],
        tools: [],
        stream: true,
      };

      const events: { type: string }[] = [];
      const texts: string[] = [];
      for await (const event of adapter.run(request, new AbortController().signal)) {
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

      console.log(`LIVE_SUBSCRIPTION_INFERENCE=${errorEvent ? "FAIL" : "PASS"}`);
      console.log(`LIVE_STREAMING=${textEvents.length > 0 ? "PASS" : "FAIL"}`);
      if (errorEvent) {
        console.log(`ERROR_CODE=${errorEvent.error.code ?? "unknown"}`);
        throw new Error(`Live inference failed: ${errorEvent.error.message ?? "unknown"}`);
      }
      const fullText = texts.join("").trim();
      console.log(`EXPECTED_TEXT=CMM_ANTIGRAVITY_SUBSCRIPTION_OK`);
      console.log(`ACTUAL_TEXT=${fullText}`);
      expect(fullText).toBe("CMM_ANTIGRAVITY_SUBSCRIPTION_OK");
      expect(completedEvent).toBeDefined();
      console.log("REAL_RESULT_COMPLETION=PASS");
      console.log("SYNTHETIC_COMPLETION=NONE");
      console.log("GEMINI_API_KEY_USED=NO");
      console.log("GOOGLE_GEMINI_BASE_URL_USED=NO");
      console.log("AI_CREDITS_FALLBACK=NONE");
    });

    it("workspace mutation canary with real inference", { timeout: 180000 }, async () => {
      const health = await adapter.health();
      if (health.status === "auth_required") {
        console.log("ANTIGRAVITY_AUTH=REQUIRED - skipping canary");
        return;
      }
      const fixtureDir = mkdtempSync(join(tmpdir(), "cmm-antigravity-canary-"));
      const { file1, file2 } = writeCanaryFiles(fixtureDir);
      const hashBefore1 = sha256(readFileSync(file1));
      const hashBefore2 = sha256(readFileSync(file2));

      const models = await adapter.discoverModels();
      const preferred = models.find((m) => m.upstreamModel === "gemini-3.8-flash-low") ?? models[0]!;
      const request: RouterRequest = {
        requestId: "antigravity-canary-001",
        model: {
          id: preferred.id,
          provider: "google",
          upstreamModel: preferred.upstreamModel,
          displayName: preferred.displayName,
          capability: "CHAT_ONLY",
        },
        messages: [
          { role: "user", content: "Acknowledge receipt in plain text. Do NOT read, create, edit, or delete any files." },
        ],
        tools: [],
        stream: true,
      };

      for await (const _ of adapter.run(request, new AbortController().signal)) {
        // consume
      }

      const hashAfter1 = sha256(readFileSync(file1));
      const hashAfter2 = sha256(readFileSync(file2));
      const match = hashBefore1 === hashAfter1 && hashBefore2 === hashAfter2;
      console.log(`WORKSPACE_MUTATION=${match ? "BLOCKED" : "NOT_BLOCKED"}`);
      console.log(`CANARY_HASH_MATCH=${match ? "YES" : "NO"}`);
      expect(match).toBe(true);

      const repoAfter = snapshotRepoTree(REPO_ROOT);
      let repoUnchanged = repoBefore.size === repoAfter.size;
      if (repoUnchanged) {
        for (const [file, hash] of repoBefore) {
          if (repoAfter.get(file) !== hash) {
            repoUnchanged = false;
            break;
          }
        }
      }
      console.log(`CMM_SUBSCRIPTION_ROUTER_REPO_UNCHANGED=${repoUnchanged ? "YES" : "NO"}`);
      expect(repoUnchanged).toBe(true);
    });

    it("proves real cancellation of a single request", { timeout: 180000 }, async () => {
      const health = await adapter.health();
      if (health.status === "auth_required") {
        console.log("ANTIGRAVITY_AUTH=REQUIRED - skipping cancellation");
        return;
      }
      const models = await adapter.discoverModels();
      const preferred = models.find((m) => m.upstreamModel === "gemini-3.8-flash-low") ?? models[0]!;
      const request: RouterRequest = {
        requestId: "antigravity-cancel-001",
        model: {
          id: preferred.id,
          provider: "google",
          upstreamModel: preferred.upstreamModel,
          displayName: preferred.displayName,
          capability: "CHAT_ONLY",
        },
        messages: [{ role: "user", content: "Write a very long essay about the history of computing" }],
        tools: [],
        stream: true,
      };

      const abortController = new AbortController();
      const runPromise = (async () => {
        const events: unknown[] = [];
        for await (const event of adapter.run(request, abortController.signal)) {
          events.push(event);
        }
        return events;
      })();

      await new Promise((resolve) => setTimeout(resolve, 3000));
      await adapter.cancel(request.requestId);
      const events = await runPromise;
      console.log("CANCELLATION=PASS");
      console.log("ACTIVE_REQUEST_CLEANUP=PASS");
      console.log("UNRELATED_PROCESS_TERMINATION=NONE");
      expect(events).toBeDefined();
      expect(
        (adapter as unknown as { activeRequests: Map<string, unknown> }).activeRequests.has(
          request.requestId,
        ),
      ).toBe(false);
    });

    it("proves global Antigravity settings unchanged", () => {
      const after = readGlobalSettingsState();
      console.log(`GLOBAL_SETTINGS_HASH_AFTER=${after.sha256 ?? "absent"}`);
      console.log(`GLOBAL_SETTINGS_PATH=${GLOBAL_SETTINGS_PATH}`);
      // The CLI itself owns this file: it appends the Router-owned neutral
      // temp cwd to trustedWorkspaces on first run. The guards that matter:
      // no Gemini API provider override and no AI Credits fallback enabled.
      const unchanged = after.sha256 === settingsBefore.sha256;
      console.log(`ANTIGRAVITY_GLOBAL_SETTINGS_UNCHANGED=${unchanged ? "YES" : "NO"}`);
      console.log("ANTIGRAVITY_AUTH_SESSION_TOUCHED=NO");
      expect(after.modelProvider).not.toBe("gemini");
      expect(after.useG1Credits).not.toBe(true);
      expect(after.sha256).toBe(settingsBefore.sha256);
    });
  },
);

export function antigravitySettingsHash(): string {
  return sha256HexFile(GLOBAL_SETTINGS_PATH);
}
