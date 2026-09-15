import type {
  ExecutionCredentialBinding,
  ObservabilityCredentialBinding,
} from "./types.js";

type BindingPurpose = "execution" | "observability";
type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function assertBindingId(bindingId: string): void {
  if (typeof bindingId !== "string" || bindingId.length === 0) {
    throw new TypeError("Credential binding ID must be a non-empty string");
  }
}

function assertBinding(
  binding: unknown,
  expectedPurpose: BindingPurpose,
): asserts binding is
  | ExecutionCredentialBinding
  | ObservabilityCredentialBinding {
  if (!isRecord(binding)) {
    throw new TypeError("Credential binding must be an object");
  }

  if (binding.purpose !== expectedPurpose) {
    throw new TypeError(`Expected an ${expectedPurpose} credential binding`);
  }

  for (const field of ["bindingId", "providerId", "secretRef"]) {
    if (typeof binding[field] !== "string" || binding[field].length === 0) {
      throw new TypeError(`Credential binding ${field} must be a non-empty string`);
    }
  }

  for (const field of ["accountId", "productId"]) {
    if (
      binding[field] !== undefined &&
      (typeof binding[field] !== "string" || binding[field].length === 0)
    ) {
      throw new TypeError(`Credential binding ${field} must be a non-empty string`);
    }
  }

  if (typeof binding.enabled !== "boolean") {
    throw new TypeError("Credential binding enabled must be a boolean");
  }
}

function snapshotExecutionBinding(
  binding: ExecutionCredentialBinding,
): ExecutionCredentialBinding {
  assertBinding(binding, "execution");
  const snapshot: ExecutionCredentialBinding = {
    bindingId: binding.bindingId,
    providerId: binding.providerId,
    secretRef: binding.secretRef,
    purpose: "execution",
    enabled: binding.enabled,
  };
  if (binding.accountId !== undefined) snapshot.accountId = binding.accountId;
  if (binding.productId !== undefined) snapshot.productId = binding.productId;
  return snapshot;
}

function snapshotObservabilityBinding(
  binding: ObservabilityCredentialBinding,
): ObservabilityCredentialBinding {
  assertBinding(binding, "observability");
  const snapshot: ObservabilityCredentialBinding = {
    bindingId: binding.bindingId,
    providerId: binding.providerId,
    secretRef: binding.secretRef,
    purpose: "observability",
    enabled: binding.enabled,
  };
  if (binding.accountId !== undefined) snapshot.accountId = binding.accountId;
  if (binding.productId !== undefined) snapshot.productId = binding.productId;
  return snapshot;
}

/**
 * Stores authorization bindings in separate purpose-specific indexes.
 *
 * The store contains secret references and authorization metadata only. It
 * deliberately has no access to secret material and never copies unknown
 * runtime fields from a caller-owned object.
 */
export class CredentialBindingStore {
  private readonly executionBindings = new Map<
    string,
    ExecutionCredentialBinding
  >();

  private readonly observabilityBindings = new Map<
    string,
    ObservabilityCredentialBinding
  >();

  addExecution(binding: ExecutionCredentialBinding): void {
    const snapshot = snapshotExecutionBinding(binding);
    if (this.executionBindings.has(snapshot.bindingId)) {
      throw new Error("Execution credential binding already exists");
    }
    this.executionBindings.set(snapshot.bindingId, snapshot);
  }

  addObservability(binding: ObservabilityCredentialBinding): void {
    const snapshot = snapshotObservabilityBinding(binding);
    if (this.observabilityBindings.has(snapshot.bindingId)) {
      throw new Error("Observability credential binding already exists");
    }
    this.observabilityBindings.set(snapshot.bindingId, snapshot);
  }

  getExecution(bindingId: string): ExecutionCredentialBinding | undefined {
    assertBindingId(bindingId);
    const binding = this.executionBindings.get(bindingId);
    return binding === undefined ? undefined : snapshotExecutionBinding(binding);
  }

  getObservability(
    bindingId: string,
  ): ObservabilityCredentialBinding | undefined {
    assertBindingId(bindingId);
    const binding = this.observabilityBindings.get(bindingId);
    return binding === undefined
      ? undefined
      : snapshotObservabilityBinding(binding);
  }

  removeExecution(bindingId: string): boolean {
    assertBindingId(bindingId);
    return this.executionBindings.delete(bindingId);
  }

  removeObservability(bindingId: string): boolean {
    assertBindingId(bindingId);
    return this.observabilityBindings.delete(bindingId);
  }
}
