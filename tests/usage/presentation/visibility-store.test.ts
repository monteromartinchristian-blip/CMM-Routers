import { describe, expect, it } from "vitest";
import type { VisibilityPreference } from "../../../src/usage/presentation/types.js";
import { VisibilityStore } from "../../../src/usage/presentation/visibility-store.js";

class MemoryVisibilityRepository {
  private readonly values: VisibilityPreference[] = [];

  async listVisibilityPreferences(scope?: VisibilityPreference["scope"]): Promise<VisibilityPreference[]> {
    return this.values.filter((value) => scope === undefined || value.scope === scope);
  }

  async upsertVisibilityPreference(preference: VisibilityPreference): Promise<void> {
    const index = this.values.findIndex((value) =>
      value.scope === preference.scope
      && value.providerId === preference.providerId
      && value.productId === preference.productId
      && value.routeId === preference.routeId
    );
    if (index >= 0) this.values[index] = preference;
    else this.values.push(preference);
  }
}

const anthropicClaude = {
  providerId: "provider:anthropic",
  productId: "product:claude-subscription",
  routeId: "route:anthropic:claude-sonnet",
};

const openRouterClaude = {
  providerId: "provider:openrouter",
  productId: "product:openrouter",
  routeId: "route:openrouter:claude-sonnet",
};

describe("VisibilityStore", () => {
  it("hides one route without hiding a sibling route for the same conceptual model", async () => {
    const visibility = new VisibilityStore(new MemoryVisibilityRepository());
    await visibility.set({
      scope: "global",
      routeId: openRouterClaude.routeId,
      state: "hidden",
    });

    expect(await visibility.resolveRoute(openRouterClaude)).toBe("hidden");
    expect(await visibility.resolveRoute(anthropicClaude)).toBe("visible");
  });

  it("resolves product and provider defaults while allowing route overrides", async () => {
    const visibility = new VisibilityStore(new MemoryVisibilityRepository());
    await visibility.set({ scope: "global", providerId: "provider:openrouter", state: "hidden" });
    await visibility.set({
      scope: "global",
      providerId: "provider:openrouter",
      productId: "product:openrouter",
      state: "hidden",
    });
    await visibility.set({ scope: "global", routeId: openRouterClaude.routeId, state: "visible" });

    expect(await visibility.resolveRoute(openRouterClaude)).toBe("visible");
    expect(await visibility.resolveRoute({
      ...openRouterClaude,
      routeId: "route:openrouter:qwen",
    })).toBe("hidden");
  });

  it("reports mixed group state when only some routes are visible", async () => {
    const visibility = new VisibilityStore(new MemoryVisibilityRepository());
    await visibility.set({ scope: "global", routeId: openRouterClaude.routeId, state: "hidden" });

    expect(await visibility.groupState([openRouterClaude, anthropicClaude])).toBe("mixed");
  });

  it("keeps v1 writes global while preserving a future-ready scope type", async () => {
    const visibility = new VisibilityStore(new MemoryVisibilityRepository());

    await expect(visibility.set({
      scope: "workspace:future",
      routeId: openRouterClaude.routeId,
      state: "hidden",
    })).rejects.toThrow(/global/i);
  });
});
