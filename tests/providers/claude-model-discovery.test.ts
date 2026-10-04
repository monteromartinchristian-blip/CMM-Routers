import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { queryMock, startupMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  startupMock: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
  startup: startupMock,
  resolveSettings: vi.fn(),
}));

import { ClaudeAdapter } from "../../src/providers/claude/adapter.js";

const ADAPTER_SOURCE_PATH = join(import.meta.dirname, "../../src/providers/claude/adapter.ts");

function makeQueryMock(
  modelInfos: Partial<{ value: string; displayName: string; resolvedModel: string; description: string }>[],
  onSupportedModels?: () => void,
) {
  return {
    supportedModels: vi.fn().mockImplementation(() => {
      onSupportedModels?.();
      return Promise.resolve(modelInfos);
    }),
    interrupt: vi.fn().mockResolvedValue(undefined),
    [Symbol.asyncIterator]: vi.fn(),
  };
}

describe("Claude Model Discovery", () => {
  let adapter: ClaudeAdapter;

  beforeEach(() => {
    adapter = new ClaudeAdapter();
    // These tests are about what discovery reads out of supportedModels(), so
    // the profile must not also report itself authenticated. A bare vi.fn()
    // startup resolves to undefined, which health() reads as "ready", and
    // discoverModels() then folds the eleven-row account catalog into the
    // result -- so the assertions below were measuring the catalog, not
    // discovery. An unauthenticated profile is stated explicitly here.
    startupMock.mockRejectedValue(new Error("no subscription in this test profile"));
  });

  it("proves no static Claude catalog exists in adapter", () => {
    const adapterSource = readFileSync(ADAPTER_SOURCE_PATH, "utf-8");

    // No hardcoded model IDs may appear anywhere in the adapter
    expect(adapterSource).not.toContain("claude-sonnet-4");
    expect(adapterSource).not.toContain("claude-opus-4");
    expect(adapterSource).not.toContain("claude-haiku-4");
    expect(adapterSource).not.toContain('"sonnet-4"');
    expect(adapterSource).not.toContain('"opus-4"');
    expect(adapterSource).not.toContain('"haiku-4"');
    expect(adapterSource).not.toContain("claude/sonnet-4");
    expect(adapterSource).not.toContain("claude/opus-4");
    expect(adapterSource).not.toContain("claude/haiku-4");
  });

  it("uses query.supportedModels() for discovery", async () => {
    const mockQuery = makeQueryMock([
      { value: "sonnet", displayName: "Claude Sonnet", resolvedModel: "claude-sonnet-5" },
      { value: "opus", displayName: "Claude Opus", resolvedModel: "claude-opus-5" },
    ]);
    queryMock.mockReturnValue(mockQuery as any);

    const models = await adapter.discoverModels();

    expect(queryMock).toHaveBeenCalled();
    expect(mockQuery.supportedModels).toHaveBeenCalled();
    expect(mockQuery.interrupt).toHaveBeenCalled();

    // Since 31e48d7 ("Publish concrete Claude models, not only routing
    // aliases") each quick-select entry that resolves to a concrete model
    // publishes TWO rows: the concrete model, which is the identity a user
    // selects, and the alias, which stays routable but is flagged so a client
    // never offers `sonnet` as a model of its own. This assertion used to
    // expect one row per entry and was written before that transition.
    expect(models.length).toBe(4);
    expect(models.filter((row) => row.isAlias !== true).map((row) => row.id)).toEqual([
      "claude/claude-sonnet-5",
      "claude/claude-opus-5",
    ]);
    expect(models.filter((row) => row.isAlias === true).map((row) => row.id)).toEqual([
      "claude/sonnet",
      "claude/opus",
    ]);
  });

  it("namespaces models as claude/*", async () => {
    const mockQuery = makeQueryMock([
      { value: "sonnet", displayName: "Sonnet" },
      { value: "haiku", displayName: "Haiku" },
    ]);
    queryMock.mockReturnValue(mockQuery as any);

    const models = await adapter.discoverModels();

    for (const model of models) {
      expect(model.id).toMatch(/^claude\//);
      expect(model.provider).toBe("claude");
    }
  });

  it("deduplicates by upstream model value", async () => {
    const mockQuery = makeQueryMock([
      { value: "sonnet", displayName: "Sonnet" },
      { value: "sonnet", displayName: "Sonnet Duplicate" },
      { value: "opus", displayName: "Opus" },
    ]);
    queryMock.mockReturnValue(mockQuery as any);

    const models = await adapter.discoverModels();

    expect(models.length).toBe(2);
    const ids = models.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("fails closed on empty discovery", async () => {
    const mockQuery = makeQueryMock([]);
    queryMock.mockReturnValue(mockQuery as any);

    await expect(adapter.discoverModels()).rejects.toThrow("SDK returned no supported models");
  });

  it("never fabricates unsupported models", async () => {
    const mockQuery = makeQueryMock([
      { value: "custom-model", displayName: "Custom" },
    ]);
    queryMock.mockReturnValue(mockQuery as any);

    const models = await adapter.discoverModels();

    expect(models.length).toBe(1);
    expect(models[0]!.upstreamModel).toBe("custom-model");
    // Should NOT add hardcoded models
    expect(models.find((m) => m.upstreamModel === "claude-sonnet-4")).toBeUndefined();
  });

  it("uses isolated SDK environment", async () => {
    const mockQuery = makeQueryMock([{ value: "sonnet", displayName: "Sonnet" }]);
    queryMock.mockReturnValue(mockQuery as any);

    await adapter.discoverModels();

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          cwd: expect.stringContaining("cmm-claude-neutral"),
          disallowedTools: expect.arrayContaining(["Bash", "Read", "Write"]),
          permissionMode: "auto",
        }),
      })
    );
  });

  it("ensures PAYG variables never reach the SDK subprocess env", async () => {
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
    const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;

    try {
      // Poison the parent environment: the adapter must NOT mutate it and
      // must NOT forward these into options.env for the SDK subprocess.
      process.env.ANTHROPIC_API_KEY = "test-key";
      process.env.ANTHROPIC_BASE_URL = "http://localhost:9999";
      process.env.ANTHROPIC_AUTH_TOKEN = "test-token";

      const mockQuery = makeQueryMock([{ value: "sonnet", displayName: "Sonnet" }]);
      queryMock.mockReturnValue(mockQuery as any);

      await adapter.discoverModels();

      // Parent env untouched (no global mutation).
      expect(process.env.ANTHROPIC_API_KEY).toBe("test-key");
      // SDK subprocess env carries none of the poisoned variables.
      const passedOptions = queryMock.mock.calls[0]?.[0]?.options as
        | Record<string, unknown>
        | undefined;
      const passedEnv = passedOptions?.env as Record<string, unknown> | undefined;
      expect(passedEnv).toBeDefined();
      expect(passedEnv?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(passedEnv?.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(passedEnv?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    } finally {
      // Restore
      if (originalApiKey !== undefined) process.env.ANTHROPIC_API_KEY = originalApiKey;
      else delete process.env.ANTHROPIC_API_KEY;

      if (originalBaseUrl !== undefined) process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
      else delete process.env.ANTHROPIC_BASE_URL;

      if (originalAuthToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = originalAuthToken;
      else delete process.env.ANTHROPIC_AUTH_TOKEN;
    }
  });

  it("names a model from its own id, falling back to the SDK label", async () => {
    // Since 31e48d7 the display name is composed from the upstream's own id
    // ("family plus declared version") rather than taken from the SDK's
    // displayName, which is only a fallback for an id that names no family.
    // This test used to assert the SDK label won, and was written before that
    // transition.
    const mockQuery = makeQueryMock([
      { value: "sonnet", displayName: "SDK label for sonnet", resolvedModel: "claude-sonnet-5" },
      { value: "cline-pass/deepseek-v4-flash", displayName: "Cline Pass" },
    ]);
    queryMock.mockReturnValue(mockQuery as any);

    const models = await adapter.discoverModels();

    // Composed from the id: family plus declared version.
    const sonnet = models.find((row) => row.upstreamModel === "claude-sonnet-5");
    expect(sonnet?.displayName).toBe("Sonnet 5");
    // No family is derivable from this id, so the SDK's own label is used
    // rather than a name the Router would have had to invent.
    const cline = models.find((row) => row.upstreamModel === "cline-pass/deepseek-v4-flash");
    expect(cline?.displayName).toBe("Cline Pass");
  });

  it("gives the concrete model first and never invents a dated id", async () => {
    const mockQuery = makeQueryMock([
      { value: "sonnet", displayName: "Sonnet", resolvedModel: "claude-sonnet-5" },
    ]);
    queryMock.mockReturnValue(mockQuery as any);

    const models = await adapter.discoverModels();

    // Since 31e48d7 the concrete row is published first, because it is the
    // identity a user selects; the alias follows as routing metadata. This
    // test used to assert the alias row came first, and was written before
    // that transition. The point of the test is unchanged: nothing here may
    // become a guessed dated id.
    expect(models[0]!.id).toBe("claude/claude-sonnet-5");
    expect(models[0]!.upstreamModel).toBe("claude-sonnet-5");
    expect(models[0]!.isAlias).not.toBe(true);

    // The alias is still routable, still spelled as the alias, and flagged.
    const alias = models.find((row) => row.isAlias === true);
    expect(alias?.id).toBe("claude/sonnet");
    expect(alias?.upstreamModel).toBe("sonnet");

    // No row may carry an id the upstream never declared.
    for (const row of models) {
      expect(row.id).not.toMatch(/\d{8}/);
    }
  });
});
