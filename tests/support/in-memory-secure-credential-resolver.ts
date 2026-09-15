import type {
  ResolvedSecret,
  SecureCredentialResolver,
} from "../../src/catalog/secure-credential-resolver.js";

/** Deterministic test infrastructure; never use this in production composition. */
export class InMemorySecureCredentialResolver
  implements SecureCredentialResolver
{
  private readonly values = new Map<string, string>();

  constructor(initial: ReadonlyMap<string, string> = new Map()) {
    for (const [secretRef, value] of initial.entries()) {
      this.values.set(secretRef, value);
    }
  }

  async resolve(secretRef: string): Promise<ResolvedSecret> {
    if (typeof secretRef !== "string" || secretRef.length === 0) {
      throw new TypeError("Secret reference must be a non-empty string");
    }

    const value = this.values.get(secretRef);
    if (value === undefined) {
      throw new Error("Secret material not found");
    }

    return { value };
  }
}
