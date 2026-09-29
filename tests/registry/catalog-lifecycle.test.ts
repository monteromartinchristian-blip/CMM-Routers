import { describe, expect, it } from "vitest";
import type { ProviderAdapter, DiscoveredModel, ProviderHealth } from "../../src/core/provider.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";

/**
 * Source-aware catalog lifecycle.
 *
 * The behaviour under test is the one a provider outage must not be able to
 * break: a source that blips keeps its identity, an unrelated source is never
 * touched, and only a *confirmed* absence retires a model.
 */
class ScriptedProvider implements ProviderAdapter {
  constructor(
    public readonly id: "chatgpt" | "claude" | "google" | "command-code",
    private behaviour: () => Promise<DiscoveredModel[]>,
  ) {}

  async discoverModels(): Promise<DiscoveredModel[]> {
    return this.behaviour();
  }

  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }

  async *run() {
    yield { type: "error" as const, error: "not implemented" };
  }

  async cancel() {}
}

/**
 * A discovered model. The Router addresses a model by `"<providerId>/<name>"`,
 * so the id prefix is the provider that discovered it; on-device-ness is the
 * separate `locality` fact, never the id.
 */
function model(
  name: string,
  provider: "chatgpt" | "claude" | "google" | "command-code",
  locality: "local" | "cloud" = "cloud",
): DiscoveredModel {
  return {
    id: `${provider}/${name}`,
    provider,
    upstreamModel: name,
    displayName: name,
    locality,
  };
}

const CLOUD_A = model("gpt-5.5", "chatgpt");
const LOCAL_QWEN = model("qwen3-4b", "google", "local");
const LOCAL_QWEN_UNCENSORED = model("qwen3-4b-uncensored", "google", "local");

describe("ProviderRegistry catalog lifecycle", () => {
  it("ALL SOURCES HEALTHY — every source contributes its own models", async () => {
    const registry = new ProviderRegistry();
    await registry.register(new ScriptedProvider("chatgpt", async () => [CLOUD_A]));
    await registry.register(new ScriptedProvider("claude", async () => [model("sonnet", "claude")]));
    await registry.register(new ScriptedProvider("google", async () => [LOCAL_QWEN]));
    await registry.refresh();

    const ids = registry.listModels().map((m) => m.id).sort();
    expect(ids).toEqual(["chatgpt/gpt-5.5", "claude/sonnet", "google/qwen3-4b"]);
    expect(registry.listModels().every((m) => m.availability === "available")).toBe(true);
    expect(registry.listSources().map((s) => s.status)).toEqual([
      "available",
      "available",
      "available",
    ]);
  });

  it("ONE CLOUD SOURCE FAILS — the failing source is retained, the others are untouched", async () => {
    const registry = new ProviderRegistry();
    await registry.register(new ScriptedProvider("chatgpt", async () => [CLOUD_A]));
    let claudeDown = false;
    await registry.register(
      new ScriptedProvider("claude", async () => {
        if (claudeDown) throw new Error("upstream 503");
        return [model("sonnet", "claude")];
      }),
    );
    await registry.register(new ScriptedProvider("google", async () => [LOCAL_QWEN]));
    await registry.refresh();

    claudeDown = true;
    await registry.refresh();

    // The failing source keeps its identity instead of vanishing...
    const ids = registry.listModels().map((m) => m.id).sort();
    expect(ids).toContain("claude/sonnet");
    // ...but it is not presented as usable.
    const claude = registry.listModels().find((m) => m.id === "claude/sonnet");
    expect(claude?.availability).toBe("unavailable");
    // ...and the healthy sources are completely unaffected.
    expect(registry.listModels().find((m) => m.id === "chatgpt/gpt-5.5")?.availability).toBe("available");
    expect(registry.listModels().find((m) => m.id === "google/qwen3-4b")?.availability).toBe("available");

    const sources = registry.listSources();
    expect(sources.find((s) => s.providerId === "claude")?.status).toBe("unavailable");
    expect(sources.find((s) => s.providerId === "chatgpt")?.status).toBe("available");
  });

  it("LOCAL RUNTIME OFFLINE — installed local models stay listed, marked unavailable", async () => {
    const registry = new ProviderRegistry();
    let localUp = true;
    await registry.register(new ScriptedProvider("chatgpt", async () => [CLOUD_A]));
    await registry.register(
      new ScriptedProvider("google", async () => {
        if (!localUp) throw new Error("ECONNREFUSED");
        return [LOCAL_QWEN, LOCAL_QWEN_UNCENSORED];
      }),
    );
    await registry.refresh();
    expect(registry.listModels().filter((m) => m.locality === "local")).toHaveLength(2);

    localUp = false;
    await registry.refresh();

    const local = registry.listModels().filter((m) => m.locality === "local");
    expect(local).toHaveLength(2);
    expect(local.every((m) => m.availability === "unavailable")).toBe(true);
  });

  it("LOCAL RUNTIME RETURNS EMPTY TRANSIENTLY — one empty answer changes nothing", async () => {
    const registry = new ProviderRegistry();
    let empty = false;
    await registry.register(
      new ScriptedProvider("google", async () =>
        empty ? [] : [LOCAL_QWEN, LOCAL_QWEN_UNCENSORED],
      ),
    );
    await registry.refresh();

    empty = true;
    await registry.refresh();

    // A single empty answer is indistinguishable from a runtime still starting,
    // so the known catalog must survive it.
    const afterOneEmpty = registry.listModels().filter((m) => m.locality === "local");
    expect(afterOneEmpty).toHaveLength(2);
    expect(afterOneEmpty.every((m) => m.availability === "unavailable")).toBe(true);

    // Recovery restores availability.
    empty = false;
    await registry.refresh();
    expect(registry.listModels().filter((m) => m.availability === "available")).toHaveLength(2);
  });

  it("LOCAL RUNTIME RESTARTS — identity survives a down/up cycle across restarts", async () => {
    const registry = new ProviderRegistry();
    let localUp = true;
    const provider = new ScriptedProvider("google", async () => {
      if (!localUp) throw new Error("ECONNREFUSED");
      return [LOCAL_QWEN];
    });
    await registry.register(provider);
    await registry.refresh();
    localUp = false;
    await registry.refresh();
    localUp = true;
    await registry.refresh();

    expect(registry.listModels().find((m) => m.id === "google/qwen3-4b")?.availability).toBe("available");
  });

  it("ROUTER RESTART — a fresh registry re-discovers rather than inheriting state", async () => {
    const build = async () => {
      const registry = new ProviderRegistry();
      await registry.register(new ScriptedProvider("google", async () => [LOCAL_QWEN]));
      await registry.refresh();
      return registry;
    };
    const first = await build();
    const second = await build();
    expect(first.listModels().map((m) => m.id)).toEqual(second.listModels().map((m) => m.id));
    expect(second.listSources()[0]?.status).toBe("available");
  });

  it("MODEL REMOVED FOR REAL — a confirmed absence retires the descriptor", async () => {
    const registry = new ProviderRegistry();
    let present = true;
    await registry.register(
      new ScriptedProvider("google", async () => (present ? [LOCAL_QWEN] : [])),
    );
    await registry.refresh();
    expect(registry.listModels()).toHaveLength(1);

    present = false;
    await registry.refresh();
    await registry.refresh(); // second consecutive empty answer confirms the removal

    expect(registry.listModels()).toHaveLength(0);
    expect(registry.listSources()[0]?.status).toBe("unavailable");
  });

  it("MODEL REAPPEARS — a confirmed removal is reversed when the model returns", async () => {
    const registry = new ProviderRegistry();
    let present = true;
    await registry.register(
      new ScriptedProvider("google", async () => (present ? [LOCAL_QWEN] : [])),
    );
    await registry.refresh();
    present = false;
    await registry.refresh();
    await registry.refresh();
    expect(registry.listModels()).toHaveLength(0);

    present = true;
    await registry.refresh();
    expect(registry.listModels().map((m) => m.id)).toEqual(["google/qwen3-4b"]);
    expect(registry.listModels()[0]?.availability).toBe("available");
  });

  it("MODEL SWITCH LOCAL -> CLOUD -> LOCAL — the selection stays resolvable at every hop", async () => {
    const registry = new ProviderRegistry();
    await registry.register(new ScriptedProvider("google", async () => [LOCAL_QWEN]));
    await registry.register(new ScriptedProvider("chatgpt", async () => [CLOUD_A]));
    await registry.refresh();

    expect((await registry.resolve("google/qwen3-4b")).id).toBe("google/qwen3-4b");
    expect((await registry.resolve("chatgpt/gpt-5.5")).id).toBe("chatgpt/gpt-5.5");
    expect((await registry.resolve("google/qwen3-4b")).id).toBe("google/qwen3-4b");
  });

  it("a model a source never advertised is still an honest error", async () => {
    const registry = new ProviderRegistry();
    await registry.register(new ScriptedProvider("google", async () => [LOCAL_QWEN]));
    await registry.refresh();
    await expect(registry.resolve("google/never-existed")).rejects.toMatchObject({
      code: "unknown_model",
    });
  });

  it("a retained model still resolves while its source is failing", async () => {
    const registry = new ProviderRegistry();
    let up = true;
    await registry.register(
      new ScriptedProvider("google", async () => {
        if (!up) throw new Error("ECONNREFUSED");
        return [LOCAL_QWEN];
      }),
    );
    await registry.refresh();
    up = false;
    await registry.refresh();

    // The listing could not be refreshed; the route itself is a separate
    // question and must not be answered "gone".
    const resolved = await registry.resolve("google/qwen3-4b");
    expect(resolved.availability).toBe("unavailable");
  });
});
