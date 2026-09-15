export interface ResolvedSecret {
  value: string;
}

export interface SecureCredentialResolver {
  resolve(secretRef: string): Promise<ResolvedSecret>;
}

/**
 * Deterministic test infrastructure only.
 *
 * Production composition must provide a resolver backed by the platform's
 * existing secure credential mechanism instead of using this in-memory map.
 */
export class InMemorySecureCredentialResolver
  implements SecureCredentialResolver
{
  private readonly values: Map<string, string>;

  constructor(
    initial: ReadonlyMap<string, string> | Readonly<Record<string, string>> =
      new Map(),
  ) {
    this.values =
      initial instanceof Map
        ? new Map(initial)
        : new Map(Object.entries(initial));
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
