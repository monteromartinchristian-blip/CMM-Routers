import SwiftUI
import CMMUsageCore

struct MenuBarUsageView: View {
    @EnvironmentObject private var model: UsageAppModel
    @Environment(\.openWindow) private var openWindow

    private var productSummaries: [MenuBarProductSummary] {
        let primaryRoutes = model.catalogRoutes.filter {
            ![AccessOfferKind.free, .promo, .trial].contains($0.offer.kind)
        }
        return MenuBarPresenter.productSummaries(routes: primaryRoutes, quotas: model.catalogQuotas)
    }

    private var degradedProviders: [CatalogProviderView] {
        model.catalogProviders.filter {
            [.degraded, .reauthRequired, .unavailable].contains($0.directory.state)
        }
    }

    private var freeCapacityCount: Int {
        MenuBarPresenter.freeCapacityCount(promotions: model.promotions, quotas: model.catalogQuotas)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("CMM Usage")
                        .font(.headline)
                    Text(lastUpdatedText)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                StatusBadge(status: model.dashboard?.overallStatus ?? .unknown)
            }

            if !degradedProviders.isEmpty {
                Label(degradedText, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let error = model.errorMessage, model.dashboard == nil {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else if !productSummaries.isEmpty {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(productSummaries.prefix(5).enumerated()), id: \.element.id) { index, product in
                            productRow(product)
                            if index < min(productSummaries.count, 5) - 1 {
                                Divider()
                            }
                        }
                    }
                }
                .frame(height: productListHeight)
            } else {
                EmptyStateView(
                    title: "No usage data yet",
                    detail: model.credentialStored ? "Refresh to load configured providers." : "Add the read-only Usage token in Settings.",
                    systemImage: "gauge.with.dots.needle.0percent"
                )
            }

            if freeCapacityCount > 0 {
                Button {
                    open(.freePromo)
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "sparkles")
                            .foregroundStyle(.secondary)
                        Text("Free & Promo")
                        Spacer()
                        Text("\(freeCapacityCount) available")
                            .foregroundStyle(.secondary)
                        Image(systemName: "chevron.right")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    .font(.caption.weight(.medium))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open Free and Promo, \(freeCapacityCount) available")
            }

            Divider()

            HStack(spacing: 12) {
                destinationButton("Quotas", .quotas)
                destinationButton("Models", .models)
                destinationButton("Providers", .providers)
                Spacer()
            }

            HStack {
                Button {
                    Task { await model.refresh() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .disabled(model.isLoading || !model.credentialStored)

                Spacer()

                Button {
                    open(model.navigationDestination)
                } label: {
                    Label("Open CMM Usage", systemImage: "macwindow")
                }
            }
        }
        .padding(15)
        .frame(width: 390)
        .task { await model.loadIfNeeded() }
    }

    private func productRow(_ product: MenuBarProductSummary) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(product.providerName)
                        .font(.subheadline.weight(.semibold))
                    Text(product.productName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                StatusBadge(status: productStatus(product))
            }

            if product.quotaLines.isEmpty {
                Text("No quota metadata reported")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Array(product.quotaLines.prefix(3))) { quota in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            HStack(spacing: 5) {
                                Text(quota.title)
                                if quota.constraining {
                                    Image(systemName: "scope")
                                        .font(.caption2)
                                        .accessibilityLabel("Constraining quota")
                                }
                            }
                            .font(.caption)
                            .foregroundStyle(quota.constraining ? .primary : .secondary)
                            Spacer()
                            Text(quota.valueText)
                                .font(.caption.weight(quota.constraining ? .semibold : .regular))
                                .monospacedDigit()
                        }
                        HStack {
                            Text(quota.resetText)
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                            Spacer()
                            if let dashboardQuota = model.quota(id: quota.id), dashboardQuota.forecast.willExhaustBeforeReset == true {
                                Label("May exhaust first", systemImage: "clock.badge.exclamationmark")
                                    .font(.caption2)
                                    .foregroundStyle(.orange)
                            }
                        }
                    }
                }
            }
        }
        .padding(.vertical, 10)
        .accessibilityElement(children: .contain)
    }

    private func destinationButton(_ title: String, _ destination: UsageNavigationDestination) -> some View {
        Button(title) { open(destination) }
            .buttonStyle(.plain)
            .font(.caption)
            .foregroundStyle(.secondary)
    }

    private func open(_ destination: UsageNavigationDestination) {
        model.navigate(to: destination)
        openWindow(id: "main")
        NSApp.activate(ignoringOtherApps: true)
    }

    private func productStatus(_ product: MenuBarProductSummary) -> UsageStatus {
        guard let first = product.quotaLines.first else { return .unknown }
        return product.quotaLines.dropFirst().reduce(first.status) { status, line in
            UsageStatus.worse(status, line.status)
        }
    }

    private var degradedText: String {
        if degradedProviders.count == 1, let provider = degradedProviders.first {
            return "\(provider.directory.displayName) · \(provider.directory.state.displayName)"
        }
        return "\(degradedProviders.count) providers need attention"
    }

    private var lastUpdatedText: String {
        guard let date = model.lastUpdated else { return "Not refreshed yet" }
        return "Updated \(date.formatted(date: .omitted, time: .shortened))"
    }

    private var productListHeight: CGFloat {
        let estimated = productSummaries.prefix(5).reduce(CGFloat.zero) { partial, product in
            partial + 58 + CGFloat(min(product.quotaLines.count, 3)) * 34
        }
        return min(max(estimated, 84), 360)
    }
}
