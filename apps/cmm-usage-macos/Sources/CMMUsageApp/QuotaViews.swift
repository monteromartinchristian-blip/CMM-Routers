import SwiftUI
import CMMUsageCore

struct QuotasSectionView: View {
    @EnvironmentObject private var model: UsageAppModel

    private var quotas: [CatalogQuotaSummary] { model.catalogQuotas.sortedForPresentation }
    private var primary: [CatalogQuotaSummary] { quotas.filter(\.constraining) }
    private var standard: [CatalogQuotaSummary] { quotas.filter { !$0.constraining && !$0.isSupplementalBalance } }
    private var supplemental: [CatalogQuotaSummary] { quotas.filter(\.isSupplementalBalance) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
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
                    if !supplemental.isEmpty {
                        sectionHeader("Additional balances", detail: "Observable balances that do not independently constrain route selection.")
                        quotaGroup(supplemental)
                    }
                }
            }
            .padding(.horizontal, 22)
            .padding(.vertical, 18)
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
        .background(.quinary.opacity(0.1), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 9, style: .continuous).stroke(.quaternary, lineWidth: 1)
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
        return model.catalogRoutes.filter { ids.contains($0.routeId) && $0.visibility == .hidden }.count
    }
}

private struct CatalogQuotaRow: View {
    let quota: CatalogQuotaSummary
    let context: String
    let affectedRoutes: [String]
    let hiddenRouteCount: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 7) {
                        Text(quota.displayName).font(.subheadline.weight(.semibold))
                        if quota.constraining {
                            Text("Constraining")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.orange)
                        }
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
                    Text("\(quota.scopeText) · \(quota.freshnessText)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            if let progress = quota.progressFraction {
                ProgressView(value: progress)
                    .progressViewStyle(.linear)
                    .accessibilityLabel("\(quota.displayName) used")
                    .accessibilityValue(progress.formatted(.percent.precision(.fractionLength(0))))
            }

            if !affectedRoutes.isEmpty {
                Text(routeText)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, quota.isSupplementalBalance ? 9 : 12)
        .opacity(quota.isSupplementalBalance ? 0.76 : 1)
    }

    private var routeText: String {
        let prefix = affectedRoutes.count > 1 ? "Affects \(affectedRoutes.count) routes: " : "Affects: "
        let hidden = hiddenRouteCount > 0 ? " · \(hiddenRouteCount) hidden route\(hiddenRouteCount == 1 ? "" : "s") still accounted" : ""
        return prefix + affectedRoutes.joined(separator: ", ") + hidden
    }
}
