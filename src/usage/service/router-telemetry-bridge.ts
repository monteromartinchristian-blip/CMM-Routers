import type { CostEvent, UsageEvent } from "../domain/types.js";
import type { UsageStore } from "../storage/usage-store.js";

export type RouterTelemetryStatus =
  | "success"
  | "provider_error"
  | "auth_error"
  | "quota_error"
  | "billing_blocked"
  | "rate_limit_error"
  | "timeout_error"
  | "cancelled";

export interface RouterTelemetryObservation {
  requestId: string;
  routerProviderId: string;
  routerModelId: string;
  status: RouterTelemetryStatus;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  errorCode?: string;
  finishReason?: "stop" | "tool_calls" | "length";
}

export interface RouterTelemetryIdentity {
  providerId: string;
  accountId: string;
  productId: string;
  accessRouteId?: string;
  modelIdentityId?: string;
}

export interface RouterTelemetryDiagnostic {
  kind: "identity_error" | "identity_unresolved" | "persistence_error";
  requestId: string;
  message: string;
}

export interface RouterTelemetryCaptureResult {
  status: "recorded" | "skipped" | "error";
}

export interface RouterTelemetrySink {
  observe(observation: RouterTelemetryObservation): void;
}

export interface RouterTelemetryBridgeOptions {
  resolveIdentity(
    input: Pick<RouterTelemetryObservation, "requestId" | "routerProviderId" | "routerModelId">,
  ): RouterTelemetryIdentity | undefined | Promise<RouterTelemetryIdentity | undefined>;
  now?: () => Date;
  onDiagnostic?: (diagnostic: RouterTelemetryDiagnostic) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class RouterTelemetryBridge implements RouterTelemetrySink {
  private readonly now: () => Date;

  constructor(
    private readonly store: UsageStore,
    private readonly options: RouterTelemetryBridgeOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private diagnostic(diagnostic: RouterTelemetryDiagnostic): void {
    try {
      this.options.onDiagnostic?.(diagnostic);
    } catch {
      // Diagnostics are advisory and must never affect inference or persistence.
    }
  }

  observe(observation: RouterTelemetryObservation): void {
    void this.capture(observation);
  }

  async capture(observation: RouterTelemetryObservation): Promise<RouterTelemetryCaptureResult> {
    let identity: RouterTelemetryIdentity | undefined;
    try {
      identity = await this.options.resolveIdentity({
        requestId: observation.requestId,
        routerProviderId: observation.routerProviderId,
        routerModelId: observation.routerModelId,
      });
    } catch (error) {
      this.diagnostic({
        kind: "identity_error",
        requestId: observation.requestId,
        message: errorMessage(error),
      });
      return { status: "error" };
    }

    if (identity === undefined) {
      this.diagnostic({
        kind: "identity_unresolved",
        requestId: observation.requestId,
        message: `No CMM Usage identity for ${observation.routerProviderId}/${observation.routerModelId}`,
      });
      return { status: "skipped" };
    }

    const occurredAt = this.now().toISOString();
    const metadata: Record<string, unknown> = {
      routerProviderId: observation.routerProviderId,
      routerModelId: observation.routerModelId,
      routerStatus: observation.status,
      ...(observation.finishReason !== undefined ? { finishReason: observation.finishReason } : {}),
      ...(observation.errorCode !== undefined ? { errorCode: observation.errorCode } : {}),
      ...(observation.reasoningTokens !== undefined
        ? { reasoningTokens: observation.reasoningTokens }
        : {}),
    };

    const usageEvent: UsageEvent = {
      id: `usage:router:${observation.requestId}`,
      occurredAt,
      providerId: identity.providerId,
      accountId: identity.accountId,
      productId: identity.productId,
      ...(identity.accessRouteId !== undefined ? { accessRouteId: identity.accessRouteId } : {}),
      ...(identity.modelIdentityId !== undefined ? { modelIdentityId: identity.modelIdentityId } : {}),
      requestCorrelationId: observation.requestId,
      ...(observation.inputTokens !== undefined ? { inputTokens: observation.inputTokens } : {}),
      ...(observation.outputTokens !== undefined ? { outputTokens: observation.outputTokens } : {}),
      ...(observation.cacheReadTokens !== undefined
        ? { cachedInputTokens: observation.cacheReadTokens }
        : {}),
      requests: 1,
      ...(observation.costUsd !== undefined
        ? { costAmount: observation.costUsd, costCurrency: "USD" }
        : {}),
      source: "router_measured",
      confidence: "measured",
      metadata,
    };

    const costEvent: CostEvent | undefined =
      observation.costUsd === undefined
        ? undefined
        : {
            id: `cost:router:${observation.requestId}`,
            occurredAt,
            providerId: identity.providerId,
            accountId: identity.accountId,
            productId: identity.productId,
            ...(identity.accessRouteId !== undefined ? { accessRouteId: identity.accessRouteId } : {}),
            amount: observation.costUsd,
            currency: "USD",
            kind: "usage",
            source: "router_measured",
            confidence: "measured",
            metadata,
          };

    try {
      await this.store.appendUsageEvents([usageEvent]);
      if (costEvent !== undefined) await this.store.appendCostEvents([costEvent]);
      return { status: "recorded" };
    } catch (error) {
      this.diagnostic({
        kind: "persistence_error",
        requestId: observation.requestId,
        message: errorMessage(error),
      });
      return { status: "error" };
    }
  }
}
