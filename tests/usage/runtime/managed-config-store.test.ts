import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedConfigStore } from "../../../src/usage/runtime/managed-config-store.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cmm-managed-usage-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ManagedConfigStore", () => {
  it("persists only non-secret integration configuration", async () => {
    const dir = tempDir();
    const store = new ManagedConfigStore(dir);
    await store.write({
      version: 1,
      apiCredentialRef: "keychain://CMM%20Usage/local-api",
      managementApiCredentialRef: "keychain://CMM%20Usage/local-management-api",
      integrations: [{
        id: "openrouter-primary",
        type: "openrouter",
        enabled: true,
        credentialRef: "keychain://CMM%20Usage/openrouter-primary",
        settings: {},
      }],
    });

    const reloaded = await store.read();
    expect(reloaded.integrations).toEqual([
      expect.objectContaining({ id: "openrouter-primary", credentialRef: "keychain://CMM%20Usage/openrouter-primary" }),
    ]);
    const serialized = readFileSync(join(dir, "usage.json"), "utf8");
    expect(serialized).not.toContain("secret-value");
  });

  it("rejects inline credential-shaped settings before writing", async () => {
    const dir = tempDir();
    const store = new ManagedConfigStore(dir);
    await expect(store.write({
      version: 1,
      apiCredentialRef: "keychain://CMM%20Usage/local-api",
      managementApiCredentialRef: "keychain://CMM%20Usage/local-management-api",
      integrations: [{
        id: "unsafe",
        type: "openrouter",
        enabled: true,
        credentialRef: "keychain://CMM%20Usage/unsafe",
        settings: { apiKey: "secret-value" },
      }],
    })).rejects.toThrow(/credential|secret/i);
  });
});
