import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sharedConfigSchema, localConfigSchema, type SharedConfig } from "./schema.js";
import { getMachineId } from "./machine-id.js";
import { assertNoPaygFallback } from "../security/payg-guard.js";

export interface RouterConfig extends SharedConfig {
  machineId: string;
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
