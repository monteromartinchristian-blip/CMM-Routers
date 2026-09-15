export interface ResolvedSecret {
  value: string;
}

export interface SecureCredentialResolver {
  resolve(secretRef: string): Promise<ResolvedSecret>;
}
