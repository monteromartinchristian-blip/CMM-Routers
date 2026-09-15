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
const STABLE_ID_KINDS = ["conn", "model", "route"] as const;

export type StableIdKind = (typeof STABLE_ID_KINDS)[number];

const STABLE_ID_KIND_SET = new Set<string>(STABLE_ID_KINDS);

function validatePart(
  value: string,
  field: string,
  options: { allowSlash?: boolean } = {},
): string {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new Error(`${field} must not be empty`);
  }
  if (value.length > 512) {
    throw new Error(`${field} is too long`);
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`${field} contains a control character`);
  }
  if (PATH_TRAVERSAL_PATTERN.test(value)) {
    throw new Error(`${field} contains an unsafe path segment`);
  }
  if (!options.allowSlash && value.includes("/")) {
    throw new Error(`${field} contains an unsafe separator`);
  }
  if (UNSAFE_CHARACTER_PATTERN.test(value)) {
    throw new Error(`${field} contains an unsafe character`);
  }

  return value;
}

function normalizeCanonicalPart(value: string, field: string): string {
  return validatePart(value.normalize("NFKC").trim().toLowerCase(), field);
}

function preserveOpaquePart(
  value: string,
  field: string,
  options: { allowSlash?: boolean } = {},
): string {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string`);
  }
  if (value !== value.trim()) {
    throw new Error(`${field} must not contain surrounding whitespace`);
  }
  return validatePart(value, field, options);
}

function optionalCanonicalPart(
  value: string | undefined,
  field: string,
): string | undefined {
  return value === undefined ? undefined : normalizeCanonicalPart(value, field);
}

function optionalOpaquePart(
  value: string | undefined,
  field: string,
): string | undefined {
  return value === undefined ? undefined : preserveOpaquePart(value, field);
}

function assertOnlyKeys(
  input: object,
  allowedKeys: readonly string[],
  operation: string,
): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new Error(`Unsupported ${operation} input field`);
  }
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

function buildOpaqueId(prefix: StableIdKind, identity: string): string {
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
export function assertStableId(value: string, kind: StableIdKind): string {
  if (typeof kind !== "string" || !STABLE_ID_KIND_SET.has(kind)) {
    throw new TypeError("Unsupported stable ID kind");
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${kind} stable ID`);
  }
  if (value !== value.trim() || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`Invalid ${kind} stable ID`);
  }
  const expectedPattern = new RegExp(`^${kind}_[a-f0-9]{${HASH_LENGTH}}$`, "u");
  if (!expectedPattern.test(value)) {
    throw new Error(`Invalid ${kind} stable ID`);
  }
  return value;
}

export function buildConnectionId(input: ConnectionIdInput): string {
  assertOnlyKeys(
    input,
    ["providerId", "accountId", "productId", "connectionKind", "profileRef", "endpointRef"],
    "buildConnectionId",
  );
  const providerId = normalizeCanonicalPart(input.providerId, "providerId");
  const accountId = optionalCanonicalPart(input.accountId, "accountId");
  const productId = optionalCanonicalPart(input.productId, "productId");
  const connectionKind = optionalCanonicalPart(input.connectionKind, "connectionKind");
  const profileRef = optionalOpaquePart(input.profileRef, "profileRef");
  const endpointRef = optionalOpaquePart(input.endpointRef, "endpointRef");

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
  assertOnlyKeys(input, ["canonicalName"], "buildModelIdentityId");
  const canonicalName = normalizeCanonicalPart(input.canonicalName, "canonicalName");
  return buildOpaqueId(
    "model",
    canonicalize([["canonicalName", canonicalName]]),
  );
}

export function buildRouteId(input: RouteIdInput): string {
  assertOnlyKeys(
    input,
    ["providerId", "connectionId", "providerModelId", "executionProfile"],
    "buildRouteId",
  );
  const providerId = normalizeCanonicalPart(input.providerId, "providerId");
  const connectionId = normalizeCanonicalPart(input.connectionId, "connectionId");
  const providerModelId = preserveOpaquePart(input.providerModelId, "providerModelId", {
    allowSlash: true,
  });
  const executionProfile = normalizeCanonicalPart(input.executionProfile, "executionProfile");

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
