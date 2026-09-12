import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RouterError } from "../../core/errors.js";

export const CAVOTI_ACK_VERSION = 1;
export const CAVOTI_PINNED_MODEL = "deepseek-v4.1-flash";
export const DEFAULT_CAVOTI_ACK_PATH = join(
  homedir(),
  "Library",
  "Application Support",
  "CMM",
  "SubscriptionRouter",
  "cavoti-payg-ack.json",
);

export interface CavotiSpendAcknowledgement {
  version: 1;
  provider: "cavoti";
  billing: "PAYG";
  model: "deepseek-v4.1-flash";
  automaticFallback: false;
}

function invalid(reason: string, ackPath?: string): never {
  throw new RouterError(
    "provider_auth_required",
    `Cavoti PAYG acknowledgement required: ${reason}`,
    ackPath ? { ackPath } : {},
  );
}

export function defaultCavotiAckPath(): string {
  return DEFAULT_CAVOTI_ACK_PATH;
}

export function parseCavotiSpendAcknowledgement(
  raw: unknown,
): CavotiSpendAcknowledgement {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return invalid("acknowledgement must be an object");
  }

  const value = raw as Record<string, unknown>;
  const allowed = new Set([
    "version",
    "provider",
    "billing",
    "model",
    "automaticFallback",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return invalid(`unknown field: ${key}`);
    }
  }
  if (Object.keys(value).length !== allowed.size) {
    return invalid("acknowledgement shape is incomplete");
  }
  if (value.version !== CAVOTI_ACK_VERSION) return invalid("version mismatch");
  if (value.provider !== "cavoti") return invalid("provider mismatch");
  if (value.billing !== "PAYG") return invalid("billing must explicitly be PAYG");
  if (value.model !== CAVOTI_PINNED_MODEL) {
    return invalid(`model must be exactly ${CAVOTI_PINNED_MODEL}`);
  }
  if (value.automaticFallback !== false) {
    return invalid("automaticFallback must be false");
  }

  return {
    version: 1,
    provider: "cavoti",
    billing: "PAYG",
    model: CAVOTI_PINNED_MODEL,
    automaticFallback: false,
  };
}

export function requireCavotiSpendAcknowledgement(
  path = DEFAULT_CAVOTI_ACK_PATH,
): CavotiSpendAcknowledgement {
  if (!existsSync(path)) {
    return invalid("acknowledgement file is absent", path);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return invalid("acknowledgement file is not valid JSON", path);
  }
  try {
    return parseCavotiSpendAcknowledgement(parsed);
  } catch (error) {
    if (error instanceof RouterError) {
      throw new RouterError(error.code, error.message, { ackPath: path });
    }
    throw error;
  }
}

export function hasCavotiSpendAcknowledgement(
  path = DEFAULT_CAVOTI_ACK_PATH,
): boolean {
  try {
    requireCavotiSpendAcknowledgement(path);
    return true;
  } catch {
    return false;
  }
}
