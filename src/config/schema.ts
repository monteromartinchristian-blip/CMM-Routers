import { z } from "zod";

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
    .strict()
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
}).strict();

export type SharedConfig = z.infer<typeof sharedConfigSchema>;

export const localConfigSchema = z
  .object({
    machineId: z.string().optional(),
    profiles: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type LocalConfig = z.infer<typeof localConfigSchema>;
