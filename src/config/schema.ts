import { z } from "zod";
import {
  PROVIDER_API_STYLES,
  PROVIDER_BILLING_CLASSES,
  isAdministrativeDiscoveryPath,
  isSafeProviderBaseUrl,
} from "../providers/manifest.js";

const providerConfigSchema = z.object({
  enabled: z.boolean(),
}).strict();

const chatgptProviderSchema = providerConfigSchema.extend({
  codexHome: z.string().optional(),
}).strict();

const claudeProviderSchema = providerConfigSchema.extend({
  profileDir: z.string().optional(),
}).strict();

const googleProviderSchema = providerConfigSchema.extend({
  agyPath: z.string().optional(),
}).strict();

const commandCodeProviderSchema = providerConfigSchema.extend({
  baseUrl: z.string().default("https://api.commandcode.ai/provider/v1"),
  secretEnv: z.string(),
}).strict();

const cavotiProviderSchema = providerConfigSchema
  .extend({
    baseUrl: z
      .literal("https://cavoti.com/v1")
      .default("https://cavoti.com/v1"),
    secretEnv: z.literal("CAVOTI_API_KEY").default("CAVOTI_API_KEY"),
    model: z
      .literal("deepseek-v4.1-flash")
      .default("deepseek-v4.1-flash"),
  })
  .strict()
  .default({
    enabled: false,
    baseUrl: "https://cavoti.com/v1",
    secretEnv: "CAVOTI_API_KEY",
    model: "deepseek-v4.1-flash",
  });

/**
 * Activation contract for a provider route. `all` takes the discovered
 * catalog, `allowlist` routes only the exact provider model ids listed, and
 * `none` keeps discovered routes visible but non-routable until an operator
 * states the exact ids. The allowlist is never a pattern and never inferred.
 */
const providerActivationSchema = z
  .object({
    mode: z.enum(["all", "allowlist", "none"]).default("all"),
    models: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .refine(
    (activation) =>
      activation.mode === "allowlist"
        ? activation.models.length > 0
        : activation.models.length === 0,
    {
      message:
        "activation.models is exactly the allowlist and is only valid in allowlist mode",
    },
  );

/**
 * Reusable OpenAI-compatible provider contract, shared by every provider in
 * the approved wave. A provider entry is DATA ONLY: identity, billing class,
 * endpoint, credential namespace, discovery path, api styles and activation.
 * Per-provider behavior lives in the provider manifest, not in the config.
 */
export const openAiCompatibleProviderSchema = providerConfigSchema
  .extend({
    displayName: z.string().min(1).optional(),
    billingClass: z.enum(PROVIDER_BILLING_CLASSES).optional(),
    baseUrl: z
      .string()
      .min(1)
      .refine(isSafeProviderBaseUrl, {
        message: "baseUrl must be a public https endpoint without credentials",
      })
      .optional(),
    secretEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    authScheme: z.literal("bearer").default("bearer"),
    discoveryPath: z
      .string()
      .refine(isAdministrativeDiscoveryPath, {
        message: "discoveryPath must be an administrative metadata path",
      })
      .default("/models"),
    apiStyles: z
      .array(z.enum(PROVIDER_API_STYLES))
      .min(1)
      .default(["openai-chat-completions"]),
    activation: providerActivationSchema.default({ mode: "all", models: [] }),
  })
  .strict();

/**
 * Credential namespaces for the approved wave. Each provider owns exactly one
 * variable name; the per-provider entry pins it as a literal so a config can
 * never point one provider at another provider's credential (or at a reserved
 * PAYG fallback variable).
 */
const WAVE_PROVIDER_SECRET_ENVS = {
  "qwen-token-plan": "QWEN_TOKEN_PLAN_API_KEY",
  "qwen-cloud": "QWEN_CLOUD_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  kira: "KIRA_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  "opencode-zen": "OPENCODE_ZEN_API_KEY",
  "nvidia-nim": "NVIDIA_NIM_API_KEY",
  vikey: "VIKEY_API_KEY",
  cline: "CLINE_API_KEY",
  "ollama-cloud": "OLLAMA_CLOUD_API_KEY",
} as const;

function waveProviderSchema(secretEnv: string) {
  return openAiCompatibleProviderSchema
    .extend({
      secretEnv: z.literal(secretEnv).default(secretEnv),
    })
    .strict()
    // prefault (not default): the seeded value is parsed through this schema,
    // so the shared defaults above stay the single source of the entry shape.
    .prefault(() => ({ enabled: false, secretEnv }));
}

const waveProviderEntries = {
  "qwen-token-plan": waveProviderSchema(WAVE_PROVIDER_SECRET_ENVS["qwen-token-plan"]),
  "qwen-cloud": waveProviderSchema(WAVE_PROVIDER_SECRET_ENVS["qwen-cloud"]),
  deepseek: waveProviderSchema(WAVE_PROVIDER_SECRET_ENVS.deepseek),
  kira: waveProviderSchema(WAVE_PROVIDER_SECRET_ENVS.kira),
  openrouter: waveProviderSchema(WAVE_PROVIDER_SECRET_ENVS.openrouter),
  "opencode-zen": waveProviderSchema(WAVE_PROVIDER_SECRET_ENVS["opencode-zen"]),
  "nvidia-nim": waveProviderSchema(WAVE_PROVIDER_SECRET_ENVS["nvidia-nim"]),
  vikey: waveProviderSchema(WAVE_PROVIDER_SECRET_ENVS.vikey),
  cline: waveProviderSchema(WAVE_PROVIDER_SECRET_ENVS.cline),
  "ollama-cloud": waveProviderSchema(WAVE_PROVIDER_SECRET_ENVS["ollama-cloud"]),
};

export const sharedConfigSchema = z.object({
  mode: z.literal("standalone"),
  host: z.literal("127.0.0.1"),
  port: z.number().min(1).max(65535).default(8790),
  bearerSecretEnv: z.string().default("CMM_ROUTER_TOKEN"),
  providers: z
    .object({
      chatgpt: chatgptProviderSchema,
      claude: claudeProviderSchema,
      google: googleProviderSchema,
      "command-code": commandCodeProviderSchema,
      cavoti: cavotiProviderSchema,
      ...waveProviderEntries,
    })
    .strict()
    // Seeded and then parsed through this same schema, so the per-provider
    // defaults (Cavoti, and every wave provider) are the single source of the
    // default providers block: adding a wave provider needs no second edit.
    .prefault(() => ({
      chatgpt: { enabled: false },
      claude: { enabled: false },
      google: { enabled: false },
      "command-code": {
        enabled: false,
        baseUrl: "https://api.commandcode.ai/provider/v1",
        secretEnv: "COMMAND_CODE_SECRET",
      },
    })),
}).strict();

export type SharedConfig = z.infer<typeof sharedConfigSchema>;

export const localConfigSchema = z
  .object({
    machineId: z.string().optional(),
    profiles: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type LocalConfig = z.infer<typeof localConfigSchema>;
