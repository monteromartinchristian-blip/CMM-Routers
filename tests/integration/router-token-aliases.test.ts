import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO = join(import.meta.dirname, "../..");
const RUN_ROUTER = join(REPO, "scripts/macos/run-router.sh");
const INDEX = join(REPO, "src/index.ts");
const LEGACY = join(REPO, "src/compat/legacy-identifiers.ts");

function read(path: string): string {
  return readFileSync(path, "utf-8");
}

describe("AGENT token aliases are compatibility-only", () => {
  it("the launch wrapper reads both AGENT aliases without creating credentials", () => {
    const script = read(RUN_ROUTER);
    expect(script).toContain("CMM_CODE_ROUTER_TOKEN");
    expect(script).toContain("CMM_QODER_TOKEN");
    expect(script).toContain("code-router-bearer");
    expect(script).toContain("qoder-bearer");
    // Reading an existing Keychain item is allowed; generating one is not.
    expect(script).not.toContain("add-generic-password");
    expect(script).not.toContain("security add-generic-password");
    // The CHAT/AGENT branch carries no partial of the separate
    // connection-management workstream: no activation block, no untracked
    // libexec reference, no dead admin-token plumbing.
    expect(script).not.toContain("CONNECTION MANAGEMENT");
    expect(script).not.toContain("connection-management");
    expect(script).not.toContain("connection-administration-policy");
    expect(script).not.toContain("CMM_ROUTER_CONNECTION_MANAGEMENT_TOKEN");
    const syntax = spawnSync("bash", ["-n", RUN_ROUTER], { encoding: "utf-8" });
    expect(syntax.status, syntax.stderr).toBe(0);
    console.log("CHAT_AGENT_BRANCH_CONTAINS_CONNECTION_MANAGEMENT_PARTIAL=NO");
  });

  it("the process composition reads the canonical env name and the legacy alias", () => {
    const index = read(INDEX);
    expect(index).toContain('optionalSecret("CMM_CODE_ROUTER_TOKEN")');
    expect(index).toContain('optionalSecret("CMM_QODER_TOKEN")');
    // The legacy wire name is frozen in the explicit compatibility layer.
    expect(read(LEGACY)).toContain('LEGACY_CODE_ROUTER_BEARER_ENV = "CMM_QODER_TOKEN"');
  });

  it("does not silently rename the installed Qoder identity", () => {
    const script = read(RUN_ROUTER);
    // The legacy account stays the default; the canonical alias is additive.
    expect(script).toContain('QODER_ACCOUNT="${CMM_QODER_KEYCHAIN_ACCOUNT:-qoder-bearer}"');
    expect(script).toContain('CODE_ACCOUNT="${CMM_CODE_ROUTER_KEYCHAIN_ACCOUNT:-code-router-bearer}"');
  });
});
