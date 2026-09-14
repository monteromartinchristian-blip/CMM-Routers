import type { UsageIntegrationDefinition } from "../runtime/configured-runtime.js";
import type {
  ProviderDirectoryCapabilities,
  ProviderDirectoryEntry,
  ProviderConnectionMethod,
  ProviderCategory,
} from "./types.js";

interface ProviderDescriptor {
  integrationType: string;
  displayName: string;
  shortDescription: string;
  category: ProviderCategory;
  connectionMethods: readonly ProviderConnectionMethod[];
  capabilities: ProviderDirectoryCapabilities;
}

const descriptors: readonly ProviderDescriptor[] = [
  {
    integrationType: "command-code",
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

export class ProviderDirectory {
  private definitions: UsageIntegrationDefinition[];

  constructor(
    definitions: readonly UsageIntegrationDefinition[],
    private readonly providerDescriptors: readonly ProviderDescriptor[] = descriptors,
  ) {
    this.definitions = [...definitions];
  }

  replaceDefinitions(definitions: readonly UsageIntegrationDefinition[]): void {
    this.definitions = [...definitions];
  }

  instanceIds(integrationType: string): string[] {
    return this.definitions
      .filter((definition) => definition.type === integrationType)
      .map((definition) => definition.id)
      .sort();
  }

  list(): ProviderDirectoryEntry[] {
    return this.providerDescriptors.map((descriptor) => {
      const instances = this.definitions.filter(
        (definition) => definition.type === descriptor.integrationType,
      );
      const enabledCount = instances.filter((definition) => definition.enabled).length;
      return {
        ...descriptor,
        state: instances.length === 0
          ? "available"
          : enabledCount === 0
            ? "disabled"
            : "connected",
        connectedInstanceCount: instances.length,
        connectionMethods: [...descriptor.connectionMethods],
        capabilities: { ...descriptor.capabilities },
      };
    });
  }

  get(integrationType: string): ProviderDirectoryEntry | undefined {
    return this.list().find((entry) => entry.integrationType === integrationType);
  }
}

export function createDefaultProviderDirectory(
  definitions: readonly UsageIntegrationDefinition[],
): ProviderDirectory {
  return new ProviderDirectory(definitions);
}
