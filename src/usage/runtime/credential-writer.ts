import {
  LocalSecureCredentialWriter as CatalogLocalSecureCredentialWriter,
  type KeychainRemove,
  type KeychainWrite,
  type SecureCredentialWriter,
} from "../../catalog/local-secure-credential-writer.js";

export interface CredentialWriteResult {
  credentialRef: string;
  hint?: string;
}

export interface CredentialWriter {
  write(instanceId: string, secret: string): Promise<CredentialWriteResult>;
  remove(reference: string): Promise<void>;
}

export class LocalSecureCredentialWriter implements CredentialWriter {
  private readonly delegate: SecureCredentialWriter;

  constructor(
    keychainWrite?: KeychainWrite,
    keychainRemove?: KeychainRemove,
  ) {
    this.delegate = new CatalogLocalSecureCredentialWriter(keychainWrite, keychainRemove);
  }

  async write(instanceId: string, secret: string): Promise<CredentialWriteResult> {
    const written = await this.delegate.write(instanceId, secret);
    return {
      credentialRef: written.secretRef,
      ...(written.hint === undefined ? {} : { hint: written.hint }),
    };
  }

  async remove(reference: string): Promise<void> {
    await this.delegate.remove(reference);
  }
}

export type { KeychainWrite, KeychainRemove } from "../../catalog/local-secure-credential-writer.js";
