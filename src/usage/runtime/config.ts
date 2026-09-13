import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { UsageIntegrationDefinition, UsageRuntimeConfig } from "./configured-runtime.js";

const integrationSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  enabled: z.boolean(),
  credentialRef: z.string().min(1).optional(),
  settings: z.record(z.string(), z.unknown()).default({}),
}).strict();

const runtimeSchema = z.object({
  version: z.literal(1).default(1),
  apiCredentialRef: z.string().min(1).default("keychain://CMM%20Usage/local-api"),
  databasePath: z.string().min(1).optional(),
  integrations: z.array(integrationSchema).default([]),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  for (const [index, integration] of value.integrations.entries()) {
    if (seen.has(integration.id)) {
      context.addIssue({
        code: "custom",
        message: "Usage integration ids must be unique",
        path: ["integrations", index, "id"],
      });
    }
    seen.add(integration.id);
  }
});

const forbiddenInlineKeys = new Set([
  "apikey",
  "token",
  "oauthtoken",
  "accesstoken",
  "refreshtoken",
  "authorization",
  "authorizationheader",
  "bearer",
  "bearertoken",
  "secret",
  "password",
]);

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function assertNoInlineSecrets(value: unknown, path: string): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoInlineSecrets(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (forbiddenInlineKeys.has(normalizedKey(key))) {
      throw new Error(`Inline credential/secret fields are not allowed in CMM Usage config: ${path}.${key}`);
    }
    assertNoInlineSecrets(entry, `${path}.${key}`);
  }
}

export interface LoadedUsageRuntimeConfig extends UsageRuntimeConfig {
  version: 1;
  apiCredentialRef: string;
  databasePath?: string;
  integrations: UsageIntegrationDefinition[];
}

export function loadUsageRuntimeConfig(configDir?: string): LoadedUsageRuntimeConfig {
  const baseDir = configDir ?? resolve(process.cwd(), "config");
  const path = resolve(baseDir, "usage.json");
  const raw = existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) as unknown : {};
  const parsed = runtimeSchema.parse(raw);
  for (const integration of parsed.integrations) {
    assertNoInlineSecrets(integration.settings, `integrations.${integration.id}.settings`);
  }
  return {
    version: parsed.version,
    apiCredentialRef: parsed.apiCredentialRef,
    integrations: parsed.integrations.map((integration) => ({
      id: integration.id,
      type: integration.type,
      enabled: integration.enabled,
      settings: integration.settings,
      ...(integration.credentialRef === undefined
        ? {}
        : { credentialRef: integration.credentialRef }),
    })),
    ...(parsed.databasePath === undefined ? {} : { databasePath: parsed.databasePath }),
  };
}
