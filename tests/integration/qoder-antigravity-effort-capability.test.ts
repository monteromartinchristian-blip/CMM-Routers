import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const IDS = [
  "chatgpt/gpt-5.5",
  "chatgpt/gpt-5.6-luna",
  "chatgpt/gpt-5.6-sol",
  "chatgpt/gpt-5.6-terra",
  "chatgpt/gpt-6-astra",
  "chatgpt/gpt-daybreak-blue-latest",
  "claude/claude-fable-5-1[1m]",
  "claude/default",
  "claude/haiku",
  "claude/opus",
  "claude/sonnet",
  "google/claude-opus-4-6-thinking",
  "google/claude-sonnet-4-6",
  "google/gemini-3.1-pro-high",
  "google/gemini-3.1-pro-low",
  "google/gemini-3.6-flash-high",
  "google/gemini-3.6-flash-low",
  "google/gemini-3.6-flash-medium",
  "google/gemini-3.7-flash-high",
  "google/gemini-3.7-flash-low",
  "google/gemini-3.7-flash-medium",
  "google/gemini-3.8-flash-high",
  "google/gemini-3.8-flash-low",
  "google/gemini-3.8-flash-medium",
  "google/gpt-oss-120b-medium",
] as const;

describe("Qoder Antigravity effort capability truth", () => {

  it("preserves a legitimate unmanaged extra model byte-for-byte", () => {
    const root = mkdtempSync(join(tmpdir(), "cmm-qoder-extra-model-"));
    const settingsPath = join(root, "settings.json");
    const backupDir = join(root, "backups");

    const extra = {
      model: "deepseek/deepseek-v4.1-flash",
      displayName: "DeepSeek V4.1 Flash (Cavoti AI)",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      capabilities: { vision: false },
    };

    writeFileSync(
      settingsPath,
      JSON.stringify({
        providers: {
          "qoder-custom-cmm-router": {
            baseUrl: "http://127.0.0.1:8790/v1",
            apiKey: "test-only-bearer",
            type: "openai-compatible",
            protocol: "openai",
            authType: "bearer",
            model: "chatgpt/gpt-5.6-sol",
            models: [...IDS.map((model) => ({ model, displayName: model })), extra],
          },
        },
      }),
      "utf8",
    );

    const result = spawnSync(process.execPath, ["scripts/qoder/reconcile-qoder-provider.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        QODER_SETTINGS_PATH: settingsPath,
        QODER_BACKUP_DIR: backupDir,
      },
      encoding: "utf8",
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);

    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      providers: Record<string, { models: Array<Record<string, unknown>> }>;
    };
    const models = settings.providers["qoder-custom-cmm-router"]!.models;

    expect(models).toHaveLength(IDS.length + 1);
    expect(models.at(-1)).toEqual(extra);
  });

  it("does not advertise an effort selector for AGY-routed Claude models", () => {
    const root = mkdtempSync(join(tmpdir(), "cmm-qoder-agy-effort-"));
    const settingsPath = join(root, "settings.json");
    const backupDir = join(root, "backups");

    writeFileSync(
      settingsPath,
      JSON.stringify({
        providers: {
          "qoder-custom-cmm-router": {
            baseUrl: "http://127.0.0.1:8790/v1",
            apiKey: "test-only-bearer",
            type: "openai-compatible",
            protocol: "openai",
            authType: "bearer",
            model: "chatgpt/gpt-5.6-sol",
            models: IDS.map((model) => ({ model, displayName: model })),
          },
        },
      }),
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      ["scripts/qoder/reconcile-qoder-provider.mjs"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          QODER_SETTINGS_PATH: settingsPath,
          QODER_BACKUP_DIR: backupDir,
        },
        encoding: "utf8",
      },
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);

    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      providers: Record<string, { models: Array<{ model: string; capabilities?: { thinking?: unknown } }> }>;
    };
    const models = settings.providers["qoder-custom-cmm-router"]!.models;
    const byId = new Map(models.map((m) => [m.model, m]));

    expect(byId.get("google/claude-sonnet-4-6")?.capabilities?.thinking).toBeUndefined();
    expect(byId.get("google/claude-opus-4-6-thinking")?.capabilities?.thinking).toBeUndefined();

    // Provider-native Claude remains independently proven adjustable.
    expect(byId.get("claude/sonnet")?.capabilities?.thinking).toBeDefined();
  });
});
