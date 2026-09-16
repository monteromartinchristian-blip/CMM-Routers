import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  SecureCredentialWriter,
  SecureCredentialWriteResult,
} from "./secure-credential-writer.js";

const execFileAsync = promisify(execFile);
const SERVICE = "CMM Usage";

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

function keychainTarget(secretRef: string): { service: string; account: string } {
  const url = new URL(secretRef);
  if (url.protocol !== "keychain:") {
    throw new Error("Secure credential writer can remove only Keychain references");
  }
  const service = decodeURIComponent(url.hostname);
  const account = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (service.length === 0 || account.length === 0) {
    throw new Error("Invalid Keychain credential reference");
  }
  return { service, account };
}

export class LocalSecureCredentialWriter implements SecureCredentialWriter {
  constructor(
    private readonly keychainWrite: KeychainWrite = macOsKeychainWrite,
    private readonly keychainRemove: KeychainRemove = macOsKeychainRemove,
  ) {}

  async write(bindingId: string, secret: string): Promise<SecureCredentialWriteResult> {
    const value = secret.trim();
    if (value.length === 0) throw new Error("Credential value must not be empty");
    await this.keychainWrite(SERVICE, bindingId, value);
    return {
      secretRef: `keychain://CMM%20Usage/${encodeURIComponent(bindingId)}`,
      hint: value.length <= 4 ? "••••" : `••••${value.slice(-4)}`,
    };
  }

  async remove(secretRef: string): Promise<void> {
    const target = keychainTarget(secretRef);
    await this.keychainRemove(target.service, target.account);
  }
}

export type { SecureCredentialWriter, SecureCredentialWriteResult } from "./secure-credential-writer.js";
