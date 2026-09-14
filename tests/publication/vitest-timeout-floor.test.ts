import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "../..");

/**
 * Global per-test timeout floor.
 *
 * Vitest's 5000 ms default predates this repository's subprocess/IO-heavy
 * suites. Under the nested publication workload (a full serial suite running
 * inside `prepare`/`verify` while npm ci/build work competes for the host),
 * tests whose only budget is the default fail nondeterministically:
 * `push-publication.test.ts` failed at 7442 ms (measured 2949 ms isolated —
 * a ~2.5x load amplification). The publication fixtures document 7-28s
 * runtimes for the same subprocess class under host load.
 *
 * 20_000 ms keeps ~2.7x margin over the observed false failure while still
 * failing a genuinely hung test ~30x faster than the outer publication
 * budgets (600_000 ms). Tests that intentionally need more already declare
 * explicit per-test budgets, which override the floor.
 */
const GLOBAL_TEST_TIMEOUT_FLOOR_MS = 20_000;

async function readProjectFile(relativePath: string): Promise<string> {
  return readFile(resolve(projectRoot, relativePath), "utf8");
}

describe("vitest global test timeout floor", () => {
  it("defines one canonical global testTimeout floor in vitest.config.ts", async () => {
    const source = await readProjectFile("vitest.config.ts");

    const match = source.match(/test:\s*\{[\s\S]*?testTimeout:\s*([0-9_]+)/);
    expect(
      match,
      "vitest.config.ts must declare testTimeout inside the test block",
    ).not.toBeNull();

    expect(
      Number(match![1]!.replaceAll("_", "")),
      "the global testTimeout floor must be exactly 20_000 ms",
    ).toBe(GLOBAL_TEST_TIMEOUT_FLOOR_MS);
  });

  it("keeps the floor canonical by forbidding --testTimeout CLI duplication", async () => {
    const manifest = JSON.parse(await readProjectFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    const commandSources = Object.values(manifest.scripts ?? {}).concat(
      await readProjectFile("scripts/publication/prepare-publication.sh"),
      await readProjectFile("scripts/publication/verify-publication.sh"),
    );

    expect(
      commandSources.join("\n"),
      "the global floor must live in vitest.config.ts, not in per-command flags",
    ).not.toContain("--testTimeout");
  });
});
