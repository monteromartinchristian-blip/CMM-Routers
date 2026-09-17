import type {
  AccessRouteSummary,
  RouterCatalogProjection,
} from "../../catalog/projection.js";
import type { RouterAdministrationService } from "../../catalog/router-administration-service.js";
import type { RouteSurface } from "../../catalog/types.js";
import type { VisibilityPreference } from "../presentation/types.js";
import type { VisibilityStore } from "../presentation/visibility-store.js";

/**
 * Outcome of the one-time legacy visibility migration.
 *
 * The three buckets are deliberately separate so an operator can tell
 * "nothing needed doing" from "the legacy row was unrepresentable":
 *
 * - `migratedRouteIds` — route ids whose Router effective visibility now
 *   honours the legacy route-scoped preference. A route appears here when the
 *   migration narrowed Router visibility to match a legacy `hidden` row, and
 *   also when Router already agreed so no write was needed. It is a route-id
 *   list, and it is idempotent: a second run reports the same ids.
 * - `skippedAmbiguous` — legacy rows that cannot be represented in current
 *   Router semantics without guessing or broadening. Entries are stable
 *   selector keys describing the *legacy row* (for example
 *   `global provider=provider:openrouter` or `workspace:team-a route=route:x`),
 *   not route ids: a provider/product/workspace-scoped row has no single route
 *   to name.
 * - `skippedUnknown` — route ids named by a legacy row that no longer exist in
 *   the current Router catalog. Router state is never created for them.
 */
export interface LegacyVisibilityMigrationResult {
  migratedRouteIds: string[];
  skippedAmbiguous: string[];
  skippedUnknown: string[];
}

/**
 * Stable, human-readable identifier of a legacy visibility row.
 *
 * Used for skip reporting so a row that cannot be migrated can be found in
 * `visibility_preferences` again. It is never used as a Router identifier.
 */
function legacyRowKey(preference: VisibilityPreference): string {
  const qualifiers = [
    preference.providerId === undefined ? undefined : `provider=${preference.providerId}`,
    preference.productId === undefined ? undefined : `product=${preference.productId}`,
    preference.routeId === undefined ? undefined : `route=${preference.routeId}`,
  ].filter((value): value is string => value !== undefined);
  return qualifiers.length === 0
    ? preference.scope
    : `${preference.scope} ${qualifiers.join(" ")}`;
}

function sameSurfaces(
  left: readonly RouteSurface[],
  right: readonly RouteSurface[],
): boolean {
  return left.length === right.length && left.every((surface) => right.includes(surface));
}

function isConsumerSurface(surface: RouteSurface): boolean {
  return surface !== "admin_console";
}

interface CandidateRow {
  key: string;
  preference: VisibilityPreference;
  route: AccessRouteSummary;
}

/**
 * One-time, fail-closed migration of legacy Usage visibility preferences into
 * the canonical Router visibility authority.
 *
 * Rules (design §8):
 *
 * 1. Only an exact route-scoped row that resolves to exactly one current
 *    Router route may mutate Router visibility. Provider-, product- and
 *    workspace-scoped rows, `inherit` rows, self-contradictory rows, unknown
 *    routes and routes claimed by more than one legacy row all fail closed and
 *    are reported instead of guessed.
 * 2. Migration never broadens visibility. The only Router write it performs is
 *    narrowing: a legacy `hidden` row reduces the route to its
 *    `admin_console` surface (never adding a surface). A legacy `visible` row
 *    is never applied over a route Router currently hides, because that would
 *    expose a route the Router authority deliberately withheld.
 * 3. Router is authoritative, so a legacy `visible` row is not a mutation at
 *    all: it is only reported when Router already exposes the route.
 * 4. Legacy rows are never deleted or rewritten, so the migration is safe to
 *    re-run and the historical record survives.
 *
 * The projection is read once by the caller and never re-read here, so the
 * migration cannot observe a partially migrated graph.
 */
export async function migrateLegacyVisibility(
  legacy: Pick<VisibilityStore, "list">,
  catalog: RouterCatalogProjection,
  admin: Pick<RouterAdministrationService, "setRouteVisibility">,
): Promise<LegacyVisibilityMigrationResult> {
  const routesById = new Map<string, AccessRouteSummary>();
  const duplicatedRouteIds = new Set<string>();
  for (const route of catalog.routes) {
    if (routesById.has(route.routeId)) duplicatedRouteIds.add(route.routeId);
    routesById.set(route.routeId, route);
  }
  const productIdByConnection = new Map(
    catalog.connections.map((connection) => [connection.connectionId, connection.productId] as const),
  );

  const rows = (await legacy.list())
    .slice()
    .sort((left, right) => legacyRowKey(left).localeCompare(legacyRowKey(right)));

  const skippedAmbiguous: string[] = [];
  const skippedUnknown: string[] = [];
  const candidatesByRouteId = new Map<string, CandidateRow[]>();

  for (const preference of rows) {
    const key = legacyRowKey(preference);
    // `inherit` is a Usage-scope fall-through with no Router analogue. Mapping
    // it onto a Router rule would silently pin a default over whatever the
    // Router authority (including a previously migrated rule) already holds.
    if (preference.state === "inherit") {
      skippedAmbiguous.push(key);
      continue;
    }
    // Router visibility has no workspace/tenant surface: promoting a
    // workspace-scoped preference would invent global semantics.
    if (preference.scope !== "global") {
      skippedAmbiguous.push(key);
      continue;
    }
    const routeId = preference.routeId;
    // A row that does not name an exact route matches many routes, and Router
    // visibility belongs to the exact AccessRoute.
    if (routeId === undefined) {
      skippedAmbiguous.push(key);
      continue;
    }
    const route = routesById.get(routeId);
    if (route === undefined || duplicatedRouteIds.has(routeId)) {
      if (route === undefined) skippedUnknown.push(routeId);
      else skippedAmbiguous.push(key);
      continue;
    }
    // A route-scoped row that contradicts the route it names is not
    // interpretable, so it is never applied.
    if (preference.providerId !== undefined && preference.providerId !== route.providerId) {
      skippedAmbiguous.push(key);
      continue;
    }
    if (
      preference.productId !== undefined &&
      preference.productId !== productIdByConnection.get(route.connectionId)
    ) {
      skippedAmbiguous.push(key);
      continue;
    }
    const candidates = candidatesByRouteId.get(routeId) ?? [];
    candidates.push({ key, preference, route });
    candidatesByRouteId.set(routeId, candidates);
  }

  const migratedRouteIds: string[] = [];
  for (const [routeId, candidates] of candidatesByRouteId) {
    // More than one legacy row resolves to this route, so which one expresses
    // the operator's intent is not knowable. Nothing is promoted.
    if (candidates.length !== 1) {
      for (const candidate of candidates) skippedAmbiguous.push(candidate.key);
      continue;
    }
    const candidate = candidates[0]!;
    const current = [...candidate.route.visibility.visibleOn];

    if (candidate.preference.state === "hidden") {
      // Narrow to the minimum hidden state, intersected with what the route
      // currently exposes: no surface is ever added.
      const target = current.filter((surface) => surface === "admin_console");
      if (!sameSurfaces(target, current)) {
        await admin.setRouteVisibility(routeId, target);
      }
      migratedRouteIds.push(routeId);
      continue;
    }

    // A legacy `visible` row can never be the reason Router exposes a route it
    // currently hides: applying it would broaden visibility.
    if (current.some(isConsumerSurface)) {
      migratedRouteIds.push(routeId);
      continue;
    }
    skippedAmbiguous.push(candidate.key);
  }

  return {
    migratedRouteIds: migratedRouteIds.sort(),
    skippedAmbiguous: [...new Set(skippedAmbiguous)].sort(),
    skippedUnknown: [...new Set(skippedUnknown)].sort(),
  };
}
