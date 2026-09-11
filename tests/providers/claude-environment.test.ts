import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { buildIsolatedEnvironment } from "../../src/providers/claude/sdk-client.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Claude isolated environment", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
  });

  it("contains dedicated config path", () => {
    const env = buildIsolatedEnvironment();
    expect(env.CLAUDE_CONFIG_DIR).toBeDefined();
    expect(env.CLAUDE_CONFIG_DIR).toMatch(/CMM\/SubscriptionRouter\/Claude$/);
  });

  it("contains no ANTHROPIC_API_KEY", () => {
    // Poison parent environment
    process.env.ANTHROPIC_API_KEY = "dummy-key";

    const env = buildIsolatedEnvironment();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("contains no ANTHROPIC_BASE_URL", () => {
    // Poison parent environment
    process.env.ANTHROPIC_BASE_URL = "http://localhost:20128";

    const env = buildIsolatedEnvironment();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("contains no ANTHROPIC_AUTH_TOKEN", () => {
    // Poison parent environment
    process.env.ANTHROPIC_AUTH_TOKEN = "dummy-token";

    const env = buildIsolatedEnvironment();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("cannot inherit http://localhost:20128", () => {
    // Poison parent with OmniRoute URL
    process.env.ANTHROPIC_BASE_URL = "http://localhost:20128";

    const env = buildIsolatedEnvironment();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(Object.values(env)).not.toContain("http://localhost:20128");
  });

  it("does not inherit arbitrary parent Claude-related PAYG variables", () => {
    // Poison with various Anthropic env vars
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
    process.env.ANTHROPIC_AUTH_TOKEN = "test-token";
    process.env.ANTHROPIC_MODEL = "claude-3-opus";

    const env = buildIsolatedEnvironment();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
  });

  it("uses a neutral cwd (temp directory)", () => {
    const env = buildIsolatedEnvironment();
    expect(env.PWD).toBeDefined();
    expect(env.PWD).toMatch(tmpdir());
    // The isolated working directory must not be the Router checkout itself.
    // Asserted against the live repo root, not a brand-specific name, so
    // production behavior never depends on the repository's name.
    expect(env.PWD).not.toBe(process.cwd());
  });

  it("leaves normal process/environment unchanged", () => {
    const beforeKey = process.env.ANTHROPIC_API_KEY;
    const beforeUrl = process.env.ANTHROPIC_BASE_URL;

    buildIsolatedEnvironment();

    // Parent environment should be untouched
    expect(process.env.ANTHROPIC_API_KEY).toBe(beforeKey);
    expect(process.env.ANTHROPIC_BASE_URL).toBe(beforeUrl);
  });

  it("preserves safe environment variables", () => {
    process.env.PATH = "/usr/bin:/bin";
    process.env.HOME = "/Users/test";

    const env = buildIsolatedEnvironment();
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/Users/test");
  });
});
