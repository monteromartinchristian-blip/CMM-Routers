import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("CMM Routers current identity", () => {
  it("uses the canonical package and runtime-visible product identity", () => {
    const pkg = JSON.parse(read("package.json"));
    const lock = JSON.parse(read("package-lock.json"));
    const index = read("src/index.ts");
    const codex = read("src/providers/codex/adapter.ts");
    const bundle = read("scripts/capture-bundle.sh");

    expect(pkg.name).toBe("cmm-routers");
    expect(lock.name).toBe("cmm-routers");
    expect(lock.packages[""].name).toBe("cmm-routers");
    expect(index).toContain("Starting CMM Routers");
    expect(codex).toContain('name: "cmm-routers"');
    expect(codex).toContain('title: "CMM Routers"');
    expect(bundle).toContain("--prefix=cmm-routers/");
  });

  it("preserves persistent legacy compatibility identifiers", () => {
    const launchd = read("launchd/com.cmm.subscription-router.plist.template");
    const runner = read("scripts/macos/run-router.sh");
    const qoder = read("scripts/qoder/reconcile-qoder-provider.mjs");

    expect(launchd).toContain("com.cmm.subscription-router");
    expect(launchd).toContain("cmm-subscription-router");
    expect(runner).toContain("cmm-subscription-router");
    expect(qoder).toContain("qoder-custom-cmm-router");
  });

  it("does not rewrite historical Task 13 identity", () => {
    expect(read("docs/task-13-closure.md")).toContain("CMM Subscription Router");
  });
});
