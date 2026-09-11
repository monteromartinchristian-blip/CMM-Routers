import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const SCRIPT = join(import.meta.dirname, "../../scripts/qoder-smoke.sh");

describe("qoder smoke script contract", () => {
  it("requires the exact QODER_SMOKE_OK marker for a PASS verdict", () => {
    const source = readFileSync(SCRIPT, "utf-8");
    expect(source).toContain("DONE");
    expect(source).toContain("/v1/responses");
    expect(source).toContain("QODER_SMOKE_OK");
  });

  it("stays local-only and never prints the bearer token", () => {
    const source = readFileSync(SCRIPT, "utf-8");
    expect(source).toContain("127.0.0.1");
    expect(source).not.toContain("0.0.0.0");
    expect(source).not.toMatch(/echo[^#\n]*\$TOKEN/);
  });

  it("documents streaming, responses, and cancellation coverage", () => {
    const source = readFileSync(SCRIPT, "utf-8");
    expect(source).toMatch(/stream/i);
    expect(source).toMatch(/cancel/i);
  });
});
