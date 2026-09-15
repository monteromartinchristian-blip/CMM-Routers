import { createHash } from "node:crypto";
import type { DiscoveredProviderModel } from "./provider-connections.js";
import { buildModelIdentityId } from "./ids.js";
import type { ModelIdentity } from "./types.js";

export interface ProviderModelIdentityBinding {
  providerId: string;
  connectionId: string;
  providerModelId: string;
  modelIdentityId: string;
}

type ProviderModelEvidence = Pick<
  DiscoveredProviderModel,
  "providerId" | "connectionId" | "providerModelId"
>;

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function snapshotIdentity(identity: ModelIdentity): ModelIdentity {
  assertNonEmpty(identity.modelIdentityId, "modelIdentityId");
  assertNonEmpty(identity.canonicalName, "canonicalName");
  if (!Array.isArray(identity.aliases)) {
    throw new TypeError("Model identity aliases must be an array");
  }

  const aliases = identity.aliases.map((alias) => {
    assertNonEmpty(alias, "model identity alias");
    return alias;
  });
  const snapshot: ModelIdentity = {
    modelIdentityId: identity.modelIdentityId,
    canonicalName: identity.canonicalName,
    aliases,
  };
  if (identity.family !== undefined) {
    assertNonEmpty(identity.family, "model identity family");
    snapshot.family = identity.family;
  }
  return snapshot;
}

function snapshotBinding(
  binding: ProviderModelIdentityBinding,
): ProviderModelIdentityBinding {
  assertNonEmpty(binding.providerId, "providerId");
  assertNonEmpty(binding.connectionId, "connectionId");
  assertNonEmpty(binding.providerModelId, "providerModelId");
  assertNonEmpty(binding.modelIdentityId, "modelIdentityId");
  return {
    providerId: binding.providerId,
    connectionId: binding.connectionId,
    providerModelId: binding.providerModelId,
    modelIdentityId: binding.modelIdentityId,
  };
}

function providerModelKey(
  providerId: string,
  connectionId: string,
  providerModelId: string,
): string {
  return [providerId, connectionId, providerModelId]
    .map((part) => `${part.length}:${part}`)
    .join("|");
}

function unknownIdentity(evidence: ProviderModelEvidence): ModelIdentity {
  const fingerprint = createHash("sha256")
    .update(providerModelKey(
      evidence.providerId,
      evidence.connectionId,
      evidence.providerModelId,
    ), "utf8")
    .digest("hex");
  const canonicalName = `Unknown provider model ${fingerprint}`;
  return {
    modelIdentityId: buildModelIdentityId({ canonicalName }),
    canonicalName,
    aliases: [evidence.providerModelId],
  };
}

export class ModelIdentityStore {
  private readonly identities = new Map<string, ModelIdentity>();
  private readonly bindings = new Map<string, ProviderModelIdentityBinding>();
  private readonly explicitIdentityIds = new Set<string>();
  private readonly provisionalIdentityIds = new Set<string>();

  upsertExplicit(identity: ModelIdentity): void {
    const snapshot = snapshotIdentity(identity);
    this.identities.set(snapshot.modelIdentityId, snapshot);
    this.explicitIdentityIds.add(snapshot.modelIdentityId);
    this.provisionalIdentityIds.delete(snapshot.modelIdentityId);
  }

  bindProviderModel(binding: ProviderModelIdentityBinding): void {
    const snapshot = snapshotBinding(binding);
    if (!this.identities.has(snapshot.modelIdentityId)) {
      throw new Error(`Unknown model identity: ${snapshot.modelIdentityId}`);
    }

    const key = providerModelKey(
      snapshot.providerId,
      snapshot.connectionId,
      snapshot.providerModelId,
    );
    const existing = this.bindings.get(key);
    if (existing !== undefined && existing.modelIdentityId !== snapshot.modelIdentityId) {
      const canReplaceProvisional =
        this.provisionalIdentityIds.has(existing.modelIdentityId) &&
        this.explicitIdentityIds.has(snapshot.modelIdentityId);
      if (!canReplaceProvisional) {
        throw new Error("Provider model is already bound to another model identity");
      }
    }
    this.bindings.set(key, snapshot);
  }

  resolveProviderModel(
    providerId: string,
    connectionId: string,
    providerModelId: string,
  ): ModelIdentity {
    assertNonEmpty(providerId, "providerId");
    assertNonEmpty(connectionId, "connectionId");
    assertNonEmpty(providerModelId, "providerModelId");

    const key = providerModelKey(providerId, connectionId, providerModelId);
    const existingBinding = this.bindings.get(key);
    if (existingBinding !== undefined) {
      const identity = this.identities.get(existingBinding.modelIdentityId);
      if (identity === undefined) {
        throw new Error(`Unknown model identity: ${existingBinding.modelIdentityId}`);
      }
      return snapshotIdentity(identity);
    }

    const identity = snapshotIdentity(
      unknownIdentity({ providerId, connectionId, providerModelId }),
    );
    this.identities.set(identity.modelIdentityId, identity);
    this.provisionalIdentityIds.add(identity.modelIdentityId);
    this.bindings.set(key, {
      providerId,
      connectionId,
      providerModelId,
      modelIdentityId: identity.modelIdentityId,
    });
    return snapshotIdentity(identity);
  }

  list(): ModelIdentity[] {
    return [...this.identities.values()].map(snapshotIdentity);
  }
}
