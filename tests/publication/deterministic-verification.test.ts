import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../..");
const PACKAGE = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
  scripts?: Record<string, string>;
};

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf-8");
}

describe("publication nested verification determinism", () => {
  const serial = "vitest run --no-file-parallelism --maxWorkers 1";

  it("defines one shared deterministic test command in package.json", () => {
    expect(PACKAGE.scripts?.["test:serial"]).toBe(serial);
  });

  it("routes nested verification in prepare-publication.sh through the shared command", () => {
    const source = read("scripts/publication/prepare-publication.sh");
    expect(source).toContain(
      "CMM_ROUTERS_PUBLICATION_CANDIDATE_VERIFY=1 npm run test:serial",
    );
    expect(source).not.toContain(
      "CMM_ROUTERS_PUBLICATION_CANDIDATE_VERIFY=1 npx vitest run",
    );
  });

  it("routes nested verification in verify-publication.sh through the shared command", () => {
    const source = read("scripts/publication/verify-publication.sh");
    expect(source).toContain(
      "CMM_ROUTERS_PUBLICATION_FRESH_CLONE_VERIFY=1 npm run test:serial",
    );
    expect(source).not.toContain(
      "CMM_ROUTERS_PUBLICATION_FRESH_CLONE_VERIFY=1 npx vitest run",
    );
  });

  it("uses one identical nested verification command in prepare and verify", () => {
    expect(PACKAGE.scripts?.["test:serial"]).toBe(serial);
    expect(read("scripts/publication/prepare-publication.sh")).toContain(
      "npm run test:serial",
    );
    expect(read("scripts/publication/verify-publication.sh")).toContain(
      "npm run test:serial",
    );
  });
});
