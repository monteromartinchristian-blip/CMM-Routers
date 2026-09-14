import SwiftUI
import CMMUsageCore

struct OverviewSectionView: View {
    @EnvironmentObject private var model: UsageAppModel

    private var connectedProviders: [CatalogProviderView] {
        model.catalogProviders.filter { $0.directory.connectedInstanceCount > 0 }
    }

    private var disconnectedProviders: [CatalogProviderView] {
        model.catalogProviders.filter { $0.directory.connectedInstanceCount == 0 }
    }

    private var attentionProviders: [CatalogProviderView] {
        model.catalogProviders.filter {
            [.degraded, .reauthRequired, .unavailable].contains($0.directory.state)
        }
    }

    private var attentionQuotas: [CatalogQuotaSummary] {
        model.catalogQuotas.filter { [.warning, .critical, .exhausted].contains($0.status) }
            .sortedForPresentation
    }

    private var resetsSoon: [CatalogQuotaSummary] {
        let now = Date()
        let cutoff = now.addingTimeInterval(24 * 60 * 60)
        return model.catalogQuotas.filter { quota in
            guard let raw = quota.resetAt,
                  let date = ISO8601DateFormatter().date(from: raw)
            else { return false }
            return date >= now && date <= cutoff
        }
        .sorted { ($0.resetAt ?? "") < ($1.resetAt ?? "") }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                summaryStrip

                if !attentionProviders.isEmpty || !attentionQuotas.isEmpty {
                    sectionTitle("Needs attention", detail: "Current provider or quota conditions that may affect access.")
                    QuietList {
                        ForEach(attentionProviders) { provider in
                            ProviderAttentionRow(provider: provider)
                        }
                        ForEach(attentionQuotas.prefix(4)) { quota in
                            OverviewQuotaRow(quota: quota, context: contextLabel(for: quota))
                        }
                    }
                }

                sectionTitle("Connected access", detail: "Subscriptions and APIs currently available to CMM Usage.")
                if connectedProviders.isEmpty {
                    CompactEmptyRow(
                        title: "No providers connected",
                        detail: "Open Providers to connect a subscription, API key or custom endpoint.",
                        systemImage: "bolt.horizontal.circle"
                    )
                } else {
                    QuietList {
                        ForEach(connectedProviders) { provider in
                            ConnectedProviderOverviewRow(
                                provider: provider,
                                products: productNames(for: provider)
                            )
                        }
                    }
                }

                if !disconnectedProviders.isEmpty {
                    sectionTitle("Available to connect", detail: "Supported providers remain visible before you connect them.")
                    QuietList {
                        ForEach(disconnectedProviders) { provider in
                            AvailableProviderOverviewRow(provider: provider)
                        }
                    }
                }

                if !resetsSoon.isEmpty {
                    sectionTitle("Resets in the next 24 hours", detail: "Only reset instants actually reported by providers are shown.")
                    QuietList {
                        ForEach(resetsSoon) { quota in
                            OverviewQuotaRow(quota: quota, context: contextLabel(for: quota))
                        }
                    }
                }

                if !model.promotions.isEmpty {
                    sectionTitle("Free & promo", detail: "Provider-reported free access, trials and promotions.")
                    QuietList {
                        ForEach(model.promotions.prefix(3)) { route in
                            HStack(spacing: 12) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(route.model.displayName).font(.subheadline.weight(.medium))
                                    Text("\(route.provider.displayName) · \(route.product.displayName)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                AccessOfferBadge(offer: route.offer)
                            }
                            .padding(.vertical, 9)
                        }
                    }
                }
            }
            .padding(.horizontal, 22)
            .padding(.vertical, 18)
            .frame(maxWidth: 880, alignment: .topLeading)
            .frame(maxWidth: .infinity, alignment: .top)
        }
        .overlay {
            if model.dashboard == nil && model.catalogProviders.isEmpty && !model.isLoading {
                EmptyStateView(
                    title: "Connect CMM Usage",
                    detail: "Open Settings to store the scoped local read credential, then refresh.",
                    systemImage: "lock.shield"
                )
            }
        }
    }

    private var summaryStrip: some View {
        HStack(spacing: 0) {
            summaryMetric("Connected", "\(connectedProviders.count)", "bolt.horizontal.circle")
            Divider().frame(height: 40)
            summaryMetric("Near limit", "\(attentionQuotas.count)", "gauge.with.dots.needle.67percent")
            Divider().frame(height: 40)
            summaryMetric("Reset soon", "\(resetsSoon.count)", "clock.arrow.circlepath")
            Divider().frame(height: 40)
            summaryMetric("Free & promo", "\(model.promotions.count)", "sparkles")
        }
        .padding(.vertical, 11)
        .background(.quinary.opacity(0.18), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .stroke(.quaternary, lineWidth: 1)
        }
    }

    private func summaryMetric(_ title: String, _ value: String, _ symbol: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: symbol).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text(value).font(.headline.monospacedDigit())
                Text(title).font(.caption2).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
        }
        .padding(.horizontal, 13)
        .frame(maxWidth: .infinity)
    }

    private func sectionTitle(_ title: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.headline)
            Text(detail).font(.caption).foregroundStyle(.secondary)
        }
    }

    private func productNames(for provider: CatalogProviderView) -> String {
        let names = model.catalogRoutes
            .filter { $0.provider.id == provider.directory.integrationType || $0.provider.displayName == provider.directory.displayName }
            .map(\.product.displayName)
        let unique = Array(Set(names)).sorted()
        return unique.isEmpty ? provider.directory.shortDescription ?? "Connected provider" : unique.joined(separator: " · ")
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
}

private struct AvailableProviderOverviewRow: View {
    let provider: CatalogProviderView

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .stroke(.secondary, lineWidth: 1)
                .frame(width: 7, height: 7)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(provider.directory.displayName).font(.subheadline.weight(.medium))
                Text(provider.directory.shortDescription ?? "Supported provider")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            Text(provider.directory.state.displayName)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 9)
        .accessibilityElement(children: .combine)
    }
}

private struct QuietList<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 0) { content }
            .padding(.horizontal, 13)
            .background(.quinary.opacity(0.12), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .stroke(.quaternary, lineWidth: 1)
            }
    }
}

private struct ProviderAttentionRow: View {
    let provider: CatalogProviderView

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(.secondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(provider.directory.displayName).font(.subheadline.weight(.medium))
                Text(provider.directory.shortDescription ?? "Provider needs attention")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            Text(provider.directory.state.displayName)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 9)
    }
}

private struct ConnectedProviderOverviewRow: View {
    let provider: CatalogProviderView
    let products: String

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(provider.directory.state == .connected ? Color.green : Color.secondary)
                .frame(width: 7, height: 7)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(provider.directory.displayName).font(.subheadline.weight(.medium))
                Text(products).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            Text(provider.directory.state.displayName)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 9)
        .accessibilityElement(children: .combine)
    }
}

private struct OverviewQuotaRow: View {
    let quota: CatalogQuotaSummary
    let context: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: quota.constraining ? "scope" : quota.status.symbolName)
                .foregroundStyle(.secondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(quota.displayName).font(.subheadline.weight(.medium))
                Text(context).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(quota.primaryValueText).font(.caption.weight(.medium))
                Text(quota.resetText).font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 9)
    }
}

private struct CompactEmptyRow: View {
    let title: String
    let detail: String
    let systemImage: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.medium))
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quinary.opacity(0.12), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 9, style: .continuous).stroke(.quaternary, lineWidth: 1)
        }
    }
}
