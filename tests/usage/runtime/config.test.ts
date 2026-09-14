import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadUsageRuntimeConfig } from "../../../src/usage/runtime/config.js";

const tempDirs: string[] = [];

function tempConfigDir(): string {
  const path = mkdtempSync(join(tmpdir(), "cmm-usage-config-"));
  tempDirs.push(path);
  return path;
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("CMM Usage runtime configuration", () => {
  it("defaults to no active integrations when usage.json is absent", () => {
    const config = loadUsageRuntimeConfig(tempConfigDir());

    expect(config).toEqual({
      version: 1,
      apiCredentialRef: "keychain://CMM%20Usage/local-api",
      managementApiCredentialRef: "keychain://CMM%20Usage/local-management-api",
      integrations: [],
    });
  });

  it("loads provider instances without embedding credentials", () => {
    const dir = tempConfigDir();
    writeFileSync(join(dir, "usage.json"), JSON.stringify({
      version: 1,
      apiCredentialRef: "keychain://CMM%20Usage/local-api-test",
      integrations: [{
        id: "claude-personal",
        type: "claude-subscription",
        enabled: true,
        credentialRef: "keychain://CMM Usage/claude-personal",
        settings: {
          planLabel: "Claude Pro",
          routes: [{ providerModelId: "claude-sonnet", displayName: "Claude Sonnet" }],
        },
      }],
    }));

    expect(loadUsageRuntimeConfig(dir)).toMatchObject({
      version: 1,
      apiCredentialRef: "keychain://CMM%20Usage/local-api-test",
      integrations: [{
        id: "claude-personal",
        type: "claude-subscription",
        enabled: true,
        credentialRef: "keychain://CMM Usage/claude-personal",
      }],
    });
  });

  it("rejects duplicate integration ids", () => {
    const dir = tempConfigDir();
    writeFileSync(join(dir, "usage.json"), JSON.stringify({
      version: 1,
      integrations: [
        { id: "same", type: "deepseek", enabled: true, credentialRef: "env://A", settings: {} },
        { id: "same", type: "openrouter", enabled: true, credentialRef: "env://B", settings: {} },
      ],
    }));

    expect(() => loadUsageRuntimeConfig(dir)).toThrow(/unique/i);
  });

  it("rejects inline secret-shaped settings", () => {
    const dir = tempConfigDir();
    writeFileSync(join(dir, "usage.json"), JSON.stringify({
      version: 1,
      integrations: [{
        id: "deepseek-personal",
        type: "deepseek",
        enabled: true,
        credentialRef: "keychain://CMM Usage/deepseek-personal",
        settings: { apiKey: "must-not-live-here" },
      }],
    }));

    expect(() => loadUsageRuntimeConfig(dir)).toThrow(/secret|credential/i);
  });
});
