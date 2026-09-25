import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const HELPER = join(REPO, "scripts", "qoder", "add-cavoti-model.mjs");
const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "cmm-qoder-cavoti-"));
  roots.push(value);
  return value;
}

function fixture(): Record<string, unknown> {
  return {
    untouchedTopLevel: { keep: true },
    providers: {
      "unrelated-provider": {
        baseUrl: "https://example.invalid/v1",
        apiKey: "other-secret",
        models: [],
      },
      "qoder-custom-cmm-router": {
        baseUrl: "http://127.0.0.1:8790/v1",
        apiKey: "qoder-secret-sentinel",
        type: "openai-compatible",
        protocol: "openai",
        authType: "bearer",
        model: "chatgpt/gpt-5.6-sol",
        models: [
          {
            model: "chatgpt/gpt-5.6-sol",
            displayName: "chatgpt/gpt-5.6-sol",
            contextWindow: 1_050_000,
            maxOutputTokens: 128_000,
            capabilities: { vision: true },
          },
        ],
      },
    },
  };
}

afterEach(() => {
  for (const item of roots.splice(0)) {
    rmSync(item, { recursive: true, force: true });
  }
});

describe("Qoder additive Cavoti model reconciler", () => {
  it("adds only the CMM Cavoti model, preserves bearer/selection/other providers, and is idempotent", () => {
    expect(existsSync(HELPER)).toBe(true);
    if (!existsSync(HELPER)) return;

    const dir = root();
    const settingsPath = join(dir, "settings.json");
    const backupDir = join(dir, "backups");
    const original = fixture();
    writeFileSync(settingsPath, JSON.stringify(original, null, 2) + "\n", {
      mode: 0o600,
    });
    chmodSync(settingsPath, 0o600);

    const first = spawnSync(process.execPath, [HELPER], {
      encoding: "utf8",
      env: {
        ...process.env,
        QODER_SETTINGS_PATH: settingsPath,
        QODER_BACKUP_DIR: backupDir,
      },
    });
    const firstOutput = `${first.stdout}${first.stderr}`;
    expect(first.status).toBe(0);
    expect(firstOutput).toContain("QODER_CAVOTI_MODEL=ADDED");
    expect(firstOutput).not.toContain("qoder-secret-sentinel");
    expect(firstOutput).not.toContain("other-secret");

    const updated = JSON.parse(readFileSync(settingsPath, "utf8"));
    const provider = updated.providers["qoder-custom-cmm-router"];
    expect(provider.apiKey).toBe("qoder-secret-sentinel");
    expect(provider.model).toBe("chatgpt/gpt-5.6-sol");
    expect(updated.untouchedTopLevel).toEqual({ keep: true });
    expect(updated.providers["unrelated-provider"]).toEqual(
      (original as any).providers["unrelated-provider"],
    );

    const cavoti = provider.models.filter(
      (item: any) => item.model === "cavoti/deepseek-v4.1-flash",
    );
    expect(cavoti).toEqual([
      {
        model: "cavoti/deepseek-v4.1-flash",
        displayName: "DeepSeek V4.1 Flash (Cavoti via CMM Routers)",
        contextWindow: 1_000_000,
        maxOutputTokens: 8_192,
        capabilities: { vision: false },
      },
    ]);

    const backups = readdirSync(backupDir);
    expect(backups).toHaveLength(1);
    expect(statSync(join(backupDir, backups[0]!)).mode & 0o777).toBe(0o600);

    const second = spawnSync(process.execPath, [HELPER], {
      encoding: "utf8",
      env: {
        ...process.env,
        QODER_SETTINGS_PATH: settingsPath,
        QODER_BACKUP_DIR: backupDir,
      },
    });
    const secondOutput = `${second.stdout}${second.stderr}`;
    expect(second.status).toBe(0);
    expect(secondOutput).toContain("QODER_CAVOTI_MODEL=ALREADY_PRESENT");
    expect(secondOutput).not.toContain("qoder-secret-sentinel");

    const afterSecond = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(
      afterSecond.providers["qoder-custom-cmm-router"].models.filter(
        (item: any) => item.model === "cavoti/deepseek-v4.1-flash",
      ),
    ).toHaveLength(1);
    expect(readdirSync(backupDir)).toHaveLength(1);
  });

  it("fails closed without writing when an existing Cavoti model conflicts", () => {
    expect(existsSync(HELPER)).toBe(true);
    if (!existsSync(HELPER)) return;

    const dir = root();
    const settingsPath = join(dir, "settings.json");
    const backupDir = join(dir, "backups");
    const config = fixture() as any;
    config.providers["qoder-custom-cmm-router"].models.push({
      model: "cavoti/deepseek-v4.1-flash",
      displayName: "conflicting",
      contextWindow: 123,
      maxOutputTokens: 456,
      capabilities: { vision: true },
    });
    const before = JSON.stringify(config, null, 2) + "\n";
    writeFileSync(settingsPath, before, { mode: 0o600 });

    const result = spawnSync(process.execPath, [HELPER], {
      encoding: "utf8",
      env: {
        ...process.env,
        QODER_SETTINGS_PATH: settingsPath,
        QODER_BACKUP_DIR: backupDir,
      },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "QODER_CAVOTI_MODEL=CONFLICT",
    );
    expect(readFileSync(settingsPath, "utf8")).toBe(before);
    expect(existsSync(backupDir) ? readdirSync(backupDir) : []).toHaveLength(0);
  });
});
