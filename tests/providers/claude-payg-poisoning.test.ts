import { describe, expect, it } from "vitest";
import { buildIsolatedEnvironment } from "../../src/providers/claude/sdk-client.js";

describe("Claude PAYG poisoning protection", () => {
  it("strips dummy ANTHROPIC_API_KEY from poisoned parent", () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "dummy";

    try {
      const env = buildIsolatedEnvironment();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      if (originalKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = originalKey;
      }
    }
  });

  it("strips dummy ANTHROPIC_BASE_URL from poisoned parent", () => {
    const originalUrl = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "https://example.invalid";

    try {
      const env = buildIsolatedEnvironment();
      expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    } finally {
      if (originalUrl === undefined) {
        delete process.env.ANTHROPIC_BASE_URL;
      } else {
        process.env.ANTHROPIC_BASE_URL = originalUrl;
      }
    }
  });

  it("strips dummy ANTHROPIC_AUTH_TOKEN from poisoned parent", () => {
    const originalToken = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_AUTH_TOKEN = "dummy";

    try {
      const env = buildIsolatedEnvironment();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    } finally {
      if (originalToken === undefined) {
        delete process.env.ANTHROPIC_AUTH_TOKEN;
      } else {
        process.env.ANTHROPIC_AUTH_TOKEN = originalToken;
      }
    }
  });

  it("child/SDK environment contains NONE of the poisoned variables", () => {
    // Poison all Anthropic env vars
    const originals = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    };

    process.env.ANTHROPIC_API_KEY = "dummy-key";
    process.env.ANTHROPIC_BASE_URL = "https://example.invalid";
    process.env.ANTHROPIC_AUTH_TOKEN = "dummy-token";

    try {
      const env = buildIsolatedEnvironment();

      // Strict assertion: none of these should exist in child env
      expect("ANTHROPIC_API_KEY" in env).toBe(false);
      expect("ANTHROPIC_BASE_URL" in env).toBe(false);
      expect("ANTHROPIC_AUTH_TOKEN" in env).toBe(false);

      // Also verify no values match the poisoned ones
      expect(Object.values(env)).not.toContain("dummy-key");
      expect(Object.values(env)).not.toContain("https://example.invalid");
      expect(Object.values(env)).not.toContain("dummy-token");
    } finally {
      // Restore originals
      for (const [key, value] of Object.entries(originals)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
