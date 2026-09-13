import type {
  AccessRoute,
  QuotaBinding,
  QuotaBucket,
  QuotaSnapshot,
  ResolveRouteHealthInput,
} from "../../../src/usage/domain/types.js";

const now = "2026-09-13T12:00:00.000Z";

function route(id: string, modelIdentityId = "model:alpha"): AccessRoute {
  return {
    id,
    accountId: "account:example",
    productId: "product:example",
    modelIdentityId,
    providerModelId: "model-alpha",
    displayName: "Model Alpha",
    status: "available",
    metadata: {},
  };
}

function bucket(
  id: string,
  status: QuotaBucket["status"],
  overrides: Partial<QuotaBucket> = {},
): QuotaBucket {
  return {
    id,
    accountId: "account:example",
    productId: "product:example",
    displayName: id,
    metric: { kind: "requests" },
    windowPolicy: { kind: "rolling_duration", durationSeconds: 18_000 },
    unit: "requests",
    enforcement: "hard",
    status,
    metadata: {},
    ...overrides,
  };
}

function binding(
  id: string,
  accessRouteId: string,
  quotaBucketId: string,
  priority?: number,
): QuotaBinding {
  return {
    id,
    accessRouteId,
    quotaBucketId,
    activeFrom: "2026-01-01T00:00:00.000Z",
    ...(priority === undefined ? {} : { priority }),
    metadata: {},
  };
}

function snapshot(
  id: string,
  quotaBucketId: string,
  remainingFraction: number,
  resetAt = "2026-09-13T17:00:00.000Z",
): QuotaSnapshot {
  return {
    id,
    quotaBucketId,
    observedAt: now,
    remainingFraction,
    usedFraction: 1 - remainingFraction,
    resetAt,
    source: "provider_official_api",
    confidence: "exact",
    stalenessAfter: "2026-09-13T12:10:00.000Z",
  };
}

const modelSpecificRoute = route("route:model-specific");
const sharedRouteA = route("route:shared-a", "model:shared-a");
const sharedRouteB = route("route:shared-b", "model:shared-b");
const commandRoute = route("route:command-code", "model:command");
const googleExternalRoute = route("route:google-external", "model:claude");
const anthropicClaudeRoute = route("route:anthropic-claude", "model:claude");
const openAiRoute = route("route:openai", "model:gpt");
const balanceRoute = route("route:balance", "model:balance");
const percentageRoute = route("route:percentage", "model:percentage");

export const canonicalQuotaScenarios = {
  modelSpecificApi: {
    now,
    accessRoute: modelSpecificRoute,
    bindings: [
      binding("binding:model-specific", modelSpecificRoute.id, "model-specific", 5),
      binding("binding:shared", modelSpecificRoute.id, "shared-plan", 10),
    ],
    quotaStates: [
      {
        bucket: bucket("model-specific", "exhausted"),
        snapshot: snapshot("snapshot:model-specific", "model-specific", 0),
      },
      {
        bucket: bucket("shared-plan", "healthy"),
        snapshot: snapshot("snapshot:shared", "shared-plan", 0.72),
      },
    ],
  } satisfies ResolveRouteHealthInput,

  sharedFreePool: {
    now,
    routes: [sharedRouteA, sharedRouteB],
    bucket: bucket("free-pool", "warning"),
    bindings: [
      binding("binding:shared-a", sharedRouteA.id, "free-pool"),
      binding("binding:shared-b", sharedRouteB.id, "free-pool"),
    ],
  },

  commandCodeStyle: {
    now,
    accessRoute: commandRoute,
    bindings: [
      binding("binding:command-short", commandRoute.id, "command-short", 10),
      binding("binding:command-weekly", commandRoute.id, "command-weekly", 20),
    ],
    quotaStates: [
      {
        bucket: bucket("command-short", "critical"),
        snapshot: snapshot("snapshot:command-short", "command-short", 0.08),
        predictedExhaustionAt: "2026-09-13T13:00:00.000Z",
      },
      {
        bucket: bucket("command-weekly", "warning", {
          windowPolicy: {
            kind: "fixed_calendar",
            calendarUnit: "week",
            timezone: "Europe/Madrid",
            anchor: "monday",
          },
        }),
        snapshot: snapshot(
          "snapshot:command-weekly",
          "command-weekly",
          0.22,
          "2026-09-14T07:00:00.000Z",
        ),
      },
    ],
  } satisfies ResolveRouteHealthInput,

  googleAiProStyle: {
    now,
    routes: [googleExternalRoute],
    buckets: [
      bucket("google-external-pool", "healthy", {
        metric: { kind: "provider_defined", providerKey: "external_pool" },
        unit: "provider-units",
      }),
      bucket("google-external-short", "warning"),
    ],
  },

  claudeStyle: {
    now,
    routes: [anthropicClaudeRoute, googleExternalRoute],
    sameModelIdentityId: "model:claude",
  },

  openAiStyle: {
    now,
    accessRoute: openAiRoute,
    bindings: [
      binding("binding:openai-requests", openAiRoute.id, "openai-requests", 10),
      binding("binding:openai-currency", openAiRoute.id, "openai-currency", 10),
    ],
    quotaStates: [
      {
        bucket: bucket("openai-requests", "warning"),
        snapshot: snapshot("snapshot:openai-requests", "openai-requests", 0.19),
      },
      {
        bucket: bucket("openai-currency", "critical", {
          metric: { kind: "currency", currency: "USD" },
          unit: "USD",
          windowPolicy: { kind: "billing_cycle", anchorDate: "2026-09-01", timezone: "UTC" },
        }),
        snapshot: snapshot("snapshot:openai-currency", "openai-currency", 0.04),
      },
    ],
  } satisfies ResolveRouteHealthInput,

  balanceOnly: {
    now,
    accessRoute: balanceRoute,
    bindings: [binding("binding:balance", balanceRoute.id, "balance")],
    quotaStates: [
      {
        bucket: bucket("balance", "healthy", {
          metric: { kind: "credits" },
          unit: "credits",
          windowPolicy: { kind: "none" },
        }),
      },
    ],
  } satisfies ResolveRouteHealthInput,

  percentageOnly: {
    now,
    accessRoute: percentageRoute,
    bindings: [binding("binding:percentage", percentageRoute.id, "percentage")],
    quotaStates: [
      {
        bucket: bucket("percentage", "warning", {
          metric: { kind: "percentage" },
          unit: "fraction",
          windowPolicy: { kind: "provider_reported" },
        }),
        snapshot: snapshot("snapshot:percentage", "percentage", 0.14),
      },
    ],
  } satisfies ResolveRouteHealthInput,
} as const;
