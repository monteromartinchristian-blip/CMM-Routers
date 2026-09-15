import type { ProviderDefinition } from "./types.js";

function snapshot(definition: ProviderDefinition): ProviderDefinition {
  return {
    providerId: definition.providerId,
    displayName: definition.displayName,
    adapterKind: definition.adapterKind,
    supportedConnectionKinds: [...definition.supportedConnectionKinds],
    discoveryCapabilities: [...definition.discoveryCapabilities],
  };
}

export class ProviderDirectory {
  private readonly definitions = new Map<string, ProviderDefinition>();

  register(definition: ProviderDefinition): void {
    if (this.definitions.has(definition.providerId)) {
      throw new Error(`Duplicate provider id: ${definition.providerId}`);
    }
    this.definitions.set(definition.providerId, snapshot(definition));
  }

  get(providerId: string): ProviderDefinition | undefined {
    const definition = this.definitions.get(providerId);
    return definition === undefined ? undefined : snapshot(definition);
  }

  list(): ProviderDefinition[] {
    return [...this.definitions.values()].map(snapshot);
  }

  has(providerId: string): boolean {
    return this.definitions.has(providerId);
  }
}
