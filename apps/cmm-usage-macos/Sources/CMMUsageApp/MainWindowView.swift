import SwiftUI
import CMMUsageCore

private extension UsageNavigationDestination {
    var symbol: String {
        switch self {
        case .overview: return "square.grid.2x2"
        case .quotas: return "gauge.with.dots.needle.67percent"
        case .models: return "cpu"
        case .providers: return "bolt.horizontal.circle"
        case .freePromo: return "sparkles"
        case .history: return "clock.arrow.circlepath"
        case .costs: return "banknote"
        case .alerts: return "bell"
        case .settings: return "gearshape"
        }
    }
}

struct MainWindowView: View {
    @EnvironmentObject private var model: UsageAppModel
    @State private var selection: UsageNavigationDestination? = .overview

    var body: some View {
        NavigationSplitView {
            List(UsageNavigationDestination.allCases, selection: $selection) { section in
                Label(section.title, systemImage: section.symbol)
                    .tag(section)
            }
            .navigationTitle("CMM Usage")
            .navigationSplitViewColumnWidth(min: 170, ideal: 190, max: 220)
        } detail: {
            VStack(spacing: 0) {
                header
                Divider()
                Group {
                    switch selection ?? .overview {
                    case .overview: OverviewSectionView()
                    case .quotas: QuotasSectionView()
                    case .models: ModelsSectionView(onAddProvider: { selection = .providers })
                    case .providers: ProvidersSectionView()
                    case .freePromo: FreePromoSectionView()
                    case .history: HistorySectionView()
                    case .costs: CostsSectionView()
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
                Text((selection ?? .overview).title)
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
