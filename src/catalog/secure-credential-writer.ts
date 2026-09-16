export interface SecureCredentialWriteResult {
  secretRef: string;
  hint?: string;
}

export interface SecureCredentialWriter {
  write(bindingId: string, secret: string): Promise<SecureCredentialWriteResult>;
  remove(secretRef: string): Promise<void>;
}
