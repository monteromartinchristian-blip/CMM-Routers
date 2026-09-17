import { z } from "zod";
import { ChatGptSubscriptionUsageAdapter } from "../adapters/chatgpt-subscription/adapter.js";
import { ClaudeSubscriptionUsageAdapter } from "../adapters/claude-subscription/adapter.js";
import { CommandCodeUsageAdapter } from "../adapters/command-code/adapter.js";
import { DeepSeekUsageAdapter } from "../adapters/deepseek/adapter.js";
import { GoogleAiProUsageAdapter } from "../adapters/google-ai-pro/adapter.js";
import { OpenAiApiUsageAdapter } from "../adapters/openai-api/adapter.js";
import { OpenRouterUsageAdapter } from "../adapters/openrouter/adapter.js";
import { OpenAiCompatibleUsageAdapter } from "../adapters/openai-compatible/adapter.js";
import { QwenModelStudioUsageAdapter } from "../adapters/qwen-model-studio/adapter.js";
import type { AccessRoute, Account, Product } from "../domain/types.js";
import type { ManualUsageAdapterDefinition } from "../adapters/manual/adapter.js";
import {
  UsageIntegrationCatalog,
  type UsageCollectorBinding,
  type UsageIntegrationDefinition,
} from "./configured-runtime.js";

export interface SecureCredentialResolver {
  resolve(reference: string): string | undefined | Promise<string | undefined>;
}

const routeSchema = z.object({
  providerModelId: z.string().min(1),
  displayName: z.string().min(1),
}).strict();

const routesSchema = z.array(routeSchema).optional();

const commandCodeSettings = z.object({
  baseUrl: z.string().url().default("https://api.commandcode.ai"),
  routes: routesSchema,
}).strict();

const claudeSettings = z.object({
  baseUrl: z.string().url().default("https://claude.ai"),
  planLabel: z.string().min(1).optional(),
  routes: routesSchema,
}).strict();

const openAiSettings = z.object({
  baseUrl: z.string().url().optional(),
  models: routesSchema,
  projectId: z.string().min(1).optional(),
  lookbackDays: z.number().int().positive().optional(),
  usagePath: z.string().min(1).optional(),
  costsPath: z.string().min(1).optional(),
}).strict();

const chatGptSettings = z.object({
  baseUrl: z.string().url().default("https://chatgpt.com/backend-api/codex"),
  accountId: z.string().min(1),
  routes: routesSchema,
}).strict();

const googleSettings = z.object({
  baseUrl: z.string().url().default("https://cloudcode-pa.googleapis.com"),
  routes: routesSchema,
}).strict();

const deepSeekSettings = z.object({
  baseUrl: z.string().url().default("https://api.deepseek.com"),
  routes: routesSchema,
}).strict();

const qwenPlanSchema = z.object({
  edition: z.enum(["personal", "team"]),
  tierLabel: z.string().min(1).optional(),
  windowLimitCredits: z.number().nonnegative().optional(),
}).strict();

const qwenSettings = z.object({
  baseUrl: z.string().url(),
  displayName: z.string().min(1).optional(),
  plan: qwenPlanSchema.optional(),
}).strict();

const openRouterSettings = z.object({
  baseUrl: z.string().url().optional(),
  managementCredentialRef: z.string().min(1).optional(),
}).strict();

/**
 * Collector-only settings for a custom OpenAI-compatible endpoint.
 *
 * The endpoint itself (provider, account, product, connection, access routes,
 * model discovery and route visibility) is an operational Router entity. Usage
 * owns only the observability endpoints and the quota mode used to interpret
 * what it collects, and it references the canonical Router identity through a
 * `UsageCollectorBinding`. `useInCmmChat` is not a Usage setting: CMMChat
 * exposure is represented only through Router route visibility.
 */
const openAiCompatibleSettings = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  usageEndpoint: z.string().min(1).optional(),
  billingEndpoint: z.string().min(1).optional(),
  quotaMode: z.enum(["automatic", "manual", "unknown"]).default("unknown"),
}).strict();

type OpenAiCompatibleSettings = z.infer<typeof openAiCompatibleSettings>;

/**
 * The collector's observation graph for one canonical Router identity.
 *
 * Every operational identity here is a *reference* supplied by the Router
 * binding; the collector constructs none of them. The rows exist so Usage
 * SQLite can key observations by canonical IDs and keep historical accounting
 * after a route is removed from Router.
 */
function collectorGraphFromBinding(
  definition: UsageIntegrationDefinition,
  settings: OpenAiCompatibleSettings,
  binding: UsageCollectorBinding,
): ManualUsageAdapterDefinition {
  const now = new Date().toISOString();
  const { providerId, accountId, productId } = binding;
  const accounts: Account[] = accountId === undefined
    ? []
    : [{
        id: accountId,
        providerId,
        label: settings.name,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }];
  const products: Product[] = productId === undefined
    ? []
    : [{
        id: productId,
        providerId,
        displayName: settings.name,
        kind: "custom",
        metadata: {
          quotaMode: settings.quotaMode,
          ...(settings.usageEndpoint === undefined ? {} : { usageEndpoint: settings.usageEndpoint }),
          ...(settings.billingEndpoint === undefined ? {} : { billingEndpoint: settings.billingEndpoint }),
        },
      }];
  const accessRoutes: AccessRoute[] = accountId === undefined || productId === undefined
    ? []
    : binding.routeIds.map((routeId) => ({
        id: routeId,
        accountId,
        productId,
        providerModelId: routeId,
        displayName: settings.name,
        status: "available",
        metadata: { collectorBinding: true },
      }));

  return {
    id: `openai-compatible:${definition.id}`,
    displayName: settings.name,
    provider: {
      id: providerId,
      displayName: settings.name,
      kind: "generic",
      status: "enabled",
      metadata: { collectorBinding: true },
      createdAt: now,
      updatedAt: now,
    },
    accounts,
    products,
    accessRoutes,
    quotaBuckets: [],
    quotaBindings: [],
    quotaSnapshots: [],
  };
}

function credentialFor(
  definition: UsageIntegrationDefinition,
  resolver: SecureCredentialResolver,
  overrideReference?: string,
) {
  const reference = overrideReference ?? definition.credentialRef;
  if (reference === undefined) {
    throw new Error(`Usage integration ${definition.id} requires a secure credential reference`);
  }
  return {
    reference,
    resolve: (value: string) => resolver.resolve(value),
  };
}

function optionalCredentialFor(
  definition: UsageIntegrationDefinition,
  resolver: SecureCredentialResolver,
) {
  if (definition.credentialRef === undefined) return undefined;
  return {
    reference: definition.credentialRef,
    resolve: (value: string) => resolver.resolve(value),
  };
}

export function createDefaultUsageIntegrationCatalog(
  resolver: SecureCredentialResolver,
): UsageIntegrationCatalog {
  const catalog = new UsageIntegrationCatalog();

  catalog.register("command-code", (definition) => {
    const settings = commandCodeSettings.parse(definition.settings);
    return new CommandCodeUsageAdapter({
      baseUrl: settings.baseUrl,
      credential: credentialFor(definition, resolver),
      ...(settings.routes === undefined ? {} : { routes: settings.routes }),
    });
  });

  catalog.register("claude-subscription", (definition) => {
    const settings = claudeSettings.parse(definition.settings);
    return new ClaudeSubscriptionUsageAdapter({
      baseUrl: settings.baseUrl,
      credential: credentialFor(definition, resolver),
      ...(settings.planLabel === undefined ? {} : { planLabel: settings.planLabel }),
      ...(settings.routes === undefined ? {} : { routes: settings.routes }),
    });
  });

  catalog.register("openai-api", (definition) => {
    const settings = openAiSettings.parse(definition.settings);
    return new OpenAiApiUsageAdapter({
      credential: credentialFor(definition, resolver),
      ...(settings.baseUrl === undefined ? {} : { baseUrl: settings.baseUrl }),
      ...(settings.models === undefined ? {} : { models: settings.models }),
      ...(settings.projectId === undefined ? {} : { projectId: settings.projectId }),
      ...(settings.lookbackDays === undefined ? {} : { lookbackDays: settings.lookbackDays }),
      ...(settings.usagePath === undefined ? {} : { usagePath: settings.usagePath }),
      ...(settings.costsPath === undefined ? {} : { costsPath: settings.costsPath }),
    });
  });

  catalog.register("chatgpt-subscription", (definition) => {
    const settings = chatGptSettings.parse(definition.settings);
    return new ChatGptSubscriptionUsageAdapter({
      baseUrl: settings.baseUrl,
      accountId: settings.accountId,
      credential: credentialFor(definition, resolver),
      ...(settings.routes === undefined ? {} : { routes: settings.routes }),
    });
  });

  catalog.register("google-ai-pro", (definition) => {
    const settings = googleSettings.parse(definition.settings);
    return new GoogleAiProUsageAdapter({
      baseUrl: settings.baseUrl,
      credential: credentialFor(definition, resolver),
      ...(settings.routes === undefined ? {} : { routes: settings.routes }),
    });
  });

  catalog.register("deepseek", (definition) => {
    const settings = deepSeekSettings.parse(definition.settings);
    return new DeepSeekUsageAdapter({
      baseUrl: settings.baseUrl,
      credential: credentialFor(definition, resolver),
      ...(settings.routes === undefined ? {} : { routes: settings.routes }),
    });
  });

  catalog.register("qwen-token-plan", (definition) => {
    const settings = qwenSettings.parse(definition.settings);
    const plan = settings.plan === undefined
      ? undefined
      : {
          edition: settings.plan.edition,
          ...(settings.plan.tierLabel === undefined ? {} : { tierLabel: settings.plan.tierLabel }),
          ...(settings.plan.windowLimitCredits === undefined
            ? {}
            : { windowLimitCredits: settings.plan.windowLimitCredits }),
        };
    return new QwenModelStudioUsageAdapter({
      kind: "token-plan",
      baseUrl: settings.baseUrl,
      credential: credentialFor(definition, resolver),
      ...(settings.displayName === undefined ? {} : { displayName: settings.displayName }),
      ...(plan === undefined ? {} : { plan }),
    });
  });

  catalog.register("qwen-payg", (definition) => {
    const settings = qwenSettings.parse(definition.settings);
    return new QwenModelStudioUsageAdapter({
      kind: "payg",
      baseUrl: settings.baseUrl,
      credential: credentialFor(definition, resolver),
      ...(settings.displayName === undefined ? {} : { displayName: settings.displayName }),
    });
  });

  catalog.register("openrouter", (definition) => {
    const settings = openRouterSettings.parse(definition.settings);
    return new OpenRouterUsageAdapter({
      credential: credentialFor(definition, resolver),
      ...(settings.baseUrl === undefined ? {} : { baseUrl: settings.baseUrl }),
      ...(settings.managementCredentialRef === undefined
        ? {}
        : { managementCredential: credentialFor(definition, resolver, settings.managementCredentialRef) }),
    });
  });

  catalog.register("openai-compatible", (definition, binding) => {
    const settings = openAiCompatibleSettings.parse(definition.settings);
    const credential = optionalCredentialFor(definition, resolver);
    // Without a canonical Router binding there is no operational identity to
    // reference, so the collector stays inert rather than inventing one.
    const manual = binding === undefined
      ? undefined
      : collectorGraphFromBinding(definition, settings, binding);
    return new OpenAiCompatibleUsageAdapter({
      id: `openai-compatible:${definition.id}`,
      displayName: settings.name,
      baseUrl: settings.baseUrl,
      ...(credential === undefined ? {} : { credential }),
      ...(manual === undefined ? {} : { manual }),
    });
  });

  return catalog;
}
