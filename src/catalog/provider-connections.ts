import type { DiscoveredModel } from "../core/provider.js";
import { RouterError } from "../core/errors.js";
import type { CredentialBindingStore } from "./credential-bindings.js";
import type { ProviderDirectory } from "./provider-directory.js";
import type {
  ExecutionCredentialBinding,
  ProviderConnection,
  RouteCapabilities,
} from "./types.js";
import type {
  ResolvedSecret,
  SecureCredentialResolver,
} from "./secure-credential-resolver.js";

export interface DiscoveredProviderModel {
  providerId: string;
  connectionId: string;
  providerModelId: string;
  displayName?: string;
  capabilities?: Partial<RouteCapabilities>;
}

/**
 * Provider-specific administrative discovery for one exact connection.
 *
 * The hook deliberately exposes no generation operation. Implementations adapt
 * existing provider `discoverModels()` entry points and receive only a
 * defensive connection snapshot plus the explicitly authorized secret.
 */
export type AdministrativeModelDiscovery = (
  connection: Readonly<ProviderConnection>,
  credential: Readonly<ResolvedSecret>,
) => Promise<readonly DiscoveredModel[]>;

export interface ProviderConnectionServiceOptions {
  directory: ProviderDirectory;
  credentialBindings: CredentialBindingStore;
  credentialResolver: SecureCredentialResolver;
  administrativeDiscovery: ReadonlyMap<string, AdministrativeModelDiscovery>;
}

function snapshotConnection(connection: ProviderConnection): ProviderConnection {
  const result: ProviderConnection = {
    connectionId: connection.connectionId,
    providerId: connection.providerId,
    connectionKind: connection.connectionKind,
    status: connection.status,
  };
  if (connection.accountId !== undefined) result.accountId = connection.accountId;
  if (connection.productId !== undefined) result.productId = connection.productId;
  if (connection.executionCredentialBindingId !== undefined) {
    result.executionCredentialBindingId = connection.executionCredentialBindingId;
  }
  if (connection.profileRef !== undefined) result.profileRef = connection.profileRef;
  if (connection.endpointRef !== undefined) result.endpointRef = connection.endpointRef;
  return result;
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Provider connection ${field} must be a non-empty string`);
  }
}

function checkedConnection(connection: ProviderConnection): ProviderConnection {
  if (typeof connection !== "object" || connection === null) {
    throw new TypeError("Provider connection must be an object");
  }
  assertNonEmpty(connection.connectionId, "connectionId");
  assertNonEmpty(connection.providerId, "providerId");
  assertNonEmpty(connection.connectionKind, "connectionKind");
  for (const field of [
    "accountId",
    "productId",
    "executionCredentialBindingId",
    "profileRef",
    "endpointRef",
  ] as const) {
    const value = connection[field];
    if (value !== undefined) assertNonEmpty(value, field);
  }
  return snapshotConnection(connection);
}

function capabilitiesOf(model: DiscoveredModel): Partial<RouteCapabilities> | undefined {
  if (model.capability === "CHAT_AND_TOOLS") {
    return { chat: true, tools: true };
  }
  if (model.capability === "CHAT_ONLY") {
    return { chat: true, tools: false };
  }
  return undefined;
}

export class ProviderConnectionService {
  private readonly connections = new Map<string, ProviderConnection>();
  private readonly options: ProviderConnectionServiceOptions;

  constructor(options: ProviderConnectionServiceOptions) {
    this.options = {
      directory: options.directory,
      credentialBindings: options.credentialBindings,
      credentialResolver: options.credentialResolver,
      administrativeDiscovery: new Map(options.administrativeDiscovery),
    };
  }

  add(connection: ProviderConnection): ProviderConnection {
    const stored = checkedConnection(connection);
    const provider = this.options.directory.get(stored.providerId);
    if (provider === undefined) {
      throw new Error(`Unknown provider: ${stored.providerId}`);
    }
    if (!provider.supportedConnectionKinds.includes(stored.connectionKind)) {
      throw new Error(
        `Provider ${stored.providerId} does not support connection kind ${stored.connectionKind}`,
      );
    }
    if (this.connections.has(stored.connectionId)) {
      throw new Error(`Provider connection already exists: ${stored.connectionId}`);
    }

    stored.status = stored.status === "disabled" ? "disabled" : "configured";
    this.connections.set(stored.connectionId, stored);
    return snapshotConnection(stored);
  }

  disable(connectionId: string): ProviderConnection {
    const connection = this.requireConnection(connectionId);
    connection.status = "disabled";
    return snapshotConnection(connection);
  }

  get(connectionId: string): ProviderConnection | undefined {
    const connection = this.connections.get(connectionId);
    return connection === undefined ? undefined : snapshotConnection(connection);
  }

  list(): ProviderConnection[] {
    return [...this.connections.values()].map(snapshotConnection);
  }

  async validateExecution(connectionId: string): Promise<ProviderConnection> {
    const connection = this.requireConnection(connectionId);
    await this.resolveExecutionCredential(connection);
    connection.status = "ready";
    return snapshotConnection(connection);
  }

  authorizeExecution(connectionId: string): ProviderConnection {
    const connection = this.requireConnection(connectionId);
    this.requireExecutionBinding(connection);
    return snapshotConnection(connection);
  }

  async *withExecutionCredential<T>(
    connectionId: string,
    execute: (
      connection: Readonly<ProviderConnection>,
      credential: Readonly<ResolvedSecret>,
    ) => AsyncIterable<T>,
  ): AsyncIterable<T> {
    const connection = this.requireConnection(connectionId);
    const credential = await this.resolveExecutionCredential(connection);
    connection.status = "ready";
    const connectionSnapshot = Object.freeze(snapshotConnection(connection));
    const resolvedCredential = Object.freeze({ value: credential.value });
    for await (const item of execute(connectionSnapshot, resolvedCredential)) {
      yield item;
    }
  }

  async discoverModels(connectionId: string): Promise<DiscoveredProviderModel[]> {
    const connection = this.requireConnection(connectionId);
    const credential = await this.resolveExecutionCredential(connection);
    const discover = this.options.administrativeDiscovery.get(connection.providerId);
    if (discover === undefined) {
      connection.status = "unavailable";
      throw new Error(
        `Provider ${connection.providerId} has no administrative discovery hook`,
      );
    }

    try {
      const models = await discover(
        Object.freeze(snapshotConnection(connection)),
        Object.freeze({ value: credential.value }),
      );
      const result = models.map((model) => {
        if (model.provider !== connection.providerId) {
          throw new Error(
            `Administrative discovery returned a model for provider ${model.provider}`,
          );
        }
        if (typeof model.upstreamModel !== "string" || model.upstreamModel.length === 0) {
          throw new Error("Administrative discovery returned an empty provider model ID");
        }
        const discovered: DiscoveredProviderModel = {
          providerId: connection.providerId,
          connectionId: connection.connectionId,
          providerModelId: model.upstreamModel,
        };
        if (model.displayName.length > 0) discovered.displayName = model.displayName;
        const capabilities = capabilitiesOf(model);
        if (capabilities !== undefined) discovered.capabilities = capabilities;
        return discovered;
      });
      connection.status = "ready";
      return result;
    } catch (error) {
      connection.status = statusForDiscoveryFailure(error);
      throw new Error("Administrative discovery failed");
    }
  }

  private requireConnection(connectionId: string): ProviderConnection {
    assertNonEmpty(connectionId, "connectionId");
    const connection = this.connections.get(connectionId);
    if (connection === undefined) {
      throw new Error(`Unknown connection: ${connectionId}`);
    }
    if (connection.status === "disabled") {
      throw new Error(`Provider connection is disabled: ${connectionId}`);
    }
    if (!this.options.directory.has(connection.providerId)) {
      connection.status = "unavailable";
      throw new Error(`Unknown provider: ${connection.providerId}`);
    }
    return connection;
  }

  private async resolveExecutionCredential(
    connection: ProviderConnection,
  ): Promise<ResolvedSecret> {
    connection.status = "validating";
    const binding = this.requireExecutionBinding(connection);

    try {
      const credential = await this.options.credentialResolver.resolve(binding.secretRef);
      if (typeof credential.value !== "string" || credential.value.length === 0) {
        throw new Error("Resolved execution credential is empty");
      }
      return { value: credential.value };
    } catch {
      connection.status = "auth_required";
      throw new Error("Execution credential could not be resolved");
    }
  }

  private requireExecutionBinding(
    connection: ProviderConnection,
  ): ExecutionCredentialBinding {
    const bindingId = connection.executionCredentialBindingId;
    if (bindingId === undefined) {
      connection.status = "auth_required";
      throw new Error("Provider connection requires an execution credential binding");
    }
    const binding = this.options.credentialBindings.getExecution(bindingId);
    if (binding === undefined || !binding.enabled) {
      connection.status = "auth_required";
      throw new Error("Provider connection has no enabled execution credential binding");
    }
    if (
      binding.providerId !== connection.providerId ||
      (binding.accountId !== undefined && binding.accountId !== connection.accountId) ||
      (binding.productId !== undefined && binding.productId !== connection.productId)
    ) {
      connection.status = "auth_required";
      throw new Error("Execution credential binding does not match the provider connection");
    }
    return binding;
  }
}

function statusForDiscoveryFailure(error: unknown): ProviderConnection["status"] {
  if (error instanceof RouterError) {
    if (error.code === "provider_auth_required") return "auth_required";
    if (
      error.code === "provider_unavailable" ||
      error.code === "provider_timeout" ||
      error.code === "provider_rate_limited"
    ) {
      return "unavailable";
    }
  }
  return "error";
}
