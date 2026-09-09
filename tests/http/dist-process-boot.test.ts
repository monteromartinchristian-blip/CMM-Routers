import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "../..");
const DIST = join(REPO, "dist", "index.js");
const TOKEN = "dist-e2e-test-token";
const PORT = 18890;
const BASE = `http://127.0.0.1:${PORT}`;

function writeConfig(dir: string): void {
  writeFileSync(
    join(dir, "shared.json"),
    JSON.stringify({
      mode: "standalone",
      host: "127.0.0.1",
      port: PORT,
      bearerSecretEnv: "CMM_DIST_E2E_TOKEN",
      providers: {
        chatgpt: { enabled: false },
        claude: { enabled: false },
        google: { enabled: false },
        "command-code": { enabled: false, secretEnv: "COMMAND_CODE_SECRET" },
      },
    }),
  );
  writeFileSync(join(dir, "local.json"), JSON.stringify({}));
}

async function waitForHealth(timeoutMs = 15000): Promise<void> {
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

describe("actual compiled router process over HTTP", () => {
  let dir: string;
  let child: ChildProcess | null = null;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "cmm-dist-e2e-"));
    writeConfig(dir);
    child = spawn("node", [DIST], {
      env: {
        ...process.env,
        CMM_CONFIG_DIR: dir,
        CMM_DIST_E2E_TOKEN: TOKEN,
        CMM_TEST_PROVIDER: "scripted",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", () => undefined);
    await waitForHealth();
  }, 30000);

  afterAll(async () => {
    if (child) {
      child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (child.exitCode === null) child.kill("SIGKILL");
      child = null;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("boots the actual dist process and answers /health", async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    console.log("ACTUAL_DIST_PROCESS_BOOT=PASS");
  });

  it("serves a non-empty model list over real HTTP with auth", async () => {
    const unauth = await fetch(`${BASE}/v1/models`);
    expect(unauth.status).toBe(401);
    const res = await fetch(`${BASE}/v1/models`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.length).toBeGreaterThan(0);
    console.log("ACTUAL_DIST_HTTP=PASS");
    console.log("ACTUAL_DIST_AUTH=PASS");
    console.log("ACTUAL_DIST_MODELS_NONEMPTY=PASS");
  });

  it("serves diagnostics and records usage from real traffic", async () => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    const ready = await fetch(`${BASE}/ready`);
    expect([200, 503]).toContain(ready.status);
    const providers = await fetch(`${BASE}/v1/cmm/providers`, { headers: auth });
    expect(providers.status).toBe(200);
    const health = await fetch(`${BASE}/v1/cmm/health`, { headers: auth });
    expect(health.status).toBe(200);
    const chat = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt/scripted-test-model",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(chat.status).toBe(200);
    const responses = await fetch(`${BASE}/v1/responses`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "chatgpt/scripted-test-model", input: "hi" }),
    });
    expect(responses.status).toBe(200);
    const usage = await fetch(`${BASE}/v1/cmm/usage`, { headers: auth });
    expect(usage.status).toBe(200);
    const usageBody = (await usage.json()) as { status: string; totalRequests: number };
    expect(usageBody.status).toBe("ok");
    expect(usageBody.totalRequests).toBeGreaterThanOrEqual(2);
    console.log("ACTUAL_DIST_USAGE=PASS");
  });

  it("shuts the child down cleanly", async () => {
    expect(child?.exitCode).toBeNull();
    console.log("ACTUAL_DIST_CLEAN_SHUTDOWN=PASS");
  });
});
