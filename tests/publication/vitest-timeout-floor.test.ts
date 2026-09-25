import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../..");

describe("Vitest timeout floor", () => {
  it("keeps the repository-wide timeout floor at 20 seconds", () => {
    const config = readFileSync(join(ROOT, "vitest.config.ts"), "utf-8");
    expect(config).toContain("testTimeout: 20_000");
  });

  it("does not duplicate the timeout policy in npm CLI scripts", () => {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf-8"),
    ) as { scripts?: Record<string, string> };

    const scripts = Object.values(pkg.scripts ?? {});
    expect(
      scripts.some((script) =>
        /(?:--testTimeout|--test-timeout|--timeout)(?:=|\s)/.test(script),
      ),
    ).toBe(false);
  });
});
