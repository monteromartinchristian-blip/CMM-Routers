import SwiftUI
import CMMUsageCore

struct MenuBarUsageView: View {
    @EnvironmentObject private var model: UsageAppModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
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

            if let error = model.errorMessage, model.dashboard == nil {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let dashboard = model.dashboard {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(dashboard.providers) { provider in
                            providerRow(provider, dashboard: dashboard)
                        }
                    }
                }
                .frame(maxHeight: 340)
            } else {
                EmptyStateView(
                    title: "No usage data yet",
                    detail: model.credentialStored ? "Refresh to load configured providers." : "Add the read-only Usage token in Settings.",
                    systemImage: "gauge.with.dots.needle.0percent"
                )
            }

            Divider()
            HStack {
                Button {
                    Task { await model.refresh() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .disabled(model.isLoading || !model.credentialStored)

                Spacer()

                Button {
                    openWindow(id: "main")
                    NSApp.activate(ignoringOtherApps: true)
                } label: {
                    Label("Open CMM Usage", systemImage: "macwindow")
                }
            }
        }
        .padding(16)
        .frame(width: 390)
        .task { await model.loadIfNeeded() }
    }

    @ViewBuilder
    private func providerRow(_ provider: ProviderUsageView, dashboard: UsageDashboardSnapshot) -> some View {
        SurfaceCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(provider.provider.displayName)
                        .font(.subheadline.weight(.semibold))
                    Spacer()
                    StatusBadge(status: provider.pressure.status)
                }
                let products = dashboard.products(for: provider.provider.id)
                if !products.isEmpty {
                    Text(products.map(\.displayName).joined(separator: " · "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                if let constraint = provider.pressure.routes.compactMap(\.primaryConstraint).max(by: { $0.status.severityRank < $1.status.severityRank }),
                   let quota = dashboard.quotas.first(where: { $0.bucketId == constraint.bucketId }) {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Constraining quota")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            Text(quota.bucket.displayName)
                                .font(.caption.weight(.medium))
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(quota.remainingSummary)
                                .font(.caption.weight(.semibold))
                            Text(quota.resetSummary)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                    if quota.forecast.willExhaustBeforeReset == true {
                        Label("Predicted to exhaust before reset", systemImage: "clock.badge.exclamationmark")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.orange)
                    }
                } else {
                    Text("No constraining quota reported")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var lastUpdatedText: String {
        guard let date = model.lastUpdated else { return "Not refreshed yet" }
        return "Updated \(date.formatted(date: .omitted, time: .shortened))"
    }
}
