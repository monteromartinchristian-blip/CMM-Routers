import type { ProviderCapability, ProviderId } from "../core/model.js";
import { FORBIDDEN_PAYG_ENV_VARS } from "../security/payg-guard.js";

/**
 * Provider manifest: the single declarative description of an
 * OpenAI-compatible provider route. One generic adapter consumes these
 * manifests; a provider only needs its own adapter class when a protocol or
 * account-state difference is demonstrated (see the wave ledger rulings).
 *
 * Billing classes are the canonical CMM Usage kinds so the same vocabulary
 * crosses the router/usage boundary without a translation layer.
 */
export const PROVIDER_BILLING_CLASSES = [
  "subscription",
  "payg",
  "api",
  "free_or_api",
] as const;

export type ProviderBillingClass = (typeof PROVIDER_BILLING_CLASSES)[number];

/**
 * Upstream wire styles a manifest can declare. The generic OpenAI-compatible
 * adapter implements `openai-chat-completions`; `anthropic-messages` is
 * declared only by providers that already own a dedicated adapter for it.
 */
export const PROVIDER_API_STYLES = [
  "openai-chat-completions",
  "anthropic-messages",
] as const;

export type ProviderApiStyle = (typeof PROVIDER_API_STYLES)[number];

export type ProviderAuthScheme = "bearer";

export interface ProviderAuthSpec {
  scheme: ProviderAuthScheme;
  /**
   * Environment variable NAME holding the credential. Never a value, and
   * never shared with another provider (credential namespace isolation).
   */
  secretEnv: string;
}

export interface ProviderDiscoverySpec {
  /** Administrative metadata read. Always a GET; never a generation call. */
  method: "GET";
  /** Path appended to the provider base URL, e.g. `/models`. */
  path: string;
}

export type ProviderActivationMode = "all" | "allowlist" | "none";

export interface ProviderActivationSpec {
  /**
   * `all`: discovery defines the routable catalog.
   * `allowlist`: only the listed provider model ids are routable.
   * `none`: routes are discoverable but not routable until an operator states
   * the exact ids (fail closed, never inferred).
   */
  mode: ProviderActivationMode;
  /** Exact provider model ids (never patterns), only for `allowlist`. */
  models: readonly string[];
}

export interface ProviderManifest {
  id: ProviderId;
  displayName: string;
  billingClass: ProviderBillingClass;
  /**
   * Canonical OpenAI-compatible base URL, normalized without a trailing slash.
   * `null` means the canonical URL is not deterministically known (region- or
   * account-parameterized, or undocumented): configuration must supply it
   * before the provider can be registered. Never guessed.
   */
  baseUrl: string | null;
  auth: ProviderAuthSpec;
  discovery: ProviderDiscoverySpec;
  apiStyles: readonly ProviderApiStyle[];
  /**
   * Tool capability the router publishes for this provider's models. Required
   * (no implicit default): `CHAT_AND_TOOLS` is only stated where the provider
   * documents an OpenAI-compatible function-calling round-trip, because this
   * is what unlocks tools for the Qoder consumer.
   */
  toolCapability: ProviderCapability;
  activation: ProviderActivationSpec;
}

/** Path fragments that would turn "discovery" into a billable generation call. */
const GENERATION_PATH_FRAGMENTS = [
  "completions",
  "messages",
  "responses",
  "generate",
  "predict",
  "embeddings",
  "images",
  "audio",
  "video",
  "rerank",
  "chat",
] as const;

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  ".in-addr.arpa",
  ".ip6.arpa",
] as const;

const BLOCKED_HOSTS = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  "broadcasthost",
]);

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV4_MAPPED_PATTERN = /^::ffff:(.+)$/;
const IPV6_MAPPED_HEX_PATTERN = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

/**
 * Parsing uses `String.prototype.match` on fresh literals: these addresses are
 * attacker-controllable config, so the matcher must stay a pure predicate with
 * no shared regex state between calls.
 */
function ipv4Octets(host: string): number[] | null {
  const match = host.match(IPV4_PATTERN);
  if (!match) return null;
  const parts = [match[1], match[2], match[3], match[4]].map((part) => Number(part));
  if (parts.some((part) => part > 255)) return null;
  return parts;
}

function isReservedIpv4(octets: readonly number[]): boolean {
  const a = octets[0] as number;
  const b = octets[1] as number;
  if (a === 0 || a === 10 || a === 127) return true; // this-net, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && (b === 0 || b === 88 || b === 168)) return true; // special + private
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return true; // bench + doc
  if (a === 203 && b === 0) return true; // documentation
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function isReservedIpv6(host: string): boolean {
  const raw = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const lowered = raw.toLowerCase();
  if (lowered === "::" || lowered === "::1") return true;
  const mapped = lowered.match(IPV4_MAPPED_PATTERN)?.[1];
  if (mapped) {
    const dotted = ipv4Octets(mapped);
    if (dotted) return isReservedIpv4(dotted);
    const hexGroups = mapped.match(IPV6_MAPPED_HEX_PATTERN);
    if (hexGroups) {
      const high = parseInt(hexGroups[1] as string, 16);
      const low = parseInt(hexGroups[2] as string, 16);
      return isReservedIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
    }
    return true;
  }
  const firstGroup = lowered.split(":")[0] ?? "";
  if (firstGroup.length === 0) return true; // other "::"-leading forms: conservative
  const value = parseInt(firstGroup, 16);
  if (Number.isNaN(value)) return false;
  if ((value & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((value & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((value & 0xff00) === 0xff00) return true; // multicast ff00::/8
  return false;
}

/**
 * True for loopback, private, link-local, carrier-grade-NAT, multicast,
 * documentation and other reserved hosts. Provider base URLs are public
 * services: a local/private host is a configuration error, never a route.
 */
export function isPrivateOrReservedHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.+$/, "");
  if (host.length === 0) return true;
  if (BLOCKED_HOSTS.has(host)) return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (host.includes(":")) return isReservedIpv6(host);
  const octets = ipv4Octets(host);
  if (octets) return isReservedIpv4(octets);
  return false;
}

/**
 * A provider base URL must be an https endpoint with no embedded credentials
 * and a public host. http is refused: every approved wave provider is a
 * network service reachable over TLS, and plaintext credentials in flight
 * would be a downgrade the router must not perform.
 */
export function isSafeProviderBaseUrl(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username.length > 0 || url.password.length > 0) return false;
  if (isPrivateOrReservedHost(url.hostname)) return false;
  return true;
}

export function assertSafeProviderBaseUrl(baseUrl: string): string {
  if (!isSafeProviderBaseUrl(baseUrl)) {
    throw new Error(
      `Provider base URL must be a public https endpoint without credentials: ${baseUrl}`,
    );
  }
  return new URL(baseUrl).toString().replace(/\/+$/, "");
}

/** True only for administrative GET paths (never a generation endpoint). */
export function isAdministrativeDiscoveryPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (path.includes("?") || path.includes("#")) return false;
  const lowered = path.toLowerCase();
  return !GENERATION_PATH_FRAGMENTS.some((fragment) => lowered.includes(fragment));
}

function fail(reason: string): never {
  throw new Error(`Invalid provider manifest: ${reason}`);
}

/** Validate and normalize a manifest. Data-only: no provider code is attached. */
export function defineProviderManifest(input: ProviderManifest): ProviderManifest {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.id)) {
    fail(`provider id must be lower-kebab-case, got "${input.id}"`);
  }
  if (input.displayName.trim().length === 0) {
    fail(`provider ${input.id} needs a display name`);
  }
  if (!PROVIDER_BILLING_CLASSES.includes(input.billingClass)) {
    fail(`provider ${input.id} has unknown billing class "${String(input.billingClass)}"`);
  }
  const baseUrl =
    input.baseUrl === null ? null : assertSafeProviderBaseUrl(input.baseUrl);

  if (input.auth?.scheme !== "bearer") {
    fail(`provider ${input.id} only supports bearer auth`);
  }
  const { secretEnv } = input.auth;
  if (!/^[A-Z][A-Z0-9_]*$/.test(secretEnv)) {
    fail(`provider ${input.id} secret env name must be an UPPER_SNAKE name, got "${secretEnv}"`);
  }
  if ((FORBIDDEN_PAYG_ENV_VARS as readonly string[]).includes(secretEnv)) {
    fail(
      `provider ${input.id} may not reuse the PAYG fallback credential ${secretEnv}: ` +
        "that variable is reserved for the fail-closed PAYG guard",
    );
  }
  if (input.discovery?.method !== "GET") {
    fail(`provider ${input.id} discovery must be an administrative GET`);
  }
  if (!isAdministrativeDiscoveryPath(input.discovery.path)) {
    fail(
      `provider ${input.id} discovery path must be an administrative metadata path ` +
        `(got "${input.discovery.path}")`,
    );
  }
  if (input.apiStyles.length === 0) {
    fail(`provider ${input.id} must declare at least one api style`);
  }
  for (const style of input.apiStyles) {
    if (!PROVIDER_API_STYLES.includes(style)) {
      fail(`provider ${input.id} declares unknown api style "${String(style)}"`);
    }
  }
  if (
    input.toolCapability !== "CHAT_AND_TOOLS" &&
    input.toolCapability !== "CHAT_ONLY"
  ) {
    fail(
      `provider ${input.id} must declare an explicit tool capability, got "${String(input.toolCapability)}"`,
    );
  }
  const activation = input.activation;
  if (
    activation.mode !== "all" &&
    activation.mode !== "allowlist" &&
    activation.mode !== "none"
  ) {
    fail(`provider ${input.id} has unknown activation mode "${String(activation.mode)}"`);
  }
  const models = [...(activation.models ?? [])];
  if (activation.mode === "allowlist" && models.length === 0) {
    fail(
      `provider ${input.id} activation allowlist must name the exact provider model ids`,
    );
  }
  if (activation.mode !== "allowlist" && models.length > 0) {
    fail(
      `provider ${input.id} activation models are only meaningful in allowlist mode`,
    );
  }
  if (models.some((model) => model.length === 0)) {
    fail(`provider ${input.id} activation allowlist contains an empty model id`);
  }

  return Object.freeze({
    id: input.id,
    displayName: input.displayName,
    billingClass: input.billingClass,
    baseUrl,
    auth: Object.freeze({ scheme: "bearer" as const, secretEnv }),
    discovery: Object.freeze({ method: "GET" as const, path: input.discovery.path }),
    apiStyles: Object.freeze([...input.apiStyles]),
    toolCapability: input.toolCapability,
    activation: Object.freeze({
      mode: activation.mode,
      models: Object.freeze(models),
    }),
  });
}

/**
 * Provider ids and credential namespaces must be globally unique: an id
 * collision would silently shadow a route, and a shared secretEnv would let
 * one provider spend another provider's credential.
 */
export function assertUniqueProviderManifests(
  manifests: readonly ProviderManifest[],
): void {
  const ids = new Set<string>();
  const credentials = new Map<string, string>();
  for (const manifest of manifests) {
    if (ids.has(manifest.id)) {
      throw new Error(`Duplicate provider id in inventory: ${manifest.id}`);
    }
    ids.add(manifest.id);
    const owner = credentials.get(manifest.auth.secretEnv);
    if (owner !== undefined) {
      throw new Error(
        `Providers ${owner} and ${manifest.id} share credential namespace ${manifest.auth.secretEnv}`,
      );
    }
    credentials.set(manifest.auth.secretEnv, manifest.id);
  }
}

/**
 * Effective base URL: explicit configuration wins, otherwise the manifest
 * default. Returns null when neither exists — the caller must skip the
 * provider rather than invent a host.
 */
export function resolveProviderBaseUrl(
  manifest: ProviderManifest,
  configuredBaseUrl: string | undefined,
): string | null {
  const configured = configuredBaseUrl?.trim();
  if (configured !== undefined && configured.length > 0) {
    return assertSafeProviderBaseUrl(configured);
  }
  return manifest.baseUrl;
}

/**
 * Exact allowlist check. `all` is discovery-driven, `allowlist` compares the
 * exact provider model id (never a pattern), and `none` keeps everything
 * non-routable.
 */
export function isActivatedModel(
  manifest: ProviderManifest,
  upstreamModelId: string,
): boolean {
  if (manifest.activation.mode === "all") return true;
  if (manifest.activation.mode === "none") return false;
  return manifest.activation.models.includes(upstreamModelId);
}
