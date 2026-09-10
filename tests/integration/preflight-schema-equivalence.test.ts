import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sharedConfigSchema } from "../../src/config/schema.js";
import { loadConfig } from "../../src/config/load-config.js";

const REPO = join(import.meta.dirname, "../..");
const SCRIPT = join(REPO, "scripts/preflight.sh");
const VALIDATOR = join(REPO, "scripts/validate-config.mjs");

const PAYG_VARS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"];

function runPreflight(configDir: string): { rc: number; output: string } {
  try {
    const output = execFileSync("bash", [SCRIPT], {
      encoding: "utf-8",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        CMM_CONFIG_DIR: configDir,
      },
      timeout: 30000,
    });
    return { rc: 0, output };
  } catch (error) {
    const err = error as { status?: number; stdout?: unknown };
    return { rc: err.status ?? 1, output: String(err.stdout ?? "") };
  }
}

/** Production reference path: the schema loadConfig() parses with. */
function productionAccepts(raw: unknown, dir: string): boolean {
  if (!sharedConfigSchema.safeParse(raw).success) return false;
  const saved = new Map(PAYG_VARS.map((k) => [k, process.env[k]]));
  for (const key of PAYG_VARS) delete process.env[key];
  try {
    loadConfig(dir);
    return true;
  } catch {
    return false;
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const VALID = {
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
};

describe("preflight / production config schema equivalence", { timeout: 20_000 }, () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmm-preflight-equiv-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const invalidCases: Array<[string, unknown]> = [
    ["missing required mode", { host: "127.0.0.1" }],
    ["invalid host", { ...VALID, host: "0.0.0.0" }],
    ["invalid port", { ...VALID, port: 70000 }],
    ["invalid port type", { ...VALID, port: "8790" }],
    ["invalid provider structure", { ...VALID, providers: { chatgpt: { enabled: "yes" } } }],
    ["unknown top-level key (timeout)", { ...VALID, timeoutMs: 5000 }],
    [
      "invalid command-code secretEnv",
      {
        ...VALID,
        providers: { ...VALID.providers, "command-code": { enabled: false, secretEnv: 42 } },
      },
    ],
    [
      "invalid claude profileDir type",
      { ...VALID, providers: { ...VALID.providers, claude: { enabled: false, profileDir: 42 } } },
    ],
    [
      "invalid google agyPath type",
      { ...VALID, providers: { ...VALID.providers, google: { enabled: false, agyPath: ["x"] } } },
    ],
  ];

  for (const [name, raw] of invalidCases) {
    it(`${name}: production and preflight both reject`, () => {
      writeFileSync(join(dir, "shared.json"), JSON.stringify(raw));
      expect(productionAccepts(raw, dir)).toBe(false);
      const { rc, output } = runPreflight(dir);
      expect(output).toContain("CONFIG=INVALID");
      expect(rc).not.toBe(0);
    });
  }

  it("valid config: production and preflight both accept", () => {
    writeFileSync(join(dir, "shared.json"), JSON.stringify(VALID));
    expect(productionAccepts(VALID, dir)).toBe(true);
    const { output } = runPreflight(dir);
    expect(output).toContain("CONFIG=VALID");
    expect(output).not.toContain("CONFIG=INVALID");
    console.log("PREFLIGHT_PRODUCTION_SCHEMA_EQUIVALENCE=PASS");
  });

  it("malformed JSON: production and preflight both reject", () => {
    writeFileSync(join(dir, "shared.json"), "{not valid json!!!");
    let productionThrew = false;
    try {
      loadConfig(dir);
    } catch {
      productionThrew = true;
    }
    expect(productionThrew).toBe(true);
    const { rc, output } = runPreflight(dir);
    expect(output).toContain("CONFIG=INVALID");
    expect(rc).not.toBe(0);
  });

  it("preflight contains no duplicate config schema", () => {
    const script = readFileSync(SCRIPT, "utf-8");
    // Validation must be delegated, never re-implemented in bash/python.
    expect(script).toContain("scripts/validate-config.mjs");
    expect(script).not.toContain("mode must be standalone");
    expect(script).not.toContain("top-level object required");
    expect(script).not.toMatch(/unknown keys:/);
    expect(script).not.toContain("z.literal");
    const validator = readFileSync(VALIDATOR, "utf-8");
    expect(validator).toContain("sharedConfigSchema");
    expect(validator).toContain("localConfigSchema");
    console.log("PREFLIGHT_DUPLICATE_CONFIG_SCHEMA=NONE");
  });
});
