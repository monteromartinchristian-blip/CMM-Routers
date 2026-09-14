import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  PUBLICATION_META_TEST_LOCK_STALE_AFTER_MS,
  PUBLICATION_META_TEST_LOCK_WAIT_MS,
} from "./meta-test-lock.js";
import { SERIAL_NESTED_VERIFICATION_BUDGET_MS } from "./publication-budgets.js";

const projectRoot = resolve(import.meta.dirname, "../..");

const PUBLICATION_SCRIPTS = [
  "scripts/publication/prepare-publication.sh",
  "scripts/publication/verify-publication.sh",
] as const;

/**
 * The publication scripts run the whole suite nested inside `prepare`/
 * `verify` while the outer publication meta-test is still running. A bare
 * `npx vitest run` schedules every file across all CPUs in that nested
 * context, and tests whose only budget is the 5000 ms default then fail
 * nondeterministically depending on which file lands at the load peak
 * (measured: the same suite failed on `push-publication.test.ts` in one run
 * and on `claude-adapter.test.ts` in another, always `Test timed out in
 * 5000ms`). The deterministic command is therefore part of the publication
 * contract, not a local convenience.
 */
const SHARED_DETERMINISTIC_COMMAND = "npm run test:serial";

async function readProjectFile(relativePath: string): Promise<string> {
  return readFile(resolve(projectRoot, relativePath), "utf8");
}

function nestedVerificationCommand(source: string, script: string): string {
  const line = source
    .split("\n")
    .find((candidate) => candidate.includes("_VERIFY=1"));

  expect(line, `${script} must invoke nested verification`).toBeDefined();

  // The line is `<ENV_ASSIGNMENT> <command>`; dropping the assignment leaves
  // exactly the command the publication flow uses for nested verification.
  return line!.trim().split(/\s+/).slice(1).join(" ");
}

describe("publication nested verification determinism", () => {
  it("defines one shared deterministic test command in package.json", async () => {
    const manifest = JSON.parse(await readProjectFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    const command = manifest.scripts?.["test:serial"];

    expect(command, "package.json must define the shared serial command").toBeDefined();
    expect(command).toContain("vitest run");
    expect(command).toContain("--no-file-parallelism");
    expect(command).toContain("--maxWorkers 1");
  });

  for (const script of PUBLICATION_SCRIPTS) {
    it(`routes nested verification in ${script} through the shared command`, async () => {
      const source = await readProjectFile(script);

      expect(
        nestedVerificationCommand(source, script),
        `${script} must use the shared deterministic command`,
      ).toBe(SHARED_DETERMINISTIC_COMMAND);

      // No second, nondeterministic nested-suite path may exist.
      expect(source).not.toMatch(/npx vitest run/);
    });
  }

  it("uses one identical nested verification command in prepare and verify", async () => {
    const commands = await Promise.all(
      PUBLICATION_SCRIPTS.map(async (script) =>
        nestedVerificationCommand(await readProjectFile(script), script),
      ),
    );

    expect(commands[0]).toBe(commands[1]);
  });

  it("budgets the outer publication meta-tests for one full nested run", async () => {
    // Measured: the deterministic nested suite takes 202s, plus npm ci, build,
    // typecheck, and the security audit. 120s (the previous budget) cannot fit
    // deterministic verification at all.
    expect(SERIAL_NESTED_VERIFICATION_BUDGET_MS).toBeGreaterThanOrEqual(300_000);

    for (const script of [
      "tests/publication/prepare-publication.test.ts",
      "tests/publication/verify-publication.test.ts",
    ] as const) {
      const source = await readProjectFile(script);

      expect(source, `${script} must use the shared nested-run budget`).toContain(
        "SERIAL_NESTED_VERIFICATION_BUDGET_MS",
      );
    }
  });

  it("keeps the meta-test lock budgets coherent with the nested-run budget", () => {
    // A waiter must be able to outlast one full nested run before giving up,
    // and a lock may only be treated as stale well after any live holder has
    // finished. Otherwise a slow-but-live holder gets its lock broken and two
    // nested suites run at once — the very contention this guards against.
    expect(PUBLICATION_META_TEST_LOCK_WAIT_MS).toBeGreaterThan(
      SERIAL_NESTED_VERIFICATION_BUDGET_MS,
    );
    expect(PUBLICATION_META_TEST_LOCK_STALE_AFTER_MS).toBeGreaterThan(
      PUBLICATION_META_TEST_LOCK_WAIT_MS,
    );
  });
});
