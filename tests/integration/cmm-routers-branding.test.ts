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

  it("documents the two canonical profiles and legacy compatibility boundary", () => {
    const readme = read("README.md");
    const install = read("docs/macos-install.md");
    const qoderSetup = read("docs/qoder-setup.md");
    const qoderAcceptance = read("docs/qoder-acceptance.md");

    expect(readme).toContain("# CMM Routers");
    expect(readme).toContain(
      "Use the AI subscriptions you already pay for, from the tools you actually want to use.",
    );
    expect(readme).toContain("CMMChat Router");
    expect(readme).toContain("CHAT_ONLY");
    expect(readme).toContain("CMM Code Router");
    expect(readme).toContain("CHAT_AND_TOOLS");
    expect(readme).toContain("Qoder");
    expect(readme).toContain("legacy compatibility");

    for (const currentDoc of [install, qoderSetup, qoderAcceptance]) {
      expect(currentDoc).toContain("CMM Routers");
    }
  });

  it("no longer presents the obsolete all-provider CHAT_ONLY matrix as current truth", () => {
    const readme = read("README.md");

    expect(readme).not.toContain("| chatgpt/* | CHAT_ONLY | BLOCKED |");
    expect(readme).not.toContain("All routes: `CHAT_ONLY`");

    for (const currentDoc of [
      readme,
      read("docs/qoder-setup.md"),
      read("docs/qoder-acceptance.md"),
    ]) {
      expect(currentDoc).not.toContain("TOOL_ACCEPTANCE=BLOCKED_PROVIDER_CAPABILITY");
    }
  });

  it("keeps current public surfaces free of user-specific home paths", () => {
    const currentFiles = [
      "README.md",
      "docs/macos-install.md",
      "docs/qoder-setup.md",
      "docs/qoder-acceptance.md",
      "tests/providers/antigravity-adapter.test.ts",
      "tests/providers/antigravity-mcp-registration.test.ts",
      "tests/providers/claude-environment.test.ts",
    ];

    for (const path of currentFiles) {
      const text = read(path);
      expect(text).not.toMatch(/\/Users\/(?:chris|christian)\//i);
    }
  });
});
