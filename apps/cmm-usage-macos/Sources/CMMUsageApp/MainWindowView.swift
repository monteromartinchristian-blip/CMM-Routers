import SwiftUI
import CMMUsageCore

enum UsageSection: String, CaseIterable, Identifiable {
    case overview = "Overview"
    case providers = "Providers"
    case models = "Models"
    case quotas = "Quotas"
    case history = "History"
    case costs = "Costs"
    case subscriptions = "Subscriptions"
    case alerts = "Alerts"
    case settings = "Settings"

    var id: String { rawValue }

    var symbol: String {
        switch self {
        case .overview: return "square.grid.2x2"
        case .providers: return "building.2"
        case .models: return "cpu"
        case .quotas: return "gauge.with.dots.needle.67percent"
        case .history: return "clock.arrow.circlepath"
        case .costs: return "banknote"
        case .subscriptions: return "creditcard"
        case .alerts: return "bell"
        case .settings: return "gearshape"
        }
    }
}

struct MainWindowView: View {
    @EnvironmentObject private var model: UsageAppModel
    @State private var selection: UsageSection? = .overview

    var body: some View {
        NavigationSplitView {
            List(UsageSection.allCases, selection: $selection) { section in
                Label(section.rawValue, systemImage: section.symbol)
                    .tag(section)
            }
            .navigationTitle("CMM Usage")
        } detail: {
            VStack(spacing: 0) {
                header
                Divider()
                Group {
                    switch selection ?? .overview {
                    case .overview: OverviewSectionView()
                    case .providers: ProvidersSectionView()
                    case .models: ModelsSectionView()
                    case .quotas: QuotasSectionView()
                    case .history: HistorySectionView()
                    case .costs: CostsSectionView()
                    case .subscriptions: SubscriptionsSectionView()
                    case .alerts: AlertsSectionView()
                    case .settings: SettingsSectionView()
                    }
                }
                .environmentObject(model)
            }
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text((selection ?? .overview).rawValue)
                    .font(.title2.weight(.semibold))
                if let error = model.errorMessage {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                } else if let updated = model.lastUpdated {
                    Text("Updated \(updated.formatted(date: .abbreviated, time: .shortened))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            StatusBadge(status: model.dashboard?.overallStatus ?? .unknown)
            Button {
                Task { await model.refresh() }
            } label: {
                Label(model.isLoading ? "Refreshing…" : "Refresh", systemImage: "arrow.clockwise")
            }
            .disabled(model.isLoading || !model.credentialStored)
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 14)
    }
}
