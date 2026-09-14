import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SERVICE = "CMM Usage";

export interface CredentialWriteResult {
  credentialRef: string;
  hint?: string;
}

export interface CredentialWriter {
  write(instanceId: string, secret: string): Promise<CredentialWriteResult>;
  remove(reference: string): Promise<void>;
}

export type KeychainWrite = (service: string, account: string, secret: string) => Promise<void>;
export type KeychainRemove = (service: string, account: string) => Promise<void>;

async function macOsKeychainWrite(service: string, account: string, secret: string): Promise<void> {
  await execFileAsync(
    "/usr/bin/security",
    ["add-generic-password", "-U", "-s", service, "-a", account, "-w", secret],
    { encoding: "utf8", maxBuffer: 64 * 1024 },
  );
}

async function macOsKeychainRemove(service: string, account: string): Promise<void> {
  try {
    await execFileAsync(
      "/usr/bin/security",
      ["delete-generic-password", "-s", service, "-a", account],
      { encoding: "utf8", maxBuffer: 64 * 1024 },
    );
  } catch {
    // Missing entries are already in the desired state.
  }
}

function keychainTarget(reference: string): { service: string; account: string } {
  const url = new URL(reference);
  if (url.protocol !== "keychain:") throw new Error("Credential writer can remove only Keychain references");
  const service = decodeURIComponent(url.hostname);
  const account = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (service.length === 0 || account.length === 0) throw new Error("Invalid Keychain credential reference");
  return { service, account };
}

export class LocalSecureCredentialWriter implements CredentialWriter {
  constructor(
    private readonly keychainWrite: KeychainWrite = macOsKeychainWrite,
    private readonly keychainRemove: KeychainRemove = macOsKeychainRemove,
  ) {}

  async write(instanceId: string, secret: string): Promise<CredentialWriteResult> {
    const value = secret.trim();
    if (value.length === 0) throw new Error("Credential value must not be empty");
    await this.keychainWrite(SERVICE, instanceId, value);
    return {
      credentialRef: `keychain://CMM%20Usage/${encodeURIComponent(instanceId)}`,
      hint: value.length <= 4 ? "••••" : `••••${value.slice(-4)}`,
    };
  }

  async remove(reference: string): Promise<void> {
    const target = keychainTarget(reference);
    await this.keychainRemove(target.service, target.account);
  }
}
