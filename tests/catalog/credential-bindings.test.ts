import { describe, expect, it } from "vitest";
import type {
  ExecutionCredentialBinding,
  ObservabilityCredentialBinding,
  SecretMaterialRef,
} from "../../src/catalog/types.js";
import { CredentialBindingStore } from "../../src/catalog/credential-bindings.js";
import {
  InMemorySecureCredentialResolver,
  type SecureCredentialResolver,
} from "../../src/catalog/secure-credential-resolver.js";

const executionBinding = (
  overrides: Partial<ExecutionCredentialBinding> = {},
): ExecutionCredentialBinding => ({
  bindingId: "execution-main",
  providerId: "openrouter",
  accountId: "account-main",
  productId: "product-api",
  secretRef: "keychain://openrouter/main",
  purpose: "execution",
  enabled: true,
  ...overrides,
});

const observabilityBinding = (
  overrides: Partial<ObservabilityCredentialBinding> = {},
): ObservabilityCredentialBinding => ({
  bindingId: "observability-main",
  providerId: "openrouter",
  accountId: "account-main",
  productId: "product-api",
  secretRef: "keychain://openrouter/main",
  purpose: "observability",
  enabled: true,
  ...overrides,
});

describe("CredentialBindingStore", () => {
  it("does not satisfy an execution lookup from an observability-only binding", () => {
    const store = new CredentialBindingStore();
    const binding = observabilityBinding();

    store.addObservability(binding);

    expect(store.getObservability(binding.bindingId)).toEqual(binding);
    expect(store.getExecution(binding.bindingId)).toBeUndefined();
  });

  it("does not create an observability binding when an execution binding is added", () => {
    const store = new CredentialBindingStore();
    const binding = executionBinding();

    store.addExecution(binding);

    expect(store.getExecution(binding.bindingId)).toEqual(binding);
    expect(store.getObservability(binding.bindingId)).toBeUndefined();
  });

  it("allows one physical secret reference to have two explicit bindings", () => {
    const store = new CredentialBindingStore();
    const physicalSecret: SecretMaterialRef = {
      secretRef: "keychain://openrouter/main",
      storageKind: "keychain",
    };
    const execution = executionBinding({
      bindingId: "execution-main",
      secretRef: physicalSecret.secretRef,
    });
    const observability = observabilityBinding({
      bindingId: "observability-main",
      secretRef: physicalSecret.secretRef,
    });

    store.addExecution(execution);
    store.addObservability(observability);

    expect(store.getExecution(execution.bindingId)).toEqual(execution);
    expect(store.getObservability(observability.bindingId)).toEqual(observability);
    expect(store.getExecution(execution.bindingId)?.secretRef).toBe(
      store.getObservability(observability.bindingId)?.secretRef,
    );
  });

  it("removes only the observability binding when observability is removed", () => {
    const store = new CredentialBindingStore();
    const execution = executionBinding();
    const observability = observabilityBinding();
    store.addExecution(execution);
    store.addObservability(observability);

    store.removeObservability(observability.bindingId);

    expect(store.getObservability(observability.bindingId)).toBeUndefined();
    expect(store.getExecution(execution.bindingId)).toEqual(execution);
  });

  it("removes only the execution binding when execution is removed", () => {
    const store = new CredentialBindingStore();
    const execution = executionBinding();
    const observability = observabilityBinding();
    store.addExecution(execution);
    store.addObservability(observability);

    store.removeExecution(execution.bindingId);

    expect(store.getExecution(execution.bindingId)).toBeUndefined();
    expect(store.getObservability(observability.bindingId)).toEqual(observability);
  });

  it("stores only binding metadata and never a raw secret value", () => {
    const store = new CredentialBindingStore();
    const rawSecret = "sk-test-raw-secret-value";
    const execution = {
      ...executionBinding(),
      secret: rawSecret,
    } as unknown as ExecutionCredentialBinding;
    const observability = {
      ...observabilityBinding(),
      token: rawSecret,
    } as unknown as ObservabilityCredentialBinding;

    store.addExecution(execution);
    store.addObservability(observability);

    const storedExecution = store.getExecution(execution.bindingId)!;
    const storedObservability = store.getObservability(observability.bindingId)!;
    expect(storedExecution).not.toHaveProperty("secret");
    expect(storedObservability).not.toHaveProperty("token");
    expect(JSON.stringify(storedExecution)).not.toContain(rawSecret);
    expect(JSON.stringify(storedObservability)).not.toContain(rawSecret);
  });

  it("keeps execution and observability add methods type-separated", () => {
    if (false) {
      const store = new CredentialBindingStore();
      const observability = observabilityBinding();
      // @ts-expect-error An observability binding cannot authorize execution.
      store.addExecution(observability);
      // @ts-expect-error An execution binding cannot authorize observability.
      store.addObservability(executionBinding());
      // @ts-expect-error Lookup accepts a binding ID, never a binding object.
      store.getExecution(observability);
    }

    expect(true).toBe(true);
  });
});

describe("InMemorySecureCredentialResolver", () => {
  it("resolves test secret material by reference without involving bindings", async () => {
    const resolver: SecureCredentialResolver = new InMemorySecureCredentialResolver(
      new Map([["keychain://openrouter/main", "sk-test-resolved-secret"]]),
    );

    await expect(resolver.resolve("keychain://openrouter/main")).resolves.toEqual({
      value: "sk-test-resolved-secret",
    });
    await expect(resolver.resolve("keychain://openrouter/missing")).rejects.toThrow(
      /secret material not found/i,
    );
  });
});
