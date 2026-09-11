import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const provisioner = resolve("scripts/macos/provision-antigravity-mcp-permission.mjs");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(settings: unknown) {
  const root = mkdtempSync(join(tmpdir(), "cmm-antigravity-permission-"));
  roots.push(root);
  const path = join(root, "settings.json");
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", "utf8");
  chmodSync(path, 0o600);
  return path;
}

function run(path: string, args: string[] = []) {
  return spawnSync(process.execPath, [provisioner, ...args], {
    env: { ...process.env, CMM_ANTIGRAVITY_SETTINGS_PATH: path },
    encoding: "utf8",
    timeout: 5000,
  });
}

function parsed(path: string) {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("Antigravity scoped MCP permission provisioner", () => {
  it("adds only the CMM MCP server wildcard and preserves unrelated settings", () => {
    const path = fixture({
      theme: "dark",
      permissions: {
        allow: ["mcp(other-server/read)"],
        ask: ["command(git status)"],
        deny: ["write_file(*)"],
      },
      nested: { keep: true },
    });

    const result = run(path);
    expect(result.status).toBe(0);

    const settings = parsed(path);
    expect(settings.theme).toBe("dark");
    expect(settings.nested).toEqual({ keep: true });

    const permissions = settings.permissions as {
      allow: string[];
      ask: string[];
      deny: string[];
    };

    expect(permissions.allow).toEqual([
      "mcp(other-server/read)",
      "mcp(cmm-qoder-tools/*)",
    ]);
    expect(permissions.ask).toEqual(["command(git status)"]);
    expect(permissions.deny).toEqual(["write_file(*)"]);

    expect(JSON.stringify(settings)).not.toContain('"mcp(*)"');
    expect(JSON.stringify(settings)).not.toContain('"command(*)"');
    expect(JSON.stringify(settings)).not.toContain('"write_file(*)","mcp(cmm-qoder-tools/*)"');

    expect(statSync(path).mode & 0o777).toBe(0o600);
    console.log("ANTIGRAVITY_SCOPED_MCP_ALLOW_ONLY=PASS");
  });

  it("is idempotent and --check validates without rewriting", () => {
    const path = fixture({
      permissions: { allow: ["mcp(cmm-qoder-tools/*)"] },
      keep: 42,
    });

    const before = readFileSync(path, "utf8");
    const mtimeBefore = statSync(path).mtimeMs;

    const apply = run(path);
    expect(apply.status).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(before);

    const check = run(path, ["--check"]);
    expect(check.status).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(statSync(path).mtimeMs).toBe(mtimeBefore);

    console.log("ANTIGRAVITY_SCOPED_MCP_PERMISSION_IDEMPOTENT=PASS");
    console.log("ANTIGRAVITY_SCOPED_MCP_PERMISSION_CHECK=PASS");
  });

  it("creates the narrow permissions structure when permissions are absent", () => {
    const path = fixture({ keep: "yes" });

    const result = run(path);
    expect(result.status).toBe(0);
    expect(parsed(path)).toEqual({
      keep: "yes",
      permissions: { allow: ["mcp(cmm-qoder-tools/*)"] },
    });

    console.log("ANTIGRAVITY_PERMISSION_ABSENT_TO_SCOPED_ALLOW=PASS");
  });

  it.each([
    ["ask exact tool", { ask: ["mcp(cmm-qoder-tools/canary_echo)"] }],
    ["ask server wildcard", { ask: ["mcp(cmm-qoder-tools/*)"] }],
    ["ask global MCP", { ask: ["mcp(*)"] }],
    ["deny exact tool", { deny: ["mcp(cmm-qoder-tools/canary_echo)"] }],
    ["deny server wildcard", { deny: ["mcp(cmm-qoder-tools/*)"] }],
    ["deny global MCP", { deny: ["mcp(*)"] }],
  ])("fails closed on higher-precedence conflict: %s", (_name, permissions) => {
    const path = fixture({
      permissions: { allow: ["mcp(other/*)"], ...permissions },
      keep: true,
    });

    const before = readFileSync(path, "utf8");
    const result = run(path);

    expect(result.status).not.toBe(0);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(result.stdout + result.stderr).not.toContain("canary_echo");
    console.log("ANTIGRAVITY_PERMISSION_CONFLICT_FAIL_CLOSED=PASS");
  });

  it("fails closed on malformed permissions shapes", () => {
    const path = fixture({ permissions: { allow: "mcp(*)" } });
    const before = readFileSync(path, "utf8");

    const result = run(path);
    expect(result.status).not.toBe(0);
    expect(readFileSync(path, "utf8")).toBe(before);

    console.log("ANTIGRAVITY_PERMISSION_SCHEMA_FAIL_CLOSED=PASS");
  });

  it("--check fails when the scoped allow is absent and never mutates", () => {
    const path = fixture({ permissions: { allow: [] }, keep: "untouched" });
    const before = readFileSync(path, "utf8");

    const result = run(path, ["--check"]);
    expect(result.status).not.toBe(0);
    expect(readFileSync(path, "utf8")).toBe(before);

    console.log("ANTIGRAVITY_PERMISSION_CHECK_FAIL_CLOSED=PASS");
  });
});
