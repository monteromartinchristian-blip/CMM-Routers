import type { VisibilityPreference } from "./types.js";

/**
 * Read-only access to the legacy Usage `visibility_preferences` rows.
 *
 * Deliberately narrower than the storage repository: this phase of the
 * migration may only *read* the legacy table, never write it. Router
 * administration is the single writable visibility authority.
 */
export interface LegacyVisibilityPreferenceReader {
  listVisibilityPreferences(
    scope?: VisibilityPreference["scope"],
  ): Promise<VisibilityPreference[]>;
}

/**
 * Legacy Usage visibility preferences, now migration/history read-only.
 *
 * `visibility_preferences` was the effective route-visibility authority before
 * the Router authority migration. It no longer is:
 *
 * - Router owns effective visibility; `PresentationCatalogService` reads it
 *   from the Router projection, and the `/v1/cmm/usage/catalog/visibility`
 *   compatibility read derives its state from Router `visibleOn`.
 * - Visibility mutations go only through `RouterAdministrationService`; the
 *   compatibility mutation surface delegates to it.
 *
 * What remains here is the legacy row *record*: the one-time
 * `migrateLegacyVisibility` reader consumes `list()`, and historical reads may
 * still scope-filter it. The effective-visibility resolver and the preference
 * writer were removed with the authority, so no current route rendering or
 * mutation can depend on this store — that is enforced by the type, not by
 * convention.
 */
export class VisibilityStore {
  constructor(private readonly repository: LegacyVisibilityPreferenceReader) {}

  /**
   * Lists legacy rows. Unscoped by default, so the one-time migration sees
   * every row — including the workspace-scoped rows it must report as skipped
   * rather than silently drop.
   */
  async list(scope?: VisibilityPreference["scope"]): Promise<VisibilityPreference[]> {
    return this.repository.listVisibilityPreferences(scope);
  }
}
