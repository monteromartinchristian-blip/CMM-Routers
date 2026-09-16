import { describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO = join(import.meta.dirname, "../..");

describe("distribution build assets", () => {
  it("ships every CMM Usage SQL migration required by the compiled runtime", () => {
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

      const sourceSchema = join(checkout, "src", "usage", "storage", "schema");
      const distSchema = join(checkout, "dist", "usage", "storage", "schema");
      const sourceMigrations = readdirSync(sourceSchema)
        .filter((filename) => filename.endsWith(".sql"))
        .sort();
      const distMigrations = readdirSync(distSchema)
        .filter((filename) => filename.endsWith(".sql"))
        .sort();

      expect(distMigrations).toEqual(sourceMigrations);
      for (const filename of sourceMigrations) {
        expect(readFileSync(join(distSchema, filename), "utf8")).toBe(
          readFileSync(join(sourceSchema, filename), "utf8"),
        );
      }
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });
});
