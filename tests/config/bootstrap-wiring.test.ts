import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("config bootstrap and provider option wiring", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmm-config-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a usable shared.json template when missing (bootstrap)", async () => {
    const { ensureSharedConfig } = await import("../../src/config/load-config.js");
    const created = ensureSharedConfig(dir);
    expect(created).toBe(true);
    const { loadConfig } = await import("../../src/config/load-config.js");
    const config = loadConfig(dir);
    expect(config.mode).toBe("standalone");
    expect(config.host).toBe("127.0.0.1");
  });

  it("does not overwrite an existing shared.json", async () => {
    const { ensureSharedConfig } = await import("../../src/config/load-config.js");
    const existing = {
      mode: "standalone",
      host: "127.0.0.1",
      port: 9999,
      bearerSecretEnv: "CMM_ROUTER_TOKEN",
      providers: {
        chatgpt: { enabled: false },
        claude: { enabled: false },
        google: { enabled: false },
        "command-code": { enabled: false, secretEnv: "COMMAND_CODE_SECRET" },
      },
    };
    writeFileSync(join(dir, "shared.json"), JSON.stringify(existing));
    const created = ensureSharedConfig(dir);
    expect(created).toBe(false);
    const { loadConfig } = await import("../../src/config/load-config.js");
    expect(loadConfig(dir).port).toBe(9999);
  });

  it("surfaces the local machine id in the loaded config", async () => {
    const { ensureSharedConfig, loadConfig } = await import(
      "../../src/config/load-config.js"
    );
    ensureSharedConfig(dir);
    const config = loadConfig(dir);
    expect(typeof config.machineId).toBe("string");
    expect(config.machineId.length).toBeGreaterThan(0);
  });

  it("threads google agyPath from config into the spawned binary", async () => {
    const { loadConfig } = await import("../../src/config/load-config.js");
    const { ensureSharedConfig } = await import("../../src/config/load-config.js");
    ensureSharedConfig(dir);
    const { readFileSync, writeFileSync: write } = await import("node:fs");
    const raw = JSON.parse(readFileSync(join(dir, "shared.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    const providers = raw.providers as Record<string, unknown>;
    providers.google = { enabled: true, agyPath: "/custom/bin/agy" };
    write(join(dir, "shared.json"), JSON.stringify(raw));
    const config = loadConfig(dir);
    expect(
      (config.providers.google as { agyPath?: string }).agyPath,
    ).toBe("/custom/bin/agy");
    const { resolveGoogleAgyPath } = await import("../../src/index.js");
    expect(resolveGoogleAgyPath(config)).toBe("/custom/bin/agy");
  });

  it("threads chatgpt codexHome and claude profileDir through resolvers", async () => {
    const { ensureSharedConfig, loadConfig } = await import(
      "../../src/config/load-config.js"
    );
    ensureSharedConfig(dir);
    const { readFileSync, writeFileSync: write } = await import("node:fs");
    const raw = JSON.parse(readFileSync(join(dir, "shared.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    const providers = raw.providers as Record<string, unknown>;
    providers.chatgpt = { enabled: true, codexHome: "/custom/codex" };
    providers.claude = { enabled: true, profileDir: "/custom/claude" };
    write(join(dir, "shared.json"), JSON.stringify(raw));
    const config = loadConfig(dir);
    const { resolveChatgptCodexHome, resolveClaudeProfileDir } = await import(
      "../../src/index.js"
    );
    expect(resolveChatgptCodexHome(config)).toBe("/custom/codex");
    expect(resolveClaudeProfileDir(config)).toBe("/custom/claude");
  });
});
