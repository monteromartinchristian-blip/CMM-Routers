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

  // Remediation 2: Preserve provider discovery errors
  it("returns unknown_model when discovery succeeded but model is absent", async () => {
    const chatgpt = new FakeProvider("chatgpt", [
      { id: "chatgpt/model-a", provider: "chatgpt", upstreamModel: "model-a", displayName: "Model A" },
    ]);
    await registry.register(chatgpt);
    await registry.refresh();

    await expect(registry.resolve("chatgpt/nonexistent")).rejects.toMatchObject({
      code: "unknown_model",
    });
  });

  it("preserves provider_auth_required from discovery failure", async () => {
    class AuthRequiredProvider implements ProviderAdapter {
      readonly id = "chatgpt" as const;

      async discoverModels(): Promise<DiscoveredModel[]> {
        throw new RouterError("provider_auth_required", "Authentication required");
      }

      async health(): Promise<ProviderHealth> {
        return { status: "auth_required" };
      }

      async *run() {
        yield { type: "error" as const, error: "not implemented" };
      }

      async cancel() {}
    }

    const provider = new AuthRequiredProvider();
    await registry.register(provider);
    await registry.refresh();

    await expect(registry.resolve("chatgpt/model")).rejects.toMatchObject({
      code: "provider_auth_required",
    });
  });

  it("preserves provider_rate_limited from discovery failure", async () => {
    class RateLimitedProvider implements ProviderAdapter {
      readonly id = "claude" as const;

      async discoverModels(): Promise<DiscoveredModel[]> {
        throw new RouterError("provider_rate_limited", "Rate limited", { retryAfterMs: 5000 });
      }

      async health(): Promise<ProviderHealth> {
        return { status: "degraded" };
      }

      async *run() {
        yield { type: "error" as const, error: "not implemented" };
      }

      async cancel() {}
    }

    const provider = new RateLimitedProvider();
    await registry.register(provider);
    await registry.refresh();

    await expect(registry.resolve("claude/model")).rejects.toMatchObject({
      code: "provider_rate_limited",
    });
  });

  it("normalizes generic Error to provider_unavailable", async () => {
    class GenericErrorProvider implements ProviderAdapter {
      readonly id = "google" as const;

      async discoverModels(): Promise<DiscoveredModel[]> {
        throw new Error("Unexpected network error");
      }

      async health(): Promise<ProviderHealth> {
        return { status: "unavailable" };
      }

      async *run() {
        yield { type: "error" as const, error: "not implemented" };
      }

      async cancel() {}
    }

    const provider = new GenericErrorProvider();
    await registry.register(provider);
    await registry.refresh();

    await expect(registry.resolve("google/model")).rejects.toMatchObject({
      code: "provider_unavailable",
    });
  });

  it("does not call other providers when one fails", async () => {
    let claudeDiscoveryCalled = false;

    class FailingChatGPTProvider implements ProviderAdapter {
      readonly id = "chatgpt" as const;

      async discoverModels(): Promise<DiscoveredModel[]> {
        throw new RouterError("provider_auth_required", "Not authenticated");
      }

      async health(): Promise<ProviderHealth> {
        return { status: "auth_required" };
      }

      async *run() {
        yield { type: "error" as const, error: "not implemented" };
      }

      async cancel() {}
    }

    class ClaudeProvider implements ProviderAdapter {
      readonly id = "claude" as const;

      async discoverModels(): Promise<DiscoveredModel[]> {
        claudeDiscoveryCalled = true;
        return [];
      }

      async health(): Promise<ProviderHealth> {
        return { status: "ready" };
      }

      async *run() {
        yield { type: "error" as const, error: "not implemented" };
      }

      async cancel() {}
    }

    await registry.register(new FailingChatGPTProvider());
    await registry.register(new ClaudeProvider());
    await registry.refresh();

    // Claude should still be called even though ChatGPT failed
    expect(claudeDiscoveryCalled).toBe(true);

    // But resolving a ChatGPT model should fail with auth error, not unknown_model
    await expect(registry.resolve("chatgpt/model")).rejects.toMatchObject({
      code: "provider_auth_required",
    });
  });
});
