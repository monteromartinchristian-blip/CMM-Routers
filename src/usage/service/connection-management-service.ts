import { randomUUID } from "node:crypto";
import type { AccessRouteSummary } from "../../catalog/projection.js";
import type {
  AddCustomEndpointInput as RouterAddCustomEndpointInput,
  ConnectProviderInput,
  RouterAdministrationService,
  SafeConnectionSummary,
} from "../../catalog/router-administration-service.js";
import type { RouteSurface } from "../../catalog/types.js";
import type { RouterCatalogSource } from "../presentation/presentation-catalog-service.js";
import type { VisibilityPreference } from "../presentation/types.js";

export interface ConnectSecretOptions {
  instanceId?: string;
  /**
   * Legacy Usage integration settings, accepted for request compatibility only.
   *
   * Router connections carry no Usage integration settings, and collector
   * settings are Usage-owned, so these are deliberately not persisted by any
   * compatibility operation.
   */
  settings?: Readonly<Record<string, unknown>>;
}

export interface CustomEndpointInput {
  name: string;
  endpointUrl: string;
  defaultModel?: string;
  apiKey?: string;
  discoverModels?: boolean;
  useInCmmChat?: boolean;
  usageEndpoint?: string;
  billingEndpoint?: string;
  quotaMode?: "automatic" | "manual" | "unknown";
  instanceId?: string;
}

/**
 * UI-facing compatibility view of a Router-owned connection.
 *
 * `id` is the canonical Router connection id, which is the only handle later
 * compatibility calls accept. `executionAuthorized` and `observabilityAuthorized`
 * are reported separately because Router models execution and observability
 * credentials as independent, explicitly authorized bindings: a provider may be
 * executable-but-not-collected, collected-but-not-executable, both, or neither.
 */
export interface SafeConnectionView {
  id: string;
  type: string;
  enabled: boolean;
  hint?: string;
  executionAuthorized: boolean;
  observabilityAuthorized: boolean;
}

/**
 * The Router administration operations the compatibility surface may reach.
 *
 * A structural pick rather than the concrete class, so this delegate cannot
 * reach any non-administrative Router internal and tests can substitute a spy.
 * The real `RouterAdministrationService` satisfies it unchanged.
 */
export type RouterAdministrationPort = Pick<
  RouterAdministrationService,
  | "connect"
  | "disconnect"
  | "setEnabled"
  | "validate"
  | "addCustomEndpoint"
  | "setRouteVisibility"
  | "connectionKindFor"
>;

/**
 * Usage-owned collector refresh.
 *
 * Collector refresh is a separate Usage operation: it reads Usage observations
 * and is never a Router administrative mutation. It is injected separately so a
 * collector failure can never roll back a persisted Router connection.
 */
export interface UsageCollectorRefresh {
  refresh(instanceId: string): Promise<unknown>;
}

export interface ConnectionManagementServiceOptions {
  /** Usage-owned collector refresh; consulted only by the compatibility `refresh` read. */
  collectorRefresh?: UsageCollectorRefresh;
  /**
   * Read-only canonical Router catalog. Consulted only to derive the safe
   * default consumer surfaces of a route when a legacy `visible` preference has
   * to be expressed as exact Router surfaces.
   */
  routerCatalog?: RouterCatalogSource;
}

const ROUTER_UNAVAILABLE = "Router administration is unavailable";

function view(summary: SafeConnectionSummary): SafeConnectionView {
  return {
    id: summary.connectionId,
    type: summary.providerId,
    enabled: summary.enabled,
    executionAuthorized: summary.executionAuthorized,
    observabilityAuthorized: summary.observabilityAuthorized,
  };
}

/**
 * Safe default consumer surfaces for one exact route.
 *
 * Derived from the canonical route's own capability profile — the same input
 * the canonical `RouteVisibilityPolicy` uses for its default rule — so a
 * non-tool-capable route is never restored onto the tool surface. Router's
 * exact-execution ceiling still applies on the next reconcile, so this can
 * never broaden visibility beyond what the route can actually honour.
 */
function defaultExecutableSurfaces(route: AccessRouteSummary): RouteSurface[] {
  const surfaces: RouteSurface[] = ["cmmchat_model_picker"];
  if (route.capabilities.tools) surfaces.push("cmmcode_model_picker");
  surfaces.push("admin_console");
  return surfaces;
}

/**
 * Compatibility delegate over Router administration.
 *
 * CMM Routers owns connectivity and execution; CMM Usage owns observability,
 * quota and history. This class therefore performs no operational write of its
 * own: every mutation is delegated to the single Router administration
 * authority, and no compatibility operation writes Router-owned state to
 * `usage.json` or writes the Usage `VisibilityStore`.
 *
 * The UI-facing method names are retained temporarily so the macOS product
 * surface keeps working while the client migrates to the canonical Router
 * administration endpoints.
 */
export class ConnectionManagementService {
  constructor(
    private readonly administration: RouterAdministrationPort | undefined,
    private readonly options: ConnectionManagementServiceOptions = {},
  ) {}

  private requireAdministration(): RouterAdministrationPort {
    if (this.administration === undefined) throw new Error(ROUTER_UNAVAILABLE);
    return this.administration;
  }

  /**
   * Connects a provider from a submitted secret.
   *
   * The legacy request carries one secret and no explicit authorization axes,
   * so both Router bindings are authorized from it — the same canonical shape
   * the privileged Router administration endpoint uses for "connect a
   * provider". Legacy Usage integration `settings` have no Router analogue and
   * are not persisted anywhere; collector settings are Usage-owned and are
   * handled by the collector surfaces, not here.
   */
  private async connectProvider(
    integrationType: string,
    secret: string,
    options: ConnectSecretOptions = {},
  ): Promise<SafeConnectionView> {
    const administration = this.requireAdministration();
    const connectionId = options.instanceId ?? `${integrationType}-${randomUUID()}`;
    const connectionKind = administration.connectionKindFor(integrationType);
    if (connectionKind === undefined) {
      // Never guess a Router connection kind: an unknown provider is rejected
      // rather than fabricated.
      throw new Error(`Unknown router provider: ${integrationType}`);
    }
    const input: ConnectProviderInput = {
      providerId: integrationType,
      connectionId,
      connectionKind,
      secret,
      authorizeExecution: true,
      authorizeObservability: true,
    };
    return view(await administration.connect(input));
  }

  async connectWithApiKey(
    integrationType: string,
    secret: string,
    options: ConnectSecretOptions = {},
  ): Promise<SafeConnectionView> {
    return this.connectProvider(integrationType, secret, options);
  }

  async connectAccount(
    integrationType: string,
    secret: string,
    options: ConnectSecretOptions = {},
  ): Promise<SafeConnectionView> {
    return this.connectProvider(integrationType, secret, options);
  }

  /**
   * Adds a custom OpenAI-compatible endpoint through Router administration.
   *
   * `useInCmmChat: false` is expressed as an exact Router visibility of
   * `["admin_console"]` so an explicit "do not use in CMM Chat" intent is
   * preserved as non-broadening Router state. Collector-only settings
   * (`discoverModels`, `usageEndpoint`, `billingEndpoint`, `quotaMode`) have no
   * Router analogue and are not persisted here.
   */
  async addCustomEndpoint(input: CustomEndpointInput): Promise<SafeConnectionView> {
    const administration = this.requireAdministration();
    const routerInput: RouterAddCustomEndpointInput = {
      connectionId: input.instanceId ?? `custom-${randomUUID()}`,
      displayName: input.name,
      endpointUrl: input.endpointUrl,
      ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
      ...(input.defaultModel === undefined ? {} : { defaultModel: input.defaultModel }),
      ...(input.useInCmmChat === false ? { visibleOn: ["admin_console" as const] } : {}),
    };
    return view(await administration.addCustomEndpoint(routerInput));
  }

  async disconnect(connectionId: string): Promise<void> {
    await this.requireAdministration().disconnect(connectionId);
  }

  async enable(connectionId: string): Promise<SafeConnectionView> {
    return view(await this.requireAdministration().setEnabled(connectionId, true));
  }

  async disable(connectionId: string): Promise<SafeConnectionView> {
    return view(await this.requireAdministration().setEnabled(connectionId, false));
  }

  async testConnection(connectionId: string): Promise<{ id: string; status: string }> {
    const summary = await this.requireAdministration().validate(connectionId);
    return { id: summary.connectionId, status: summary.status };
  }

  /**
   * Refreshes Usage observations for one collector instance.
   *
   * Deliberately not delegated to Router administration: collector refresh is
   * Usage-owned observability work and must not be conflated with Router
   * connection enablement.
   */
  async refresh(connectionId: string) {
    const collectorRefresh = this.options.collectorRefresh;
    if (collectorRefresh === undefined) {
      throw new Error("Usage collector refresh is unavailable");
    }
    return collectorRefresh.refresh(connectionId);
  }

  /**
   * Maps the legacy `{ routeId, state }` preference onto exact Router surfaces.
   *
   * `hidden` becomes `["admin_console"]`, which can never broaden visibility.
   * `visible` restores the route's capability-derived executable surfaces. A
   * preference that does not name an exact route is rejected: Router visibility
   * belongs to the exact `AccessRoute`, never to a provider, product or model
   * identity.
   *
   * Two legacy shapes fail closed instead of being guessed:
   *
   * - a workspace-scoped preference, because Router has no workspace/tenant
   *   visibility surface and applying it globally would silently widen it;
   * - `inherit`, because Router has no fall-through rule. Mapping it onto the
   *   capability default would silently pin that default over whatever exact
   *   Router rule already exists — including a rule produced by the legacy
   *   visibility migration.
   */
  async setVisibility(preference: VisibilityPreference): Promise<void> {
    const administration = this.requireAdministration();
    if (preference.scope !== "global") {
      throw new Error("Router route visibility is global; workspace scope is unsupported");
    }
    const routeId = preference.routeId;
    if (routeId === undefined) {
      throw new Error("Router route visibility requires an exact route");
    }
    if (preference.state === "inherit") {
      throw new Error("Router route visibility requires an explicit visible or hidden state");
    }
    const visibleOn = preference.state === "hidden"
      ? (["admin_console"] as const)
      : await this.defaultSurfaces(routeId);
    await administration.setRouteVisibility(routeId, [...visibleOn]);
  }

  private async defaultSurfaces(routeId: string): Promise<readonly RouteSurface[]> {
    const source = this.options.routerCatalog;
    if (source === undefined) {
      throw new Error("Canonical router catalog is unavailable");
    }
    const projection = await source.read();
    const route = projection.routes.find((entry) => entry.routeId === routeId);
    if (route === undefined) throw new Error(`Unknown route: ${routeId}`);
    return defaultExecutableSurfaces(route);
  }
}
