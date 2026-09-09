import { describe, expect, it } from "vitest";
import { verifyBearer } from "../../src/security/bearer-auth.js";

describe("bearer auth ESM runtime", () => {
  it("accepts a valid bearer token", () => {
    expect(verifyBearer("Bearer test-secret-123", "test-secret-123")).toBe(true);
  });

  it("rejects a wrong bearer token", () => {
    expect(verifyBearer("Bearer wrong-token", "test-secret-123")).toBe(false);
  });

  it("rejects a different-length bearer safely (no throw)", () => {
    expect(verifyBearer("Bearer short", "test-secret-123- much - longer-secret")).toBe(false);
    expect(verifyBearer("Bearer a-very-much-longer-token-value-here", "tiny")).toBe(false);
  });

  it("rejects a missing bearer header", () => {
    expect(verifyBearer(undefined, "test-secret-123")).toBe(false);
    expect(verifyBearer("", "test-secret-123")).toBe(false);
    expect(verifyBearer("Basic abc", "test-secret-123")).toBe(false);
  });

  it("uses constant-time comparison, not plain equality", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(import.meta.dirname, "../../src/security/bearer-auth.ts"),
      "utf-8",
    );
    expect(source).toContain("timingSafeEqual");
    expect(source).not.toContain("require(");
  });
});
