import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { queryMock, startupMock, resolveSettingsMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  startupMock: vi.fn(),
  resolveSettingsMock: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
  startup: startupMock,
  resolveSettings: resolveSettingsMock,
}));

import { ClaudeAdapter } from "../../src/providers/claude/adapter.js";

describe("Claude runtime profileDir and health isolation", () => {
  beforeEach(() => {
    queryMock.mockReset();
    startupMock.mockReset();
    resolveSettingsMock.mockReset();
  });

  it("wires a runtime profileDir into the actual SDK invocation env", async () => {
    // Import order matters: modules are already imported above, BEFORE we
    // construct config — proving no import-time capture is in play.
    const profileDir = mkdtempSync(join(tmpdir(), "cmm-router-profile-"));
    queryMock.mockReturnValue({
      supportedModels: vi.fn().mockResolvedValue([{ value: "sonnet", displayName: "Sonnet" }]),
      interrupt: vi.fn().mockResolvedValue(undefined),
      [Symbol.asyncIterator]: () => (async function* () {})(),
    });
    const adapter = new ClaudeAdapter({ profileDir });
    await adapter.discoverModels();
    const passedOptions = queryMock.mock.calls[0]?.[0]?.options as
      | Record<string, unknown>
      | undefined;
    const passedEnv = passedOptions?.env as Record<string, unknown> | undefined;
    expect(passedEnv?.CLAUDE_CONFIG_DIR).toBe(profileDir);
    expect(passedOptions?.settingSources).toEqual([]);
    console.log("CLAUDE_PROFILE_DIR_RUNTIME_WIRING=PASS");
  });

  it("health ignores a poisoned normal profile and follows the router profile", async () => {
    // Normal user settings claim a third-party provider; the isolated
    // startup probe is what decides. First call: isolated startup succeeds
    // even though a normal profile would look foreign.
    resolveSettingsMock.mockResolvedValue({
      effective: { apiProvider: "third-party-poison" },
      provenance: {},
      perSource: {},
    });
    startupMock.mockResolvedValue({});
    const adapter = new ClaudeAdapter();
    const health = await adapter.health();
    expect(health.status).toBe("ready");
    // resolveSettings must have been called with filesystem sources disabled.
    expect(resolveSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({ settingSources: [] }),
    );
    // startup must carry the same isolation.
    const startupOptions = startupMock.mock.calls[0]?.[0]?.options as
      | Record<string, unknown>
      | undefined;
    expect(startupOptions?.settingSources).toEqual([]);
    expect(startupOptions?.env).toBeDefined();
    console.log("CLAUDE_HEALTH_PROFILE_ISOLATION=PASS");
  });

  it("health surfaces auth_required when the isolated probe fails auth", async () => {
    resolveSettingsMock.mockResolvedValue({
      effective: { apiProvider: "firstParty" },
      provenance: {},
      perSource: {},
    });
    startupMock.mockRejectedValue(new Error("not logged in, run login"));
    const adapter = new ClaudeAdapter();
    const health = await adapter.health();
    expect(health.status).toBe("auth_required");
  });
});
