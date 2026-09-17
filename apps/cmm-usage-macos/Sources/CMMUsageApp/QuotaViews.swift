import SwiftUI
import CMMUsageCore

struct QuotasSectionView: View {
    @EnvironmentObject private var model: UsageAppModel

    private var quotas: [CatalogQuotaSummary] { model.catalogQuotas.sortedForPresentation }
    private var claimable: [CatalogQuotaSummary] { quotas.filter(\.isClaimableEntitlement) }
    private var primary: [CatalogQuotaSummary] { quotas.filter { $0.constraining && !$0.isClaimableEntitlement } }
    private var standard: [CatalogQuotaSummary] {
        quotas.filter { !$0.constraining && !$0.isSupplementalBalance && !$0.isClaimableEntitlement }
    }
    private var supplemental: [CatalogQuotaSummary] {
        quotas.filter { $0.isSupplementalBalance && !$0.isClaimableEntitlement }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 15) {
                if quotas.isEmpty {
                    EmptyStateView(
                        title: "No quotas reported",
                        detail: "Provider-native quota windows and balances appear here after discovery.",
                        systemImage: "gauge.with.dots.needle.67percent"
                    )
                } else {
                    if !primary.isEmpty {
                        sectionHeader("Constraining now", detail: "The hard or selected constraints currently governing one or more routes.")
                        quotaGroup(primary)
                    }
                    if !standard.isEmpty {
                        sectionHeader("All quotas", detail: "Simultaneous windows stay independent and shared pools appear once.")
                        quotaGroup(standard)
                    }
                    if !claimable.isEmpty {
                        sectionHeader("Capacity available to claim", detail: "Extra provider allowance that is visible now but does not constrain usage until you explicitly activate it.")
                        VStack(spacing: 0) {
                            ForEach(Array(claimable.enumerated()), id: \.element.id) { index, quota in
                                ClaimableQuotaRow(
                                    quota: quota,
                                    context: contextLabel(for: quota),
                                    affectedRoutes: claimableRouteLabels(for: quota)
                                )
                                if index < claimable.count - 1 { Divider().padding(.leading, 14) }
                            }
                        }
                        .background(.quinary.opacity(0.055), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                        .overlay {
                            RoundedRectangle(cornerRadius: 7, style: .continuous).stroke(.quaternary.opacity(0.8), lineWidth: 1)
                        }
                    }
                    if !supplemental.isEmpty {
                        sectionHeader("Additional balances", detail: "Observable balances that do not independently constrain route selection.")
                        quotaGroup(supplemental)
                    }
                }
            }
            .padding(.horizontal, 22)
            .padding(.vertical, 14)
            .frame(maxWidth: 900, alignment: .topLeading)
            .frame(maxWidth: .infinity, alignment: .top)
        }
    }

    private func sectionHeader(_ title: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.headline)
            Text(detail).font(.caption).foregroundStyle(.secondary)
        }
    }

    private func quotaGroup(_ values: [CatalogQuotaSummary]) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(values.enumerated()), id: \.element.id) { index, quota in
                CatalogQuotaRow(
                    quota: quota,
                    context: contextLabel(for: quota),
                    affectedRoutes: affectedRouteLabels(for: quota),
                    hiddenRouteCount: hiddenRouteCount(for: quota)
                )
                if index < values.count - 1 { Divider().padding(.leading, 14) }
            }
        }
        .background(.quinary.opacity(0.055), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 7, style: .continuous).stroke(.quaternary.opacity(0.8), lineWidth: 1)
        }
    }

    private func contextLabel(for quota: CatalogQuotaSummary) -> String {
        if let productId = quota.scope.productId,
           let route = model.catalogRoutes.first(where: { $0.product.id == productId }) {
            return "\(route.provider.displayName) · \(route.product.displayName)"
        }
        if let routeId = quota.affectedRouteIds?.first,
           let route = model.catalogRoutes.first(where: { $0.routeId == routeId }) {
            return "\(route.provider.displayName) · \(route.product.displayName)"
        }
        return quota.scopeText
    }

    private func affectedRouteLabels(for quota: CatalogQuotaSummary) -> [String] {
        let ids = Set(quota.affectedRouteIds ?? [])
        return model.catalogRoutes
            .filter { ids.contains($0.routeId) }
            .map { "\($0.model.displayName) · \($0.provider.displayName)" }
            .sorted()
    }

    private func hiddenRouteCount(for quota: CatalogQuotaSummary) -> Int {
        let ids = Set(quota.affectedRouteIds ?? [])
        return model.catalogRoutes.filter { ids.contains($0.routeId) && !$0.isVisibleInModelCatalog }.count
    }

    private func claimableRouteLabels(for quota: CatalogQuotaSummary) -> [String] {
        let ids = Set(quota.entitlement?.appliesToRouteIds ?? [])
        return model.catalogRoutes
            .filter { ids.contains($0.routeId) }
            .map { $0.model.displayName }
            .sorted()
    }
}

private struct ClaimableQuotaRow: View {
    let quota: CatalogQuotaSummary
    let context: String
    let affectedRoutes: [String]

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "gift")
                .font(.title3)
                .foregroundStyle(.secondary)
                .frame(width: 24, height: 24)

            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 7) {
                    Text(quota.displayName)
                        .font(.subheadline.weight(.semibold))
                    Text("Claimable")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.quinary.opacity(0.45), in: Capsule())
                }
                Text(context)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if !affectedRoutes.isEmpty {
                    Text("Applies to \(affectedRoutes.joined(separator: ", "))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }

            Spacer(minLength: 16)

            VStack(alignment: .trailing, spacing: 4) {
                Text(quota.claimableValueText ?? "Bonus available")
                    .font(.subheadline.weight(.semibold).monospacedDigit())
                if let entitlement = quota.entitlement {
                    Text(actionText(entitlement))
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                    if let validUntil = entitlement.validUntil {
                        Text(validUntilText(validUntil))
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
    }

    private func actionText(_ entitlement: QuotaEntitlementSummary) -> String {
        if let label = entitlement.actionLabel, !label.isEmpty { return label }
        switch entitlement.eligibility {
        case .requiresAuth: return "Sign in to claim"
        case .eligible: return "Ready to claim"
        case .ineligible: return "Not currently eligible"
        case .unknown: return "Eligibility unknown"
        }
    }

    private func validUntilText(_ value: String) -> String {
        guard let date = ISO8601DateFormatter().date(from: value) else { return "Valid until \(value)" }
        return "Valid until \(date.formatted(.dateTime.day().month(.abbreviated).year()))"
    }
}

private struct CatalogQuotaRow: View {
    let quota: CatalogQuotaSummary
    let context: String
    let affectedRoutes: [String]
    let hiddenRouteCount: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 7) {
                        Text(quota.displayName).font(.subheadline.weight(.semibold))
                        if quota.scope.kind == .sharedPool {
                            Text("Shared")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }
                    }
                    Text(context).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                StatusBadge(status: quota.status)
            }

            HStack(alignment: .firstTextBaseline, spacing: 16) {
                Text(quota.primaryValueText)
                    .font(.headline.monospacedDigit())
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(quota.resetText).font(.caption.weight(.medium))
                    Text(quota.freshnessText == "Stale" ? "Stale data" : quota.freshnessText)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            if let progress = quota.progressFraction {
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text("Used")
                        Spacer()
                        Text(progress.formatted(.percent.precision(.fractionLength(0))))
                    }
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    ProgressView(value: progress)
                        .progressViewStyle(.linear)
                        .accessibilityLabel("\(quota.displayName) used")
                        .accessibilityValue(progress.formatted(.percent.precision(.fractionLength(0))))
                }
            }

            if !affectedRoutes.isEmpty {
                Text(routeText)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, quota.isSupplementalBalance ? 7 : 9)
        .opacity(quota.isSupplementalBalance ? 0.76 : 1)
    }

    private var routeText: String {
        let prefix = affectedRoutes.count > 1 ? "Affects \(affectedRoutes.count) routes: " : "Affects: "
        let hidden = hiddenRouteCount > 0 ? " · \(hiddenRouteCount) hidden route\(hiddenRouteCount == 1 ? "" : "s") still accounted" : ""
        return prefix + affectedRoutes.joined(separator: ", ") + hidden
    }
}
