import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "../../scripts/preflight.sh");

function runPreflight(env: Record<string, string | undefined>): { rc: number; output: string } {
  try {
    const output = execFileSync("bash", [SCRIPT], {
      encoding: "utf-8",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        ...env,
      },
      timeout: 30000,
    });
    return { rc: 0, output };
  } catch (error) {
    const err = error as { status?: number; stdout?: unknown };
    return { rc: err.status ?? 1, output: String(err.stdout ?? "") };
  }
}

function writeShared(dir: string, providers: Record<string, unknown>): void {
  writeFileSync(
    join(dir, "shared.json"),
    JSON.stringify({
      mode: "standalone",
      host: "127.0.0.1",
      port: 8790,
      bearerSecretEnv: "CMM_ROUTER_TOKEN",
      providers,
    }),
  );
}

describe("preflight effective provider configuration", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmm-preflight-cfg-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("checks the configured claude profileDir, not the default", () => {
    const custom = mkdtempSync(join(tmpdir(), "cmm-custom-claude-"));
    const dir2 = mkdtempSync(join(tmpdir(), "cmm-preflight-cfg2-"));
    try {
      writeShared(dir, {
        chatgpt: { enabled: false },
        claude: { enabled: true, profileDir: custom },
        google: { enabled: false },
        "command-code": { enabled: false, secretEnv: "COMMAND_CODE_SECRET" },
      });
      const present = runPreflight({ CMM_CONFIG_DIR: dir });
      expect(present.output).toContain(`CLAUDE_PROFILE_DIR_CONFIG=${custom}`);
      expect(present.output).toContain("CLAUDE_ROUTER_PROFILE=PASS");
      console.log("PREFLIGHT_CLAUDE_PROFILE_CONFIG=PASS");

      writeShared(dir2, {
        chatgpt: { enabled: false },
        claude: { enabled: true, profileDir: join(dir2, "no-such-profile") },
        google: { enabled: false },
        "command-code": { enabled: false, secretEnv: "COMMAND_CODE_SECRET" },
      });
      const missing = runPreflight({ CMM_CONFIG_DIR: dir2 });
      expect(missing.output).toContain("CLAUDE_ROUTER_PROFILE=MISSING");
      expect(missing.rc).not.toBe(0);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
      rmSync(custom, { recursive: true, force: true });
    }
  });

  it("checks the configured agyPath as authoritative", () => {
    const fakeAgy = join(mkdtempSync(join(tmpdir(), "cmm-fakeagy-")), "agy");
    writeFileSync(fakeAgy, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeAgy, 0o755);
    writeShared(dir, {
      chatgpt: { enabled: false },
      claude: { enabled: false },
      google: { enabled: true, agyPath: fakeAgy },
      "command-code": { enabled: false, secretEnv: "COMMAND_CODE_SECRET" },
    });
    const present = runPreflight({ CMM_CONFIG_DIR: dir });
    expect(present.output).toContain(`AGY_PATH_CONFIG=${fakeAgy}`);
    expect(present.output).toContain("AGY_BINARY=PASS");
    console.log("PREFLIGHT_AGY_PATH_CONFIG=PASS");

    writeShared(dir, {
      chatgpt: { enabled: false },
      claude: { enabled: false },
      google: { enabled: true, agyPath: "/tmp/definitely-not-agy-xyz" },
      "command-code": { enabled: false, secretEnv: "COMMAND_CODE_SECRET" },
    });
    const missing = runPreflight({ CMM_CONFIG_DIR: dir });
    expect(missing.output).toContain("AGY_BINARY=FAIL");
    expect(missing.rc).not.toBe(0);
  });

  it("checks the configured command secret env var", () => {
    writeShared(dir, {
      chatgpt: { enabled: false },
      claude: { enabled: false },
      google: { enabled: false },
      "command-code": { enabled: true, secretEnv: "CMM_TEST_COMMAND_SECRET" },
    });
    const absent = runPreflight({ CMM_CONFIG_DIR: dir });
    expect(absent.output).toContain("COMMAND_CODE_SECRET_ENV=CMM_TEST_COMMAND_SECRET");
    expect(absent.output).toContain("COMMAND_CODE_STATE=AUTH_REQUIRED");
    expect(absent.rc).not.toBe(0);
    const present = runPreflight({
      CMM_CONFIG_DIR: dir,
      CMM_TEST_COMMAND_SECRET: "dummy-secret-value",
    });
    expect(present.output).toContain("COMMAND_CODE_SECRET=SET");
    console.log("PREFLIGHT_COMMAND_SECRET_ENV_CONFIG=PASS");
  });
});
