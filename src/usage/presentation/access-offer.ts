import type { AccessRoute, Confidence, Product, Source } from "../domain/types.js";
import type { AccessOfferKind, AccessOfferSummary } from "./types.js";

const offerKinds = new Set<AccessOfferKind>([
  "FREE",
  "PROMO",
  "INCLUDED",
  "TRIAL",
  "PAYG",
  "UNKNOWN",
]);

const sources = new Set<Source>([
  "provider_official_api",
  "provider_official_sdk",
  "provider_official_cli",
  "provider_local_state",
  "router_measured",
  "manual",
  "derived",
  "estimated",
]);

const confidences = new Set<Confidence>([
  "exact",
  "measured",
  "calculated",
  "estimated",
  "unknown",
]);

function stringMetadata(
  metadata: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function explicitOfferKind(
  route: AccessRoute,
  product: Product,
): AccessOfferKind | undefined {
  for (const metadata of [route.metadata, product.metadata]) {
    const value = stringMetadata(metadata, "offerKind");
    if (value !== undefined && offerKinds.has(value as AccessOfferKind)) {
      return value as AccessOfferKind;
    }
  }
  return undefined;
}

export function projectAccessOffer(
  route: AccessRoute,
  product: Product,
): AccessOfferSummary {
  const kind = explicitOfferKind(route, product)
    ?? (product.kind === "subscription"
      ? "INCLUDED"
      : product.kind === "api" || product.kind === "aggregator"
        ? "PAYG"
        : "UNKNOWN");

  const inheritedMetadata = (key: string) =>
    stringMetadata(route.metadata, key) ?? stringMetadata(product.metadata, key);
  const sourceValue = inheritedMetadata("offerSource");
  const confidenceValue = inheritedMetadata("offerConfidence");
  const observedAt = inheritedMetadata("offerObservedAt");
  const validUntil = inheritedMetadata("offerValidUntil");

  return {
    kind,
    ...(sourceValue !== undefined && sources.has(sourceValue as Source)
      ? { source: sourceValue as Source }
      : {}),
    ...(confidenceValue !== undefined && confidences.has(confidenceValue as Confidence)
      ? { confidence: confidenceValue as Confidence }
      : {}),
    ...(observedAt === undefined ? {} : { observedAt }),
    ...(validUntil === undefined ? {} : { validUntil }),
  };
}

export function friendlyProductName(product: Product): string {
  const planId = stringMetadata(product.metadata, "planId");
  if (planId === "individual-goat" || product.displayName === "individual-goat") return "GOAT";
  return product.displayName;
}
