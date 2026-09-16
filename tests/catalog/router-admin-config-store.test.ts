import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalSecureCredentialWriter } from "../../src/catalog/local-secure-credential-writer.js";
import { RouterAdminConfigStore } from "../../src/catalog/router-admin-config-store.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cmm-router-admin-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("RouterAdminConfigStore", () => {
  it("updates shared.json atomically with mode 0600 and secure references only", async () => {
    const dir = tempDir();
    const store = new RouterAdminConfigStore(dir);

    const next = await store.update((config) => ({
      ...config,
      administrativeConnections: [{
        connectionId: "connection:openrouter:primary",
        providerId: "openrouter",
        connectionKind: "openai-chat-completions",
        executionSecretRef: "keychain://CMM%20Usage/openrouter-primary",
        enabled: true,
      }],
    }));

    expect(next.administrativeConnections).toEqual([
      expect.objectContaining({
        connectionId: "connection:openrouter:primary",
        executionSecretRef: "keychain://CMM%20Usage/openrouter-primary",
      }),
    ]);
    const path = join(dir, "shared.json");
    const serialized = readFileSync(path, "utf8");
    expect(serialized).toContain("executionSecretRef");
    expect(serialized).toContain("keychain://CMM%20Usage/openrouter-primary");
    expect(serialized).not.toMatch(/"(?:apiKey|accessToken|secret|cookie)"/i);
    expect(() => statSync(`${path}.tmp`)).toThrow();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("leaves the previous shared.json byte-for-byte unchanged when validation fails", async () => {
    const dir = tempDir();
    const path = join(dir, "shared.json");
    const store = new RouterAdminConfigStore(dir);
    await store.write(await store.read());
    const before = readFileSync(path);

    await expect(store.update((config) => ({
      ...config,
      administrativeConnections: [{
        connectionId: "connection:openrouter:unsafe",
        providerId: "openrouter",
        connectionKind: "openai-chat-completions",
        enabled: true,
        apiKey: "raw-secret-value",
      }],
    } as never))).rejects.toThrow();

    expect(readFileSync(path)).toEqual(before);
    expect(() => statSync(`${path}.tmp`)).toThrow();
  });

  it("replaces a stale permissive temp file with a 0600 atomic write", async () => {
    const dir = tempDir();
    const path = join(dir, "shared.json");
    writeFileSync(`${path}.tmp`, "stale", { mode: 0o644 });
    const store = new RouterAdminConfigStore(dir);

    await store.write(store.read());

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => statSync(`${path}.tmp`)).toThrow();
  });

  it("fails closed when an existing shared.json contains raw administrative credentials", () => {
    const dir = tempDir();
    const store = new RouterAdminConfigStore(dir);
    writeFileSync(join(dir, "shared.json"), JSON.stringify({
      mode: "standalone",
      host: "127.0.0.1",
      administrativeConnections: [{
        connectionId: "connection:openrouter:unsafe",
        providerId: "openrouter",
        connectionKind: "openai-chat-completions",
        enabled: true,
        accessToken: "raw-token-value",
      }],
    }));

    expect(() => store.read()).toThrow();
  });
});

describe("LocalSecureCredentialWriter", () => {
  it("keeps the existing Keychain service/account semantics while returning a secretRef", async () => {
    const writes: Array<[string, string, string]> = [];
    const removes: Array<[string, string]> = [];
    const writer = new LocalSecureCredentialWriter(
      async (service, account, secret) => { writes.push([service, account, secret]); },
      async (service, account) => { removes.push([service, account]); },
    );

    const result = await writer.write("openrouter-primary", " raw-secret-value ");

    expect(writes).toEqual([["CMM Usage", "openrouter-primary", "raw-secret-value"]]);
    expect(result).toEqual({
      secretRef: "keychain://CMM%20Usage/openrouter-primary",
      hint: "••••alue",
    });
    await writer.remove(result.secretRef);
    expect(removes).toEqual([["CMM Usage", "openrouter-primary"]]);
  });
});
