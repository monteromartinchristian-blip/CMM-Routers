import { describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO = join(import.meta.dirname, "../..");

describe("distribution build assets", () => {
  it("ships the CMM Usage SQL migration required by the compiled runtime", () => {
    const checkout = mkdtempSync(join(tmpdir(), "cmm-build-assets-"));

    try {
      cpSync(join(REPO, "src"), join(checkout, "src"), { recursive: true });
      cpSync(join(REPO, "scripts"), join(checkout, "scripts"), { recursive: true });
      for (const filename of ["package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json"]) {
        cpSync(join(REPO, filename), join(checkout, filename));
      }
      symlinkSync(join(REPO, "node_modules"), join(checkout, "node_modules"), "dir");

      const build = spawnSync("npm", ["run", "build"], {
        cwd: checkout,
        encoding: "utf8",
      });
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);

      const initialMigration = join(
        checkout,
        "dist",
        "usage",
        "storage",
        "schema",
        "001_initial.sql",
      );
      const privacyMigration = join(
        checkout,
        "dist",
        "usage",
        "storage",
        "schema",
        "002_scrub_legacy_openrouter_key_buckets.sql",
      );
      expect(existsSync(initialMigration)).toBe(true);
      expect(readFileSync(initialMigration, "utf8")).toContain("CREATE TABLE");
      expect(existsSync(privacyMigration)).toBe(true);
      expect(readFileSync(privacyMigration, "utf8")).toContain("DELETE FROM quota_buckets");
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });
});
