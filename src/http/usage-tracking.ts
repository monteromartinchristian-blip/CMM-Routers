import type { RouterEvent } from "../core/events.js";
import type { UsageStatus, UsageStore } from "../observability/usage-store.js";

export function usageStatusForRouterErrorCode(code: string): UsageStatus {
  switch (code) {
    case "provider_quota_exhausted":
      return "quota_error";
    case "provider_billing_blocked":
      // Account-state block: distinct from quota exhaustion at the usage
      // boundary so an owed balance is never reported as a spent allowance.
      return "billing_blocked";
    case "provider_rate_limited":
      return "rate_limit_error";
    case "provider_timeout":
      return "timeout_error";
    case "provider_auth_required":
      return "auth_error";
    default:
      return "provider_error";
  }
}

export interface TrackedOutcome {
  events: RouterEvent[];
  status: UsageStatus;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  costUsd?: number | undefined;
  errorCode?: string | undefined;
  finishReason?: "stop" | "tool_calls" | "length" | undefined;
  error?: unknown;
}

export async function* trackProviderStream(
  usageStore: UsageStore | undefined,
  requestId: string,
  provider: string,
  modelId: string,
  events: AsyncIterable<RouterEvent>,
  signal?: AbortSignal,
): AsyncGenerator<RouterEvent, TrackedOutcome, void> {
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let reasoningTokens: number | undefined;
  let cacheReadTokens: number | undefined;
  let costUsd: number | undefined;
  const collected: RouterEvent[] = [];

  const record = (event: RouterEvent): void => {
    collected.push(event);
  };

  const captureUsage = (event: RouterEvent): void => {
    if (event.type !== "usage") return;
    if (event.inputTokens !== undefined) inputTokens = event.inputTokens;
    if (event.outputTokens !== undefined) outputTokens = event.outputTokens;
    if (event.reasoningTokens !== undefined) reasoningTokens = event.reasoningTokens;
    if (event.cacheReadTokens !== undefined) cacheReadTokens = event.cacheReadTokens;
    if (event.costUsd !== undefined) costUsd = event.costUsd;
  };

  const usageFields = () => ({
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    costUsd,
  });

  if (!usageStore) {
    for await (const event of events) {
      const typed = event as RouterEvent;
      record(typed);

      if (signal?.aborted) {
        yield typed;
        return { events: collected, status: "cancelled", ...usageFields() };
      }

      if (typed.type === "usage") {
        captureUsage(typed);
        yield typed;
        continue;
      }

      if (typed.type === "completed") {
        yield typed;
        return {
          events: collected,
          status: "success",
          ...usageFields(),
          finishReason: typed.finishReason,
        };
      }

      if (typed.type === "error") {
        const errorCode = errorCodeOf(typed.error);
        yield typed;
        return {
          events: collected,
          status: usageStatusForTerminalError(typed.error),
          ...usageFields(),
          ...(errorCode ? { errorCode } : {}),
          error: typed.error,
        };
      }

      yield typed;
    }
    return { events: collected, status: "provider_error", ...usageFields() };
  }

  usageStore.beginRequest(requestId, provider, modelId);
  let ended = false;
  const endOnce = (outcome: {
    status: UsageStatus;
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    reasoningTokens?: number | undefined;
    cacheReadTokens?: number | undefined;
    costUsd?: number | undefined;
    errorCode?: string | undefined;
  }): void => {
    if (ended) return;
    ended = true;
    usageStore.endRequest(requestId, outcome);
  };

  try {
    for await (const event of events) {
      const typed = event as RouterEvent;
      if (signal?.aborted) {
        endOnce({ status: "cancelled", ...usageFields() });
        record(typed);
        yield typed;
        return { events: collected, status: "cancelled", ...usageFields() };
      }

      if (typed.type === "usage") {
        captureUsage(typed);
        record(typed);
        yield typed;
        continue;
      }

      if (typed.type === "completed") {
        endOnce({ status: "success", ...usageFields() });
        record(typed);
        yield typed;
        return {
          events: collected,
          status: "success",
          ...usageFields(),
          finishReason: typed.finishReason,
        };
      }

      if (typed.type === "error") {
        const errorCode = errorCodeOf(typed.error);
        const status = usageStatusForTerminalError(typed.error);
        endOnce({
          status,
          ...usageFields(),
          ...(errorCode ? { errorCode } : {}),
        });
        record(typed);
        yield typed;
        return {
          events: collected,
          status,
          ...usageFields(),
          ...(errorCode ? { errorCode } : {}),
          error: typed.error,
        };
      }

      record(typed);
      yield typed;
    }

    endOnce({ status: "provider_error", ...usageFields() });
    return {
      events: collected,
      status: "provider_error",
      ...usageFields(),
    };
  } catch (error) {
    const errorCode = errorCodeOf(error);
    endOnce({
      status: errorCode === "provider_timeout" ? "timeout_error" : "provider_error",
      ...usageFields(),
      ...(errorCode ? { errorCode } : {}),
    });
    throw error;
  }
}

function errorCodeOf(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function usageStatusForTerminalError(error: unknown): UsageStatus {
  const errorCode = errorCodeOf(error);
  if (!errorCode) return "provider_error";
  return usageStatusForRouterErrorCode(errorCode);
}
