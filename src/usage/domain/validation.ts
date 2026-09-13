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
  .strict()
  .superRefine((value, context) => {
    const tolerance = 1e-9;

    if (
      value.usedFraction !== undefined &&
      value.remainingFraction !== undefined &&
      Math.abs(value.usedFraction + value.remainingFraction - 1) > tolerance
    ) {
      context.addIssue({
        code: "custom",
        message: "usedFraction and remainingFraction must sum to 1",
        path: ["remainingFraction"],
      });
    }

    if (value.limitValue !== undefined) {
      if (value.usedValue !== undefined && value.usedValue - value.limitValue > tolerance) {
        context.addIssue({
          code: "custom",
          message: "usedValue cannot exceed limitValue",
          path: ["usedValue"],
        });
      }
      if (value.remainingValue !== undefined && value.remainingValue - value.limitValue > tolerance) {
        context.addIssue({
          code: "custom",
          message: "remainingValue cannot exceed limitValue",
          path: ["remainingValue"],
        });
      }
      if (
        value.usedValue !== undefined &&
        value.remainingValue !== undefined &&
        Math.abs(value.usedValue + value.remainingValue - value.limitValue) > tolerance
      ) {
        context.addIssue({
          code: "custom",
          message: "usedValue and remainingValue must sum to limitValue",
          path: ["remainingValue"],
        });
      }
      if (
        value.limitValue > 0 &&
        value.usedValue !== undefined &&
        value.usedFraction !== undefined &&
        Math.abs(value.usedValue / value.limitValue - value.usedFraction) > tolerance
      ) {
        context.addIssue({
          code: "custom",
          message: "usedFraction must match usedValue / limitValue",
          path: ["usedFraction"],
        });
      }
      if (
        value.limitValue > 0 &&
        value.remainingValue !== undefined &&
        value.remainingFraction !== undefined &&
        Math.abs(value.remainingValue / value.limitValue - value.remainingFraction) > tolerance
      ) {
        context.addIssue({
          code: "custom",
          message: "remainingFraction must match remainingValue / limitValue",
          path: ["remainingFraction"],
        });
      }
    }
  });
