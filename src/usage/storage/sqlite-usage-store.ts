import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  AccessRoute,
  Account,
  ConsumptionRule,
  CostEvent,
  ModelIdentity,
  Product,
  Provider,
  QuotaBinding,
  QuotaBucket,
  QuotaGroup,
  QuotaSnapshot,
  QuotaState,
  RouteGraph,
  SubscriptionPeriod,
  UsageEvent,
} from "../domain/types.js";
import type { VisibilityPreference } from "../presentation/types.js";
import { applyUsageMigrations } from "./migrations.js";
import type { UsageStore } from "./usage-store.js";

type PayloadRow = { payload_json: string };

const forbiddenPersistenceKeys = new Set([
  "prompt",
  "completion",
  "apikey",
  "oauth",
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

function assertPersistenceSafe(value: unknown, path = "root"): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPersistenceSafe(entry, `${path}[${index}]`));
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (forbiddenPersistenceKeys.has(normalizedKey(key))) {
      throw new Error(`Sensitive field is not allowed in CMM Usage persistence: ${path}.${key}`);
    }
    assertPersistenceSafe(entry, `${path}.${key}`);
  }
}

function encode(value: unknown): string {
  assertPersistenceSafe(value);
  return JSON.stringify(value);
}

function decode<T>(row: PayloadRow | undefined): T | undefined {
  return row === undefined ? undefined : (JSON.parse(row.payload_json) as T);
}

function decodeAll<T>(rows: readonly PayloadRow[]): T[] {
  return rows.map((row) => JSON.parse(row.payload_json) as T);
}

function visibilityPreferenceId(value: VisibilityPreference): string {
  return [
    value.scope,
    value.providerId ?? "*",
    value.productId ?? "*",
    value.routeId ?? "*",
  ].join("|");
}

export class SqliteUsageStore implements UsageStore {
  private database: DatabaseSync | undefined;

  constructor(private readonly path: string) {}

  async initialize(): Promise<void> {
    if (this.database !== undefined) return;
    if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true });
    const database = new DatabaseSync(this.path);
    database.exec("PRAGMA foreign_keys = ON");
    applyUsageMigrations(database);
    this.database = database;
  }

  async close(): Promise<void> {
    this.database?.close();
    this.database = undefined;
  }

  private db(): DatabaseSync {
    if (this.database === undefined) throw new Error("SqliteUsageStore is not initialized");
    return this.database;
  }

  private upsert(
    table: string,
    value: { id: string },
    columns: readonly [string, SQLInputValue | undefined][],
  ): void {
    const names = ["id", ...columns.map(([name]) => name), "payload_json"];
    const placeholders = names.map(() => "?").join(", ");
    const updates = names
      .filter((name) => name !== "id")
      .map((name) => `${name}=excluded.${name}`)
      .join(", ");
    this.db()
      .prepare(
        `INSERT INTO ${table} (${names.join(", ")}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${updates}`,
      )
      .run(value.id, ...columns.map(([, entry]) => entry ?? null), encode(value));
  }

  async upsertProvider(value: Provider): Promise<void> {
    this.upsert("providers", value, []);
  }

  async upsertAccount(value: Account): Promise<void> {
    this.upsert("accounts", value, [["provider_id", value.providerId]]);
  }

  async upsertProduct(value: Product): Promise<void> {
    this.upsert("products", value, [["provider_id", value.providerId]]);
  }

  async upsertSubscriptionPeriod(value: SubscriptionPeriod): Promise<void> {
    this.upsert("subscription_periods", value, [
      ["account_id", value.accountId],
      ["product_id", value.productId],
    ]);
  }

  async upsertModelIdentity(value: ModelIdentity): Promise<void> {
    this.upsert("model_identities", value, []);
  }

  async upsertAccessRoute(value: AccessRoute): Promise<void> {
    this.upsert("access_routes", value, [
      ["account_id", value.accountId],
      ["product_id", value.productId],
      ["subscription_period_id", value.subscriptionPeriodId],
      ["model_identity_id", value.modelIdentityId],
    ]);
  }

  async upsertQuotaGroup(value: QuotaGroup): Promise<void> {
    this.upsert("quota_groups", value, [["product_id", value.productId]]);
  }

  async upsertQuotaBucket(value: QuotaBucket): Promise<void> {
    this.upsert("quota_buckets", value, [
      ["account_id", value.accountId],
      ["product_id", value.productId],
      ["quota_group_id", value.quotaGroupId],
    ]);
  }

  async upsertQuotaBinding(value: QuotaBinding): Promise<void> {
    this.upsert("quota_bindings", value, [
      ["access_route_id", value.accessRouteId],
      ["quota_bucket_id", value.quotaBucketId],
      ["consumption_rule_id", value.consumptionRuleId],
    ]);
  }

  async upsertConsumptionRule(value: ConsumptionRule): Promise<void> {
    this.upsert("consumption_rules", value, []);
  }

  private transaction(action: () => void): void {
    const database = this.db();
    database.exec("BEGIN IMMEDIATE");
    try {
      action();
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  async appendUsageEvents(values: readonly UsageEvent[]): Promise<void> {
    const statement = this.db().prepare(`
      INSERT OR IGNORE INTO usage_events(
        id, occurred_at, provider_id, account_id, product_id, access_route_id, model_identity_id, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.transaction(() => {
      for (const value of values) {
        statement.run(
          value.id,
          value.occurredAt,
          value.providerId,
          value.accountId,
          value.productId,
          value.accessRouteId ?? null,
          value.modelIdentityId ?? null,
          encode(value),
        );
      }
    });
  }

  async appendCostEvents(values: readonly CostEvent[]): Promise<void> {
    const statement = this.db().prepare(`
      INSERT OR IGNORE INTO cost_events(
        id, occurred_at, provider_id, account_id, product_id, access_route_id, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.transaction(() => {
      for (const value of values) {
        statement.run(
          value.id,
          value.occurredAt,
          value.providerId,
          value.accountId,
          value.productId,
          value.accessRouteId ?? null,
          encode(value),
        );
      }
    });
  }

  async appendQuotaSnapshots(values: readonly QuotaSnapshot[]): Promise<void> {
    const statement = this.db().prepare(`
      INSERT OR IGNORE INTO quota_snapshots(id, quota_bucket_id, observed_at, payload_json)
      VALUES (?, ?, ?, ?)
    `);
    this.transaction(() => {
      for (const value of values) {
        statement.run(value.id, value.quotaBucketId, value.observedAt, encode(value));
      }
    });
  }

  private selectById<T>(table: string, id: string): T | undefined {
    const row = this.db().prepare(`SELECT payload_json FROM ${table} WHERE id = ?`).get(id) as
      | PayloadRow
      | undefined;
    return decode<T>(row);
  }

  async getProvider(id: string): Promise<Provider | undefined> {
    return this.selectById<Provider>("providers", id);
  }

  async listProviders(): Promise<Provider[]> {
    const rows = this.db().prepare("SELECT payload_json FROM providers ORDER BY id").all() as PayloadRow[];
    return decodeAll<Provider>(rows);
  }

  async getAccount(id: string): Promise<Account | undefined> {
    return this.selectById<Account>("accounts", id);
  }

  async getProduct(id: string): Promise<Product | undefined> {
    return this.selectById<Product>("products", id);
  }

  async listProducts(providerId?: string): Promise<Product[]> {
    const rows = (providerId === undefined
      ? this.db().prepare("SELECT payload_json FROM products ORDER BY id").all()
      : this.db()
          .prepare("SELECT payload_json FROM products WHERE provider_id = ? ORDER BY id")
          .all(providerId)) as PayloadRow[];
    return decodeAll<Product>(rows);
  }

  async getSubscriptionPeriod(id: string): Promise<SubscriptionPeriod | undefined> {
    return this.selectById<SubscriptionPeriod>("subscription_periods", id);
  }

  async listSubscriptionPeriods(productId?: string): Promise<SubscriptionPeriod[]> {
    const rows = (productId === undefined
      ? this.db().prepare("SELECT payload_json FROM subscription_periods ORDER BY id").all()
      : this.db()
          .prepare("SELECT payload_json FROM subscription_periods WHERE product_id = ? ORDER BY id")
          .all(productId)) as PayloadRow[];
    return decodeAll<SubscriptionPeriod>(rows);
  }

  async getModelIdentity(id: string): Promise<ModelIdentity | undefined> {
    return this.selectById<ModelIdentity>("model_identities", id);
  }

  async listModelIdentities(): Promise<ModelIdentity[]> {
    const rows = this.db()
      .prepare("SELECT payload_json FROM model_identities ORDER BY id")
      .all() as PayloadRow[];
    return decodeAll<ModelIdentity>(rows);
  }

  async getAccessRoute(id: string): Promise<AccessRoute | undefined> {
    return this.selectById<AccessRoute>("access_routes", id);
  }

  async listAccessRoutes(productId?: string): Promise<AccessRoute[]> {
    const rows = (productId === undefined
      ? this.db().prepare("SELECT payload_json FROM access_routes ORDER BY id").all()
      : this.db()
          .prepare("SELECT payload_json FROM access_routes WHERE product_id = ? ORDER BY id")
          .all(productId)) as PayloadRow[];
    return decodeAll<AccessRoute>(rows);
  }

  async getQuotaBucket(id: string): Promise<QuotaBucket | undefined> {
    return this.selectById<QuotaBucket>("quota_buckets", id);
  }

  async listQuotaBuckets(productId?: string): Promise<QuotaBucket[]> {
    const rows = (productId === undefined
      ? this.db().prepare("SELECT payload_json FROM quota_buckets ORDER BY id").all()
      : this.db()
          .prepare("SELECT payload_json FROM quota_buckets WHERE product_id = ? ORDER BY id")
          .all(productId)) as PayloadRow[];
    return decodeAll<QuotaBucket>(rows);
  }

  async getCurrentQuotaState(bucketId: string): Promise<QuotaSnapshot[]> {
    const rows = this.db()
      .prepare(
        "SELECT payload_json FROM quota_snapshots WHERE quota_bucket_id = ? ORDER BY observed_at DESC, id DESC",
      )
      .all(bucketId) as PayloadRow[];
    return decodeAll<QuotaSnapshot>(rows);
  }

  async getRouteGraph(accessRouteId: string): Promise<RouteGraph> {
    const accessRoute = await this.getAccessRoute(accessRouteId);
    if (accessRoute === undefined) throw new Error(`Unknown access route: ${accessRouteId}`);

    const bindingRows = this.db()
      .prepare("SELECT payload_json FROM quota_bindings WHERE access_route_id = ? ORDER BY id")
      .all(accessRouteId) as PayloadRow[];
    const bindings = decodeAll<QuotaBinding>(bindingRows);
    const quotaStates: QuotaState[] = [];
    for (const binding of bindings) {
      const bucket = await this.getQuotaBucket(binding.quotaBucketId);
      if (bucket === undefined) continue;
      const [snapshot] = await this.getCurrentQuotaState(bucket.id);
      quotaStates.push(snapshot === undefined ? { bucket } : { bucket, snapshot });
    }

    return { accessRoute, bindings, quotaStates };
  }

  async listUsageEvents(limit = 100): Promise<UsageEvent[]> {
    const rows = this.db()
      .prepare("SELECT payload_json FROM usage_events ORDER BY occurred_at DESC, id DESC LIMIT ?")
      .all(limit) as PayloadRow[];
    return decodeAll<UsageEvent>(rows);
  }

  async listCostEvents(limit = 100): Promise<CostEvent[]> {
    const rows = this.db()
      .prepare("SELECT payload_json FROM cost_events ORDER BY occurred_at DESC, id DESC LIMIT ?")
      .all(limit) as PayloadRow[];
    return decodeAll<CostEvent>(rows);
  }

  async upsertVisibilityPreference(value: VisibilityPreference): Promise<void> {
    const id = visibilityPreferenceId(value);
    this.db()
      .prepare(`
        INSERT INTO visibility_preferences(id, scope, provider_id, product_id, route_id, payload_json)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          scope=excluded.scope,
          provider_id=excluded.provider_id,
          product_id=excluded.product_id,
          route_id=excluded.route_id,
          payload_json=excluded.payload_json
      `)
      .run(
        id,
        value.scope,
        value.providerId ?? null,
        value.productId ?? null,
        value.routeId ?? null,
        encode(value),
      );
  }

  async listVisibilityPreferences(
    scope?: VisibilityPreference["scope"],
  ): Promise<VisibilityPreference[]> {
    const rows = (scope === undefined
      ? this.db().prepare("SELECT payload_json FROM visibility_preferences ORDER BY id").all()
      : this.db()
          .prepare("SELECT payload_json FROM visibility_preferences WHERE scope = ? ORDER BY id")
          .all(scope)) as PayloadRow[];
    return decodeAll<VisibilityPreference>(rows);
  }
}
