import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { sharedConfigSchema, localConfigSchema, type SharedConfig } from "./schema.js";
import { getMachineId } from "./machine-id.js";
import { assertNoPaygFallback } from "../security/payg-guard.js";

export interface RouterConfig extends SharedConfig {
  machineId: string;
}

const BOOTSTRAP_SHARED_CONFIG = {
  mode: "standalone",
  host: "127.0.0.1",
  port: 8790,
  bearerSecretEnv: "CMM_ROUTER_TOKEN",
  providers: {
    chatgpt: { enabled: true },
    claude: { enabled: true },
    google: { enabled: true },
    "command-code": {
      enabled: false,
      baseUrl: "https://api.commandcode.ai/provider/v1",
      secretEnv: "COMMAND_CODE_SECRET",
    },
  },
} as const;

/**
 * Bootstrap a fresh config dir from the documented defaults. Returns true
 * when shared.json was created, false when one already existed. Never
 * overwrites an existing file and never writes secrets.
 */
export function ensureSharedConfig(configDir?: string): boolean {
  const baseDir = configDir ?? resolve(process.cwd(), "config");
  const sharedPath = resolve(baseDir, "shared.json");
  if (existsSync(sharedPath)) return false;
  writeFileSync(sharedPath, `${JSON.stringify(BOOTSTRAP_SHARED_CONFIG, null, 2)}\n`, "utf-8");
  return true;
}

export function loadConfig(configDir?: string): RouterConfig {
  assertNoPaygFallback(process.env);

  const baseDir = configDir ?? resolve(process.cwd(), "config");
  const sharedPath = resolve(baseDir, "shared.json");

  let sharedRaw: unknown;
  try {
    const content = readFileSync(sharedPath, "utf-8");
    sharedRaw = JSON.parse(content);
  } catch {
    sharedRaw = {};
  }

  const shared = sharedConfigSchema.parse(sharedRaw);

  const localPath = resolve(baseDir, "local.json");
  let localRaw: unknown = {};
  try {
    const content = readFileSync(localPath, "utf-8");
    localRaw = JSON.parse(content);
  } catch {
    // Local config is optional
  }

  localConfigSchema.parse(localRaw);

  const machineId = getMachineId();

  return {
    ...shared,
    machineId,
  };
}
