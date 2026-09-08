import { describe, expect, it, beforeEach } from "vitest";
import type { ProviderAdapter, DiscoveredModel, ProviderHealth } from "../../src/core/provider.js";
import { RouterError } from "../../src/core/errors.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";

class FakeProvider implements ProviderAdapter {
  constructor(
    public readonly id: "chatgpt" | "claude",
    private models: DiscoveredModel[],
    private healthy = true,
  ) {}

  async discoverModels(): Promise<DiscoveredModel[]> {
    if (!this.healthy) {
      throw new Error("discovery failed");
    }
    return this.models;
  }

  async health(): Promise<ProviderHealth> {
    return this.healthy ? { status: "ready" } : { status: "unavailable" };
  }

  async *run() {
    yield { type: "error" as const, error: "not implemented" };
  }

  async cancel() {}
}

describe("ProviderRegistry", () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  it("resolves chatgpt/model-a only to ChatGPT provider", async () => {
    const chatgpt = new FakeProvider("chatgpt", [
      { id: "chatgpt/model-a", provider: "chatgpt", upstreamModel: "model-a", displayName: "Model A" },
    ]);
    await registry.register(chatgpt);

    const model = await registry.resolve("chatgpt/model-a");
    expect(model.id).toBe("chatgpt/model-a");
    expect(model.provider).toBe("chatgpt");
  });

  it("cannot resolve claude/model-a to ChatGPT even with name collision", async () => {
    const chatgpt = new FakeProvider("chatgpt", [
      { id: "chatgpt/model-a", provider: "chatgpt", upstreamModel: "model-a", displayName: "Model A" },
    ]);
    const claude = new FakeProvider("claude", [
      { id: "claude/model-a", provider: "claude", upstreamModel: "model-a", displayName: "Claude Model A" },
    ]);
    await registry.register(chatgpt);
    await registry.register(claude);

    const model = await registry.resolve("claude/model-a");
    expect(model.provider).toBe("claude");
  });

  it("returns unknown_provider for unknown prefix", async () => {
    await expect(registry.resolve("unknown/model")).rejects.toThrow(RouterError);
    await expect(registry.resolve("unknown/model")).rejects.toMatchObject({
      code: "unknown_provider",
    });
  });

  it("returns unknown_model for known provider with missing model", async () => {
    const chatgpt = new FakeProvider("chatgpt", [
      { id: "chatgpt/model-a", provider: "chatgpt", upstreamModel: "model-a", displayName: "Model A" },
    ]);
    await registry.register(chatgpt);

    await expect(registry.resolve("chatgpt/nonexistent")).rejects.toThrow(RouterError);
    await expect(registry.resolve("chatgpt/nonexistent")).rejects.toMatchObject({
      code: "unknown_model",
    });
  });

  it("does not erase healthy providers when one fails discovery", async () => {
    const chatgpt = new FakeProvider("chatgpt", [
      { id: "chatgpt/model-a", provider: "chatgpt", upstreamModel: "model-a", displayName: "Model A" },
    ]);
    const failing = new FakeProvider("claude", [], false);
    await registry.register(chatgpt);
    await registry.register(failing);

    await registry.refresh();

    const models = registry.listModels();
    expect(models.some((m) => m.provider === "chatgpt")).toBe(true);
  });

  it("has no fallback when resolution fails", async () => {
    const chatgpt = new FakeProvider("chatgpt", []);
    await registry.register(chatgpt);

    await expect(registry.resolve("chatgpt/missing")).rejects.toThrow(RouterError);
  });
});
