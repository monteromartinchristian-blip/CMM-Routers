import type {
  AccessRoute,
  Account,
  AdapterCapability,
  CostEvent,
  ModelIdentity,
  Product,
  Provider,
  QuotaSnapshot,
  UsageEvent,
} from "../domain/types.js";

export type UsageAdapterCapability = AdapterCapability;

export interface UsageAdapterManifest {
  id: string;
  displayName: string;
  collectionSafety: "non_inference_only";
  minimumRefreshIntervalMs?: number;
}

export type UsageAdapterHealth =
  | { status: "healthy"; detail?: string }
  | { status: "degraded"; detail?: string }
  | { status: "unavailable"; detail?: string }
  | { status: "unknown"; detail?: string };

export type UsageAdapterErrorKind =
  | "auth"
  | "rate_limit"
  | "unavailable"
  | "stale"
  | "protocol";

export interface UsageAdapterErrorState {
  kind: UsageAdapterErrorKind;
  message: string;
}

export class UsageAdapterError extends Error {
  constructor(
    readonly kind: UsageAdapterErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "UsageAdapterError";
  }
}

export interface UsageUnsupportedResult {
  status: "unsupported";
  capability: UsageAdapterCapability;
}

export interface UsageDisabledResult {
  status: "disabled";
}

export interface UsageErrorResult {
  status: "error";
  error: UsageAdapterErrorState;
}

export interface UsageDiscoverySuccess {
  status: "ok";
  providers: Provider[];
  accounts: Account[];
  products: Product[];
  models: ModelIdentity[];
  accessRoutes: AccessRoute[];
  metadata?: Readonly<Record<string, unknown>>;
}

export type UsageDiscoveryResult =
  | UsageDiscoverySuccess
  | UsageUnsupportedResult
  | UsageDisabledResult
  | UsageErrorResult;

export interface UsageEventBatchSuccess {
  status: "ok";
  values: UsageEvent[];
  cursor?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export type UsageEventBatch =
  | UsageEventBatchSuccess
  | UsageUnsupportedResult
  | UsageDisabledResult
  | UsageErrorResult;

export interface QuotaSnapshotBatchSuccess {
  status: "ok";
  values: QuotaSnapshot[];
  metadata?: Readonly<Record<string, unknown>>;
}

export type QuotaSnapshotBatch =
  | QuotaSnapshotBatchSuccess
  | UsageUnsupportedResult
  | UsageDisabledResult
  | UsageErrorResult;

export interface CostEventBatchSuccess {
  status: "ok";
  values: CostEvent[];
  cursor?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export type CostEventBatch =
  | CostEventBatchSuccess
  | UsageUnsupportedResult
  | UsageDisabledResult
  | UsageErrorResult;

export interface UsageRefreshSuccess {
  status: "ok";
  refreshedAt: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export type UsageRefreshResult =
  | UsageRefreshSuccess
  | UsageUnsupportedResult
  | UsageDisabledResult
  | UsageErrorResult;

export interface UsageAdapter {
  readonly id: string;
  manifest(): UsageAdapterManifest;
  capabilities(): ReadonlySet<UsageAdapterCapability>;
  health(): Promise<UsageAdapterHealth>;
  discover(): Promise<UsageDiscoveryResult>;
  collectUsageEvents(cursor?: string): Promise<UsageEventBatch>;
  collectQuotaSnapshots(): Promise<QuotaSnapshotBatch>;
  collectCostEvents(cursor?: string): Promise<CostEventBatch>;
  refresh(): Promise<UsageRefreshResult>;
}

export function unsupported(capability: UsageAdapterCapability): UsageUnsupportedResult {
  return { status: "unsupported", capability };
}
