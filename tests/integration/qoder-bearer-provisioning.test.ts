import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "../..");

function read(rel: string): string {
  return readFileSync(join(REPO, rel), "utf-8");
}

describe("Qoder bearer provisioning (fresh Mac reproducibility)", () => {
  it("documents intentional qoder-bearer Keychain provisioning", () => {
    const docs = read("docs/macos-install.md");
    expect(docs).toContain("security add-generic-password -s cmm-subscription-router -a qoder-bearer -w");
    expect(docs).toContain("CMM_QODER_TOKEN");
    console.log("QODER_BEARER_PROVISIONING=PASS");
  });

  it("installer provisions or reports the qoder-bearer item idempotently", () => {
    const installer = read("scripts/macos/install-router.sh");
    expect(installer).toContain("-a $QODER_ACCOUNT");
    expect(installer).toContain("qoder-bearer");
    expect(installer).toContain("find-generic-password");
    // Never writes the token value anywhere.
    expect(installer).not.toMatch(/add-generic-password[^\n]*-w\s+["']/);
    console.log("QODER_FRESH_MAC_REPRODUCIBILITY=PASS");
  });

  it("runtime lookup uses the documented service and account", () => {
    const wrapper = read("scripts/macos/run-router.sh");
    expect(wrapper).toMatch(/QODER_ACCOUNT="\$\{CMM_QODER_KEYCHAIN_ACCOUNT:-qoder-bearer\}"/);
    expect(wrapper).toMatch(/QODER_SERVICE="\$\{CMM_QODER_KEYCHAIN_SERVICE:-cmm-subscription-router\}"/);
    expect(wrapper).toContain("CMM_QODER_TOKEN");
    console.log("QODER_BEARER_RUNTIME_LOOKUP=PASS");
  });

  it("no tracked file contains a literal bearer secret value", () => {
    for (const rel of [
      "docs/macos-install.md",
      "scripts/macos/install-router.sh",
      "scripts/macos/run-router.sh",
      "launchd/com.cmm.subscription-router.plist.template",
    ]) {
      const text = read(rel);
      expect(text).not.toMatch(/(token|secret|bearer)\s*[:=]\s*["'][A-Za-z0-9_-]{16,}["']/i);
    }
    console.log("QODER_BEARER_NO_TRACKED_SECRET=PASS");
  });
});
