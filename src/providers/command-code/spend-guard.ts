import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RouterError } from "../../core/errors.js";

export const DEFAULT_ACK_PATH = join(
  homedir(),
  "Library",
  "Application Support",
  "CMM",
  "SubscriptionRouter",
  "command-code-spend-ack.json",
);

export interface SpendAcknowledgement {
  version: 1;
  plan: "GOAT";
  autoTopUpDisabled: true;
  allowOnDemandCredits: false;
}

const FORBIDDEN_SPEND_PATHS = ["/extra", "extra", "purchase", "top-up", "topup", "top_up"];

export function assertNoSpendPath(path: string): void {
  const lowered = path.toLowerCase();
  for (const forbidden of FORBIDDEN_SPEND_PATHS) {
    if (lowered.includes(forbidden)) {
      throw new RouterError(
        "provider_protocol_error",
        `Forbidden Command Code spending path blocked: ${path}`,
      );
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSpendAcknowledgement(raw: unknown): SpendAcknowledgement {
  if (!isRecord(raw)) {
    throw new RouterError(
      "provider_auth_required",
      "Command Code spending acknowledgement invalid: expected an object",
    );
  }
  const allowedKeys = new Set([
    "version",
    "plan",
    "autoTopUpDisabled",
    "allowOnDemandCredits",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      throw new RouterError(
        "provider_auth_required",
        `Command Code spending acknowledgement has unknown field: ${key}`,
      );
    }
  }
  if (raw.version !== 1) {
    throw new RouterError(
      "provider_auth_required",
      "Command Code spending acknowledgement requires version 1",
    );
  }
  if (raw.plan !== "GOAT") {
    throw new RouterError(
      "provider_auth_required",
      'Command Code spending acknowledgement requires plan "GOAT"',
    );
  }
  if (raw.autoTopUpDisabled !== true) {
    throw new RouterError(
      "provider_auth_required",
      "Command Code requires autoTopUpDisabled=true acknowledgement",
    );
  }
  if (raw.allowOnDemandCredits !== false) {
    throw new RouterError(
      "provider_auth_required",
      "Command Code requires allowOnDemandCredits=false acknowledgement",
    );
  }
  return {
    version: 1,
    plan: "GOAT",
    autoTopUpDisabled: true,
    allowOnDemandCredits: false,
  };
}

export function loadSpendAcknowledgement(
  ackPath: string = DEFAULT_ACK_PATH,
): SpendAcknowledgement {
  if (!existsSync(ackPath)) {
    throw new RouterError(
      "provider_auth_required",
      "Command Code spending acknowledgement missing: create the machine-local GOAT ack file",
      { ackPath },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(ackPath, "utf-8")) as unknown;
  } catch {
    throw new RouterError(
      "provider_auth_required",
      "Command Code spending acknowledgement is not valid JSON",
      { ackPath },
    );
  }
  return parseSpendAcknowledgement(parsed);
}

export function requireSpendAcknowledgement(
  ackPath: string = DEFAULT_ACK_PATH,
): SpendAcknowledgement {
  return loadSpendAcknowledgement(ackPath);
}
