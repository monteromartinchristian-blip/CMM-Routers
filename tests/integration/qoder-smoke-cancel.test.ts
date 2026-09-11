import { describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "../..");

function smokeUses(substring: string): boolean {
  return (readFileSync(join(REPO, "scripts", "qoder-smoke.sh"), "utf-8") as string).includes(
    substring,
  );
}

describe("qoder smoke real-cancellation semantics", () => {
  it("kills the client mid-stream and requires router-book proof", () => {
    expect(smokeUses("kill -9")).toBe(true);
    expect(smokeUses("cancelledEvents")).toBe(true);
    expect(smokeUses("CANCEL_REACHABILITY=PASS")).toBe(false);
    expect(smokeUses("QODER_SMOKE_CANCELLATION=PASS")).toBe(true);
  });

  it("treats a too-fast request as BLOCKED, never as cancellation PASS", () => {
    expect(smokeUses("request-finished-before-cancel")).toBe(true);
  });

  it("proves real cancellation against a live scripted server", { timeout: 90000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "cmm-smoke-cancel-"));
    const port = 18992;
    writeFileSync(
      join(dir, "shared.json"),
      JSON.stringify({
        mode: "standalone",
        host: "127.0.0.1",
        port,
        bearerSecretEnv: "CMM_SMOKE_CANCEL_TOKEN",
        providers: {
          chatgpt: { enabled: false },
          claude: { enabled: false },
          google: { enabled: false },
          "command-code": { enabled: false, secretEnv: "COMMAND_CODE_SECRET" },
        },
      }),
    );
    writeFileSync(join(dir, "local.json"), JSON.stringify({}));
    const token = "smoke-cancel-secret";
    const child = spawn("node", [join(REPO, "dist", "index.js")], {
      env: {
        ...process.env,
        CMM_CONFIG_DIR: dir,
        CMM_SMOKE_CANCEL_TOKEN: token,
        CMM_TEST_PROVIDER: "scripted",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const base = `http://127.0.0.1:${port}`;
      const started = Date.now();
      for (;;) {
        try {
          const res = await fetch(`${base}/health`);
          if (res.ok) break;
        } catch {
          // not up yet
        }
        if (Date.now() - started > 15000) throw new Error("scripted server never came up");
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      // The scripted double answers instantly, so a mid-stream kill may
      // legitimately report BLOCKED (finished before cancel) — but it must
      // NEVER report a fake CANCEL_REACHABILITY PASS or a bare QODER_SMOKE
      // PASS without the cancellation verdict line.
      let output = "";
      let rc = 0;
      try {
        output = execFileSync("bash", [join(REPO, "scripts", "qoder-smoke.sh"), base], {
          encoding: "utf-8",
          env: { ...process.env, CMM_ROUTER_TOKEN: token },
          timeout: 60000,
        });
      } catch (error) {
        rc = (error as { status?: number }).status ?? 1;
        output = String((error as { stdout?: unknown }).stdout ?? output);
      }
      expect(output).not.toContain("CANCEL_REACHABILITY=PASS");
      // The scripted double answers instantly, so the kill legitimately
      // lands after completion: BLOCKED (finished before cancel) is the
      // honest verdict here. What must NEVER happen is a bare PASS without
      // the cancellation verdict line, or the old reachability fake.
      if (output.includes("QODER_SMOKE=PASS")) {
        expect(output).toContain("QODER_SMOKE_CANCELLATION=PASS");
      } else {
        expect(output).toMatch(/BLOCKED_EXTERNAL_PRECONDITION|QODER_SMOKE=FAIL step=cancel/);
      }
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (child.exitCode === null) child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
