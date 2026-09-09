import type { DiscoveredModel, ProviderId, RouterRequest } from "./model.js";
import type { RouterEvent } from "./events.js";
import type { ProviderHealth } from "./provider.js";
import { RouterError } from "./errors.js";

export const WIRE_VERSION = 1 as const;

export type WorkerOperation = "run" | "cancel" | "discover" | "health";

export interface WorkerRequestEnvelope {
  version: 1;
  requestId: string;
  provider: ProviderId;
  operation: WorkerOperation;
  payload: RouterRequest | { requestId: string } | null;
}

export interface WorkerEventEnvelope {
  version: 1;
  requestId: string;
  sequence: number;
  event: RouterEvent;
}

export interface WorkerModelsEnvelope {
  version: 1;
  provider: ProviderId;
  models: DiscoveredModel[];
}

export interface WorkerHealthEnvelope {
  version: 1;
  provider: ProviderId;
  health: ProviderHealth;
}

export interface WorkerCancelEnvelope {
  version: 1;
  requestId: string;
  provider: ProviderId;
}

export interface WorkerErrorEnvelope {
  version: 1;
  requestId: string;
  error: { code: string; message: string; provider?: string };
}

const FORBIDDEN_WIRE_KEYS = [
  "authorization",
  "api_key",
  "apikey",
  "access_token",
  "refresh_token",
  "oauth",
  "secret",
  "cookie",
  "token",
];

function assertNoSecrets(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoSecrets(item, `${path}[${index}]`);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_WIRE_KEYS.includes(key.toLowerCase())) {
        throw new RouterError(
          "provider_protocol_error",
          `Wire envelope must not carry secret field: ${path}.${key}`,
        );
      }
      assertNoSecrets(entry, `${path}.${key}`);
    }
  }
}

export function serializeEnvelope(envelope: unknown): string {
  assertNoSecrets(envelope);
  return JSON.stringify(envelope);
}

function assertVersion(envelope: { version?: unknown }, what: string): void {
  if (envelope.version !== WIRE_VERSION) {
    throw new RouterError(
      "provider_protocol_error",
      `Unsupported ${what} wire version: ${String(envelope.version)}`,
    );
  }
}

export function parseRequestEnvelope(raw: string): WorkerRequestEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new RouterError("provider_protocol_error", "Wire request is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new RouterError("provider_protocol_error", "Wire request must be an object");
  }
  const envelope = parsed as Record<string, unknown>;
  assertVersion(envelope as { version?: unknown }, "request");
  if (typeof envelope.requestId !== "string" || envelope.requestId.length === 0) {
    throw new RouterError("provider_protocol_error", "Wire request needs a requestId");
  }
  if (
    envelope.provider !== "chatgpt" &&
    envelope.provider !== "claude" &&
    envelope.provider !== "google" &&
    envelope.provider !== "command-code"
  ) {
    throw new RouterError("provider_protocol_error", "Wire request has unknown provider");
  }
  if (
    envelope.operation !== "run" &&
    envelope.operation !== "cancel" &&
    envelope.operation !== "discover" &&
    envelope.operation !== "health"
  ) {
    throw new RouterError("provider_protocol_error", "Wire request has unknown operation");
  }
  assertNoSecrets(envelope);
  return envelope as unknown as WorkerRequestEnvelope;
}

export function parseEventEnvelope(raw: string): WorkerEventEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new RouterError("provider_protocol_error", "Wire event is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new RouterError("provider_protocol_error", "Wire event must be an object");
  }
  const envelope = parsed as Record<string, unknown>;
  assertVersion(envelope as { version?: unknown }, "event");
  if (typeof envelope.requestId !== "string" || typeof envelope.sequence !== "number") {
    throw new RouterError("provider_protocol_error", "Wire event needs requestId and sequence");
  }
  if (!envelope.event || typeof envelope.event !== "object") {
    throw new RouterError("provider_protocol_error", "Wire event needs an event payload");
  }
  assertNoSecrets(envelope);
  return envelope as unknown as WorkerEventEnvelope;
}

export function safeRouterError(error: unknown): { code: string; message: string; provider?: string } {
  if (error instanceof RouterError) {
    const provider = typeof error.meta.provider === "string" ? error.meta.provider : undefined;
    return {
      code: error.code,
      message: error.message.slice(0, 300),
      ...(provider ? { provider } : {}),
    };
  }
  return { code: "router_internal_error", message: "Internal error" };
}
