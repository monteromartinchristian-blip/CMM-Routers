import Foundation
import SwiftUI
import CMMUsageCore

@MainActor
final class UsageAppModel: ObservableObject {
    static let defaultBaseURL = "http://127.0.0.1:8790"

    @Published private(set) var dashboard: UsageDashboardSnapshot?
    @Published private(set) var catalogProviders: [CatalogProviderView] = []
    @Published private(set) var catalogRoutes: [CatalogRouteEntry] = []
    @Published private(set) var catalogQuotas: [CatalogQuotaSummary] = []
    @Published private(set) var promotions: [CatalogRouteEntry] = []
    @Published private(set) var visibilityPreferences: [CatalogVisibilityPreference] = []
    @Published private(set) var isLoading = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var lastUpdated: Date?
    @Published private(set) var credentialStored = false
    @Published private(set) var managementCredentialStored = false
    @Published private(set) var baseURLString: String
    @Published private(set) var connectionHints: [String: String] = [:]

    private let defaults: UserDefaults
    private let credentialStore: UsageCredentialStore
    private let managementCredentialStore: UsageCredentialStore
    private let baseURLKey = "cmmUsage.baseURL"

    init(
        defaults: UserDefaults = .standard,
        credentialStores: UsageCredentialStores = CMMUsageModule.credentialStores()
    ) {
        self.defaults = defaults
        self.credentialStore = credentialStores.read
        self.managementCredentialStore = credentialStores.management
        self.baseURLString = defaults.string(forKey: baseURLKey) ?? Self.defaultBaseURL
    }

    func loadIfNeeded() async {
        await refreshCredentialState()
        guard dashboard == nil, !isLoading else { return }
        await load()
    }

    func load() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let client = try makeClient()
            let nextDashboard = try await client.fetchDashboard()
            let nextProviders = try await client.fetchCatalogProviders()
            let nextRoutes = try await client.fetchCatalogRoutes()
            let nextQuotas = try await client.fetchCatalogQuotas()
            let nextPromotions = try await client.fetchPromotions()
            let nextVisibility = try await client.fetchVisibility()

            dashboard = nextDashboard
            catalogProviders = nextProviders
            catalogRoutes = nextRoutes
            catalogQuotas = nextQuotas
            promotions = nextPromotions
            visibilityPreferences = nextVisibility
            lastUpdated = Date()
            errorMessage = nil
            await refreshCredentialState()
        } catch {
            errorMessage = error.localizedDescription
            await refreshCredentialState()
        }
    }

    func refresh() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let client = try makeClient()
            _ = try await client.refreshAll()
            let nextDashboard = try await client.fetchDashboard()
            let nextProviders = try await client.fetchCatalogProviders()
            let nextRoutes = try await client.fetchCatalogRoutes()
            let nextQuotas = try await client.fetchCatalogQuotas()
            let nextPromotions = try await client.fetchPromotions()
            let nextVisibility = try await client.fetchVisibility()
            dashboard = nextDashboard
            catalogProviders = nextProviders
            catalogRoutes = nextRoutes
            catalogQuotas = nextQuotas
            promotions = nextPromotions
            visibilityPreferences = nextVisibility
            lastUpdated = Date()
            errorMessage = nil
            await refreshCredentialState()
        } catch {
            errorMessage = error.localizedDescription
            await refreshCredentialState()
        }
    }

    func saveConnection(baseURL: String, token: String?) async throws {
        let trimmedURL = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parsed = URL(string: trimmedURL),
              let host = parsed.host?.lowercased(),
              parsed.scheme == "http" || parsed.scheme == "https",
              ["127.0.0.1", "localhost", "::1"].contains(host)
        else {
            throw ConnectionSettingsError.loopbackRequired
        }

        if let token, !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            try await credentialStore.saveTokenOffMainThread(token.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        defaults.set(trimmedURL, forKey: baseURLKey)
        baseURLString = trimmedURL
        await refreshCredentialState()
        await load()
    }

    func saveManagementCredential(_ token: String) async throws {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        try await managementCredentialStore.saveTokenOffMainThread(trimmed)
        await refreshCredentialState()
    }

    func clearCredential() async throws {
        try await credentialStore.deleteTokenOffMainThread()
        await refreshCredentialState()
        dashboard = nil
        catalogProviders = []
        catalogRoutes = []
        catalogQuotas = []
        promotions = []
        visibilityPreferences = []
        errorMessage = nil
    }

    func clearManagementCredential() async throws {
        try await managementCredentialStore.deleteTokenOffMainThread()
        await refreshCredentialState()
    }

    func connectAccount(provider: CatalogProviderView, secret: String) async throws {
        let result = try await makeClient().connectAccount(
            integrationType: provider.directory.integrationType,
            secret: secret
        )
        rememberHint(result)
        await loadAfterMutation()
    }

    func connectAPIKey(provider: CatalogProviderView, secret: String) async throws {
        let result = try await makeClient().connectWithAPIKey(
            integrationType: provider.directory.integrationType,
            secret: secret
        )
        rememberHint(result)
        await loadAfterMutation()
    }

    func addCustomEndpoint(_ input: CustomEndpointConnectionInput) async throws -> UsageConnectionView {
        let result = try await makeClient().addCustomEndpoint(input)
        rememberHint(result)
        await loadAfterMutation()
        return result
    }

    func setConnectionEnabled(instanceId: String, enabled: Bool) async throws {
        _ = try await makeClient().setConnectionEnabled(id: instanceId, enabled: enabled)
        await loadAfterMutation()
    }

    func disconnect(instanceId: String) async throws {
        try await makeClient().disconnectConnection(id: instanceId)
        connectionHints.removeValue(forKey: instanceId)
        await loadAfterMutation()
    }

    func testConnection(instanceId: String) async throws -> UsageConnectionTestResult {
        try await makeClient().testConnection(id: instanceId)
    }

    func setRouteVisibility(routeId: String, state: CatalogVisibilityState) async throws {
        try await setRoutesVisibility(routeIds: [routeId], state: state)
    }

    func setRoutesVisibility(routeIds: [String], state: CatalogVisibilityState) async throws {
        let client = try makeClient()
        var mutationError: Error?
        for routeId in routeIds {
            do {
                _ = try await client.setRouteVisibility(routeId: routeId, state: state)
            } catch {
                mutationError = error
                break
            }
        }
        let nextRoutes = try await client.fetchCatalogRoutes()
        let nextVisibility = try await client.fetchVisibility()
        catalogRoutes = nextRoutes
        visibilityPreferences = nextVisibility
        if let mutationError { throw mutationError }
    }

    func connectionHint(for provider: CatalogProviderView) -> String {
        for id in provider.instanceIds {
            if let hint = connectionHints[id] {
                return ProviderCatalogPresenter.safeCredentialHint(hint)
            }
        }
        return provider.directory.connectedInstanceCount > 0 ? "Stored securely" : "Add key"
    }

    func quota(id: String?) -> QuotaUsageView? {
        guard let id else { return nil }
        return dashboard?.quotas.first { $0.bucketId == id }
    }

    func product(id: String) -> Product? {
        dashboard?.products.first { $0.id == id }
    }

    func provider(id: String) -> ProviderUsageView? {
        dashboard?.providers.first { $0.provider.id == id }
    }

    private func makeClient() throws -> CMMUsageAPIClient {
        guard let baseURL = URL(string: baseURLString) else {
            throw CMMUsageAPIError.invalidBaseURL
        }
        return CMMUsageAPIClient(
            baseURL: baseURL,
            credentialStore: credentialStore,
            managementCredentialStore: managementCredentialStore
        )
    }

    private func refreshCredentialState() async {
        credentialStored = ((try? await credentialStore.readTokenOffMainThread()) ?? nil) != nil
        managementCredentialStored = ((try? await managementCredentialStore.readTokenOffMainThread()) ?? nil) != nil
    }

    private func rememberHint(_ connection: UsageConnectionView) {
        if let hint = connection.hint {
            connectionHints[connection.id] = ProviderCatalogPresenter.safeCredentialHint(hint)
        }
    }

    private func loadAfterMutation() async {
        let wasLoading = isLoading
        if !wasLoading { isLoading = true }
        defer { if !wasLoading { isLoading = false } }
        do {
            let client = try makeClient()
            catalogProviders = try await client.fetchCatalogProviders()
            catalogRoutes = try await client.fetchCatalogRoutes()
            catalogQuotas = try await client.fetchCatalogQuotas()
            promotions = try await client.fetchPromotions()
            visibilityPreferences = try await client.fetchVisibility()
            dashboard = try await client.fetchDashboard()
            lastUpdated = Date()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

enum ConnectionSettingsError: LocalizedError {
    case loopbackRequired

    var errorDescription: String? {
        "CMM Usage must connect to a loopback URL such as http://127.0.0.1:8790."
    }
}
