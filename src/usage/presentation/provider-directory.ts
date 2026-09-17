import type {
  ProviderDirectoryCapabilities,
  ProviderDirectoryEntry,
  ProviderConnectionMethod,
  ProviderCategory,
} from "./types.js";

interface ProviderDescriptor {
  integrationType: string;
  /**
   * Canonical Router provider id. This is the join key to Router connection
   * truth; `integrationType` is only the stable product-facing identifier.
   */
  providerId: string;
  displayName: string;
  shortDescription: string;
  category: ProviderCategory;
  connectionMethods: readonly ProviderConnectionMethod[];
  capabilities: ProviderDirectoryCapabilities;
}

const descriptors: readonly ProviderDescriptor[] = [
  {
    integrationType: "command-code",
    providerId: "command-code",
    displayName: "Command Code",
    shortDescription: "Command Code subscription usage and quota metadata.",
    category: "subscription",
    connectionMethods: ["local_session", "account"],
    capabilities: {
      modelDiscovery: true,
      quotaDiscovery: true,
      balanceDiscovery: true,
      costDiscovery: false,
      pricingDiscovery: false,
    },
  },
  {
    integrationType: "chatgpt-subscription",
    providerId: "chatgpt",
    displayName: "ChatGPT / Codex",
    shortDescription: "ChatGPT and Codex subscription usage.",
    category: "subscription",
    connectionMethods: ["local_session", "account"],
    capabilities: {
      modelDiscovery: true,
      quotaDiscovery: true,
      balanceDiscovery: false,
      costDiscovery: false,
      pricingDiscovery: false,
    },
  },
  {
    integrationType: "claude-subscription",
    providerId: "claude",
    displayName: "Claude",
    shortDescription: "Claude subscription usage windows.",
    category: "subscription",
    connectionMethods: ["local_session", "account"],
    capabilities: {
      modelDiscovery: true,
      quotaDiscovery: true,
      balanceDiscovery: false,
      costDiscovery: false,
      pricingDiscovery: false,
    },
  },
  {
    integrationType: "google-ai-pro",
    providerId: "google",
    displayName: "Google AI Pro",
    shortDescription: "Google AI Pro / Antigravity access and quota metadata.",
    category: "subscription",
    connectionMethods: ["local_session", "account"],
    capabilities: {
      modelDiscovery: true,
      quotaDiscovery: true,
      balanceDiscovery: false,
      costDiscovery: false,
      pricingDiscovery: false,
    },
  },
  {
    integrationType: "qwen-token-plan",
    providerId: "qwen-token-plan",
    displayName: "Qwen Token Plan",
    shortDescription: "Qwen Cloud subscription token-plan capacity.",
    category: "subscription",
    connectionMethods: ["local_session", "account"],
    capabilities: {
      modelDiscovery: true,
      quotaDiscovery: true,
      balanceDiscovery: true,
      costDiscovery: false,
      pricingDiscovery: false,
    },
  },
  {
    integrationType: "openai-api",
    providerId: "openai-api",
    displayName: "OpenAI API",
    shortDescription: "OpenAI API usage and costs.",
    category: "api",
    connectionMethods: ["api_key"],
    capabilities: {
      modelDiscovery: true,
      quotaDiscovery: true,
      balanceDiscovery: false,
      costDiscovery: true,
      pricingDiscovery: false,
    },
  },
  {
    integrationType: "deepseek",
    providerId: "deepseek",
    displayName: "DeepSeek",
    shortDescription: "DeepSeek API balance and usage metadata.",
    category: "api",
    connectionMethods: ["api_key"],
    capabilities: {
      modelDiscovery: true,
      quotaDiscovery: true,
      balanceDiscovery: true,
      costDiscovery: false,
      pricingDiscovery: false,
    },
  },
  {
    integrationType: "qwen-payg",
    providerId: "qwen-payg",
    displayName: "Qwen Model Studio",
    shortDescription: "Qwen Model Studio pay-as-you-go API access.",
    category: "api",
    connectionMethods: ["api_key"],
    capabilities: {
      modelDiscovery: true,
      quotaDiscovery: true,
      balanceDiscovery: true,
      costDiscovery: false,
      pricingDiscovery: false,
    },
  },
  {
    integrationType: "openrouter",
    providerId: "openrouter",
    displayName: "OpenRouter",
    shortDescription: "OpenRouter models and shared prepaid balance.",
    category: "aggregator",
    connectionMethods: ["api_key"],
    capabilities: {
      modelDiscovery: true,
      quotaDiscovery: true,
      balanceDiscovery: true,
      costDiscovery: false,
      pricingDiscovery: false,
    },
  },
  {
    integrationType: "openai-compatible",
    providerId: "custom-openai-compatible",
    displayName: "Custom Endpoint",
    shortDescription: "Connect an OpenAI-compatible local or remote endpoint.",
    category: "custom_endpoint",
    connectionMethods: ["custom_endpoint"],
    capabilities: {
      modelDiscovery: true,
      quotaDiscovery: false,
      balanceDiscovery: false,
      costDiscovery: false,
      pricingDiscovery: false,
    },
  },
];

/**
 * Static presentation metadata for the Providers product surface.
 *
 * No longer derives connected/disabled state from Usage integrations.
 * Dynamic connection state comes from the Router projection and is joined
 * by `PresentationCatalogService`.
 */
export class ProviderDirectory {
  constructor(
    private readonly providerDescriptors: readonly ProviderDescriptor[] = descriptors,
  ) {}

  list(): ProviderDirectoryEntry[] {
    return this.providerDescriptors.map((descriptor) => ({
      ...descriptor,
      state: "available" as const,
      connectedInstanceCount: 0,
      connectionMethods: [...descriptor.connectionMethods],
      capabilities: { ...descriptor.capabilities },
    }));
  }

  get(integrationType: string): ProviderDirectoryEntry | undefined {
    return this.list().find((entry) => entry.integrationType === integrationType);
  }
}

export function createDefaultProviderDirectory(): ProviderDirectory {
  return new ProviderDirectory();
}
