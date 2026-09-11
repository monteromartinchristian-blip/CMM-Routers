import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "../../scripts/preflight.sh");

const CLEAN_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: process.env.HOME ?? "/tmp",
};

describe("preflight fail-closed exits", () => {
  it("exits non-zero on unsafe Claude PAYG state", () => {
    let rc = 0;
    let output = "";
    try {
      output = execFileSync("bash", [SCRIPT], {
        encoding: "utf-8",
        env: { ...CLEAN_ENV, ANTHROPIC_API_KEY: "dummy-anthropic-1" },
        timeout: 30000,
      });
    } catch (error) {
      rc = (error as { status?: number }).status ?? 1;
      output = String((error as { stdout?: unknown }).stdout ?? "");
    }
    expect(output).toContain("CLAUDE_PAYG_ENV=UNSAFE");
    expect(rc).not.toBe(0);
  });

  it("exits non-zero on unsafe Google PAYG state", () => {
    let rc = 0;
    let output = "";
    try {
      output = execFileSync("bash", [SCRIPT], {
        encoding: "utf-8",
        env: { ...CLEAN_ENV, GEMINI_API_KEY: "dummy-gemini-1" },
        timeout: 30000,
      });
    } catch (error) {
      rc = (error as { status?: number }).status ?? 1;
      output = String((error as { stdout?: unknown }).stdout ?? "");
    }
    expect(output).toContain("GOOGLE_PAYG_ENV=UNSAFE");
    expect(rc).not.toBe(0);
  });
});
