import { createHash } from "node:crypto";

export interface ConnectionIdInput {
  providerId: string;
  accountId?: string;
  productId?: string;
  connectionKind?: string;
  profileRef?: string;
  endpointRef?: string;
}

export interface ModelIdentityIdInput {
  canonicalName: string;
}

export interface RouteIdInput {
  providerId: string;
  connectionId: string;
  providerModelId: string;
  executionProfile: string;
}

const HASH_LENGTH = 16;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const PATH_TRAVERSAL_PATTERN = /(?:^|\/)\.\.?(?:\/|$)/u;
const UNSAFE_CHARACTER_PATTERN = /[\\?#[\]{}<>"'`]/u;
const STABLE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u;

function normalizePart(
  value: string,
  field: string,
  options: { allowSlash?: boolean } = {},
): string {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string`);
  }

  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error(`${field} must not be empty`);
  }
  if (normalized.length > 512) {
    throw new Error(`${field} is too long`);
  }
  if (CONTROL_CHARACTER_PATTERN.test(normalized)) {
    throw new Error(`${field} contains a control character`);
  }
  if (PATH_TRAVERSAL_PATTERN.test(normalized)) {
    throw new Error(`${field} contains an unsafe path segment`);
  }
  if (!options.allowSlash && normalized.includes("/")) {
    throw new Error(`${field} contains an unsafe separator`);
  }
  if (UNSAFE_CHARACTER_PATTERN.test(normalized)) {
    throw new Error(`${field} contains an unsafe character`);
  }

  return normalized;
}

function optionalPart(value: string | undefined, field: string): string | undefined {
  return value === undefined ? undefined : normalizePart(value, field);
}

function canonicalize(parts: ReadonlyArray<readonly [string, string | undefined]>): string {
  return parts
    .map(([key, value]) => {
      const encodedKey = `${key.length}:${key}`;
      const encodedValue = value === undefined ? "-" : `${value.length}:${value}`;
      return `${encodedKey}=${encodedValue}`;
    })
    .join("|");
}

function buildOpaqueId(prefix: string, identity: string): string {
  const digest = createHash("sha256")
    .update(identity, "utf8")
    .digest("hex")
    .slice(0, HASH_LENGTH);
  const value = `${prefix}_${digest}`;
  return assertStableId(value, prefix);
}

/**
 * Validate an opaque stable ID before it crosses a domain boundary.
 * The error deliberately excludes the supplied value so a mistaken secret
 * cannot be echoed through diagnostics.
 */
export function assertStableId(value: string, kind: string): string {
  if (typeof kind !== "string" || kind.trim().length === 0) {
    throw new TypeError("Stable ID kind must not be empty");
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${kind} stable ID`);
  }
  if (value !== value.trim() || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`Invalid ${kind} stable ID`);
  }
  if (!STABLE_ID_PATTERN.test(value)) {
    throw new Error(`Invalid ${kind} stable ID`);
  }
  return value;
}

export function buildConnectionId(input: ConnectionIdInput): string {
  const providerId = normalizePart(input.providerId, "providerId");
  const accountId = optionalPart(input.accountId, "accountId");
  const productId = optionalPart(input.productId, "productId");
  const connectionKind = optionalPart(input.connectionKind, "connectionKind");
  const profileRef = optionalPart(input.profileRef, "profileRef");
  const endpointRef = optionalPart(input.endpointRef, "endpointRef");

  return buildOpaqueId(
    "conn",
    canonicalize([
      ["providerId", providerId],
      ["accountId", accountId],
      ["productId", productId],
      ["connectionKind", connectionKind],
      ["profileRef", profileRef],
      ["endpointRef", endpointRef],
    ]),
  );
}

export function buildModelIdentityId(input: ModelIdentityIdInput): string {
  const canonicalName = normalizePart(input.canonicalName, "canonicalName");
  return buildOpaqueId(
    "model",
    canonicalize([["canonicalName", canonicalName]]),
  );
}

export function buildRouteId(input: RouteIdInput): string {
  const providerId = normalizePart(input.providerId, "providerId");
  const connectionId = normalizePart(input.connectionId, "connectionId");
  const providerModelId = normalizePart(input.providerModelId, "providerModelId", {
    allowSlash: true,
  });
  const executionProfile = normalizePart(input.executionProfile, "executionProfile");

  return buildOpaqueId(
    "route",
    canonicalize([
      ["providerId", providerId],
      ["connectionId", connectionId],
      ["providerModelId", providerModelId],
      ["executionProfile", executionProfile],
    ]),
  );
}
