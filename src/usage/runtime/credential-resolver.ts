import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SecureCredentialResolver } from "./integration-catalog.js";

const execFileAsync = promisify(execFile);

export type KeychainLookup = (service: string, account: string) => Promise<string | undefined>;

export interface LocalSecureCredentialResolverOptions {
  env?: NodeJS.ProcessEnv;
  keychainLookup?: KeychainLookup;
}

async function macOsKeychainLookup(service: string, account: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/security",
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      { encoding: "utf8", maxBuffer: 64 * 1024 },
    );
    const value = stdout.trim();
    return value.length === 0 ? undefined : value;
  } catch {
    return undefined;
  }
}

export class LocalSecureCredentialResolver implements SecureCredentialResolver {
  private readonly env: NodeJS.ProcessEnv;
  private readonly keychainLookup: KeychainLookup;

  constructor(options: LocalSecureCredentialResolverOptions = {}) {
    this.env = options.env ?? process.env;
    this.keychainLookup = options.keychainLookup ?? macOsKeychainLookup;
  }

  async resolve(reference: string): Promise<string | undefined> {
    let url: URL;
    try {
      url = new URL(reference);
    } catch {
      throw new Error("Usage credential must be a secure reference with an explicit scheme");
    }

    if (url.protocol === "env:") {
      const name = decodeURIComponent(url.hostname || url.pathname.replace(/^\//, ""));
      if (name.length === 0) throw new Error("Environment credential reference is missing a variable name");
      const value = this.env[name]?.trim();
      return value && value.length > 0 ? value : undefined;
    }

    if (url.protocol === "keychain:") {
      const service = decodeURIComponent(url.hostname);
      const account = decodeURIComponent(url.pathname.replace(/^\//, ""));
      if (service.length === 0 || account.length === 0) {
        throw new Error("Keychain credential reference must include service and account");
      }
      return this.keychainLookup(service, account);
    }

    throw new Error(`Unsupported usage credential reference scheme: ${url.protocol}`);
  }
}
