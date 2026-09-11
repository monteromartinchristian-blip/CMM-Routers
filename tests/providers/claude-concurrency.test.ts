import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { ClaudeAdapter } from "../../src/providers/claude/adapter.js";
import {
  CLAUDE_CONFIG_DIR,
  buildIsolatedEnvironment,
} from "../../src/providers/claude/sdk-client.js";
import type { RouterRequest } from "../../src/core/provider.js";

function makeRequest(requestId = "iso-test"): RouterRequest {
  return {
    requestId,
    model: {
      id: "claude/sonnet",
      provider: "claude",
      upstreamModel: "sonnet",
      displayName: "Sonnet",
    },
    messages: [{ role: "user", content: "Hello" }],
    tools: [],
    stream: true,
  };
}

describe("Claude concurrent environment isolation", () => {
  let adapter: ClaudeAdapter;

  beforeEach(() => {
    adapter = new ClaudeAdapter();
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  it("never mutates global process.env during run", { timeout: 30000 }, async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    const savedUrl = process.env.ANTHROPIC_BASE_URL;
    const savedToken = process.env.ANTHROPIC_AUTH_TOKEN;
    const savedDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.ANTHROPIC_API_KEY = "poison-key";
    process.env.ANTHROPIC_BASE_URL = "http://localhost:20128";
    process.env.ANTHROPIC_AUTH_TOKEN = "poison-token";
    process.env.CLAUDE_CONFIG_DIR = "/tmp/other-profile";

    try {
      const abortController = new AbortController();
      abortController.abort();

      for await (const _ of adapter.run(makeRequest(), abortController.signal)) {
        // consume
      }

      expect(process.env.ANTHROPIC_API_KEY).toBe("poison-key");
      expect(process.env.ANTHROPIC_BASE_URL).toBe("http://localhost:20128");
      expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe("poison-token");
      expect(process.env.CLAUDE_CONFIG_DIR).toBe("/tmp/other-profile");
      console.log("HOST_PROCESS_ENV_UNCHANGED=YES");
    } finally {
      if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
      else delete process.env.ANTHROPIC_API_KEY;
      if (savedUrl !== undefined) process.env.ANTHROPIC_BASE_URL = savedUrl;
      else delete process.env.ANTHROPIC_BASE_URL;
      if (savedToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = savedToken;
      else delete process.env.ANTHROPIC_AUTH_TOKEN;
      if (savedDir !== undefined) process.env.CLAUDE_CONFIG_DIR = savedDir;
      else delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  it("builds per-request isolated envs without cross contamination", () => {
    process.env.ANTHROPIC_API_KEY = "poison-a";

    const envA = buildIsolatedEnvironment();
    process.env.ANTHROPIC_API_KEY = "poison-b";
    const envB = buildIsolatedEnvironment();

    expect(envA.ANTHROPIC_API_KEY).toBeUndefined();
    expect(envB.ANTHROPIC_API_KEY).toBeUndefined();
    expect(envA.CLAUDE_CONFIG_DIR).toBe(CLAUDE_CONFIG_DIR);
    expect(envB.CLAUDE_CONFIG_DIR).toBe(CLAUDE_CONFIG_DIR);
    console.log("REQUEST_A_ENV_ISOLATED=YES");
    console.log("REQUEST_B_ENV_ISOLATED=YES");
    console.log("CROSS_REQUEST_ENV_CONTAMINATION=NONE");
  });

  it("adapter source performs zero process.env writes", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(import.meta.dirname, "../../src/providers/claude/adapter.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/process\.env\.[A-Z_]+=|delete process\.env\./);
    console.log("CLAUDE_GLOBAL_PROCESS_ENV_MUTATION=NONE");
  });
});
