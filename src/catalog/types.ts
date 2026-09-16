export type ConnectionKind = string;

export type DiscoveryCapability = string;

export type ExecutionProfile = string;

export type BillingClass = string;

export interface ProviderDefinition {
  providerId: string;
  displayName: string;
  adapterKind: string;
  supportedConnectionKinds: ConnectionKind[];
  discoveryCapabilities: DiscoveryCapability[];
}

export interface Account {
  accountId: string;
  providerId: string;
  label: string;
  identityStatus: "resolved" | "unresolved";
  externalAccountRef?: string;
}

export type ProductKind =
  | "subscription"
  | "api"
  | "free_pool"
  | "promo_pool"
  | "enterprise"
  | "local";

export interface ProviderProduct {
  productId: string;
  accountId: string;
  providerId: string;
  kind: ProductKind;
  label: string;
}

export interface SecretMaterialRef {
  secretRef: string;
  storageKind: "keychain" | "native_secure_store";
}

export type CredentialPurpose = "execution" | "observability";

export interface ExecutionCredentialBinding {
  bindingId: string;
  providerId: string;
  accountId?: string;
  productId?: string;
  secretRef: string;
  purpose: "execution";
  enabled: boolean;
}

export interface ObservabilityCredentialBinding {
  bindingId: string;
  providerId: string;
  accountId?: string;
  productId?: string;
  secretRef: string;
  purpose: "observability";
  enabled: boolean;
}

export type ConnectionStatus =
  | "configured"
  | "validating"
  | "ready"
  | "auth_required"
  | "unavailable"
  | "disabled"
  | "error";

export interface ProviderConnection {
  connectionId: string;
  providerId: string;
  accountId?: string;
  productId?: string;
  connectionKind: ConnectionKind;
  executionCredentialBindingId?: string;
  profileRef?: string;
  endpointRef?: string;
  status: ConnectionStatus;
}

export interface ModelIdentity {
  modelIdentityId: string;
  canonicalName: string;
  family?: string;
  aliases: string[];
}

export interface RouteCapabilities {
  chat: boolean;
  tools: boolean;
  vision?: boolean;
  reasoningEffort?: boolean;
  streaming: boolean;
}

export type RouteSurface =
  | "cmmchat_model_picker"
  | "cmmcode_model_picker"
  | "admin_console";

export interface RouteVisibility {
  visibleOn: RouteSurface[];
}

export interface AccessRoute {
  routeId: string;
  modelIdentityId: string;
  connectionId: string;
  providerId: string;
  providerModelId: string;
  executionProfile: string;
  capabilities: RouteCapabilities;
  billingClass: string;
  routable: boolean;
  visibility: RouteVisibility;
}
