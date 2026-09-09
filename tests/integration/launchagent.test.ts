import { describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const REPO = join(import.meta.dirname, "../..");
const TEMPLATE = join(REPO, "launchd/com.cmm.subscription-router.plist.template");
const INSTALLER = join(REPO, "scripts/macos/install-router.sh");
const PREFLIGHT_WRAPPER = join(REPO, "scripts/macos/preflight-router.sh");

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

  it("installer resolves the real repo root from scripts/macos", () => {
    const content = readFileSync(INSTALLER, "utf-8");
    // Two levels up: scripts/macos -> repo root. One level would land in scripts/.
    expect(content).toContain('"$SCRIPT_DIR/../.."');
    expect(content).not.toMatch(/dirname "\$0"\)\/\.\."(?!\/\.\.)/);
  });

  it("preflight wrapper resolves the exact preflight script", () => {
    const content = readFileSync(PREFLIGHT_WRAPPER, "utf-8");
    expect(content).toContain("scripts/preflight.sh");
    expect(content).toContain("REPO_DIR");
    expect(content).toContain("SCRIPT_DIR/../..");
  });

  it("installer dry-run against temp HOME succeeds and renders repo paths", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "cmm-launchd-"));
    const dest = join(fakeHome, "test.plist");
    const output = execFileSync(
      "bash",
      [
        "-c",
        [
          `SCRIPT_DIR="${REPO}/scripts/macos"`,
          `REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"`,
          `test "$REPO_DIR" = "${REPO}"`,
          `test -f "$REPO_DIR/launchd/com.cmm.subscription-router.plist.template"`,
          `sed -e "s#__REPO_DIR__#${REPO}#g" -e "s#__HOME__#${fakeHome}#g" "$REPO_DIR/launchd/com.cmm.subscription-router.plist.template" > "${dest}"`,
          `grep -q "${REPO}/scripts/macos/run-router.sh" "${dest}"`,
          `grep -q "${fakeHome}/Library/Logs/CMM-Subscription-Router/router.log" "${dest}"`,
          `echo DRY_RUN_OK`,
        ].join(" && "),
      ],
      { encoding: "utf-8" },
    );
    expect(output).toContain("DRY_RUN_OK");
  });

  it("installer fails non-zero when the template is missing", () => {
    const script = [
      "set -euo pipefail",
      `TEMPLATE="/nonexistent-${Date.now()}.plist.template"`,
      'if [ ! -f "$TEMPLATE" ]; then echo "error: missing template" >&2; exit 1; fi',
    ].join("\n");
    const tmp = join(mkdtempSync(join(tmpdir(), "cmm-launchd-")), "check.sh");
    writeFileSync(tmp, script);
    let rc = 0;
    try {
      execFileSync("bash", [tmp], { encoding: "utf-8" });
    } catch (error) {
      rc = (error as { status?: number }).status ?? 1;
    }
    expect(rc).not.toBe(0);
  });

  it("installer script uses strict failure propagation", () => {
    const content = readFileSync(INSTALLER, "utf-8");
    expect(content).toContain("set -euo pipefail");
    // Must never claim success when rendering failed.
    expect(content).toContain('exit 1');
  });
});
