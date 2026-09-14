import { defineConfig } from "vitest/config";

/**
 * Global per-test timeout floor.
 *
 * Vitest's 5000 ms default is too low for this repository's subprocess/IO
 * tests under the nested publication workload (a full serial suite running
 * inside `prepare`/`verify` while npm ci/build work competes for the host):
 * `push-publication.test.ts` failed at 7442 ms there (2949 ms isolated, a
 * ~2.5x load amplification). 20_000 ms keeps ~2.7x margin over that observed
 * false failure while still failing a genuinely hung test ~30x faster than
 * the outer publication budgets. Tests that intentionally need more declare
 * explicit per-test budgets, which override this floor.
 */
export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 20_000,
    exclude: ["**/dist/**", "**/node_modules/**"]
  }
});
