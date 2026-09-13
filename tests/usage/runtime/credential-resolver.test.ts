import { describe, expect, it } from "vitest";
import { LocalSecureCredentialResolver } from "../../../src/usage/runtime/credential-resolver.js";

describe("LocalSecureCredentialResolver", () => {
  it("resolves env references without persisting values", async () => {
    const resolver = new LocalSecureCredentialResolver({
      env: { CMM_TEST_USAGE_KEY: "env-secret" },
      keychainLookup: async () => undefined,
    });

    expect(await resolver.resolve("env://CMM_TEST_USAGE_KEY")).toBe("env-secret");
  });

  it("resolves keychain references through the injected native lookup", async () => {
    const calls: Array<{ service: string; account: string }> = [];
    const resolver = new LocalSecureCredentialResolver({
      env: {},
      keychainLookup: async (service, account) => {
        calls.push({ service, account });
        return "keychain-secret";
      },
    });

    expect(await resolver.resolve("keychain://CMM%20Usage/claude-personal")).toBe("keychain-secret");
    expect(calls).toEqual([{ service: "CMM Usage", account: "claude-personal" }]);
  });

  it("refuses raw or unsupported credential references", async () => {
    const resolver = new LocalSecureCredentialResolver({ env: {}, keychainLookup: async () => undefined });

    await expect(resolver.resolve("raw-secret-value")).rejects.toThrow(/reference|scheme/i);
    await expect(resolver.resolve("file:///tmp/secret")).rejects.toThrow(/scheme/i);
  });
});
