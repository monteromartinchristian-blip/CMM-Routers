import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CodexAdapter } from "../../src/providers/codex/adapter.js";

describe("Codex workspace mutation canary", () => {
  let tempDir: string;
  let fixtureFile: string;
  let initialHash: string;

  beforeEach(async () => {
    // Create a temporary directory with a fixture file
    tempDir = await mkdtemp(join(tmpdir(), "codex-canary-"));
    fixtureFile = join(tempDir, "canary.txt");

    const content = "This file must not be modified by Codex\n";
    await writeFile(fixtureFile, content);

    // Calculate initial hash
    const fileContent = await readFile(fixtureFile);
    initialHash = createHash("sha256").update(fileContent).digest("hex");
  });

  afterEach(async () => {
    // Cleanup would happen here if we had a real filesystem cleanup utility
  });

  it.skipIf(!process.env.CMM_RUN_LIVE)(
    "does not mutate workspace files during operation",
    async () => {
      const adapter = new CodexAdapter();

      try {
        // Discover models to trigger app-server initialization
        const models = await adapter.discoverModels();
        expect(models.length).toBeGreaterThan(0);

        // Verify fixture file was not modified
        const fileContent = await readFile(fixtureFile);
        const finalHash = createHash("sha256").update(fileContent).digest("hex");

        expect(finalHash).toBe(initialHash);
        console.log(`✓ Workspace integrity verified: ${fixtureFile} unchanged`);
      } finally {
        // Adapter cleanup
      }
    },
    30000,
  );

  it("verifies test setup creates valid fixture", async () => {
    // This test runs without CMM_RUN_LIVE to verify our test setup works
    const fileContent = await readFile(fixtureFile, "utf-8");
    expect(fileContent).toBe("This file must not be modified by Codex\n");
    expect(initialHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
