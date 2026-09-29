import type { FastifyInstance } from "fastify";
import {
  buildRouterCatalogProjection,
  type Listable,
  type RouterCatalogProjectionInput,
} from "../catalog/projection.js";
import type { ModelIdentity, ProviderDefinition } from "../catalog/types.js";
import type { ProviderRegistry } from "../registry/provider-registry.js";
import type { DiscoveredModel } from "../core/model.js";

/**
 * `GET /v1/cmm/catalog` — the read-only Router catalog projection.
 *
 * This file is the *read path only*, extracted from
 * `origin/feature/cmm-usage` `src/http/catalog.ts`. That module also owns
 * `registerRouterAdministration`: the `POST /v1/cmm/catalog/connections`,
 * `POST /v1/cmm/catalog/custom-endpoints`, `PATCH/DELETE
 * /v1/cmm/catalog/connections/:id`, `.../validate`, `.../refresh` and `PATCH
 * /v1/cmm/catalog/routes/:id/visibility` mutations plus their privileged bearer.
 * None of that is ported here, and none of it is reachable on this branch: the
 * read is registered on its own, with no administration token and no
 * administration service to delegate to.
 */

/**
 * The provider inventory this branch can actually state.
 *
 * `displayName` echoes the provider id because the provider display names are
 * owned by `origin/feature/cmm-usage` `src/providers/manifests.ts`, which is not
 * ported — inventing a label here would create the second provider inventory the
 * manifest design explicitly forbids. `adapterKind` is the registry key, which
 * on this branch *is* the adapter implementation. The connection kinds and
 * discovery capabilities are declared as none, because this branch has no
 * connection authority to declare them from.
 */
function catalogDirectory(registry: ProviderRegistry): Listable<ProviderDefinition> {
  return {
    list: () =>
      registry.listProviderIds().map(
        (providerId): ProviderDefinition => ({
          providerId,
          displayName: providerId,
          adapterKind: providerId,
          supportedConnectionKinds: [],
          discoveryCapabilities: [],
        }),
      ),
  };
}

function modelAliases(model: DiscoveredModel): string[] {
  return [...new Set([model.id, model.upstreamModel])];
}

/**
 * Model identities from the registry's own discovery results.
 *
 * `modelIdentityId` is this branch's model id (`"<provider>/<model>"`) — the
 * same key `GET /v1/models` publishes and `ProviderRegistry.resolve()` routes
 * on, so every entry is a model this Router can actually serve. It is NOT the
 * canonical `model_<hash>` identity issued by `catalog/ids.ts` on the source
 * branch; when that store is ported this projection must switch to it so
 * consumers never see two identity spaces.
 *
 * Keyed by id so a provider that reports a foreign-prefixed model cannot make
 * the projection ambiguous.
 *
 * `family` carries the upstream's own version/family declaration. It is omitted
 * when the upstream declared none, which is the truthful state for a rolling
 * alias such as `claude/sonnet`; it is never derived from the id.
 */
function catalogModelIdentities(registry: ProviderRegistry): Listable<ModelIdentity> {
  return {
    list: () => {
      const byIdentityId = new Map<string, ModelIdentity>();
      for (const model of registry.listModels()) {
        if (byIdentityId.has(model.id)) continue;
        byIdentityId.set(
          model.id,
          model.version !== undefined
            ? {
                modelIdentityId: model.id,
                canonicalName: model.displayName,
                family: model.version,
                aliases: modelAliases(model),
              }
            : {
                modelIdentityId: model.id,
                canonicalName: model.displayName,
                aliases: modelAliases(model),
              },
        );
      }
      return [...byIdentityId.values()];
    },
  };
}

function emptyCollection<T>(): Listable<T> {
  return { list: () => [] };
}

/**
 * The catalog projection input for this branch's runtime.
 *
 * Only the sections with a real source of truth here are populated:
 *
 * - `providers`: the adapters actually registered in the runtime registry.
 * - `models`: the models those adapters discovered.
 *
 * `accounts`, `products`, `connections` and `routes` are empty, and that is the
 * honest answer rather than a stub to be filled in with guesses:
 *
 * - Account and product identity comes from the source branch's
 *   `config.providers.*.catalog` section plus `catalog/ids.ts`. Neither exists
 *   on this branch, and that branch's own rule is that an unknown account
 *   identity "is intentionally not materialized as a fake Account/Product".
 * - Connections come from `ProviderConnectionService` fed by the credential
 *   binding stores — the credential machinery that is not ported. The
 *   consequence is the correct one: a client that asks "which connection kind
 *   does provider X use?" gets no answer, and connecting requires the mutation
 *   surface this branch does not serve.
 * - Routes need `routeId`, `executionProfile`, `billingClass`, `routable` and a
 *   visibility decision, all produced by the source branch's reconciler, route
 *   policy, activation config and `RouteVisibilityPolicy`. This branch has no
 *   authority for a billing class or a model-picker visibility, so emitting a
 *   route would fabricate exactly the two things that must never be guessed.
 *
 * Consumers must therefore treat the routes of this Router as served-by-model-id
 * (the `/v1/models` and chat contract), not as catalog routes.
 */
export function routerCatalogProjectionInput(
  registry: ProviderRegistry,
): RouterCatalogProjectionInput {
  return {
    directory: catalogDirectory(registry),
    accounts: [],
    products: [],
    connections: emptyCollection(),
    modelIdentities: catalogModelIdentities(registry),
    routeCatalog: emptyCollection(),
  };
}

/**
 * Register the read-only catalog projection.
 *
 * The registered pattern is exactly `GET /v1/cmm/catalog`, the identity the
 * read-only principal's allowlist
 * (`src/security/usage-reader-policy.ts` `READ_ONLY_ROUTES`) names.
 *
 * Deliberately absent compared with the source branch: there is no
 * `beforeRead` → `catalogReconciler.reconcileAll()`. That branch reconciles on
 * read, i.e. every read triggers live provider discovery. The CMM Usage probe
 * polls this route, so a reconcile-on-read hook here would let a monitoring
 * client repeatedly spawn provider runtimes. The read is served from the
 * registry's existing discovery cache instead, which is the same cache
 * `GET /v1/models` already serves.
 */
export function registerCatalogRead(
  fastify: FastifyInstance,
  registry: ProviderRegistry,
): void {
  fastify.get("/v1/cmm/catalog", async () => {
    // Reconcile staleness on read for the same reason `/v1/models` does: a
    // catalog that only changes on restart cannot describe the account the
    // reader is asking about. Sources still inside their TTL are untouched, so
    // the CMM Usage poller never spawns a provider runtime.
    await registry.refreshStale();
    return buildRouterCatalogProjection(routerCatalogProjectionInput(registry));
  });
}
