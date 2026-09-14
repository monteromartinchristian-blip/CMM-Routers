import SwiftUI
import CMMUsageCore

private extension ProviderDirectoryState {
    var label: String {
        switch self {
        case .available: return "Available"
        case .connecting: return "Connecting"
        case .connected: return "Connected"
        case .degraded: return "Degraded"
        case .disabled: return "Disabled"
        case .reauthRequired: return "Reconnect"
        case .unavailable: return "Unavailable"
        }
    }

    var tint: Color {
        switch self {
        case .connected: return .green
        case .connecting: return .blue
        case .degraded, .reauthRequired: return .orange
        case .available, .disabled, .unavailable: return .secondary
        }
    }
}

private struct ProviderStateBadge: View {
    let state: ProviderDirectoryState

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(state.tint)
                .frame(width: 6, height: 6)
            Text(state.label)
                .font(.caption2.weight(.medium))
        }
        .foregroundStyle(state.tint)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Connection status: \(state.label)")
    }
}

private struct ProviderListSection<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 2)
            VStack(spacing: 0) {
                content
            }
            .background(.quinary.opacity(0.22), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(.quaternary, lineWidth: 1)
            }
        }
    }
}

struct ProvidersSectionView: View {
    @EnvironmentObject private var model: UsageAppModel
    @State private var section: ProviderSettingsSection = .accounts

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Picker("Provider settings", selection: $section) {
                    ForEach(ProviderSettingsSection.allCases) { value in
                        Text(value.title).tag(value)
                    }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 430)
                Spacer()
            }
            .padding(.horizontal, 22)
            .padding(.vertical, 12)

            Divider()

            ScrollView {
                Group {
                    switch section {
                    case .accounts:
                        AccountProvidersView()
                    case .apiKeys:
                        APIKeyProvidersView()
                    case .customEndpoints:
                        CustomEndpointsView()
                    }
                }
                .environmentObject(model)
                .padding(.horizontal, 22)
                .padding(.vertical, 18)
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
        }
    }
}

private struct AccountProvidersView: View {
    @EnvironmentObject private var model: UsageAppModel
    @State private var connectProvider: CatalogProviderView?
    @State private var actionError: String?

    private var groups: ProviderPresentationGroups {
        ProviderCatalogPresenter.groups(for: .accounts, providers: model.catalogProviders)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 4) {
                Label("Connect an account", systemImage: "key.horizontal")
                    .font(.headline)
                Text("Use subscription access and provider sessions without exposing credentials in the app UI.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if !model.managementCredentialStored {
                managementCredentialNotice
            }

            if groups.connected.isEmpty && groups.available.isEmpty {
                CompactProviderEmptyState(
                    title: "No account providers available",
                    detail: ProviderCatalogPresenter.emptyStateDetail(for: .accounts)
                )
            } else {
                if !groups.connected.isEmpty {
                    ProviderListSection(title: "Connected") {
                        ForEach(Array(groups.connected.enumerated()), id: \.element.id) { index, provider in
                            accountRow(provider, connected: true)
                            if index < groups.connected.count - 1 { Divider().padding(.leading, 14) }
                        }
                    }
                }

                if !groups.available.isEmpty {
                    ProviderListSection(title: "Other providers") {
                        ForEach(Array(groups.available.enumerated()), id: \.element.id) { index, provider in
                            accountRow(provider, connected: false)
                            if index < groups.available.count - 1 { Divider().padding(.leading, 14) }
                        }
                    }
                }
            }

            if let actionError {
                Label(actionError, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
        }
        .sheet(item: $connectProvider) { provider in
            ProviderCredentialSheet(provider: provider, kind: .account)
                .environmentObject(model)
        }
    }

    private var managementCredentialNotice: some View {
        Label("Connection management is locked. Add the management token in Settings to change providers.", systemImage: "lock")
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.vertical, 4)
    }

    @ViewBuilder
    private func accountRow(_ provider: CatalogProviderView, connected: Bool) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "person.crop.circle")
                .foregroundStyle(.secondary)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 7) {
                    Text(provider.directory.displayName)
                        .font(.subheadline.weight(.semibold))
                    if connected || provider.directory.state == .disabled {
                        ProviderStateBadge(state: provider.directory.state)
                    }
                }
                Text(provider.directory.shortDescription ?? "Provider account")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 20)

            if let instanceId = provider.instanceIds.first {
                Menu {
                    if provider.directory.state == .disabled {
                        Button("Enable") { mutate { try await model.setConnectionEnabled(instanceId: instanceId, enabled: true) } }
                    } else {
                        Button("Disable") { mutate { try await model.setConnectionEnabled(instanceId: instanceId, enabled: false) } }
                    }
                    Button("Reconnect…") { connectProvider = provider }
                    Divider()
                    Button("Disconnect", role: .destructive) { mutate { try await model.disconnect(instanceId: instanceId) } }
                } label: {
                    Image(systemName: "ellipsis")
                        .frame(width: 24, height: 24)
                }
                .menuStyle(.borderlessButton)
                .disabled(!model.managementCredentialStored)
                .accessibilityLabel("Actions for \(provider.directory.displayName)")
            } else {
                Button("Connect") { connectProvider = provider }
                    .buttonStyle(.borderless)
                    .disabled(!model.managementCredentialStored)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private func mutate(_ operation: @escaping () async throws -> Void) {
        Task {
            do {
                try await operation()
                actionError = nil
            } catch {
                actionError = error.localizedDescription
            }
        }
    }
}

private struct APIKeyProvidersView: View {
    @EnvironmentObject private var model: UsageAppModel
    @State private var connectProvider: CatalogProviderView?
    @State private var actionError: String?

    private var groups: ProviderPresentationGroups {
        ProviderCatalogPresenter.groups(for: .apiKeys, providers: model.catalogProviders)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text("API providers").font(.headline)
                Text("Keys are stored in secure credential storage. Only a masked hint is shown here.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            let values = groups.connected + groups.available
            if values.isEmpty {
                CompactProviderEmptyState(
                    title: "No API providers available",
                    detail: ProviderCatalogPresenter.emptyStateDetail(for: .apiKeys)
                )
            } else {
                ProviderListSection(title: "Providers") {
                    ForEach(Array(values.enumerated()), id: \.element.id) { index, provider in
                        apiKeyRow(provider)
                        if index < values.count - 1 { Divider().padding(.leading, 14) }
                    }
                }
            }

            if let actionError {
                Label(actionError, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
        }
        .sheet(item: $connectProvider) { provider in
            ProviderCredentialSheet(provider: provider, kind: .apiKey)
                .environmentObject(model)
        }
    }

    private func apiKeyRow(_ provider: CatalogProviderView) -> some View {
        HStack(spacing: 12) {
            Circle()
                .fill(provider.directory.state.tint)
                .frame(width: 7, height: 7)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 7) {
                    Text(provider.directory.displayName)
                        .font(.subheadline.weight(.semibold))
                    if provider.directory.connectedInstanceCount > 0 {
                        ProviderStateBadge(state: provider.directory.state)
                    }
                }
                Text(provider.directory.shortDescription ?? "API access")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 20)
            Text(model.connectionHint(for: provider))
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
            Button(provider.directory.connectedInstanceCount > 0 ? "Reconnect" : "Add key") {
                connectProvider = provider
            }
            .buttonStyle(.borderless)
            .disabled(!model.managementCredentialStored)

            if let instanceId = provider.instanceIds.first {
                Menu {
                    Button(provider.directory.state == .disabled ? "Enable" : "Disable") {
                        mutate {
                            try await model.setConnectionEnabled(
                                instanceId: instanceId,
                                enabled: provider.directory.state == .disabled
                            )
                        }
                    }
                    Button("Disconnect", role: .destructive) {
                        mutate { try await model.disconnect(instanceId: instanceId) }
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .frame(width: 22, height: 22)
                }
                .menuStyle(.borderlessButton)
                .disabled(!model.managementCredentialStored)
                .accessibilityLabel("Actions for \(provider.directory.displayName)")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .accessibilityElement(children: .contain)
    }

    private func mutate(_ operation: @escaping () async throws -> Void) {
        Task {
            do {
                try await operation()
                actionError = nil
            } catch {
                actionError = error.localizedDescription
            }
        }
    }
}

private enum ProviderCredentialKind {
    case account
    case apiKey
}

private struct ProviderCredentialSheet: View {
    @EnvironmentObject private var model: UsageAppModel
    @Environment(\.dismiss) private var dismiss
    let provider: CatalogProviderView
    let kind: ProviderCredentialKind

    @State private var secret = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(kind == .apiKey ? "Connect API provider" : "Connect account")
                .font(.title3.weight(.semibold))
            Text(provider.directory.displayName)
                .font(.headline)
            Text(detailText)
                .font(.caption)
                .foregroundStyle(.secondary)

            SecureField(kind == .apiKey ? "API key" : "Session or account credential", text: $secret)
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel(kind == .apiKey ? "API key" : "Account credential")

            if let errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }

            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                Button(isSaving ? "Connecting…" : "Connect") {
                    connect()
                }
                .buttonStyle(.borderedProminent)
                .disabled(secret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSaving)
            }
        }
        .padding(20)
        .frame(width: 430)
    }

    private var detailText: String {
        if kind == .apiKey {
            return "The key is written directly to secure storage. CMM Usage never displays it again."
        }
        if provider.directory.connectionMethods.contains(.localSession) {
            return "CMM can use a provider account/session credential without exposing it in catalog or usage data."
        }
        return "The account credential is stored securely and kept separate from Usage read access."
    }

    private func connect() {
        isSaving = true
        Task {
            do {
                if kind == .apiKey {
                    try await model.connectAPIKey(provider: provider, secret: secret)
                } else {
                    try await model.connectAccount(provider: provider, secret: secret)
                }
                secret = ""
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
                isSaving = false
            }
        }
    }
}

private struct CustomEndpointsView: View {
    @EnvironmentObject private var model: UsageAppModel

    @State private var name = ""
    @State private var endpointURL = ""
    @State private var defaultModel = ""
    @State private var apiKey = ""
    @State private var discoverModels = true
    @State private var useInCMMChat = true
    @State private var quotaMode = "unknown"
    @State private var savedInstanceId: String?
    @State private var statusMessage: String?
    @State private var errorMessage: String?
    @State private var isSaving = false

    private var customRoutes: [CatalogRouteEntry] {
        model.catalogRoutes.filter { $0.product.category == .custom }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 7) {
                    Label("Custom Endpoints", systemImage: "server.rack")
                        .font(.headline)
                    if !customRoutes.isEmpty {
                        Text("\(customRoutes.count)")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(.quaternary, in: RoundedRectangle(cornerRadius: 4))
                    }
                }
                Text("Connect OpenAI-compatible endpoints using semantic settings; credentials remain in secure storage.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if !customRoutes.isEmpty {
                ProviderListSection(title: "Connected endpoints") {
                    ForEach(Array(customRoutes.enumerated()), id: \.element.id) { index, route in
                        HStack(spacing: 12) {
                            Image(systemName: "server.rack").foregroundStyle(.secondary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(route.provider.displayName).font(.subheadline.weight(.semibold))
                                Text("\(route.model.displayName) · \(route.availability == .available ? "Available" : "Status unknown")")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(route.offer.kind.rawValue)
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        if index < customRoutes.count - 1 { Divider().padding(.leading, 14) }
                    }
                }
            }

            VStack(alignment: .leading, spacing: 12) {
                Label("New endpoint", systemImage: "plus")
                    .font(.headline)

                HStack(spacing: 12) {
                    LabeledField(title: "Name", placeholder: "Local Lab", text: $name)
                    LabeledField(title: "Default Model", placeholder: "Optional", text: $defaultModel)
                }
                LabeledField(title: "Endpoint URL", placeholder: "http://127.0.0.1:11434/v1", text: $endpointURL)
                VStack(alignment: .leading, spacing: 4) {
                    Text("API Key").font(.caption).foregroundStyle(.secondary)
                    SecureField("Optional — stored securely", text: $apiKey)
                        .textFieldStyle(.roundedBorder)
                }

                HStack(spacing: 18) {
                    Toggle("Use in CMMChat", isOn: $useInCMMChat)
                    Toggle("Discover models", isOn: $discoverModels)
                    Spacer()
                    Picker("Quota", selection: $quotaMode) {
                        Text("Unknown").tag("unknown")
                        Text("Automatic").tag("automatic")
                        Text("Manual").tag("manual")
                    }
                    .frame(width: 180)
                }
                .toggleStyle(.checkbox)

                if let statusMessage {
                    Label(statusMessage, systemImage: "checkmark.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let errorMessage {
                    Label(errorMessage, systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }

                HStack(spacing: 8) {
                    Button {
                        testSavedEndpoint()
                    } label: {
                        Label("Test", systemImage: "bolt")
                    }
                    .disabled(savedInstanceId == nil || isSaving || !model.managementCredentialStored)

                    Button {
                        saveEndpoint()
                    } label: {
                        Label(isSaving ? "Saving…" : "Save", systemImage: "square.and.arrow.down")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canSave || isSaving || !model.managementCredentialStored)
                }
            }
            .padding(14)
            .background(.quinary.opacity(0.2), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(.quaternary, lineWidth: 1)
            }
        }
    }

    private var canSave: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && URL(string: endpointURL.trimmingCharacters(in: .whitespacesAndNewlines)) != nil
    }

    private func saveEndpoint() {
        isSaving = true
        errorMessage = nil
        statusMessage = nil
        Task {
            do {
                let result = try await model.addCustomEndpoint(
                    CustomEndpointConnectionInput(
                        instanceId: savedInstanceId,
                        name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                        endpointURL: endpointURL.trimmingCharacters(in: .whitespacesAndNewlines),
                        defaultModel: defaultModel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : defaultModel.trimmingCharacters(in: .whitespacesAndNewlines),
                        apiKey: apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : apiKey.trimmingCharacters(in: .whitespacesAndNewlines),
                        discoverModels: discoverModels,
                        useInCMMChat: useInCMMChat,
                        quotaMode: quotaMode
                    )
                )
                savedInstanceId = result.id
                apiKey = ""
                statusMessage = "Saved. You can test this endpoint now."
                isSaving = false
            } catch {
                errorMessage = error.localizedDescription
                isSaving = false
            }
        }
    }

    private func testSavedEndpoint() {
        guard let savedInstanceId else { return }
        statusMessage = nil
        errorMessage = nil
        Task {
            do {
                let result = try await model.testConnection(instanceId: savedInstanceId)
                statusMessage = result.status == "healthy" ? "Connection healthy." : "Provider reported: \(result.status)."
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

private struct LabeledField: View {
    let title: String
    let placeholder: String
    @Binding var text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            TextField(placeholder, text: $text)
                .textFieldStyle(.roundedBorder)
        }
        .frame(maxWidth: .infinity)
    }
}

private struct CompactProviderEmptyState: View {
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "plus.circle")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 8)
    }
}
