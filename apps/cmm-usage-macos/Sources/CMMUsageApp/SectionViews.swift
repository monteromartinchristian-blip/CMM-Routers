import SwiftUI
import CMMUsageCore

private struct SectionShell<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        ScrollView {
            content
                .padding(22)
                .frame(maxWidth: .infinity, alignment: .topLeading)
        }
    }
}

struct HistorySectionView: View {
    @EnvironmentObject private var model: UsageAppModel

    var body: some View {
        SectionShell {
            if let history = model.dashboard?.history, !history.isEmpty {
                LazyVStack(spacing: 8) {
                    ForEach(history) { event in
                        SurfaceCard {
                            HStack(alignment: .top) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(model.product(id: event.productId)?.displayName ?? event.productId)
                                        .font(.subheadline.weight(.semibold))
                                    Text(event.occurredAt).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                VStack(alignment: .trailing, spacing: 3) {
                                    Text(event.requests.map { "\(Int($0)) request\(Int($0) == 1 ? "" : "s")" } ?? "Usage event")
                                        .font(.caption.weight(.medium))
                                    Text("\(event.source.rawValue) · \(event.confidence.rawValue)")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            } else {
                EmptyStateView(title: "No history", detail: "Router-measured and provider-reported usage events will appear here.", systemImage: "clock.arrow.circlepath")
            }
        }
    }
}

struct CostsSectionView: View {
    @EnvironmentObject private var model: UsageAppModel

    var body: some View {
        SectionShell {
            if let costs = model.dashboard?.costs, !costs.isEmpty {
                LazyVStack(spacing: 8) {
                    ForEach(costs) { cost in
                        SurfaceCard {
                            HStack {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(model.product(id: cost.productId)?.displayName ?? cost.productId)
                                        .font(.subheadline.weight(.semibold))
                                    Text("\(cost.kind.capitalized) · \(cost.occurredAt)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                VStack(alignment: .trailing, spacing: 3) {
                                    Text(cost.amount, format: .currency(code: cost.currency))
                                        .font(.headline)
                                    Text("\(cost.source.rawValue) · \(cost.confidence.rawValue)")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            } else {
                EmptyStateView(title: "No costs", detail: "Provider cost events and known charges will appear here without being conflated with quota percentages.", systemImage: "banknote")
            }
        }
    }
}

struct SubscriptionsSectionView: View {
    @EnvironmentObject private var model: UsageAppModel

    var body: some View {
        SectionShell {
            if let subscriptions = model.dashboard?.subscriptions, !subscriptions.isEmpty {
                LazyVStack(spacing: 10) {
                    ForEach(subscriptions) { subscription in
                        SurfaceCard {
                            HStack {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(model.product(id: subscription.productId)?.displayName ?? subscription.productId)
                                        .font(.headline)
                                    Text("Started \(subscription.startedAt)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    if let endedAt = subscription.endedAt {
                                        Text("Ended \(endedAt)").font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                VStack(alignment: .trailing, spacing: 6) {
                                    Text(subscription.status.rawValue.capitalized)
                                        .font(.caption.weight(.semibold))
                                    if let amount = subscription.billingAmount, let currency = subscription.billingCurrency {
                                        Text(amount, format: .currency(code: currency))
                                            .font(.subheadline.weight(.medium))
                                    }
                                }
                            }
                        }
                    }
                }
            } else {
                EmptyStateView(title: "No subscriptions", detail: "Subscription periods remain queryable here even after cancellation or archival.", systemImage: "creditcard")
            }
        }
    }
}

struct AlertsSectionView: View {
    @EnvironmentObject private var model: UsageAppModel

    var body: some View {
        SectionShell {
            if let alerts = model.dashboard?.alerts, !alerts.isEmpty {
                LazyVStack(spacing: 10) {
                    ForEach(alerts) { alert in
                        SurfaceCard {
                            HStack {
                                Image(systemName: alert.status.symbolName)
                                    .foregroundStyle(alert.status.tint)
                                    .font(.title2)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(UsageAlertPresenter.title(quota: model.catalogQuotas.first { $0.bucketId == alert.bucketId }))
                                        .font(.headline)
                                    Text(alert.kind.replacingOccurrences(of: "_", with: " ").capitalized)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                StatusBadge(status: alert.status)
                            }
                        }
                    }
                }
            } else {
                EmptyStateView(title: "No active alerts", detail: "Warnings appear when a quota is constrained or forecast to exhaust before reset.", systemImage: "bell")
            }
        }
    }
}

struct SettingsSectionView: View {
    @EnvironmentObject private var model: UsageAppModel
    @State private var baseURL = UsageAppModel.defaultBaseURL
    @State private var token = ""
    @State private var managementToken = ""
    @State private var saveError: String?
    @State private var didSeed = false

    var body: some View {
        SectionShell {
            VStack(alignment: .leading, spacing: 14) {
                SurfaceCard {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Local CMM Usage API").font(.headline)
                        Text("The client only connects to loopback and stores the scoped read-only token in macOS Keychain.")
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        TextField("http://127.0.0.1:8790", text: $baseURL)
                            .textFieldStyle(.roundedBorder)
                        SecureField(model.credentialStored ? "Leave blank to keep existing token" : "Read-only Usage token", text: $token)
                            .textFieldStyle(.roundedBorder)

                        HStack {
                            Label(model.credentialStored ? "Read access configured" : "Read access not configured", systemImage: model.credentialStored ? "checkmark.shield" : "lock.slash")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Spacer()
                            Button("Remove Credential", role: .destructive) {
                                Task {
                                    do {
                                        try await model.clearCredential()
                                        token = ""
                                        saveError = nil
                                    } catch {
                                        saveError = error.localizedDescription
                                    }
                                }
                            }
                            .disabled(!model.credentialStored)
                            Button("Save & Connect") {
                                Task {
                                    do {
                                        try await model.saveConnection(baseURL: baseURL, token: token.isEmpty ? nil : token)
                                        token = ""
                                        saveError = nil
                                    } catch {
                                        saveError = error.localizedDescription
                                    }
                                }
                            }
                            .buttonStyle(.borderedProminent)
                        }
                        if let saveError {
                            Label(saveError, systemImage: "exclamationmark.triangle")
                                .font(.caption)
                                .foregroundStyle(.orange)
                        }
                    }
                }

                SurfaceCard {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Connection management").font(.headline)
                        Text("Provider changes use a separate local credential from read-only Usage access.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        SecureField(
                            model.managementCredentialStored ? "Leave blank to keep existing management token" : "Connection-management token",
                            text: $managementToken
                        )
                        .textFieldStyle(.roundedBorder)
                        HStack {
                            Label(
                                model.managementCredentialStored ? "Provider changes enabled" : "Provider changes locked",
                                systemImage: model.managementCredentialStored ? "checkmark.shield" : "lock"
                            )
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            Spacer()
                            Button("Remove", role: .destructive) {
                                Task {
                                    do {
                                        try await model.clearManagementCredential()
                                        managementToken = ""
                                        saveError = nil
                                    } catch {
                                        saveError = error.localizedDescription
                                    }
                                }
                            }
                            .disabled(!model.managementCredentialStored)
                            Button("Save") {
                                Task {
                                    do {
                                        try await model.saveManagementCredential(managementToken)
                                        managementToken = ""
                                        saveError = nil
                                    } catch {
                                        saveError = error.localizedDescription
                                    }
                                }
                            }
                            .disabled(managementToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                    }
                }

                SurfaceCard {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Privacy boundary").font(.headline)
                        Label("Reads the local CMM Usage API only", systemImage: "network")
                        Label("Never opens the CMM Usage SQLite database", systemImage: "externaldrive.badge.xmark")
                        Label("Never receives an inference-capable bearer", systemImage: "lock.shield")
                        Label("Provider credentials remain in Keychain/provider secure storage", systemImage: "key")
                    }
                    .font(.caption)
                }
            }
            .task {
                guard !didSeed else { return }
                baseURL = model.baseURLString
                didSeed = true
            }
        }
    }
}
