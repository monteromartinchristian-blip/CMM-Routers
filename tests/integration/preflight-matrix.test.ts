import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "../../scripts/preflight.sh");

function runPreflight(env: Record<string, string | undefined>): { rc: number; output: string } {
  const nodeDir = process.execPath.includes("/")
    ? process.execPath.slice(0, process.execPath.lastIndexOf("/"))
    : "";
  const basePath = [nodeDir, "/usr/bin", "/bin"].filter(Boolean).join(":");
  try {
    const output = execFileSync("bash", [SCRIPT], {
      encoding: "utf-8",
      env: {
        PATH: env.PATH ?? basePath,
        HOME: process.env.HOME ?? "/tmp",
        ...env,
      },
      timeout: 30000,
    });
    return { rc: 0, output };
  } catch (error) {
    const err = error as { status?: number; stdout?: unknown };
    return { rc: err.status ?? 1, output: String(err.stdout ?? "") };
  }
}

function writeShared(dir: string, providers: Record<string, unknown>): void {
  writeFileSync(
    join(dir, "shared.json"),
    JSON.stringify({
      mode: "standalone",
      host: "127.0.0.1",
      port: 8790,
      bearerSecretEnv: "CMM_ROUTER_TOKEN",
      providers,
    }),
  );
}

function allDisabled(dir: string): void {
  writeShared(dir, {
    chatgpt: { enabled: false },
    claude: { enabled: false },
    google: { enabled: false },
    "command-code": { enabled: false, secretEnv: "COMMAND_CODE_SECRET" },
  });
}

describe("preflight provider-aware fail-closed matrix", { timeout: 20_000 }, () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmm-preflight-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("OPENAI_API_KEY=dummy only fails closed", () => {
    const { rc, output } = runPreflight({ CMM_CONFIG_DIR: dir, OPENAI_API_KEY: "dummy" });
    expect(output).toContain("OPENAI_PAYG_ENV=UNSAFE");
    expect(rc).not.toBe(0);
  });

  it("ANTHROPIC_API_KEY=dummy only fails closed", () => {
    const { rc, output } = runPreflight({ CMM_CONFIG_DIR: dir, ANTHROPIC_API_KEY: "dummy" });
    expect(output).toContain("CLAUDE_PAYG_ENV=UNSAFE");
    expect(rc).not.toBe(0);
  });

  it("GEMINI_API_KEY=dummy only fails closed", () => {
    const { rc, output } = runPreflight({ CMM_CONFIG_DIR: dir, GEMINI_API_KEY: "dummy" });
    expect(output).toContain("GOOGLE_PAYG_ENV=UNSAFE");
    expect(rc).not.toBe(0);
  });

  it("enabled provider AUTH_REQUIRED fails closed", () => {
    // Codex binary exists here but login is not guaranteed; force the auth
    // gate via command-code enabled without its secret (deterministic).
    writeShared(dir, {
      chatgpt: { enabled: false },
      claude: { enabled: false },
      google: { enabled: false },
      "command-code": { enabled: true, secretEnv: "COMMAND_CODE_SECRET" },
    });
    const { rc, output } = runPreflight({ CMM_CONFIG_DIR: dir });
    expect(output).toContain("COMMAND_CODE_STATE=AUTH_REQUIRED");
    expect(rc).not.toBe(0);
  });

  it("disabled providers with absent binaries/auth are SKIPPED_DISABLED and pass", () => {
    allDisabled(dir);
    const fakeBin = mkdtempSync(join(tmpdir(), "cmm-fakebin-"));
    try {
      symlinkSync(process.execPath, join(fakeBin, "node"));
      const { rc, output } = runPreflight({
        CMM_CONFIG_DIR: dir,
        PATH: `${fakeBin}:/usr/bin:/bin`,
      });
      expect(output).toContain("SKIPPED_DISABLED");
      // No PAYG poison present; disabled providers must not block.
      expect(output).not.toContain("=UNSAFE");
      expect(rc).toBe(0);
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("enabled provider with absent binary fails closed", () => {
    writeShared(dir, {
      chatgpt: { enabled: true },
      claude: { enabled: false },
      google: { enabled: false },
      "command-code": { enabled: false, secretEnv: "COMMAND_CODE_SECRET" },
    });
    const fakeBin = mkdtempSync(join(tmpdir(), "cmm-fakebin-"));
    try {
      symlinkSync(process.execPath, join(fakeBin, "node"));
      const { rc, output } = runPreflight({
        CMM_CONFIG_DIR: dir,
        // Fake bin dir has node but no codex: enabled chatgpt must block.
        PATH: `${fakeBin}:/usr/bin:/bin`,
      });
      expect(output).toContain("CHATGPT_PROVIDER=ENABLED");
      expect(output).toContain("CODEX_BINARY=UNAVAILABLE");
      expect(rc).not.toBe(0);
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("accepts ChatGPT auth status emitted by Codex on stderr", () => {
    writeShared(dir, {
      chatgpt: { enabled: true },
      claude: { enabled: false },
      google: { enabled: false },
      "command-code": { enabled: false, secretEnv: "COMMAND_CODE_SECRET" },
    });

    const fakeBin = mkdtempSync(join(tmpdir(), "cmm-fakebin-codex-stderr-"));
    try {
      symlinkSync(process.execPath, join(fakeBin, "node"));

      const fakeCodex = join(fakeBin, "codex");
      writeFileSync(
        fakeCodex,
        [
          "#!/bin/sh",
          'if [ "$1" = "login" ] && [ "$2" = "status" ]; then',
          '  echo "Logged in using ChatGPT" >&2',
          "  exit 0",
          "fi",
          "exit 2",
          "",
        ].join("\n"),
      );
      chmodSync(fakeCodex, 0o755);

      const { rc, output } = runPreflight({
        CMM_CONFIG_DIR: dir,
        PATH: `${fakeBin}:/usr/bin:/bin`,
      });

      expect(output).toContain("CODEX_CHATGPT_AUTH=READY");
      expect(output).toContain("PREFLIGHT=PASS");
      expect(rc).toBe(0);
      console.log("CODEX_CHATGPT_AUTH_STDERR_STATUS=PASS");
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("node absent fails closed", () => {
    allDisabled(dir);
    const fakeBin = mkdtempSync(join(tmpdir(), "cmm-fakebin-"));
    try {
      // bash present but node absent: NODE=FAIL must block even with all
      // providers disabled.
      symlinkSync("/bin/bash", join(fakeBin, "bash"));
      const { rc, output } = runPreflight({
        CMM_CONFIG_DIR: dir,
        PATH: fakeBin,
      });
      expect(output).toContain("NODE=FAIL");
      expect(rc).not.toBe(0);
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });
});
