import { chmodSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const PROVISIONER = join(REPO, "scripts/macos/provision-codex-upstream-profile.sh");

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
}

function fixtureCatalog(): string {
  return JSON.stringify({
    models: [
      {
        slug: "gpt-5.6-sol",
        tool_mode: "code_mode_only",
        shell_type: "shell_command",
        supports_search_tool: true,
        apply_patch_tool_type: "freeform",
        multi_agent_version: "v2",
      },
      {
        slug: "gpt-fixture-2",
        tool_mode: "code_mode_only",
        shell_type: "shell_command",
        supports_search_tool: true,
        apply_patch_tool_type: "freeform",
        multi_agent_version: "v2",
      },
    ],
  });
}

describe("Codex upstream tool-neutral profile", () => {
  it("builds an isolated subscription-only profile and leaves source auth untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "cmm-codex-profile-"));
    const home = join(root, "home");
    const sourceHome = join(home, ".codex");
    const profile = join(home, "Library/Application Support/CMM Routers/codex-upstream");
    const bin = join(root, "codex");
    const catalog = join(root, "models.json");

    mkdirSync(sourceHome, { recursive: true });
    const originalAuth = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "subscription-token" },
      OPENAI_API_KEY: "must-not-copy",
    });
    writeFileSync(join(sourceHome, "auth.json"), originalAuth, "utf8");
    writeFileSync(catalog, fixtureCatalog(), "utf8");
    writeExecutable(bin, "#!/bin/sh\necho 'codex-cli 0.147.0'\n");

    execFileSync("/bin/bash", [PROVISIONER], {
      env: {
        ...process.env,
        HOME: home,
        CMM_ROUTER_CODEX_BIN: bin,
        CMM_ROUTER_CODEX_AUTH_SOURCE_HOME: sourceHome,
        CMM_ROUTER_CODEX_PROFILE_DIR: profile,
        CMM_ROUTER_CODEX_CATALOG_SOURCE_FILE: catalog,
      },
      stdio: "pipe",
    });

    const sourceAfter = readFileSync(join(sourceHome, "auth.json"), "utf8");
    expect(sourceAfter).toBe(originalAuth);

    const profileAuth = JSON.parse(readFileSync(join(profile, "auth.json"), "utf8"));
    expect(profileAuth.auth_mode).toBe("chatgpt");
    expect(profileAuth.tokens).toEqual({ access_token: "subscription-token" });
    expect(profileAuth.OPENAI_API_KEY).toBeUndefined();

    const patched = JSON.parse(readFileSync(join(profile, "model_catalog.json"), "utf8"));
    expect(patched.models).toHaveLength(2);
    for (const model of patched.models) {
      expect(model.tool_mode).toBe("direct");
      expect(model.shell_type).toBe("disabled");
      expect(model.supports_search_tool).toBe(false);
      expect(model.apply_patch_tool_type).toBeNull();
      expect(model.multi_agent_version).toBeNull();
    }

    const config = readFileSync(join(profile, "config.toml"), "utf8");
    expect(config).toContain("model_catalog_json = ");
    expect(config).toContain('web_search = "disabled"');
    expect(config).toContain("[agents]");
    expect(config).toContain("enabled = false");

    expect(statSync(profile).mode & 0o777).toBe(0o700);
    expect(statSync(join(profile, "auth.json")).mode & 0o777).toBe(0o600);

    console.log("CODEX_UPSTREAM_PROFILE_ISOLATED=PASS");
    console.log("CODEX_UPSTREAM_PROFILE_SUBSCRIPTION_ONLY=PASS");
    console.log("CODEX_UPSTREAM_PROFILE_ALL_MODELS_TOOL_NEUTRAL=PASS");
    console.log("GLOBAL_CODEX_AUTH_UNCHANGED=PASS");
  });

  it("fails closed on an unsupported Codex CLI version", () => {
    const root = mkdtempSync(join(tmpdir(), "cmm-codex-profile-version-"));
    const home = join(root, "home");
    const sourceHome = join(home, ".codex");
    const profile = join(root, "profile");
    const bin = join(root, "codex");
    const catalog = join(root, "models.json");

    mkdirSync(sourceHome, { recursive: true });
    writeFileSync(
      join(sourceHome, "auth.json"),
      JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "x" } }),
      "utf8",
    );
    writeFileSync(catalog, fixtureCatalog(), "utf8");
    writeExecutable(bin, "#!/bin/sh\necho 'codex-cli 0.999.0'\n");

    expect(() =>
      execFileSync("/bin/bash", [PROVISIONER], {
        env: {
          ...process.env,
          HOME: home,
          CMM_ROUTER_CODEX_BIN: bin,
          CMM_ROUTER_CODEX_AUTH_SOURCE_HOME: sourceHome,
          CMM_ROUTER_CODEX_PROFILE_DIR: profile,
          CMM_ROUTER_CODEX_CATALOG_SOURCE_FILE: catalog,
        },
        stdio: "pipe",
      }),
    ).toThrow();

    console.log("CODEX_UPSTREAM_PROFILE_VERSION_MISMATCH_FAIL_CLOSED=PASS");
  });
});
