import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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

describe("preflight malformed config fails closed", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmm-preflight-bad-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("malformed JSON fails closed, never PASS", () => {
    writeFileSync(join(dir, "shared.json"), "{not valid json!!!\n");
    const { rc, output } = runPreflight({ CMM_CONFIG_DIR: dir });
    expect(output).toContain("CONFIG=INVALID");
    expect(output).toContain("PREFLIGHT=FAIL");
    expect(rc).not.toBe(0);
    console.log("PREFLIGHT_MALFORMED_JSON=FAIL_CLOSED");
  });

  it("schema-invalid config fails closed", () => {
    // Valid JSON but violates production schema (bad host + unknown key).
    writeFileSync(
      join(dir, "shared.json"),
      JSON.stringify({ mode: "standalone", host: "0.0.0.0", bogusKey: 1 }),
    );
    const { rc, output } = runPreflight({ CMM_CONFIG_DIR: dir });
    expect(output).toContain("CONFIG=INVALID");
    expect(output).toContain("PREFLIGHT=FAIL");
    expect(rc).not.toBe(0);
    console.log("PREFLIGHT_SCHEMA_INVALID_CONFIG=FAIL_CLOSED");
  });

  it("valid config proceeds to provider-state verdict", () => {
    writeFileSync(
      join(dir, "shared.json"),
      JSON.stringify({
        mode: "standalone",
        host: "127.0.0.1",
        port: 8790,
        bearerSecretEnv: "CMM_ROUTER_TOKEN",
        providers: {
          chatgpt: { enabled: false },
          claude: { enabled: false },
          google: { enabled: false },
          "command-code": { enabled: false, secretEnv: "COMMAND_CODE_SECRET" },
        },
      }),
    );
    const { output } = runPreflight({ CMM_CONFIG_DIR: dir });
    expect(output).not.toContain("CONFIG=INVALID");
    console.log("PREFLIGHT_VALID_CONFIG=PASS_OR_PROVIDER_STATE");
  });
});
