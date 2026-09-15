import { describe, expect, it } from "vitest";
import { buildModelIdentityId } from "../../src/catalog/ids.js";
import type { DiscoveredProviderModel } from "../../src/catalog/provider-connections.js";
import type { ModelIdentity } from "../../src/catalog/types.js";
import { ModelIdentityStore } from "../../src/catalog/model-identities.js";

function explicitIdentity(canonicalName: string): ModelIdentity {
  return {
    modelIdentityId: buildModelIdentityId({ canonicalName }),
    canonicalName,
    aliases: [canonicalName.toLowerCase()],
  };
}

function discoveredModel(
  overrides: Partial<DiscoveredProviderModel> = {},
): DiscoveredProviderModel {
  return {
    providerId: "anthropic",
    connectionId: "conn-anthropic-main",
    providerModelId: "claude-sonnet-4",
    ...overrides,
  };
}

function binding(
  modelIdentityId: string,
  overrides: Partial<{
    providerId: string;
    connectionId: string;
    providerModelId: string;
  }> = {},
) {
  return {
    providerId: "anthropic",
    connectionId: "conn-anthropic-main",
    providerModelId: "claude-sonnet-4",
    modelIdentityId,
    ...overrides,
  } as const;
}

describe("ModelIdentityStore", () => {
  it("resolves explicit bindings to one canonical model across providers", () => {
    const store = new ModelIdentityStore();
    const identity = explicitIdentity("Claude Sonnet");
    store.upsertExplicit(identity);
    store.bindProviderModel(binding(identity.modelIdentityId));
    store.bindProviderModel(
      binding(identity.modelIdentityId, {
        providerId: "google",
        connectionId: "conn-google-main",
        providerModelId: "claude-sonnet-4",
      }),
    );

    expect(
      store.resolveProviderModel(
        "anthropic",
        "conn-anthropic-main",
        "claude-sonnet-4",
      ),
    ).toEqual(identity);
    expect(
      store.resolveProviderModel(
        "google",
        "conn-google-main",
        "claude-sonnet-4",
      ),
    ).toEqual(identity);
    expect(store.list()).toEqual([identity]);
  });

  it("keeps the same provider-native model ID distinct across connections", () => {
    const store = new ModelIdentityStore();
    const first = discoveredModel();
    const second = discoveredModel({ connectionId: "conn-anthropic-backup" });

    const firstIdentity = store.resolveProviderModel(
      first.providerId,
      first.connectionId,
      first.providerModelId,
    );
    const secondIdentity = store.resolveProviderModel(
      second.providerId,
      second.connectionId,
      second.providerModelId,
    );

    expect(secondIdentity.modelIdentityId).not.toBe(firstIdentity.modelIdentityId);
    expect(store.list()).toHaveLength(2);
  });

  it("keeps an unknown model distinct instead of guessing an existing family", () => {
    const store = new ModelIdentityStore();
    const known = explicitIdentity("Claude Sonnet");
    store.upsertExplicit(known);
    store.bindProviderModel(
      binding(known.modelIdentityId, {
        providerModelId: "claude-sonnet-4",
      }),
    );

    const unknown = store.resolveProviderModel(
      "anthropic",
      "conn-anthropic-main",
      "claude-sonnet-4-2026-09-15",
    );

    expect(unknown.modelIdentityId).not.toBe(known.modelIdentityId);
    expect(unknown.canonicalName).not.toBe(known.canonicalName);
  });

  it("preserves the same binding when a discovered model is rediscovered", () => {
    const store = new ModelIdentityStore();
    const model = discoveredModel();

    const first = store.resolveProviderModel(
      model.providerId,
      model.connectionId,
      model.providerModelId,
    );
    const rediscovered = store.resolveProviderModel(
      model.providerId,
      model.connectionId,
      model.providerModelId,
    );

    expect(rediscovered).toEqual(first);
    expect(store.list()).toHaveLength(1);
  });

  it("allows an explicit mapping to replace a provisional unknown binding", () => {
    const store = new ModelIdentityStore();
    const model = discoveredModel();
    const provisional = store.resolveProviderModel(
      model.providerId,
      model.connectionId,
      model.providerModelId,
    );
    const explicit = explicitIdentity("Claude Sonnet");
    store.upsertExplicit(explicit);

    store.bindProviderModel(
      binding(explicit.modelIdentityId, {
        providerId: model.providerId,
        connectionId: model.connectionId,
        providerModelId: model.providerModelId,
      }),
    );

    expect(
      store.resolveProviderModel(
        model.providerId,
        model.connectionId,
        model.providerModelId,
      ),
    ).toEqual(explicit);
    expect(store.list()).toContainEqual(provisional);

    const otherExplicit = explicitIdentity("Claude Opus");
    store.upsertExplicit(otherExplicit);
    expect(() =>
      store.bindProviderModel(
        binding(otherExplicit.modelIdentityId, {
          providerId: model.providerId,
          connectionId: model.connectionId,
          providerModelId: model.providerModelId,
        }),
      ),
    ).toThrow(/already bound/i);
  });

  it("does not replace a binding after its provisional identity becomes explicit", () => {
    const store = new ModelIdentityStore();
    const model = discoveredModel();
    const provisional = store.resolveProviderModel(
      model.providerId,
      model.connectionId,
      model.providerModelId,
    );
    store.upsertExplicit(provisional);

    const otherExplicit = explicitIdentity("Claude Opus");
    store.upsertExplicit(otherExplicit);

    expect(() =>
      store.bindProviderModel(
        binding(otherExplicit.modelIdentityId, {
          providerId: model.providerId,
          connectionId: model.connectionId,
          providerModelId: model.providerModelId,
        }),
      ),
    ).toThrow(/already bound/i);
    expect(
      store.resolveProviderModel(
        model.providerId,
        model.connectionId,
        model.providerModelId,
      ),
    ).toEqual(provisional);
  });

  it("retains identity history when later discovery omits an older model", () => {
    const store = new ModelIdentityStore();
    const historical = store.resolveProviderModel(
      "anthropic",
      "conn-anthropic-main",
      "claude-sonnet-3",
    );

    store.resolveProviderModel(
      "anthropic",
      "conn-anthropic-main",
      "claude-sonnet-4",
    );

    expect(store.list()).toContainEqual(historical);
  });
});
