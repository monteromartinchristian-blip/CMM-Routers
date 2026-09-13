import Foundation
import SwiftUI
import CMMUsageCore

@MainActor
final class UsageAppModel: ObservableObject {
    static let defaultBaseURL = "http://127.0.0.1:8790"

    @Published private(set) var dashboard: UsageDashboardSnapshot?
    @Published private(set) var isLoading = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var lastUpdated: Date?
    @Published private(set) var credentialStored = false
    @Published private(set) var baseURLString: String

    private let defaults: UserDefaults
    private let credentialStore: UsageCredentialStore
    private let baseURLKey = "cmmUsage.baseURL"

    init(
        defaults: UserDefaults = .standard,
        credentialStore: UsageCredentialStore = KeychainUsageCredentialStore()
    ) {
        self.defaults = defaults
        self.credentialStore = credentialStore
        self.baseURLString = defaults.string(forKey: baseURLKey) ?? Self.defaultBaseURL
        self.credentialStored = ((try? credentialStore.readToken()) ?? nil) != nil
    }

    func loadIfNeeded() async {
        guard dashboard == nil, !isLoading else { return }
        await load()
    }

    func load() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            dashboard = try await makeClient().fetchDashboard()
            lastUpdated = Date()
            errorMessage = nil
            credentialStored = true
        } catch {
            errorMessage = error.localizedDescription
            credentialStored = ((try? credentialStore.readToken()) ?? nil) != nil
        }
    }

    func refresh() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            _ = try await makeClient().refreshAll()
            dashboard = try await makeClient().fetchDashboard()
            lastUpdated = Date()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
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
            try credentialStore.saveToken(token.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        defaults.set(trimmedURL, forKey: baseURLKey)
        baseURLString = trimmedURL
        credentialStored = ((try? credentialStore.readToken()) ?? nil) != nil
        await load()
    }

    func clearCredential() throws {
        try credentialStore.deleteToken()
        credentialStored = false
        dashboard = nil
        errorMessage = nil
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
        return CMMUsageAPIClient(baseURL: baseURL, credentialStore: credentialStore)
    }
}

enum ConnectionSettingsError: LocalizedError {
    case loopbackRequired

    var errorDescription: String? {
        "CMM Usage must connect to a loopback URL such as http://127.0.0.1:8790."
    }
}
