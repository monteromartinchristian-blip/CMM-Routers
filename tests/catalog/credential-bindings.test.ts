import { describe, expect, it } from "vitest";
import type {
  ExecutionCredentialBinding,
  ObservabilityCredentialBinding,
  SecretMaterialRef,
} from "../../src/catalog/types.js";
import { CredentialBindingStore } from "../../src/catalog/credential-bindings.js";
import type { SecureCredentialResolver } from "../../src/catalog/secure-credential-resolver.js";
import { InMemorySecureCredentialResolver } from "../support/in-memory-secure-credential-resolver.js";

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

  it("rejects a forged observability binding passed to addExecution at runtime", () => {
    const store = new CredentialBindingStore();
    const forged = observabilityBinding({
      bindingId: "forged-execution",
    }) as unknown as ExecutionCredentialBinding;

    expect(() => store.addExecution(forged)).toThrow(
      /expected an execution credential binding/i,
    );
    expect(store.getExecution(forged.bindingId)).toBeUndefined();
  });

  it("rejects a forged execution binding passed to addObservability at runtime", () => {
    const store = new CredentialBindingStore();
    const forged = executionBinding({
      bindingId: "forged-observability",
    }) as unknown as ObservabilityCredentialBinding;

    expect(() => store.addObservability(forged)).toThrow(
      /expected an observability credential binding/i,
    );
    expect(store.getObservability(forged.bindingId)).toBeUndefined();
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
    const rawSecret = "fixture-test-raw-secret-value";
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

  it("snapshots execution registration input and get results", () => {
    const store = new CredentialBindingStore();
    const input = executionBinding();
    store.addExecution(input);

    input.providerId = "mutated-provider";
    input.accountId = "mutated-account";
    input.secretRef = "keychain://mutated/reference";
    input.enabled = false;

    const returned = store.getExecution(input.bindingId)!;
    returned.providerId = "mutated-from-get";
    returned.accountId = "mutated-from-get";
    returned.secretRef = "keychain://mutated/from-get";
    returned.enabled = false;

    expect(store.getExecution(input.bindingId)).toEqual(
      executionBinding(),
    );
  });

  it("snapshots observability registration input and get results", () => {
    const store = new CredentialBindingStore();
    const input = observabilityBinding();
    store.addObservability(input);

    input.providerId = "mutated-provider";
    input.productId = "mutated-product";
    input.secretRef = "keychain://mutated/reference";
    input.enabled = false;

    const returned = store.getObservability(input.bindingId)!;
    returned.providerId = "mutated-from-get";
    returned.productId = "mutated-from-get";
    returned.secretRef = "keychain://mutated/from-get";
    returned.enabled = false;

    expect(store.getObservability(input.bindingId)).toEqual(
      observabilityBinding(),
    );
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
      new Map([["keychain://openrouter/main", "fixture-test-resolved-secret"]]),
    );

    await expect(resolver.resolve("keychain://openrouter/main")).resolves.toEqual({
      value: "fixture-test-resolved-secret",
    });
    await expect(resolver.resolve("keychain://openrouter/missing")).rejects.toThrow(
      /secret material not found/i,
    );
  });
});
