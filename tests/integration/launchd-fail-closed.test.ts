import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = join(import.meta.dirname, "../..");
const NODE_DIR = dirname(process.execPath);

interface InstallResult {
  rc: number;
  output: string;
  plistPath: string;
  plistExists: boolean;
  plist: string;
}

let repoCopy: string;

function writeConfig(dir: string, providers: Record<string, unknown>): string {
  const configDir = mkdtempSync(join(tmpdir(), "cmm-launchd-cfg-"));
  writeFileSync(
    join(configDir, "shared.json"),
    JSON.stringify({
      mode: "standalone",
      host: "127.0.0.1",
      port: 8790,
      bearerSecretEnv: "CMM_ROUTER_TOKEN",
      providers,
    }),
  );
  void dir;
  return configDir;
}

function runInstaller(options: {
  configDir: string;
  home: string;
  path?: string;
  extraEnv?: Record<string, string>;
}): InstallResult {
  const plistPath = join(options.home, "Library", "LaunchAgents", "com.cmm.subscription-router.plist");
  let output = "";
  let rc = 0;
  try {
    output = execFileSync("bash", [`${repoCopy}/scripts/macos/install-router.sh`], {
      encoding: "utf-8",
      env: {
        HOME: options.home,
        PATH: options.path ?? process.env.PATH ?? "/usr/bin:/bin",
        CMM_CONFIG_DIR: options.configDir,
        ...options.extraEnv,
      },
      timeout: 30000,
    });
  } catch (error) {
    const err = error as { status?: number; stdout?: unknown; stderr?: unknown };
    rc = err.status ?? 1;
    output = `${String(err.stdout ?? "")}${String(err.stderr ?? "")}`;
  }
  return {
    rc,
    output,
    plistPath,
    plistExists: existsSync(plistPath),
    plist: existsSync(plistPath) ? readFileSync(plistPath, "utf-8") : "",
  };
}

const ALL_DISABLED = {
  chatgpt: { enabled: false },
  claude: { enabled: false },
  google: { enabled: false },
  "command-code": { enabled: false, secretEnv: "COMMAND_CODE_SECRET" },
};

describe("launchd installer fails closed on unresolved runtime binaries", () => {
  beforeAll(() => {
    repoCopy = mkdtempSync(join(tmpdir(), "cmm-launchd-failclosed-"));
    execFileSync("bash", [
      "-c",
      `cp -r "${REPO}/scripts" "${REPO}/launchd" "${REPO}/src" "${REPO}/dist" "${repoCopy}/" && ln -s "${REPO}/node_modules" "${repoCopy}/node_modules"`,
    ]);
  });

  afterAll(() => {
    rmSync(repoCopy, { recursive: true, force: true });
  });

  it("fails closed when node is not resolvable", () => {
    const home = mkdtempSync(join(tmpdir(), "cmm-home-"));
    const configDir = writeConfig(home, ALL_DISABLED);
    try {
      const result = runInstaller({
        configDir,
        home,
        extraEnv: { CMM_ROUTER_NODE_BIN: "/nonexistent/node" },
      });
      expect(result.rc).not.toBe(0);
      expect(result.plistExists).toBe(false);
      expect(result.output).toContain("node runtime is not resolvable");
      console.log("LAUNCHD_MISSING_NODE=FAIL_CLOSED");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("fails closed when codex is missing while ChatGPT is enabled", () => {
    const home = mkdtempSync(join(tmpdir(), "cmm-home-"));
    const configDir = writeConfig(home, {
      chatgpt: { enabled: true },
      claude: { enabled: false },
      google: { enabled: false },
      "command-code": { enabled: false, secretEnv: "COMMAND_CODE_SECRET" },
    });
    try {
      const result = runInstaller({
        configDir,
        home,
        // node resolvable, codex absent from PATH (homebrew dir excluded).
        path: `${NODE_DIR}:/usr/bin:/bin`,
      });
      expect(result.rc).not.toBe(0);
      expect(result.plistExists).toBe(false);
      expect(result.output).toContain("codex binary is not resolvable");
      console.log("LAUNCHD_MISSING_CODEX_WHEN_ENABLED=FAIL_CLOSED");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("fails closed when agy is missing while Google is enabled", () => {
    const home = mkdtempSync(join(tmpdir(), "cmm-home-"));
    const configDir = writeConfig(home, {
      chatgpt: { enabled: false },
      claude: { enabled: false },
      google: { enabled: true },
      "command-code": { enabled: false, secretEnv: "COMMAND_CODE_SECRET" },
    });
    try {
      const result = runInstaller({
        configDir,
        home,
        // No agy on PATH and HOME has no ~/.local/bin/agy fallback.
        path: `${NODE_DIR}:/usr/bin:/bin`,
      });
      expect(result.rc).not.toBe(0);
      expect(result.plistExists).toBe(false);
      expect(result.output).toContain("agy binary is not resolvable");
      console.log("LAUNCHD_MISSING_AGY_WHEN_ENABLED=FAIL_CLOSED");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("fails closed when a configured agyPath is not executable", () => {
    const home = mkdtempSync(join(tmpdir(), "cmm-home-"));
    const configDir = writeConfig(home, {
      chatgpt: { enabled: false },
      claude: { enabled: false },
      google: { enabled: true, agyPath: "/tmp/definitely-not-agy-cmm" },
      "command-code": { enabled: false, secretEnv: "COMMAND_CODE_SECRET" },
    });
    try {
      const result = runInstaller({ configDir, home });
      expect(result.rc).not.toBe(0);
      expect(result.plistExists).toBe(false);
      expect(result.output).toContain("agyPath is not executable");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("does not require binaries for disabled providers or Command Code", () => {
    const home = mkdtempSync(join(tmpdir(), "cmm-home-"));
    const configDir = writeConfig(home, {
      chatgpt: { enabled: false },
      claude: { enabled: false },
      google: { enabled: false },
      // Command Code is HTTP-based: enabled without any local binary.
      "command-code": { enabled: true, secretEnv: "COMMAND_CODE_SECRET" },
    });
    try {
      const result = runInstaller({
        configDir,
        home,
        path: `${NODE_DIR}:/usr/bin:/bin`,
      });
      expect(result.rc).toBe(0);
      expect(result.plistExists).toBe(true);
      console.log("LAUNCHD_DISABLED_PROVIDER_BINARY_NOT_REQUIRED=PASS");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("bakes absolute runtime paths and never bare command names", () => {
    const home = mkdtempSync(join(tmpdir(), "cmm-home-"));
    const fakeCodex = join(mkdtempSync(join(tmpdir(), "cmm-fakecodex-")), "codex");
    writeFileSync(fakeCodex, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const configDir = writeConfig(home, {
      chatgpt: { enabled: true },
      claude: { enabled: false },
      google: { enabled: false },
      "command-code": { enabled: false, secretEnv: "COMMAND_CODE_SECRET" },
    });
    try {
      const result = runInstaller({
        configDir,
        home,
        extraEnv: { CMM_ROUTER_CODEX_BIN: fakeCodex },
      });
      expect(result.rc).toBe(0);
      const nodeValue = result.plist.match(
        /<key>CMM_ROUTER_NODE_BIN<\/key>\s*<string>([^<]+)<\/string>/,
      )?.[1];
      const codexValue = result.plist.match(
        /<key>CMM_ROUTER_CODEX_BIN<\/key>\s*<string>([^<]+)<\/string>/,
      )?.[1];
      expect(nodeValue?.startsWith("/")).toBe(true);
      expect(codexValue).toBe(fakeCodex);
      expect(result.plist).not.toMatch(/<string>node<\/string>/);
      expect(result.plist).not.toMatch(/<string>codex<\/string>/);
      console.log("LAUNCHD_BARE_NODE_FALLBACK=NONE");
      console.log("LAUNCHD_BARE_CODEX_FALLBACK=NONE");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("fails closed when the shared config is invalid", () => {
    const home = mkdtempSync(join(tmpdir(), "cmm-home-"));
    const configDir = mkdtempSync(join(tmpdir(), "cmm-badcfg-"));
    writeFileSync(join(configDir, "shared.json"), JSON.stringify({ host: "127.0.0.1" }));
    try {
      const result = runInstaller({ configDir, home });
      expect(result.rc).not.toBe(0);
      expect(result.plistExists).toBe(false);
      expect(result.output).toContain("config validation failed");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
