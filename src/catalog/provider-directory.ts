import type { ProviderDefinition } from "./types.js";

export class ProviderDirectory {
  private readonly definitions = new Map<string, ProviderDefinition>();

  register(definition: ProviderDefinition): void {
    if (this.definitions.has(definition.providerId)) {
      throw new Error(`Duplicate provider id: ${definition.providerId}`);
    }
    this.definitions.set(definition.providerId, definition);
  }

  get(providerId: string): ProviderDefinition | undefined {
    return this.definitions.get(providerId);
  }

  list(): ProviderDefinition[] {
    return [...this.definitions.values()];
  }

  has(providerId: string): boolean {
    return this.definitions.has(providerId);
  }
}
