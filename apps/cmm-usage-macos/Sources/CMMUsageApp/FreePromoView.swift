import SwiftUI
import CMMUsageCore

struct FreePromoSectionView: View {
    @EnvironmentObject private var model: UsageAppModel

    private var claimableAllowances: [CatalogQuotaSummary] {
        model.catalogQuotas.filter(\.isClaimableEntitlement).sortedForPresentation
    }

    private var connectedPromotions: [CatalogRouteEntry] {
        model.promotions.filter {
            ProviderCatalogPresenter.isConnected($0.provider, among: model.catalogProviders)
        }
    }

    private var disconnected: [CatalogRouteEntry] {
        model.promotions.filter {
            !ProviderCatalogPresenter.isConnected($0.provider, among: model.catalogProviders)
        }
    }

    private var exhausted: [CatalogRouteEntry] {
        connectedPromotions.filter { route in route.quota.contains { $0.status == .exhausted } }
    }

    private var expiringSoon: [CatalogRouteEntry] {
        let exhaustedIds = Set(exhausted.map(\.routeId))
        return connectedPromotions.filter { route in
            guard !exhaustedIds.contains(route.routeId) else { return false }
            guard let value = route.offer.validUntil,
                  let date = ISO8601DateFormatter().date(from: value)
            else { return false }
            return date >= Date() && date <= Date().addingTimeInterval(7 * 24 * 60 * 60)
        }
    }

    private var newAccess: [CatalogRouteEntry] {
        let excluded = Set((exhausted + expiringSoon).map(\.routeId))
        let cutoff = Date().addingTimeInterval(-7 * 24 * 60 * 60)
        return connectedPromotions.filter { route in
            guard !excluded.contains(route.routeId),
                  let value = route.offer.observedAt,
                  let observedAt = ISO8601DateFormatter().date(from: value)
            else { return false }
            return observedAt >= cutoff
        }
    }

    private var active: [CatalogRouteEntry] {
        let excluded = Set((exhausted + expiringSoon + newAccess).map(\.routeId))
        return connectedPromotions.filter { !excluded.contains($0.routeId) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 15) {
                if model.promotions.isEmpty && claimableAllowances.isEmpty {
                    EmptyStateView(
                        title: "No provider-reported free access yet",
                        detail: "Free routes, trials and promotions appear here only when there is explicit provider evidence.",
                        systemImage: "sparkles"
                    )
                } else {
                    if !claimableAllowances.isEmpty {
                        claimableSection
                    }
                    if !disconnected.isEmpty {
                        section(
                            "Available but provider not connected",
                            detail: "Evidence-backed free or promotional access you can unlock by connecting the provider.",
                            routes: disconnected,
                            connected: false
                        )
                    }
                    if !newAccess.isEmpty {
                        section("New free access", detail: "Recently observed provider-reported access.", routes: newAccess)
                    }
                    if !expiringSoon.isEmpty {
                        section("Expiring soon", detail: "Promotions ending within seven days.", routes: expiringSoon)
                    }
                    if !active.isEmpty {
                        section("Active access", detail: "Free, promotional and trial routes currently available.", routes: active)
                    }
                    if !exhausted.isEmpty {
                        section("Exhausted until reset", detail: "Promotional routes whose reported allowance is currently exhausted.", routes: exhausted)
                    }
                }
            }
            .padding(.horizontal, 22)
            .padding(.vertical, 14)
            .frame(maxWidth: 860, alignment: .topLeading)
            .frame(maxWidth: .infinity, alignment: .top)
        }
    }

    private func section(
        _ title: String,
        detail: String,
        routes: [CatalogRouteEntry],
        connected: Bool = true
    ) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.headline)
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            VStack(spacing: 0) {
                ForEach(Array(routes.enumerated()), id: \.element.id) { index, route in
                    PromotionRouteRow(route: route, connected: connected, allQuotas: model.catalogQuotas)
                    if index < routes.count - 1 { Divider().padding(.leading, 14) }
                }
            }
            .background(.quinary.opacity(0.055), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 7, style: .continuous).stroke(.quaternary.opacity(0.8), lineWidth: 1)
            }
        }
    }

    private var claimableSection: some View {
        VStack(alignment: .leading, spacing: 7) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Bonus capacity available").font(.headline)
                Text("Extra free allowance discovered by CMM Usage. Activation always requires an explicit user action.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            VStack(spacing: 0) {
                ForEach(Array(claimableAllowances.enumerated()), id: \.element.id) { index, quota in
                    FreeCapacityRow(
                        quota: quota,
                        providerName: providerName(for: quota),
                        modelNames: modelNames(for: quota)
                    )
                    if index < claimableAllowances.count - 1 { Divider().padding(.leading, 14) }
                }
            }
            .background(.quinary.opacity(0.055), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 7, style: .continuous).stroke(.quaternary.opacity(0.8), lineWidth: 1)
            }
        }
    }

    private func providerName(for quota: CatalogQuotaSummary) -> String {
        let routeIds = Set(quota.entitlement?.appliesToRouteIds ?? [])
        if let route = model.catalogRoutes.first(where: { routeIds.contains($0.routeId) }) {
            return route.provider.displayName
        }
        if let productId = quota.scope.productId,
           let route = model.catalogRoutes.first(where: { $0.product.id == productId }) {
            return route.provider.displayName
        }
        return quota.scopeText
    }

    private func modelNames(for quota: CatalogQuotaSummary) -> [String] {
        let routeIds = Set(quota.entitlement?.appliesToRouteIds ?? [])
        return Array(Set(model.catalogRoutes.filter { routeIds.contains($0.routeId) }.map { $0.model.displayName })).sorted()
    }
}

private struct PromotionRouteRow: View {
    let route: CatalogRouteEntry
    let connected: Bool
    let allQuotas: [CatalogQuotaSummary]

    private var hierarchy: ModelQuotaHierarchy {
        ModelCatalogPresenter.quotaHierarchy(for: route, allQuotas: allQuotas)
    }

    private var quota: CatalogQuotaSummary? {
        hierarchy.modelLimits.first ?? hierarchy.otherLimits.first ?? hierarchy.sharedLimits.first
    }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 7) {
                    Text(route.model.displayName).font(.subheadline.weight(.semibold))
                    AccessOfferBadge(offer: route.offer)
                }
                Text("\(route.provider.displayName) · \(route.product.displayName)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let validUntil = route.offer.validUntilText {
                    Text(validUntil)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            Spacer(minLength: 18)
            VStack(alignment: .trailing, spacing: 3) {
                Text(quota?.primaryValueText ?? accessText)
                    .font(.caption.weight(.medium))
                if let shared = hierarchy.sharedLimits.first,
                   shared.bucketId != quota?.bucketId {
                    Text("Shared · \(shared.primaryValueText)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                if let bonus = hierarchy.claimableAllowances.first {
                    Label(bonus.claimableValueText ?? "Bonus available", systemImage: "gift")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                }
                Text(connected ? visibilityText : "Connect in Providers")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }

    private var accessText: String {
        switch route.offer.kind {
        case .free: return "Free access"
        case .promo: return "Promotional access"
        case .trial: return "Trial access"
        default: return route.offer.kind.rawValue
        }
    }

    private var visibilityText: String {
        route.visibility == .visible ? "Visible in model catalog" : "Hidden from model picker"
    }
}

private struct FreeCapacityRow: View {
    let quota: CatalogQuotaSummary
    let providerName: String
    let modelNames: [String]

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "gift")
                .font(.title3)
                .foregroundStyle(.secondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 7) {
                    Text(quota.displayName).font(.subheadline.weight(.semibold))
                    Text("CLAIMABLE")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.secondary)
                }
                Text(providerName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if !modelNames.isEmpty {
                    Text("For \(modelNames.joined(separator: ", "))")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 18)
            VStack(alignment: .trailing, spacing: 3) {
                Text(quota.claimableValueText ?? "Bonus available")
                    .font(.subheadline.weight(.semibold).monospacedDigit())
                Text(quota.entitlement?.actionLabel ?? "Explicit claim required")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .accessibilityElement(children: .combine)
    }
}
