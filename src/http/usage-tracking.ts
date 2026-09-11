import type { RouterEvent } from "../core/events.js";
import type { UsageStatus, UsageStore } from "../observability/usage-store.js";

export function usageStatusForRouterErrorCode(code: string): UsageStatus {
  switch (code) {
    case "provider_quota_exhausted":
      return "quota_error";
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
  errorCode?: string | undefined;
  finishReason?: "stop" | "tool_calls" | "length" | undefined;
  error?: unknown;
}

/**
 * Track one provider event stream into a UsageStore. The passthrough design
 * preserves streaming: consumers receive each event as it arrives while the
 * tracker only accumulates token counts. Exactly one
 * beginRequest/endRequest pair fires per call: begin immediately, end on the
 * first terminal event (or on abort/throw with cancelled/provider_error).
 */
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
  const collected: RouterEvent[] = [];
  const record = (event: RouterEvent): void => {
    collected.push(event);
  };

  if (!usageStore) {
    for await (const event of events) {
      const typed = event as RouterEvent;
      record(typed);
      yield typed;
      if (signal?.aborted) {
        return { events: collected, status: "cancelled", inputTokens, outputTokens };
      }
      if (typed.type === "usage") {
        if (typed.inputTokens !== undefined) inputTokens = typed.inputTokens;
        if (typed.outputTokens !== undefined) outputTokens = typed.outputTokens;
      }
      if (typed.type === "completed") {
        return {
          events: collected,
          status: "success",
          inputTokens,
          outputTokens,
          finishReason: typed.finishReason,
        };
      }
      if (typed.type === "error") {
        const errorCode = errorCodeOf(typed.error);
        return {
          events: collected,
          status: usageStatusForTerminalError(typed.error),
          inputTokens,
          outputTokens,
          ...(errorCode ? { errorCode } : {}),
          error: typed.error,
        };
      }
    }
    return { events: collected, status: "provider_error", inputTokens, outputTokens };
  }

  usageStore.beginRequest(requestId, provider, modelId);
  let ended = false;
  const endOnce = (outcome: {
    status: UsageStatus;
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
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
        endOnce({ status: "cancelled", inputTokens, outputTokens });
        record(typed);
        yield typed;
        return { events: collected, status: "cancelled", inputTokens, outputTokens };
      }
      if (typed.type === "usage") {
        if (typed.inputTokens !== undefined) inputTokens = typed.inputTokens;
        if (typed.outputTokens !== undefined) outputTokens = typed.outputTokens;
        record(typed);
        yield typed;
        continue;
      }
      if (typed.type === "completed") {
        endOnce({ status: "success", inputTokens, outputTokens });
        record(typed);
        yield typed;
        return {
          events: collected,
          status: "success",
          inputTokens,
          outputTokens,
          finishReason: typed.finishReason,
        };
      }
      if (typed.type === "error") {
        const errorCode = errorCodeOf(typed.error);
        const status = usageStatusForTerminalError(typed.error);
        endOnce({ status, inputTokens, outputTokens, ...(errorCode ? { errorCode } : {}) });
        record(typed);
        yield typed;
        return { events: collected, status, inputTokens, outputTokens, ...(errorCode ? { errorCode } : {}), error: typed.error };
      }
      record(typed);
      yield typed;
    }
    endOnce({ status: "provider_error", inputTokens, outputTokens });
    return { events: collected, status: "provider_error", inputTokens, outputTokens };
  } catch (error) {
    const errorCode = errorCodeOf(error);
    endOnce({
      status: errorCode === "provider_timeout" ? "timeout_error" : "provider_error",
      inputTokens,
      outputTokens,
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
