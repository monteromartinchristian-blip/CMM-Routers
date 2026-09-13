import { z } from "zod";

const sourceSchema = z.enum([
  "provider_official_api",
  "provider_official_sdk",
  "provider_official_cli",
  "provider_local_state",
  "router_measured",
  "manual",
  "derived",
  "estimated",
]);

const confidenceSchema = z.enum(["exact", "measured", "calculated", "estimated", "unknown"]);
const fractionSchema = z.number().finite().min(0).max(1);
const nonNegativeSchema = z.number().finite().min(0);
const isoTimestampSchema = z.string().datetime({ offset: true });

export const quotaSnapshotSchema = z
  .object({
    id: z.string().min(1),
    quotaBucketId: z.string().min(1),
    observedAt: isoTimestampSchema,
    usedValue: nonNegativeSchema.optional(),
    remainingValue: nonNegativeSchema.optional(),
    limitValue: nonNegativeSchema.optional(),
    usedFraction: fractionSchema.optional(),
    remainingFraction: fractionSchema.optional(),
    resetAt: isoTimestampSchema.optional(),
    providerResetText: z.string().min(1).optional(),
    source: sourceSchema,
    confidence: confidenceSchema,
    stalenessAfter: isoTimestampSchema,
    rawSafeMetadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
