import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "../../scripts/preflight.sh");

describe("preflight redaction", () => {
  it("never prints dummy secret values", () => {
    let output: string;
    try {
      output = execFileSync("bash", [SCRIPT], {
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: process.env.HOME ?? "/tmp",
          COMMAND_CODE_SECRET: "dummy-cc-secret-12345",
          GEMINI_API_KEY: "dummy-gemini-12345",
          GOOGLE_API_KEY: "dummy-google-12345",
          ANTHROPIC_API_KEY: "dummy-anthropic-12345",
          CMM_ROUTER_TOKEN: "dummy-router-12345",
        },
        timeout: 30000,
      });
    } catch (error) {
      // Fail-closed preflight exits non-zero on unsafe PAYG state; the
      // redaction assertions below apply to the captured stdout either way.
      output = String((error as { stdout?: unknown }).stdout ?? "");
    }
    for (const secret of [
      "dummy-cc-secret-12345",
      "dummy-gemini-12345",
      "dummy-google-12345",
      "dummy-anthropic-12345",
      "dummy-router-12345",
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain("COMMAND_CODE_SECRET=SET");
    expect(output).toContain("GOOGLE_PAYG_ENV=UNSAFE");
    expect(output).toContain("CLAUDE_PAYG_ENV=UNSAFE");
  });
});
