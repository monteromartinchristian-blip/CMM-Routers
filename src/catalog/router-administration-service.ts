import type { SharedConfig } from "../config/schema.js";
import { buildConnectionId } from "./ids.js";
import type {
  CatalogReconciler,
  CatalogRoutePolicy,
  ConnectionReconcileResult,
} from "./catalog-reconciler.js";
import type { CredentialBindingStore } from "./credential-bindings.js";
import type { ProviderConnectionService } from "./provider-connections.js";
import type { ProviderDirectory } from "./provider-directory.js";
import type { RouteCatalog } from "./route-catalog.js";
import type { RouterAdminConfigStore } from "./router-admin-config-store.js";
import type { SecureCredentialWriter } from "./secure-credential-writer.js";
import type {
  AccessRoute,
  ConnectionKind,
  ProviderConnection,
  RouteSurface,
} from "./types.js";

const CUSTOM_PROVIDER_ID = "custom-openai-compatible";
const CUSTOM_CONNECTION_KIND = "openai-chat-completions";

type AdministrativeConnection = SharedConfig["administrativeConnections"][number];

export interface ConnectProviderInput {
  providerId: string;
  connectionId: string;
  connectionKind: ConnectionKind;
  secret?: string;
  accountId?: string;
  productId?: string;
  profileRef?: string;
  endpointRef?: string;
  authorizeExecution: boolean;
  authorizeObservability: boolean;
}

export interface AddCustomEndpointInput {
  connectionId: string;
  displayName: string;
  endpointUrl: string;
  apiKey?: string;
  defaultModel?: string;
  visibleOn?: RouteSurface[];
}

export interface SafeConnectionSummary {
  readonly connectionId: string;
  readonly providerId: string;
  readonly connectionKind: ConnectionKind;
  readonly status: ProviderConnection["status"];
  readonly enabled: boolean;
  readonly executionAuthorized: boolean;
  readonly observabilityAuthorized: boolean;
  readonly accountId?: string;
  readonly productId?: string;
  readonly profileRef?: string;
  readonly endpointRef?: string;
}

export interface RouterAdministrationServiceOptions {
  directory: ProviderDirectory;
  connections: ProviderConnectionService;
  credentialBindings: CredentialBindingStore;
  routeCatalog: RouteCatalog;
  catalogReconciler: CatalogReconciler;
  configStore: RouterAdminConfigStore;
  credentialWriter: SecureCredentialWriter;
}

function stableOpaqueRef(value: string): string {
  return encodeURIComponent(value).replace(/'/gu, "%27");
}

function executionBindingId(connectionId: string): string {
  return `execution:${connectionId}`;
}

function observabilityBindingId(connectionId: string): string {
  return `observability:${connectionId}`;
}

function adminRecord(
  connection: ProviderConnection,
  refs: { executionSecretRef?: string; observabilitySecretRef?: string },
): AdministrativeConnection {
  return {
    connectionId: connection.connectionId,
    providerId: connection.providerId,
    connectionKind: connection.connectionKind,
    enabled: connection.status !== "disabled",
    ...(connection.accountId === undefined ? {} : { accountId: connection.accountId }),
    ...(connection.productId === undefined ? {} : { productId: connection.productId }),
    ...(refs.executionSecretRef === undefined
      ? {}
      : { executionSecretRef: refs.executionSecretRef }),
    ...(refs.observabilitySecretRef === undefined
      ? {}
      : { observabilitySecretRef: refs.observabilitySecretRef }),
    ...(connection.profileRef === undefined ? {} : { profileRef: connection.profileRef }),
    ...(connection.endpointRef === undefined ? {} : { endpointRef: connection.endpointRef }),
  };
}

export class RouterAdministrationService {
  private readonly directory: ProviderDirectory;
  private readonly connections: ProviderConnectionService;
  private readonly bindings: CredentialBindingStore;
  private readonly routeCatalog: RouteCatalog;
  private readonly reconciler: CatalogReconciler;
  private readonly configStore: RouterAdminConfigStore;
  private readonly credentialWriter: SecureCredentialWriter;

  constructor(options: RouterAdministrationServiceOptions) {
    this.directory = options.directory;
    this.connections = options.connections;
    this.bindings = options.credentialBindings;
    this.routeCatalog = options.routeCatalog;
    this.reconciler = options.catalogReconciler;
    this.configStore = options.configStore;
    this.credentialWriter = options.credentialWriter;
  }

  async connect(input: ConnectProviderInput): Promise<SafeConnectionSummary> {
    return this.connectInternal(input);
  }

  async disconnect(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (connection === undefined) throw new Error(`Unknown connection: ${connectionId}`);

    const executionId = executionBindingId(connectionId);
    const observabilityId = observabilityBindingId(connectionId);
    const execution = this.bindings.getExecution(executionId);
    const observability = this.bindings.getObservability(observabilityId);
    const persisted = this.configStore.read();
    const persistedConnection = persisted.administrativeConnections.find(
      (entry) => entry.connectionId === connectionId,
    );

    this.connections.remove(connectionId);
    if (execution !== undefined) this.bindings.removeExecution(executionId);
    if (observability !== undefined) this.bindings.removeObservability(observabilityId);

    try {
      await this.configStore.update((current) => ({
        ...current,
        administrativeConnections: current.administrativeConnections.filter(
          (entry) => entry.connectionId !== connectionId,
        ),
      }));
    } catch (error) {
      if (execution !== undefined) this.bindings.addExecution(execution);
      if (observability !== undefined) this.bindings.addObservability(observability);
      this.connections.add(connection);
      if (connection.status === "disabled") this.connections.disable(connectionId);
      throw error;
    }

    const refs = new Set([
      persistedConnection?.executionSecretRef,
      persistedConnection?.observabilitySecretRef,
    ].filter((value): value is string => value !== undefined));
    for (const secretRef of refs) await this.credentialWriter.remove(secretRef);
  }

  async setEnabled(connectionId: string, enabled: boolean): Promise<SafeConnectionSummary> {
    const before = this.connections.get(connectionId);
    if (before === undefined) throw new Error(`Unknown connection: ${connectionId}`);

    const connection = enabled
      ? this.connections.enable(connectionId)
      : this.connections.disable(connectionId);
    try {
      await this.persistConnection(connection);
      return this.summary(connection.connectionId);
    } catch (error) {
      this.connections.remove(connectionId);
      this.connections.add(before);
      throw error;
    }
  }

  async validate(connectionId: string): Promise<SafeConnectionSummary> {
    await this.connections.validateExecution(connectionId);
    return this.summary(connectionId);
  }

  async refreshModels(connectionId: string): Promise<ConnectionReconcileResult> {
    return this.reconciler.reconcileConnection(connectionId, { force: true });
  }

  async addCustomEndpoint(input: AddCustomEndpointInput): Promise<SafeConnectionSummary> {
    if (!this.directory.has(CUSTOM_PROVIDER_ID)) {
      this.directory.register({
        providerId: CUSTOM_PROVIDER_ID,
        displayName: "Custom OpenAI-compatible endpoint",
        adapterKind: "openai-compatible",
        supportedConnectionKinds: [CUSTOM_CONNECTION_KIND],
        discoveryCapabilities: [],
      });
    }

    const connectionId = buildConnectionId({
      providerId: CUSTOM_PROVIDER_ID,
      connectionRef: input.connectionId,
      connectionKind: CUSTOM_CONNECTION_KIND,
      profileRef: stableOpaqueRef(input.displayName),
      endpointRef: stableOpaqueRef(input.endpointUrl),
    });
    const hasSecret = input.apiKey !== undefined && input.apiKey.trim().length > 0;
    const explicitModels = input.defaultModel === undefined
      ? []
      : [{
          providerId: CUSTOM_PROVIDER_ID,
          connectionId,
          providerModelId: input.defaultModel,
          displayName: input.defaultModel,
          capabilities: { chat: true, tools: true },
        }];
    const customRoutePolicy: CatalogRoutePolicy = (_connection, model) => ({
      canonicalName: stableOpaqueRef(`${input.displayName}:${model.providerModelId}`),
      executionProfile: "default",
      capabilities: { chat: true, tools: true, streaming: true },
      billingClass: "api",
      routable: hasSecret,
      visibility: {
        visibleOn: input.visibleOn ?? [
          "cmmchat_model_picker",
          "cmmcode_model_picker",
          "admin_console",
        ],
      },
    });

    const summary = await this.connectInternal(
      {
        providerId: CUSTOM_PROVIDER_ID,
        connectionId,
        connectionKind: CUSTOM_CONNECTION_KIND,
        ...(hasSecret ? { secret: input.apiKey } : {}),
        profileRef: input.displayName,
        endpointRef: input.endpointUrl,
        authorizeExecution: hasSecret,
        authorizeObservability: false,
      },
      explicitModels,
      customRoutePolicy,
    );

    if (input.visibleOn !== undefined && explicitModels.length > 0) {
      const routes = this.routeCatalog.list().filter((route) => route.connectionId === connectionId);
      for (const route of routes) await this.setRouteVisibility(route.routeId, input.visibleOn);
    }
    return this.summary(summary.connectionId);
  }

  async setRouteVisibility(
    routeId: string,
    visibleOn: readonly RouteSurface[],
  ): Promise<AccessRoute> {
    const before = this.routeCatalog.get(routeId);
    if (before === undefined) throw new Error(`Unknown route: ${routeId}`);
    const changed = this.routeCatalog.setVisibility(routeId, visibleOn);
    try {
      await this.configStore.update((current) => {
        const nextRule = { routeId, visibleOn: [...visibleOn] };
        const existingIndex = current.routeVisibility.findIndex((rule) => rule.routeId === routeId);
        const routeVisibility = current.routeVisibility.slice();
        if (existingIndex === -1) routeVisibility.push(nextRule);
        else routeVisibility[existingIndex] = nextRule;
        return { ...current, routeVisibility };
      });
    } catch (error) {
      this.routeCatalog.setVisibility(routeId, before.visibility.visibleOn);
      throw error;
    }
    return changed;
  }

  private async connectInternal(
    input: ConnectProviderInput,
    explicitModels?: readonly {
      providerId: string;
      connectionId: string;
      providerModelId: string;
      displayName?: string;
      capabilities?: { chat?: boolean; tools?: boolean };
    }[],
    explicitRoutePolicy?: CatalogRoutePolicy,
  ): Promise<SafeConnectionSummary> {
    const provider = this.directory.get(input.providerId);
    if (provider === undefined) throw new Error(`Unknown provider: ${input.providerId}`);
    if (!provider.supportedConnectionKinds.includes(input.connectionKind)) {
      throw new Error(
        `Provider ${input.providerId} does not support connection kind ${input.connectionKind}`,
      );
    }
    if (this.connections.get(input.connectionId) !== undefined) {
      throw new Error(`Provider connection already exists: ${input.connectionId}`);
    }

    const executionId = executionBindingId(input.connectionId);
    const observabilityId = observabilityBindingId(input.connectionId);
    if (input.authorizeExecution && this.bindings.getExecution(executionId) !== undefined) {
      throw new Error("Execution credential binding already exists");
    }
    if (
      input.authorizeObservability &&
      this.bindings.getObservability(observabilityId) !== undefined
    ) {
      throw new Error("Observability credential binding already exists");
    }
    if ((input.authorizeExecution || input.authorizeObservability) && input.secret === undefined) {
      throw new Error("Authorized connection requires credential material");
    }

    const beforeConfig = this.configStore.read();
    const beforeCatalog = this.reconciler.snapshotState();
    let writtenSecretRef: string | undefined;
    let executionCreated = false;
    let observabilityCreated = false;
    let connectionCreated = false;
    let configPersisted = false;

    try {
      if (input.secret !== undefined) {
        writtenSecretRef = (await this.credentialWriter.write(input.connectionId, input.secret)).secretRef;
      }

      if (input.authorizeExecution) {
        this.bindings.addExecution({
          bindingId: executionId,
          providerId: input.providerId,
          ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
          ...(input.productId === undefined ? {} : { productId: input.productId }),
          secretRef: writtenSecretRef!,
          purpose: "execution",
          enabled: true,
        });
        executionCreated = true;
      }
      if (input.authorizeObservability) {
        this.bindings.addObservability({
          bindingId: observabilityId,
          providerId: input.providerId,
          ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
          ...(input.productId === undefined ? {} : { productId: input.productId }),
          secretRef: writtenSecretRef!,
          purpose: "observability",
          enabled: true,
        });
        observabilityCreated = true;
      }

      const connection = this.connections.add({
        connectionId: input.connectionId,
        providerId: input.providerId,
        connectionKind: input.connectionKind,
        ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
        ...(input.productId === undefined ? {} : { productId: input.productId }),
        ...(input.authorizeExecution ? { executionCredentialBindingId: executionId } : {}),
        ...(input.profileRef === undefined ? {} : { profileRef: input.profileRef }),
        ...(input.endpointRef === undefined ? {} : { endpointRef: input.endpointRef }),
        status: "configured",
      });
      connectionCreated = true;

      await this.configStore.update((current) => ({
        ...current,
        administrativeConnections: [
          ...current.administrativeConnections.filter(
            (entry) => entry.connectionId !== connection.connectionId,
          ),
          adminRecord(connection, {
            ...(input.authorizeExecution && writtenSecretRef !== undefined
              ? { executionSecretRef: writtenSecretRef }
              : {}),
            ...(input.authorizeObservability && writtenSecretRef !== undefined
              ? { observabilitySecretRef: writtenSecretRef }
              : {}),
          }),
        ],
      }));
      configPersisted = true;

      if (explicitModels === undefined && input.authorizeExecution) {
        const result = await this.reconciler.reconcileConnection(connection.connectionId, {
          force: true,
        });
        if (result.failed) {
          throw new Error(`Catalog reconciliation failed for ${connection.connectionId}`);
        }
      } else if (explicitModels !== undefined) {
        this.reconciler.reconcileDiscoveredModels(
          connection.connectionId,
          explicitModels,
          explicitRoutePolicy,
        );
      }
      return this.summary(connection.connectionId);
    } catch (error) {
      this.reconciler.restoreState(beforeCatalog);
      if (configPersisted) {
        await this.configStore.write(beforeConfig).catch(() => undefined);
      }
      if (connectionCreated) this.connections.remove(input.connectionId);
      if (executionCreated) this.bindings.removeExecution(executionId);
      if (observabilityCreated) this.bindings.removeObservability(observabilityId);
      if (writtenSecretRef !== undefined) {
        await this.credentialWriter.remove(writtenSecretRef).catch(() => undefined);
      }
      throw error;
    }
  }

  private async persistConnection(connection: ProviderConnection): Promise<void> {
    const current = this.configStore.read();
    const existing = current.administrativeConnections.find(
      (entry) => entry.connectionId === connection.connectionId,
    );
    await this.configStore.update((config) => ({
      ...config,
      administrativeConnections: [
        ...config.administrativeConnections.filter(
          (entry) => entry.connectionId !== connection.connectionId,
        ),
        adminRecord(connection, {
          ...(existing?.executionSecretRef === undefined
            ? {}
            : { executionSecretRef: existing.executionSecretRef }),
          ...(existing?.observabilitySecretRef === undefined
            ? {}
            : { observabilitySecretRef: existing.observabilitySecretRef }),
        }),
      ],
    }));
  }

  private summary(connectionId: string): SafeConnectionSummary {
    const connection = this.connections.get(connectionId);
    if (connection === undefined) throw new Error(`Unknown connection: ${connectionId}`);
    return {
      connectionId: connection.connectionId,
      providerId: connection.providerId,
      connectionKind: connection.connectionKind,
      status: connection.status,
      enabled: connection.status !== "disabled",
      executionAuthorized:
        this.bindings.getExecution(executionBindingId(connectionId))?.enabled === true,
      observabilityAuthorized:
        this.bindings.getObservability(observabilityBindingId(connectionId))?.enabled === true,
      ...(connection.accountId === undefined ? {} : { accountId: connection.accountId }),
      ...(connection.productId === undefined ? {} : { productId: connection.productId }),
      ...(connection.profileRef === undefined ? {} : { profileRef: connection.profileRef }),
      ...(connection.endpointRef === undefined ? {} : { endpointRef: connection.endpointRef }),
    };
  }
}
