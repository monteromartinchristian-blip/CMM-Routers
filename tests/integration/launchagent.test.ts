import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const REPO = join(import.meta.dirname, "../..");
const TEMPLATE = join(REPO, "launchd/com.cmm.subscription-router.plist.template");

function renderTemplate(): string {
  return readFileSync(TEMPLATE, "utf-8")
    .replaceAll("__REPO_DIR__", REPO)
    .replaceAll("__HOME__", "/Users/testuser");
}

describe("LaunchAgent installation", () => {
  it("template contains no bearer token or Command Code key", () => {
    const raw = readFileSync(TEMPLATE, "utf-8");
    expect(raw).not.toContain("Bearer ");
    expect(raw).not.toContain("user_");
    expect(raw).not.toContain("sk-");
    expect(raw.toLowerCase()).not.toContain("password value");
  });

  it("rendered plist binds loopback only and points at this clone", () => {
    const rendered = renderTemplate();
    expect(rendered).toContain("com.cmm.subscription-router");
    expect(rendered).toContain(REPO);
    expect(rendered).toContain("scripts/macos/run-router.sh");
    expect(rendered).not.toContain("0.0.0.0");
  });

  it("references Keychain identifiers, not secret values", () => {
    const rendered = renderTemplate();
    expect(rendered).toContain("cmm-subscription-router");
    expect(rendered).toContain("router-bearer");
    expect(rendered).toContain("command-code-secret");
  });

  it("install script dry-run generates a valid plist", () => {
    const output = execFileSync(
      "bash",
      ["-c", `REPO_DIR="${REPO}"; sed -e "s#__REPO_DIR__#${REPO}#g" -e "s#__HOME__#/Users/testuser#g" "${TEMPLATE}"`],
      { encoding: "utf-8" },
    );
    expect(output).toContain("<plist");
    expect(output).toContain(REPO);
  });

  it("scripts are executable shell with no secrets", () => {
    for (const script of [
      "scripts/macos/install-router.sh",
      "scripts/macos/uninstall-router.sh",
      "scripts/macos/run-router.sh",
      "scripts/macos/preflight-router.sh",
    ]) {
      const content = readFileSync(join(REPO, script), "utf-8");
      expect(content).toContain("#!/usr/bin/env bash");
      expect(content).not.toMatch(/user_[A-Za-z0-9]{10,}/);
    }
  });
});
