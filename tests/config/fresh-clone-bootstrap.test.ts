import { describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "../..");

describe("fresh-clone config bootstrap", () => {
  it("creates shared.json from the example and starts production loading", async () => {
    // Clean-clone simulation: copy the repo fixture WITHOUT config/shared.json.
    const clone = mkdtempSync(join(tmpdir(), "cmm-fresh-clone-"));
    try {
      for (const entry of ["src", "config", "package.json"]) {
        cpSync(join(REPO, entry), join(clone, entry), { recursive: true });
      }
      const sharedPath = join(clone, "config", "shared.json");
      rmSync(sharedPath, { force: true });
      expect(existsSync(sharedPath)).toBe(false);

      const { ensureSharedConfigFromExample, loadConfig } = await import(
        "../../src/config/load-config.js"
      );
      const created = ensureSharedConfigFromExample(join(clone, "config"));
      expect(created).toBe(true);
      expect(existsSync(sharedPath)).toBe(true);
      console.log("FRESH_CLONE_SHARED_CONFIG_BOOTSTRAP=PASS");

      // Production startup proceeds with the bootstrapped config.
      const config = loadConfig(join(clone, "config"));
      expect(config.mode).toBe("standalone");
      expect(config.host).toBe("127.0.0.1");

      // Second call never overwrites the user's config.
      const before = readFileSync(sharedPath, "utf-8");
      expect(ensureSharedConfigFromExample(join(clone, "config"))).toBe(false);
      expect(readFileSync(sharedPath, "utf-8")).toBe(before);
      console.log("EXISTING_CONFIG_NOT_OVERWRITTEN=PASS");
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it("fails clearly when both shared.json and the example are missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cmm-no-config-"));
    try {
      const { ensureSharedConfigFromExample } = await import(
        "../../src/config/load-config.js"
      );
      expect(() => ensureSharedConfigFromExample(dir)).toThrow(/shared\.example\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
