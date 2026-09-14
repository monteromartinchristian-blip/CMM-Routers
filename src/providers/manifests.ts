import type { ProviderId } from "../core/model.js";
import type { WaveProviderActivationConfig } from "../config/schema.js";
import { CAVOTI_PINNED_MODEL } from "./cavoti/spend-guard.js";
import {
  assertUniqueProviderManifests,
  defineProviderManifest,
  type ProviderActivationSpec,
  type ProviderManifest,
} from "./manifest.js";

/**
 * Provider manifest catalog for the approved provider-expansion wave.
 *
 * Every manifest is data: identity, billing class, canonical base URL (or an
 * explicit `null` when the endpoint is region/account-parameterized and must
 * come from configuration), credential namespace, administrative discovery
 * path, declared api styles, tool capability and activation scope. The generic
 * `OpenAiCompatibleAdapter` consumes these manifests; no provider-specific
 * class or code path is introduced here.
 */

/**
 * Qwen Token Plan: the subscription product. Dedicated `sk-sp-*` keys against
 * `https://token-plan.<region>.maas.aliyuncs.com/compatible-mode/v1`, unified
 * credit deduction, plan-scoped model allowlist. The region is account-specific
 * (repo evidence: the CMM Usage Qwen adapter notes in this repository's
 * history), so the base URL is configuration, not a guessed default.
 */
export const QWEN_TOKEN_PLAN_MANIFEST: ProviderManifest = defineProviderManifest({
  id: "qwen-token-plan",
  displayName: "Qwen Token Plan",
  billingClass: "subscription",
  baseUrl: null,
  auth: { scheme: "bearer", secretEnv: "QWEN_TOKEN_PLAN_API_KEY" },
  discovery: { method: "GET", path: "/models" },
  apiStyles: ["openai-chat-completions"],
  toolCapability: "CHAT_AND_TOOLS",
  activation: { mode: "all", models: [] },
});

/**
 * Qwen Cloud PAYG (Alibaba Cloud Model Studio, post-paid): `sk-`/`sk-ws-` keys
 * against `https://dashscope.<region>.aliyuncs.com/compatible-mode/v1`, billed
 * per model token price. A different product, credential namespace, billing
 * class and usage account than Token Plan: the router must never mix them, and
 * no automatic PAYG fallback exists. Region is account-specific, so the base
 * URL is configuration.
 */
export const QWEN_CLOUD_MANIFEST: ProviderManifest = defineProviderManifest({
  id: "qwen-cloud",
  displayName: "Qwen Cloud (PAYG)",
  billingClass: "payg",
  baseUrl: null,
  auth: { scheme: "bearer", secretEnv: "QWEN_CLOUD_API_KEY" },
  discovery: { method: "GET", path: "/models" },
  apiStyles: ["openai-chat-completions"],
  toolCapability: "CHAT_AND_TOOLS",
  activation: { mode: "all", models: [] },
});

/**
 * Factory for the OpenAI-compatible wave providers: every field that is the
 * same for the whole wave (administrative GET discovery, chat-completions
 * style, declared tool capability, discovery-driven activation) is stated once,
 * and each provider still declares its identity, endpoint and credential
 * namespace explicitly.
 */
function openAiWaveManifest(fields: {
  id: ProviderManifest["id"];
  displayName: string;
  billingClass: ProviderManifest["billingClass"];
  baseUrl: string | null;
  secretEnv: string;
  toolCapability?: ProviderManifest["toolCapability"];
  activation?: ProviderManifest["activation"];
}): ProviderManifest {
  return defineProviderManifest({
    id: fields.id,
    displayName: fields.displayName,
    billingClass: fields.billingClass,
    baseUrl: fields.baseUrl,
    auth: { scheme: "bearer", secretEnv: fields.secretEnv },
    discovery: { method: "GET", path: "/models" },
    apiStyles: ["openai-chat-completions"],
    toolCapability: fields.toolCapability ?? "CHAT_AND_TOOLS",
    activation: fields.activation ?? { mode: "all", models: [] },
  });
}

/**
 * DeepSeek API: post-paid OpenAI-compatible endpoint documented by the
 * provider, and by this repository's own CMM Usage integration notes
 * (`https://api.deepseek.com`, versioned OpenAI-compatible root `/v1`).
 */
export const DEEPSEEK_MANIFEST: ProviderManifest = openAiWaveManifest({
  id: "deepseek",
  displayName: "DeepSeek API",
  billingClass: "payg",
  baseUrl: "https://api.deepseek.com/v1",
  secretEnv: "DEEPSEEK_API_KEY",
});

/**
 * OpenRouter: prepaid credit pool plus per-key caps, all metadata surfaces are
 * authenticated GETs under `https://openrouter.ai/api/v1` (repo evidence: the
 * CMM Usage OpenRouter notes), and `GET /models` is authoritative discovery.
 */
export const OPENROUTER_MANIFEST: ProviderManifest = openAiWaveManifest({
  id: "openrouter",
  displayName: "OpenRouter",
  billingClass: "payg",
  baseUrl: "https://openrouter.ai/api/v1",
  secretEnv: "OPENROUTER_API_KEY",
});

/** OpenCode Zen: OpenAI-compatible gateway at the product's own API host. */
export const OPENCODE_ZEN_MANIFEST: ProviderManifest = openAiWaveManifest({
  id: "opencode-zen",
  displayName: "OpenCode Zen",
  billingClass: "payg",
  baseUrl: "https://opencode.ai/zen/v1",
  secretEnv: "OPENCODE_ZEN_API_KEY",
});

/**
 * Kira AI: canonical endpoint supplied by the operator for this wave. Billing
 * class stays the neutral `api` because the free-model expectations are
 * discovery fixtures, not provider pricing metadata, and tool capability stays
 * `CHAT_ONLY` until a Kira tool-calling round-trip is proven (an unproven
 * capability must never unlock tools for the Qoder consumer).
 */
export const KIRA_MANIFEST: ProviderManifest = openAiWaveManifest({
  id: "kira",
  displayName: "Kira AI",
  billingClass: "api",
  baseUrl: "https://kiraai.vn/api/v1",
  secretEnv: "KIRA_API_KEY",
  toolCapability: "CHAT_ONLY",
});

/**
 * NVIDIA NIM: OpenAI-compatible NVIDIA-hosted inference at the documented NIM
 * API host. Discovery may expose the whole NVIDIA catalog, but the wave's
 * initial routing scope is a single planned model whose exact provider model id
 * is NOT deterministically known from repository evidence. The manifest
 * therefore declares `activation: none`: discovered routes stay visible to an
 * operator but are not routable until the exact id is confirmed in config
 * (`providers.nvidia-nim.activation = { mode: "allowlist", models: ["<exact>"] }`).
 */
export const NVIDIA_NIM_MANIFEST: ProviderManifest = openAiWaveManifest({
  id: "nvidia-nim",
  displayName: "NVIDIA NIM",
  billingClass: "api",
  baseUrl: "https://integrate.api.nvidia.com/v1",
  secretEnv: "NVIDIA_NIM_API_KEY",
  activation: { mode: "none", models: [] },
});

/**
 * Vikey: no canonical OpenAI-compatible host is established by the plan text or
 * by any repository evidence, so the manifest deliberately carries
 * `baseUrl: null` rather than guessing one. An operator must supply
 * `providers.vikey.baseUrl`; until then an enabled route is skipped with a
 * clear reason. Tool capability stays `CHAT_ONLY` until proven.
 */
export const VIKEY_MANIFEST: ProviderManifest = openAiWaveManifest({
  id: "vikey",
  displayName: "Vikey",
  billingClass: "api",
  baseUrl: null,
  secretEnv: "VIKEY_API_KEY",
  toolCapability: "CHAT_ONLY",
});

/**
 * Cavoti AI: recovered from the in-tree implementation (adapter, client,
 * spend-guard and historical tests) rather than rewritten. It keeps its
 * dedicated adapter because it is an exact-model pinned PAYG route with a
 * machine-local spend acknowledgement and an account-state billing block that
 * is distinct from quota exhaustion. The manifest records the same identity the
 * runtime uses: the pinned model is the only activated route.
 */
export const CAVOTI_MANIFEST: ProviderManifest = defineProviderManifest({
  id: "cavoti",
  displayName: "Cavoti AI",
  billingClass: "payg",
  baseUrl: "https://cavoti.com/v1",
  auth: { scheme: "bearer", secretEnv: "CAVOTI_API_KEY" },
  discovery: { method: "GET", path: "/models" },
  apiStyles: ["openai-chat-completions"],
  toolCapability: "CHAT_AND_TOOLS",
  activation: { mode: "allowlist", models: [CAVOTI_PINNED_MODEL] },
});

/** Providers served by the generic OpenAI-compatible adapter. */
export const GENERIC_WAVE_MANIFESTS: readonly ProviderManifest[] = [
  QWEN_TOKEN_PLAN_MANIFEST,
  QWEN_CLOUD_MANIFEST,
  DEEPSEEK_MANIFEST,
  OPENROUTER_MANIFEST,
  OPENCODE_ZEN_MANIFEST,
  KIRA_MANIFEST,
  NVIDIA_NIM_MANIFEST,
  VIKEY_MANIFEST,
];

/**
 * Complete approved wave inventory: the generic routes plus the providers that
 * keep a dedicated adapter for a demonstrated protocol or account-state
 * difference (see the wave ledger rulings).
 */
export const PROVIDER_WAVE_MANIFESTS: readonly ProviderManifest[] = [
  ...GENERIC_WAVE_MANIFESTS,
  CAVOTI_MANIFEST,
];

/** Subscription bridges: present and unchanged, not part of the HTTP wave. */
export const SUBSCRIPTION_BRIDGE_IDS = ["chatgpt", "claude", "google"] as const;

export function providerWaveManifest(id: ProviderId): ProviderManifest {
  const found = PROVIDER_WAVE_MANIFESTS.find((manifest) => manifest.id === id);
  if (found === undefined) {
    throw new Error(`Provider ${id} is not part of the approved wave inventory`);
  }
  return found;
}

export function isWaveProviderId(id: ProviderId): boolean {
  return PROVIDER_WAVE_MANIFESTS.some((manifest) => manifest.id === id);
}

/**
 * Module-load invariant, invoked explicitly by the composition root and by the
 * inventory tests: ids and credential namespaces are globally unique.
 */
export function assertProviderWaveInventory(): void {
  assertUniqueProviderManifests(PROVIDER_WAVE_MANIFESTS);
}

/**
 * Effective activation: an explicitly configured activation wins, otherwise
 * the manifest's own scope applies. An absent config activation never widens a
 * manifest-level `none` (that scope exists precisely because the exact model
 * id is not yet confirmed).
 */
export function resolveEffectiveActivation(
  manifest: ProviderManifest,
  configured: WaveProviderActivationConfig | undefined,
): ProviderActivationSpec {
  if (configured === undefined || configured.mode === undefined) {
    return manifest.activation;
  }
  const models = configured.mode === "allowlist" ? [...(configured.models ?? [])] : [];
  return { mode: configured.mode, models };
}
