import { z } from "zod";

const providerConfigSchema = z.object({
  enabled: z.boolean(),
});

const chatgptProviderSchema = providerConfigSchema.extend({
  codexHome: z.string().optional(),
});

const claudeProviderSchema = providerConfigSchema.extend({
  profileDir: z.string().optional(),
});

const googleProviderSchema = providerConfigSchema.extend({
  agyPath: z.string().optional(),
});

const commandCodeProviderSchema = providerConfigSchema.extend({
  baseUrl: z.string().default("https://api.commandcode.ai/provider/v1"),
  secretEnv: z.string(),
});

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
    })
    .default(() => ({
      chatgpt: { enabled: false },
      claude: { enabled: false },
      google: { enabled: false },
      "command-code": {
        enabled: false,
        baseUrl: "https://api.commandcode.ai/provider/v1",
        secretEnv: "COMMAND_CODE_SECRET",
      },
    })),
});

export type SharedConfig = z.infer<typeof sharedConfigSchema>;

const secretKeyPattern =
  /^(authorization|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|oauth|secret|cookie)|\b(oauth|secret|token|key)\w*$/i;

function hasSecretKeys(obj: Record<string, unknown>): boolean {
  for (const key of Object.keys(obj)) {
    if (secretKeyPattern.test(key)) {
      return true;
    }
    const value = obj[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (hasSecretKeys(value as Record<string, unknown>)) {
        return true;
      }
    }
  }
  return false;
}

export const localConfigSchema = z
  .object({
    machineId: z.string().optional(),
    profiles: z.record(z.string(), z.string()).optional(),
  })
  .passthrough()
  .refine((data) => !hasSecretKeys(data), {
    message:
      "Local configuration must not contain secret-like keys (apiKey, oauthToken, accessToken, etc.)",
  });

export type LocalConfig = z.infer<typeof localConfigSchema>;
