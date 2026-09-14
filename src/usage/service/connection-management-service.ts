import { randomUUID } from "node:crypto";
import type { VisibilityPreference } from "../presentation/types.js";
import type { VisibilityStore } from "../presentation/visibility-store.js";
import type { ConfiguredUsageRuntime, UsageIntegrationDefinition } from "../runtime/configured-runtime.js";
import type { CredentialWriter } from "../runtime/credential-writer.js";
import type { ManagedConfigStore } from "../runtime/managed-config-store.js";

export interface ConnectSecretOptions {
  instanceId?: string;
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

export interface SafeConnectionView {
  id: string;
  type: string;
  enabled: boolean;
  hint?: string;
}

function safeView(definition: UsageIntegrationDefinition, hint?: string): SafeConnectionView {
  return {
    id: definition.id,
    type: definition.type,
    enabled: definition.enabled,
    ...(hint === undefined ? {} : { hint }),
  };
}

export class ConnectionManagementService {
  constructor(
    private readonly configStore: ManagedConfigStore,
    private readonly credentials: CredentialWriter,
    private readonly runtime: ConfiguredUsageRuntime,
    private readonly visibility?: VisibilityStore,
  ) {}

  private async replace(definition: UsageIntegrationDefinition): Promise<void> {
    const config = await this.configStore.update((current) => ({
      ...current,
      integrations: [
        ...current.integrations.filter((entry) => entry.id !== definition.id),
        definition,
      ],
    }));
    await this.runtime.applyConfig(config);
  }

  private async connectSecret(
    integrationType: string,
    secret: string,
    options: ConnectSecretOptions = {},
  ): Promise<SafeConnectionView> {
    const instanceId = options.instanceId ?? `${integrationType}-${randomUUID()}`;
    const written = await this.credentials.write(instanceId, secret);
    const definition: UsageIntegrationDefinition = {
      id: instanceId,
      type: integrationType,
      enabled: true,
      credentialRef: written.credentialRef,
      settings: options.settings ?? {},
    };
    try {
      await this.replace(definition);
    } catch (error) {
      await this.credentials.remove(written.credentialRef);
      throw error;
    }
    return safeView(definition, written.hint);
  }

  async connectWithApiKey(
    integrationType: string,
    secret: string,
    options: ConnectSecretOptions = {},
  ): Promise<SafeConnectionView> {
    return this.connectSecret(integrationType, secret, options);
  }

  async connectAccount(
    integrationType: string,
    secret: string,
    options: ConnectSecretOptions = {},
  ): Promise<SafeConnectionView> {
    return this.connectSecret(integrationType, secret, options);
  }

  async addCustomEndpoint(input: CustomEndpointInput): Promise<SafeConnectionView> {
    const instanceId = input.instanceId ?? `custom-${randomUUID()}`;
    const settings: Readonly<Record<string, unknown>> = {
      name: input.name,
      baseUrl: input.endpointUrl,
      ...(input.defaultModel === undefined ? {} : { defaultModel: input.defaultModel }),
      discoverModels: input.discoverModels ?? true,
      useInCmmChat: input.useInCmmChat ?? true,
      ...(input.usageEndpoint === undefined ? {} : { usageEndpoint: input.usageEndpoint }),
      ...(input.billingEndpoint === undefined ? {} : { billingEndpoint: input.billingEndpoint }),
      quotaMode: input.quotaMode ?? "unknown",
    };

    if (input.apiKey !== undefined && input.apiKey.trim().length > 0) {
      return this.connectSecret("openai-compatible", input.apiKey, { instanceId, settings });
    }
    const definition: UsageIntegrationDefinition = {
      id: instanceId,
      type: "openai-compatible",
      enabled: true,
      settings,
    };
    await this.replace(definition);
    return safeView(definition);
  }

  async disconnect(instanceId: string): Promise<void> {
    const current = await this.configStore.read();
    const definition = current.integrations.find((entry) => entry.id === instanceId);
    if (definition === undefined) throw new Error(`Unknown usage connection: ${instanceId}`);
    const next = {
      ...current,
      integrations: current.integrations.filter((entry) => entry.id !== instanceId),
    };
    await this.configStore.write(next);
    await this.runtime.applyConfig(next);
    if (definition.credentialRef !== undefined) await this.credentials.remove(definition.credentialRef);
  }

  private async setEnabled(instanceId: string, enabled: boolean): Promise<SafeConnectionView> {
    const current = await this.configStore.read();
    const definition = current.integrations.find((entry) => entry.id === instanceId);
    if (definition === undefined) throw new Error(`Unknown usage connection: ${instanceId}`);
    const nextDefinition = { ...definition, enabled };
    await this.replace(nextDefinition);
    return safeView(nextDefinition);
  }

  async enable(instanceId: string): Promise<SafeConnectionView> {
    return this.setEnabled(instanceId, true);
  }

  async disable(instanceId: string): Promise<SafeConnectionView> {
    return this.setEnabled(instanceId, false);
  }

  async testConnection(instanceId: string): Promise<{ id: string; status: string }> {
    const adapter = this.runtime.adapters.get(instanceId);
    if (adapter === undefined) throw new Error(`Unknown usage connection: ${instanceId}`);
    if (adapter.capabilities().has("discover_accounts") || adapter.capabilities().has("discover_models") || adapter.capabilities().has("discover_quota_graph")) {
      const result = await this.runtime.adapters.discover(instanceId);
      return { id: instanceId, status: result.status === "ok" ? "healthy" : result.status };
    }
    const health = await adapter.health();
    return { id: instanceId, status: health.status };
  }

  async refresh(instanceId: string) {
    return this.runtime.service.refresh(instanceId);
  }

  async setVisibility(preference: VisibilityPreference): Promise<void> {
    if (this.visibility === undefined) throw new Error("Visibility mutation is unavailable");
    await this.visibility.set(preference);
  }
}
