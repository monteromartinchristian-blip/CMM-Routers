import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "../../src");

describe("production entrypoint ESM safety", () => {
  it("contains no CommonJS require() in src/index.ts", () => {
    const source = readFileSync(join(SRC, "index.ts"), "utf-8");
    expect(source).not.toMatch(/require\(/);
  });

  it("compiles dist/index.js as ESM with no require() calls", () => {
    const dist = readFileSync(join(import.meta.dirname, "../../dist/index.js"), "utf-8");
    expect(dist).not.toContain("require(");
  });
});
