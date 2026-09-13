import Foundation

public struct UsageRefreshResultView: Decodable, Sendable {
    public let adapterId: String
    public let attempted: Bool
    public let success: Bool
}

public enum CMMUsageAPIError: Error, LocalizedError {
    case missingCredential
    case invalidBaseURL
    case loopbackRequired
    case invalidResponse
    case httpStatus(Int)

    public var errorDescription: String? {
        switch self {
        case .missingCredential:
            return "No scoped CMM Usage credential is stored in Keychain."
        case .invalidBaseURL:
            return "The configured CMM Usage API URL is invalid."
        case .loopbackRequired:
            return "CMM Usage only connects to a loopback API address."
        case .invalidResponse:
            return "CMM Usage returned an invalid HTTP response."
        case .httpStatus(let status):
            return "CMM Usage returned HTTP \(status)."
        }
    }
}

public final class CMMUsageAPIClient {
    public let baseURL: URL
    private let credentialStore: UsageCredentialStore
    private let session: URLSession
    private let decoder: JSONDecoder

    public init(
        baseURL: URL,
        credentialStore: UsageCredentialStore,
        session: URLSession = .shared,
        decoder: JSONDecoder = JSONDecoder()
    ) {
        self.baseURL = baseURL
        self.credentialStore = credentialStore
        self.session = session
        self.decoder = decoder
    }

    public func fetchProviders() async throws -> [ProviderUsageView] {
        let response: UsageListResponse<ProviderUsageView> = try await get("providers")
        return response.data
    }

    public func fetchOverview() async throws -> UsageOverview {
        try await request(nil, method: "GET", body: nil)
    }

    public func fetchProducts() async throws -> [Product] {
        let response: UsageListResponse<Product> = try await get("products")
        return response.data
    }

    public func fetchModels() async throws -> [ModelUsageView] {
        let response: UsageListResponse<ModelUsageView> = try await get("models")
        return response.data
    }

    public func fetchRoutes() async throws -> [RouteUsageView] {
        let response: UsageListResponse<RouteUsageView> = try await get("routes")
        return response.data
    }

    public func fetchQuotas() async throws -> [QuotaUsageView] {
        let response: UsageListResponse<QuotaUsageView> = try await get("quotas")
        return response.data
    }

    public func fetchHistory() async throws -> [UsageEvent] {
        let response: UsageListResponse<UsageEvent> = try await get("history")
        return response.data
    }

    public func fetchCosts() async throws -> [CostEvent] {
        let response: UsageListResponse<CostEvent> = try await get("costs")
        return response.data
    }

    public func fetchSubscriptions() async throws -> [SubscriptionPeriod] {
        let response: UsageListResponse<SubscriptionPeriod> = try await get("subscriptions")
        return response.data
    }

    public func fetchAlerts() async throws -> [UsageAlertView] {
        let response: UsageListResponse<UsageAlertView> = try await get("alerts")
        return response.data
    }

    public func fetchDashboard() async throws -> UsageDashboardSnapshot {
        let overview = try await fetchOverview()
        let providers = try await fetchProviders()
        let products = try await fetchProducts()
        let models = try await fetchModels()
        let routes = try await fetchRoutes()
        let quotas = try await fetchQuotas()
        let history = try await fetchHistory()
        let costs = try await fetchCosts()
        let subscriptions = try await fetchSubscriptions()
        let alerts = try await fetchAlerts()
        return UsageDashboardSnapshot(
            overview: overview,
            providers: providers,
            products: products,
            models: models,
            routes: routes,
            quotas: quotas,
            history: history,
            costs: costs,
            subscriptions: subscriptions,
            alerts: alerts
        )
    }

    public func refreshAll() async throws -> [UsageRefreshResultView] {
        try await request("refresh-all", method: "POST", body: Data("{}".utf8))
    }

    private func get<Value: Decodable>(_ component: String) async throws -> Value {
        try await request(component, method: "GET", body: nil)
    }

    private func request<Value: Decodable>(
        _ component: String?,
        method: String,
        body: Data?
    ) async throws -> Value {
        guard let token = try credentialStore.readToken(), !token.isEmpty else {
            throw CMMUsageAPIError.missingCredential
        }
        guard let host = baseURL.host?.lowercased(),
              ["127.0.0.1", "localhost", "::1"].contains(host),
              baseURL.scheme == "http" || baseURL.scheme == "https"
        else {
            throw CMMUsageAPIError.loopbackRequired
        }
        let path = component.map { "v1/cmm/usage/\($0)" } ?? "v1/cmm/usage"
        guard let url = URL(string: path, relativeTo: normalizedBaseURL)?.absoluteURL else {
            throw CMMUsageAPIError.invalidBaseURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw CMMUsageAPIError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            throw CMMUsageAPIError.httpStatus(http.statusCode)
        }
        return try decoder.decode(Value.self, from: data)
    }

    private var normalizedBaseURL: URL {
        baseURL.absoluteString.hasSuffix("/") ? baseURL : baseURL.appendingPathComponent("")
    }
}
