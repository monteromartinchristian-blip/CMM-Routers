import { describe, expect, it } from "vitest";
import type { VisibilityPreference } from "../../../src/usage/presentation/types.js";
import { VisibilityStore } from "../../../src/usage/presentation/visibility-store.js";

class MemoryLegacyRows {
  constructor(private readonly rows: readonly VisibilityPreference[]) {}

  async listVisibilityPreferences(
    scope?: VisibilityPreference["scope"],
  ): Promise<VisibilityPreference[]> {
    return this.rows
      .filter((row) => scope === undefined || row.scope === scope)
      .map((row) => ({ ...row }));
  }
}

const globalRoute = { scope: "global", routeId: "route:one", state: "hidden" } as const;
const workspaceRoute = {
  scope: "workspace:team-a",
  routeId: "route:one",
  state: "hidden",
} as const;
const globalProvider = { scope: "global", providerId: "provider:one", state: "visible" } as const;

describe("VisibilityStore", () => {
  it("reads every legacy row for migration, including non-global scopes", async () => {
    const visibility = new VisibilityStore(
      new MemoryLegacyRows([globalRoute, workspaceRoute, globalProvider]),
    );

    // The one-time migration must be able to see workspace-scoped rows so it
    // can report them as skipped instead of silently dropping them.
    expect(await visibility.list()).toEqual([globalRoute, workspaceRoute, globalProvider]);
  });

  it("still filters legacy rows by scope for history reads", async () => {
    const visibility = new VisibilityStore(
      new MemoryLegacyRows([globalRoute, workspaceRoute]),
    );

    expect(await visibility.list("workspace:team-a")).toEqual([workspaceRoute]);
  });

  it("no longer resolves effective visibility from legacy rows", async () => {
    const visibility = new VisibilityStore(new MemoryLegacyRows([globalRoute])) as unknown as
      Record<string, unknown>;

    expect(visibility.resolveRoute).toBeUndefined();
    expect(visibility.groupState).toBeUndefined();
  });

  it("no longer writes legacy visibility rows", async () => {
    const visibility = new VisibilityStore(new MemoryLegacyRows([])) as unknown as
      Record<string, unknown>;

    expect(visibility.set).toBeUndefined();
  });
});
