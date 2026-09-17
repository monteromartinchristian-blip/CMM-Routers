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

function offerKindFrom(metadata: Readonly<Record<string, unknown>>): AccessOfferKind | undefined {
  const value = stringMetadata(metadata, "offerKind");
  return value !== undefined && offerKinds.has(value as AccessOfferKind)
    ? value as AccessOfferKind
    : undefined;
}

/**
 * Offer evidence carried by the route row itself, falling back to the product
 * row only when the caller states that the product row describes this route.
 */
function offerMetadata(
  route: AccessRoute,
  product: Product | undefined,
): Omit<AccessOfferSummary, "kind"> {
  const inheritedMetadata = (key: string) =>
    stringMetadata(route.metadata, key) ??
    (product === undefined ? undefined : stringMetadata(product.metadata, key));
  const sourceValue = inheritedMetadata("offerSource");
  const confidenceValue = inheritedMetadata("offerConfidence");
  const observedAt = inheritedMetadata("offerObservedAt");
  const validUntil = inheritedMetadata("offerValidUntil");

  return {
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

export function projectAccessOffer(
  route: AccessRoute,
  product: Product,
): AccessOfferSummary {
  const kind = offerKindFrom(route.metadata)
    ?? offerKindFrom(product.metadata)
    ?? (product.kind === "subscription"
      ? "INCLUDED"
      : product.kind === "api" || product.kind === "aggregator"
        ? "PAYG"
        : "UNKNOWN");

  return { kind, ...offerMetadata(route, product) };
}

/**
 * Offer for a route whose Usage product row disagrees with Router identity.
 *
 * The disagreeing row describes a *different* product, so neither its kind nor
 * its metadata may source this route's offer. Only the route row's own offer
 * metadata — intelligence for this exact route — refines the Router-supplied
 * fallback kind.
 */
export function projectRouteOffer(
  route: AccessRoute,
  fallbackKind: AccessOfferKind,
): AccessOfferSummary {
  return {
    kind: offerKindFrom(route.metadata) ?? fallbackKind,
    ...offerMetadata(route, undefined),
  };
}

export function friendlyProductName(product: Product): string {
  const planId = stringMetadata(product.metadata, "planId");
  if (planId === "individual-goat" || product.displayName === "individual-goat") return "GOAT";
  return product.displayName;
}
