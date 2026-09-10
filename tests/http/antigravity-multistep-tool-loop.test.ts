import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import {
  AntigravityAdapter,
  SpawnInferenceRunner,
  type InferenceRunner,
} from "../../src/providers/antigravity/adapter.js";
import { DeferredToolBroker } from "../../src/core/deferred-tool-broker.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

const REPO = join(import.meta.dirname, "../..");
const TSX = join(REPO, "node_modules/.bin/tsx");
const LAUNCHER_TS = join(REPO, "src/bridge/mcp-bridge-launcher.ts");
const FAKE_AGY_MULTISTEP = join(import.meta.dirname, "../helpers/fake-agy-multistep.js");

const savedEnv: Record<string, string | undefined> = {};
let registryDir: string;

beforeAll(() => {
  for (const key of [
    "CMM_TEST_TSX",
    "CMM_TEST_LAUNCHER",
    "CMM_TEST_TOOL_A",
    "CMM_TEST_TOOL_B",
    "CMM_BRIDGE_REGISTRY_DIR",
  ]) {
    savedEnv[key] = process.env[key];
  }
  registryDir = mkdtempSync(join(tmpdir(), "cmm-ms-http-registry-"));
  process.env.CMM_TEST_TSX = TSX;
  process.env.CMM_TEST_LAUNCHER = LAUNCHER_TS;
  process.env.CMM_TEST_TOOL_A = "cmm_echo";
  process.env.CMM_TEST_TOOL_B = "cmm_echo";
  process.env.CMM_BRIDGE_REGISTRY_DIR = registryDir;
});
afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    rmSync(registryDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

/** Real SpawnInferenceRunner whose child command is the multi-step fixture. */
function multistepRunner(): InferenceRunner {
  const inner = new SpawnInferenceRunner(process.execPath, { terminationGraceMs: 200 });
  return {
    runInference: (args, options) => inner.runInference([FAKE_AGY_MULTISTEP, ...args], options),
    streamInference: (args, options, onEvent) =>
      inner.streamInference([FAKE_AGY_MULTISTEP, ...args], options, onEvent),
  };
}

/** Model discovery stub so no real agy process is required. */
const modelsRunner = {
  run: (): { status: number | null; signal: null; stdout: string; stderr: string } => ({
    status: 0,
    signal: null,
    stdout: "test-model    Test Model\n",
    stderr: "",
  }),
};

type ChatBody = {
  choices: Array<{
    finish_reason: string;
    message: {
      content: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
  }>;
};

describe("Router-level Antigravity two-step agent loop", () => {
  it("runs tool A then tool B on one agy run and returns a final derived from both", async () => {
    const adapter = new AntigravityAdapter(multistepRunner(), modelsRunner as never, {
      broker: new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 30000 }),
      bridgeCommand: TSX,
      bridgeLauncherPath: LAUNCHER_TS,
      mcpRegistrar: () => undefined,
      sessionTtlMs: 30000,
    });
    const registry = new ProviderRegistry();
    await registry.register(adapter);
    await registry.refresh();
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: "s",
      qoderToken: "q",
      registry,
    });
    const auth = { authorization: "Bearer q" };
    const user = { role: "user", content: "go" };

    try {
      const first = await server.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: auth,
        payload: { model: "google/test-model", messages: [user], tools: [CMM_ECHO_TOOL] },
      });
      expect(first.statusCode).toBe(200);
      const firstBody = first.json() as ChatBody;
      expect(firstBody.choices[0]!.finish_reason).toBe("tool_calls");
      const callA = firstBody.choices[0]!.message.tool_calls![0]!;
      expect(typeof callA.id).toBe("string");
      expect(callA.id.length).toBeGreaterThan(0);

      const second = await server.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: auth,
        payload: {
          model: "google/test-model",
          messages: [
            user,
            {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: callA.id, type: "function", function: { name: "cmm_echo", arguments: callA.function.arguments } },
              ],
            },
            { role: "tool", tool_call_id: callA.id, content: "RESULT_A" },
          ],
          tools: [CMM_ECHO_TOOL],
        },
      });
      expect(second.statusCode).toBe(200);
      const secondBody = second.json() as ChatBody;
      const callB = secondBody.choices[0]!.message.tool_calls?.[0];
      expect(callB).toBeDefined();
      expect(callB!.id).not.toBe(callA.id);

      const third = await server.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: auth,
        payload: {
          model: "google/test-model",
          messages: [
            user,
            {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: callA.id, type: "function", function: { name: "cmm_echo", arguments: callA.function.arguments } },
              ],
            },
            { role: "tool", tool_call_id: callA.id, content: "RESULT_A" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: callB!.id, type: "function", function: { name: "cmm_echo", arguments: callB!.function.arguments } },
              ],
            },
            { role: "tool", tool_call_id: callB!.id, content: "RESULT_B" },
          ],
          tools: [CMM_ECHO_TOOL],
        },
      });
      expect(third.statusCode).toBe(200);
      const thirdBody = third.json() as ChatBody;
      expect(thirdBody.choices[0]!.message.content).toContain("final:RESULT_A|RESULT_B");
      expect(adapter.activeToolSessions()).toBe(0);
      expect(adapter.liveRendezvousSessions()).toBe(0);
      console.log("MULTI_STEP_QODER_AGENT_LOOP_GOOGLE_HTTP=PASS");
      console.log("MULTI_STEP_QODER_AGENT_LOOP=PASS");
    } finally {
      await server.close();
    }
  }, 60000);
});
