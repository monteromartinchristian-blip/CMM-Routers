import { randomUUID } from "node:crypto";
import type {
  AccessRoute,
  AccessRouteStatus,
  Account,
  LifecycleStatus,
  Metadata,
  Metric,
  ModelIdentity,
  ModelLifecycle,
  Product,
  Provider,
  ProviderKind,
  QuotaBinding,
  QuotaBucket,
  QuotaEnforcement,
  QuotaStatus,
  SubscriptionPeriod,
  WindowPolicy,
} from "../domain/types.js";
import type { UsageStore } from "../storage/usage-store.js";

export interface RegisterProviderInput {
  id?: string;
  displayName: string;
  kind: ProviderKind;
  status?: Provider["status"];
  metadata?: Metadata;
}

export interface RegisterAccountInput {
  id?: string;
  providerId: string;
  label: string;
  status?: Account["status"];
  externalAccountHint?: string;
}

export interface RegisterProductInput {
  id?: string;
  providerId: string;
  displayName: string;
  kind: string;
  metadata?: Metadata;
}

export interface StartSubscriptionInput {
  id?: string;
  accountId: string;
  productId: string;
  startedAt?: string;
  billingAmount?: number;
  billingCurrency?: string;
  metadata?: Metadata;
}

export interface EndSubscriptionInput {
  subscriptionPeriodId: string;
  status: Exclude<LifecycleStatus, "active">;
  endedAt?: string;
}

export interface RegisterModelInput {
  id?: string;
  canonicalName: string;
  vendor: string;
  family?: string;
  version?: string;
  lifecycle?: ModelLifecycle;
  aliases?: readonly string[];
  metadata?: Metadata;
}

export interface RegisterAccessRouteInput {
  id?: string;
  accountId: string;
  productId: string;
  subscriptionPeriodId?: string;
  modelIdentityId?: string;
  providerModelId: string;
  displayName: string;
  status?: AccessRouteStatus;
  metadata?: Metadata;
}

export interface RegisterQuotaBucketInput {
  id?: string;
  accountId: string;
  productId: string;
  quotaGroupId?: string;
  displayName: string;
  metric: Metric;
  windowPolicy: WindowPolicy;
  limitValue?: number;
  unit: string;
  enforcement: QuotaEnforcement;
  status?: QuotaStatus;
  providerKey?: string;
  metadata?: Metadata;
}

export interface BindQuotaInput {
  id?: string;
  accessRouteId: string;
  quotaBucketId: string;
  consumptionRuleId?: string;
  activeFrom?: string;
  activeTo?: string;
  priority?: number;
  metadata?: Metadata;
}

export interface UsageRegistry {
  registerProvider(input: RegisterProviderInput): Promise<Provider>;
  setProviderEnabled(providerId: string, enabled: boolean): Promise<Provider>;
  registerAccount(input: RegisterAccountInput): Promise<Account>;
  registerProduct(input: RegisterProductInput): Promise<Product>;
  startSubscription(input: StartSubscriptionInput): Promise<SubscriptionPeriod>;
  endSubscription(input: EndSubscriptionInput): Promise<SubscriptionPeriod>;
  registerModel(input: RegisterModelInput): Promise<ModelIdentity>;
  registerAccessRoute(input: RegisterAccessRouteInput): Promise<AccessRoute>;
  registerQuotaBucket(input: RegisterQuotaBucketInput): Promise<QuotaBucket>;
  bindQuota(input: BindQuotaInput): Promise<QuotaBinding>;
}

export interface UsageRegistryOptions {
  now?: () => string;
  id?: (prefix: string) => string;
}

function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

export class UsageRegistryService implements UsageRegistry {
  private readonly now: () => string;
  private readonly createId: (prefix: string) => string;

  constructor(
    private readonly store: UsageStore,
    options: UsageRegistryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.id ?? ((prefix) => `${prefix}:${randomUUID()}`);
  }

  async registerProvider(input: RegisterProviderInput): Promise<Provider> {
    const timestamp = this.now();
    const value: Provider = {
      id: input.id ?? this.createId("provider"),
      displayName: input.displayName,
      kind: input.kind,
      status: input.status ?? "enabled",
      metadata: input.metadata ?? {},
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.upsertProvider(value);
    return value;
  }

  async setProviderEnabled(providerId: string, enabled: boolean): Promise<Provider> {
    const current = requireValue(
      await this.store.getProvider(providerId),
      `Unknown provider: ${providerId}`,
    );
    const value: Provider = {
      ...current,
      status: enabled ? "enabled" : "disabled",
      updatedAt: this.now(),
    };
    await this.store.upsertProvider(value);
    return value;
  }

  async registerAccount(input: RegisterAccountInput): Promise<Account> {
    requireValue(await this.store.getProvider(input.providerId), `Unknown provider: ${input.providerId}`);
    const timestamp = this.now();
    const value: Account = {
      id: input.id ?? this.createId("account"),
      providerId: input.providerId,
      label: input.label,
      status: input.status ?? "active",
      ...(input.externalAccountHint === undefined
        ? {}
        : { externalAccountHint: input.externalAccountHint }),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.upsertAccount(value);
    return value;
  }

  async registerProduct(input: RegisterProductInput): Promise<Product> {
    requireValue(await this.store.getProvider(input.providerId), `Unknown provider: ${input.providerId}`);
    const value: Product = {
      id: input.id ?? this.createId("product"),
      providerId: input.providerId,
      displayName: input.displayName,
      kind: input.kind,
      metadata: input.metadata ?? {},
    };
    await this.store.upsertProduct(value);
    return value;
  }

  async startSubscription(input: StartSubscriptionInput): Promise<SubscriptionPeriod> {
    const account = requireValue(
      await this.store.getAccount(input.accountId),
      `Unknown account: ${input.accountId}`,
    );
    const product = requireValue(
      await this.store.getProduct(input.productId),
      `Unknown product: ${input.productId}`,
    );
    if (account.providerId !== product.providerId) {
      throw new Error("Account and product must belong to the same provider");
    }

    const value: SubscriptionPeriod = {
      id: input.id ?? this.createId("subscription"),
      accountId: input.accountId,
      productId: input.productId,
      status: "active",
      startedAt: input.startedAt ?? this.now(),
      ...(input.billingAmount === undefined ? {} : { billingAmount: input.billingAmount }),
      ...(input.billingCurrency === undefined ? {} : { billingCurrency: input.billingCurrency }),
      metadata: input.metadata ?? {},
    };
    await this.store.upsertSubscriptionPeriod(value);
    return value;
  }

  async endSubscription(input: EndSubscriptionInput): Promise<SubscriptionPeriod> {
    const current = requireValue(
      await this.store.getSubscriptionPeriod(input.subscriptionPeriodId),
      `Unknown subscription period: ${input.subscriptionPeriodId}`,
    );
    const value: SubscriptionPeriod = {
      ...current,
      status: input.status,
      endedAt: input.endedAt ?? this.now(),
    };
    await this.store.upsertSubscriptionPeriod(value);
    return value;
  }

  async registerModel(input: RegisterModelInput): Promise<ModelIdentity> {
    const value: ModelIdentity = {
      id: input.id ?? this.createId("model"),
      canonicalName: input.canonicalName,
      vendor: input.vendor,
      ...(input.family === undefined ? {} : { family: input.family }),
      ...(input.version === undefined ? {} : { version: input.version }),
      lifecycle: input.lifecycle ?? "unknown",
      aliases: input.aliases ?? [],
      metadata: input.metadata ?? {},
    };
    await this.store.upsertModelIdentity(value);
    return value;
  }

  async registerAccessRoute(input: RegisterAccessRouteInput): Promise<AccessRoute> {
    const account = requireValue(
      await this.store.getAccount(input.accountId),
      `Unknown account: ${input.accountId}`,
    );
    const product = requireValue(
      await this.store.getProduct(input.productId),
      `Unknown product: ${input.productId}`,
    );
    if (account.providerId !== product.providerId) {
      throw new Error("Account and product must belong to the same provider");
    }
    if (input.modelIdentityId !== undefined) {
      requireValue(
        await this.store.getModelIdentity(input.modelIdentityId),
        `Unknown model identity: ${input.modelIdentityId}`,
      );
    }
    if (input.subscriptionPeriodId !== undefined) {
      const subscription = requireValue(
        await this.store.getSubscriptionPeriod(input.subscriptionPeriodId),
        `Unknown subscription period: ${input.subscriptionPeriodId}`,
      );
      if (subscription.accountId !== input.accountId || subscription.productId !== input.productId) {
        throw new Error("Subscription period does not belong to the access route account/product");
      }
    }

    const value: AccessRoute = {
      id: input.id ?? this.createId("route"),
      accountId: input.accountId,
      productId: input.productId,
      ...(input.subscriptionPeriodId === undefined
        ? {}
        : { subscriptionPeriodId: input.subscriptionPeriodId }),
      ...(input.modelIdentityId === undefined ? {} : { modelIdentityId: input.modelIdentityId }),
      providerModelId: input.providerModelId,
      displayName: input.displayName,
      status: input.status ?? "unknown",
      metadata: input.metadata ?? {},
    };
    await this.store.upsertAccessRoute(value);
    return value;
  }

  async registerQuotaBucket(input: RegisterQuotaBucketInput): Promise<QuotaBucket> {
    const account = requireValue(
      await this.store.getAccount(input.accountId),
      `Unknown account: ${input.accountId}`,
    );
    const product = requireValue(
      await this.store.getProduct(input.productId),
      `Unknown product: ${input.productId}`,
    );
    if (account.providerId !== product.providerId) {
      throw new Error("Account and product must belong to the same provider");
    }

    const value: QuotaBucket = {
      id: input.id ?? this.createId("bucket"),
      accountId: input.accountId,
      productId: input.productId,
      ...(input.quotaGroupId === undefined ? {} : { quotaGroupId: input.quotaGroupId }),
      displayName: input.displayName,
      metric: input.metric,
      windowPolicy: input.windowPolicy,
      ...(input.limitValue === undefined ? {} : { limitValue: input.limitValue }),
      unit: input.unit,
      enforcement: input.enforcement,
      status: input.status ?? "unknown",
      ...(input.providerKey === undefined ? {} : { providerKey: input.providerKey }),
      metadata: input.metadata ?? {},
    };
    await this.store.upsertQuotaBucket(value);
    return value;
  }

  async bindQuota(input: BindQuotaInput): Promise<QuotaBinding> {
    requireValue(
      await this.store.getAccessRoute(input.accessRouteId),
      `Unknown access route: ${input.accessRouteId}`,
    );
    requireValue(
      await this.store.getQuotaBucket(input.quotaBucketId),
      `Unknown quota bucket: ${input.quotaBucketId}`,
    );

    const value: QuotaBinding = {
      id: input.id ?? this.createId("binding"),
      accessRouteId: input.accessRouteId,
      quotaBucketId: input.quotaBucketId,
      ...(input.consumptionRuleId === undefined
        ? {}
        : { consumptionRuleId: input.consumptionRuleId }),
      activeFrom: input.activeFrom ?? this.now(),
      ...(input.activeTo === undefined ? {} : { activeTo: input.activeTo }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      metadata: input.metadata ?? {},
    };
    await this.store.upsertQuotaBinding(value);
    return value;
  }
}
