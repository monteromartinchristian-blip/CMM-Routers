import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

/**
 * Phase 6 — compiled-process Code Router E2E.
 *
 * Boots the ACTUAL built `dist/index.js`, serves it over real loopback HTTP, and
 * proves the whole canonical contract with no live provider:
 *
 *   built process -> capability publication -> exact CHAT_AND_TOOLS model ->
 *   tool declaration -> structured tool call -> client-owned execution ->
 *   structured result -> same provider/model continuation -> final answer ->
 *   clean shutdown.
 *
 * The provider is the test-only `scripted-tools` double, injected solely through
 * CMM_TEST_PROVIDER. It performs no network I/O and consumes no quota.
 */

const REPO = join(import.meta.dirname, "../..");
const DIST = join(REPO, "dist", "index.js");
const PORT = 18891;
const BASE = `http://127.0.0.1:${PORT}`;
const CMMCHAT_ENV = "CMM_DIST_CODE_E2E_CMMCHAT";
const CMMCHAT_TOKEN = "dist-code-router-cmmchat-token";
const CODE_TOKEN = "dist-code-router-code-token";
const MODEL = "command-code/scripted-tool-model";

function writeConfig(dir: string): void {
  writeFileSync(
    join(dir, "shared.json"),
    JSON.stringify({
      mode: "standalone",
      host: "127.0.0.1",
      port: PORT,
      bearerSecretEnv: CMMCHAT_ENV,
      providers: {
        chatgpt: { enabled: false },
        claude: { enabled: false },
        google: { enabled: false },
        "command-code": { enabled: false, secretEnv: "COMMAND_CODE_SECRET" },
        cavoti: {
          enabled: false,
          baseUrl: "https://cavoti.com/v1",
          secretEnv: "CAVOTI_API_KEY",
          model: "deepseek-v4.1-flash",
        },
      },
    }),
  );
  writeFileSync(join(dir, "local.json"), JSON.stringify({}));
}

async function waitForHealth(timeoutMs = 20000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() - started > timeoutMs) throw new Error("dist process never became healthy");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe("compiled process: generic Code Router end to end", () => {
  let dir: string;
  let child: ChildProcess | null = null;

  beforeAll(async () => {
    if (!existsSync(DIST)) {
      throw new Error(`missing ${DIST}: run 'npm run build' before this E2E`);
    }
    dir = mkdtempSync(join(tmpdir(), "cmm-dist-code-e2e-"));
    writeConfig(dir);
    child = spawn("node", [DIST], {
      env: {
        ...process.env,
        CMM_CONFIG_DIR: dir,
        [CMMCHAT_ENV]: CMMCHAT_TOKEN,
        CMM_CODE_ROUTER_TOKEN: CODE_TOKEN,
        CMM_TEST_PROVIDER: "scripted-tools",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", () => undefined);
    await waitForHealth();
  }, 40000);

  afterAll(async () => {
    if (child) {
      child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (child.exitCode === null) child.kill("SIGKILL");
      child = null;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const codeAuth = { authorization: `Bearer ${CODE_TOKEN}` };

  it("publishes the exact CHAT_AND_TOOLS model capability over real HTTP", async () => {
    const unauth = await fetch(`${BASE}/v1/models`);
    expect(unauth.status).toBe(401);

    const res = await fetch(`${BASE}/v1/models`, { headers: codeAuth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; x_cmm?: { code_router?: string } }>;
    };
    const model = body.data.find((entry) => entry.id === MODEL);
    expect(model?.x_cmm?.code_router).toBe("CHAT_AND_TOOLS");
    console.log("COMPILED_PROCESS_MODEL_CAPABILITY=PASS");
  });

  it("completes the full client-owned tool round trip", async () => {
    const first = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { ...codeAuth, "Content-Type": "application/json", "x-cmm-client": "generic-openai" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "echo please" }],
        tools: [CMM_ECHO_TOOL],
      }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      model: string;
      choices: Array<{
        finish_reason: string;
        message: { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
      }>;
    };
    expect(firstBody.model).toBe(MODEL);
    expect(firstBody.choices[0]!.finish_reason).toBe("tool_calls");
    const call = firstBody.choices[0]!.message.tool_calls![0]!;
    expect(call.function.name).toBe("cmm_echo");
    console.log("COMPILED_PROCESS_TOOL_CALL_SURFACED=PASS");

    const second = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { ...codeAuth, "Content-Type": "application/json", "x-cmm-client": "generic-openai" },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "user", content: "echo please" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: call.id,
                type: "function",
                function: { name: call.function.name, arguments: call.function.arguments },
              },
            ],
          },
          { role: "tool", tool_call_id: call.id, content: "CLIENT_RESULT" },
        ],
        tools: [CMM_ECHO_TOOL],
      }),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      choices: Array<{ finish_reason: string; message: { content: string } }>;
    };
    expect(secondBody.choices[0]!.finish_reason).toBe("stop");
    expect(secondBody.choices[0]!.message.content).toBe(
      `scripted-final[ids=${call.id}][results=CLIENT_RESULT]`,
    );
    console.log("COMPILED_PROCESS_CONTINUATION=PASS");
    console.log("COMPILED_PROCESS_CODE_ROUTER_E2E=PASS");
  });

  it("keeps CMMChat CHAT_ONLY inside the compiled process", async () => {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${CMMCHAT_TOKEN}`,
        "Content-Type": "application/json",
        "x-cmm-client": "qoder",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "hi" }],
        tools: [CMM_ECHO_TOOL],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("unsupported_capability");
    console.log("COMPILED_PROCESS_CMMCHAT_CHAT_ONLY=PASS");
  });

  it("shuts the child down cleanly", () => {
    expect(child?.exitCode).toBeNull();
    console.log("COMPILED_PROCESS_CLEAN_SHUTDOWN=PASS");
  });
});
