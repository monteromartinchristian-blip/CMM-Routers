import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "../..");

function read(rel: string): string {
  return readFileSync(join(REPO, rel), "utf-8");
}

/**
 * Phase 5 — the canonical Code Router bearer is installable through the existing
 * LaunchAgent/Keychain architecture, without renaming any persisted legacy
 * identifier and without ever writing a secret value.
 */
describe("canonical Code Router bearer install path", () => {
  it("the LaunchAgent template carries Code Router Keychain identifiers only", () => {
    const plist = read("launchd/com.cmm.subscription-router.plist.template");
    expect(plist).toContain("CMM_CODE_ROUTER_KEYCHAIN_SERVICE");
    expect(plist).toContain("CMM_CODE_ROUTER_KEYCHAIN_ACCOUNT");
    expect(plist).toContain("code-router-bearer");
    // Identifiers only: the template never embeds a secret value.
    expect(plist).not.toMatch(/CMM_CODE_ROUTER_TOKEN<\/key>\s*<string>[^<]+<\/string>/);
    console.log("CODE_ROUTER_KEYCHAIN_IDENTIFIERS_PRESENT=PASS");
  });

  it("the runtime wrapper resolves the canonical bearer from the configured Keychain pair", () => {
    const wrapper = read("scripts/macos/run-router.sh");
    expect(wrapper).toContain("CMM_CODE_ROUTER_TOKEN");
    expect(wrapper).toMatch(/CODE_ACCOUNT="\$\{CMM_CODE_ROUTER_KEYCHAIN_ACCOUNT:-code-router-bearer\}"/);
    expect(wrapper).toMatch(/CODE_SERVICE="\$\{CMM_CODE_ROUTER_KEYCHAIN_SERVICE:-cmm-subscription-router\}"/);
    // Absence must stay non-fatal: only the CMMChat bearer is required.
    expect(wrapper).toContain('if [ -z "${!BEARER_ENV:-}" ]; then');
    console.log("CANONICAL_CODE_ROUTER_AUTH_INSTALL_PATH=PASS");
  });

  it("the installer reports the canonical bearer idempotently without creating or printing it", () => {
    const installer = read("scripts/macos/install-router.sh");
    expect(installer).toContain("code-router-bearer");
    expect(installer).toContain("CODE_ACCOUNT");
    expect(installer).toContain("find-generic-password");
    expect(installer).not.toMatch(/add-generic-password[^\n]*-w\s+["']/);
    console.log("CODE_ROUTER_BEARER_INSTALLER_REPORT=PASS");
  });

  it("the legacy Qoder identifiers remain present and unchanged", () => {
    const plist = read("launchd/com.cmm.subscription-router.plist.template");
    const wrapper = read("scripts/macos/run-router.sh");
    const installer = read("scripts/macos/install-router.sh");
    expect(plist).toContain("CMM_QODER_KEYCHAIN_SERVICE");
    expect(plist).toContain("CMM_QODER_KEYCHAIN_ACCOUNT");
    expect(plist).toContain("qoder-bearer");
    expect(wrapper).toContain("CMM_QODER_TOKEN");
    expect(installer).toContain("qoder-bearer");
    // The LaunchAgent label and Keychain service are stable.
    expect(plist).toContain("com.cmm.subscription-router");
    expect(plist).toContain("cmm-subscription-router");
    console.log("LEGACY_QODER_AUTH_COMPATIBILITY=PASS");
    console.log("PERSISTED_LEGACY_NAMES_PRESERVED=YES");
  });

  it("no tracked install file contains a literal bearer value", () => {
    for (const rel of [
      "docs/macos-install.md",
      "scripts/macos/install-router.sh",
      "scripts/macos/run-router.sh",
      "launchd/com.cmm.subscription-router.plist.template",
      ".env.example",
    ]) {
      const text = read(rel);
      expect(text, rel).not.toMatch(/(token|secret|bearer)\s*[:=]\s*["'][A-Za-z0-9_-]{16,}["']/i);
    }
    console.log("TRACKED_SECRETS=NONE");
  });
});
