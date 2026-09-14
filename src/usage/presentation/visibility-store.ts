import type { VisibilityPreference } from "./types.js";

export interface VisibilityTarget {
  providerId: string;
  productId: string;
  routeId: string;
}

export interface VisibilityPreferenceRepository {
  listVisibilityPreferences(scope?: VisibilityPreference["scope"]): Promise<VisibilityPreference[]>;
  upsertVisibilityPreference(preference: VisibilityPreference): Promise<void>;
}

export type ResolvedVisibility = "visible" | "hidden";
export type VisibilityGroupState = ResolvedVisibility | "mixed";

function matches(preference: VisibilityPreference, target: VisibilityTarget): boolean {
  if (preference.providerId !== undefined && preference.providerId !== target.providerId) return false;
  if (preference.productId !== undefined && preference.productId !== target.productId) return false;
  if (preference.routeId !== undefined && preference.routeId !== target.routeId) return false;
  return true;
}

function specificity(preference: VisibilityPreference): number {
  return Number(preference.providerId !== undefined)
    + Number(preference.productId !== undefined) * 2
    + Number(preference.routeId !== undefined) * 4;
}

export class VisibilityStore {
  constructor(private readonly repository: VisibilityPreferenceRepository) {}

  async set(preference: VisibilityPreference): Promise<void> {
    if (preference.scope !== "global") {
      throw new Error("CMM Usage v1 writes only global visibility preferences");
    }
    await this.repository.upsertVisibilityPreference(preference);
  }

  async list(): Promise<VisibilityPreference[]> {
    return this.repository.listVisibilityPreferences("global");
  }

  async resolveRoute(
    target: VisibilityTarget,
    workspaceId?: string,
  ): Promise<ResolvedVisibility> {
    const scopes: VisibilityPreference["scope"][] = workspaceId === undefined
      ? ["global"]
      : [`workspace:${workspaceId}`, "global"];

    for (const scope of scopes) {
      const candidates = (await this.repository.listVisibilityPreferences(scope))
        .filter((preference) => matches(preference, target))
        .sort((left, right) => specificity(right) - specificity(left));

      for (const preference of candidates) {
        if (preference.state === "inherit") continue;
        return preference.state;
      }
    }
    return "visible";
  }

  async groupState(targets: readonly VisibilityTarget[]): Promise<VisibilityGroupState> {
    if (targets.length === 0) return "visible";
    const states = await Promise.all(targets.map((target) => this.resolveRoute(target)));
    if (states.every((state) => state === "visible")) return "visible";
    if (states.every((state) => state === "hidden")) return "hidden";
    return "mixed";
  }
}
