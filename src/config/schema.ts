import { z } from "zod";
import {
  PROVIDER_API_STYLES,
  PROVIDER_BILLING_CLASSES,
  isAdministrativeDiscoveryPath,
  isSafeProviderBaseUrl,
} from "../providers/manifest.js";

const providerIdentityRefSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, "identity refs must be non-secret stable identifiers");

const providerCatalogAccountSchema = z.discriminatedUnion("identityStatus", [
  z
    .object({
      ref: providerIdentityRefSchema,
      label: z.string().min(1),
      identityStatus: z.literal("resolved"),
      externalAccountRef: providerIdentityRefSchema,
    })
    .strict(),
  z
    .object({
      ref: providerIdentityRefSchema,
      label: z.string().min(1),
      identityStatus: z.literal("unresolved"),
    })
    .strict(),
]);

const providerProductKindSchema = z.enum([
  "subscription",
  "api",
  "free_pool",
  "promo_pool",
  "enterprise",
  "local",
]);

const providerCatalogProductSchema = z
  .object({
    ref: providerIdentityRefSchema,
    accountRef: providerIdentityRefSchema,
    kind: providerProductKindSchema,
    label: z.string().min(1),
  })
  .strict();

const providerCatalogConnectionSchema = z
  .object({
    ref: providerIdentityRefSchema,
    productRef: providerIdentityRefSchema,
    runtime: z.enum(["primary", "disabled"]),
  })
  .strict();

const providerCatalogSchema = z
  .object({
    accounts: z.array(providerCatalogAccountSchema).min(1),
    products: z.array(providerCatalogProductSchema).min(1),
    connections: z.array(providerCatalogConnectionSchema).min(1),
  })
  .strict()
  .superRefine((catalog, context) => {
    const accountRefs = new Set<string>();
    catalog.accounts.forEach((account, index) => {
      if (accountRefs.has(account.ref)) {
        context.addIssue({
          code: "custom",
          path: ["accounts", index, "ref"],
          message: "account ref must be unique within provider catalog",
        });
      }
      accountRefs.add(account.ref);
    });

    const productRefs = new Set<string>();
    catalog.products.forEach((product, index) => {
      if (productRefs.has(product.ref)) {
        context.addIssue({
          code: "custom",
          path: ["products", index, "ref"],
          message: "product ref must be unique within provider catalog",
        });
      }
      productRefs.add(product.ref);
      if (!accountRefs.has(product.accountRef)) {
        context.addIssue({
          code: "custom",
          path: ["products", index, "accountRef"],
          message: "product accountRef must reference a configured account",
        });
      }
    });

    const connectionRefs = new Set<string>();
    let primaryRuntimeCount = 0;
    catalog.connections.forEach((connection, index) => {
      if (connectionRefs.has(connection.ref)) {
        context.addIssue({
          code: "custom",
          path: ["connections", index, "ref"],
          message: "connection ref must be unique within provider catalog",
        });
      }
      connectionRefs.add(connection.ref);
      if (!productRefs.has(connection.productRef)) {
        context.addIssue({
          code: "custom",
          path: ["connections", index, "productRef"],
          message: "connection productRef must reference a configured product",
        });
      }
      if (connection.runtime === "primary") primaryRuntimeCount += 1;
    });
    if (primaryRuntimeCount > 1) {
      context.addIssue({
        code: "custom",
        path: ["connections"],
        message: "provider catalog may declare at most one primary runtime connection",
      });
    }
  });

const providerConfigSchema = z
  .object({
    enabled: z.boolean(),
    catalog: providerCatalogSchema.optional(),
  })
  .strict();

const routeSurfaceSchema = z.enum([
  "cmmchat_model_picker",
  "cmmcode_model_picker",
  "admin_console",
]);

const routeVisibilityRuleSchema = z
  .object({
    providerId: z.string().min(1),
    providerModelId: z.string().min(1),
    visibleOn: z.array(routeSurfaceSchema),
  })
  .strict();

const routeVisibilityPolicySchema = z
  .array(routeVisibilityRuleSchema)
  .default([])
  .superRefine((rules, context) => {
    const seen = new Set<string>();
    rules.forEach((rule, index) => {
      const key = `${rule.providerId}\u0000${rule.providerModelId}`;
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "routeVisibility contains a duplicate provider/model rule",
        });
      }
      seen.add(key);
    });
  });

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
 *
 * Both fields are optional on purpose: an absent activation means "inherit the
 * provider manifest", which is what keeps a manifest-level `none` (an
 * unconfirmed exact model id) from being silently widened by a config default.
 */
const providerActivationSchema = z
  .object({
    mode: z.enum(["all", "allowlist", "none"]).optional(),
    models: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .refine(
    (activation) => {
      if (activation.mode === undefined) return activation.models === undefined;
      if (activation.mode === "allowlist") {
        return activation.models !== undefined && activation.models.length > 0;
      }
      return activation.models === undefined || activation.models.length === 0;
    },
    {
      message:
        "activation.mode is required when activation.models is set, and models is " +
        "exactly the non-empty allowlist for mode 'allowlist'",
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
    activation: providerActivationSchema.optional(),
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
  routeVisibility: routeVisibilityPolicySchema,
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
export type ProviderCatalogConfig = z.infer<typeof providerCatalogSchema>;

/** Configuration entry shape shared by every provider in the approved wave. */
export type WaveProviderConfig = z.infer<typeof openAiCompatibleProviderSchema>;

/** Optional activation override carried by a wave provider config entry. */
export type WaveProviderActivationConfig = z.infer<typeof providerActivationSchema>;

/** Wave provider ids, in the order they appear in the providers block. */
export const WAVE_PROVIDER_IDS = [
  "qwen-token-plan",
  "qwen-cloud",
  "deepseek",
  "kira",
  "openrouter",
  "opencode-zen",
  "nvidia-nim",
  "vikey",
  "cline",
  "ollama-cloud",
] as const;

export type WaveProviderId = (typeof WAVE_PROVIDER_IDS)[number];

/**
 * Typed accessor for one wave provider's config entry. The index signature is
 * confined here so the composition root never casts config shapes itself.
 * Returns undefined when the entry is absent: a config object built without the
 * schema (or an older config) must not crash the composition root — the caller
 * skips that provider with a reason, which is fail-closed.
 */
export function waveProviderConfig(
  providers: SharedConfig["providers"],
  id: WaveProviderId,
): WaveProviderConfig | undefined {
  return (providers as unknown as Record<string, WaveProviderConfig | undefined>)[id];
}

export const localConfigSchema = z
  .object({
    machineId: z.string().optional(),
    profiles: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type LocalConfig = z.infer<typeof localConfigSchema>;
