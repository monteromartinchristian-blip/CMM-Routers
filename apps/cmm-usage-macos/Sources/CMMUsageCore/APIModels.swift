import Foundation

public struct UsageListResponse<Value: Decodable>: Decodable {
    public let data: [Value]

    public init(data: [Value]) {
        self.data = data
    }
}

public enum UsageStatus: String, Codable, CaseIterable, Sendable {
    case healthy
    case warning
    case critical
    case exhausted
    case unavailable
    case unknown
}

public enum UsageSource: String, Codable, Sendable {
    case providerOfficialAPI = "provider_official_api"
    case providerOfficialSDK = "provider_official_sdk"
    case providerOfficialCLI = "provider_official_cli"
    case providerLocalState = "provider_local_state"
    case routerMeasured = "router_measured"
    case manual
    case derived
    case estimated
}

public enum UsageConfidence: String, Codable, Sendable {
    case exact
    case measured
    case calculated
    case estimated
    case unknown
}

public enum AccessOfferKind: String, Codable, CaseIterable, Sendable {
    case free = "FREE"
    case promo = "PROMO"
    case included = "INCLUDED"
    case trial = "TRIAL"
    case payg = "PAYG"
    case unknown = "UNKNOWN"
}

public struct AccessOfferSummary: Decodable, Sendable {
    public let kind: AccessOfferKind
    public let modifiers: [String]?
    public let source: UsageSource?
    public let confidence: UsageConfidence?
    public let observedAt: String?
    public let validUntil: String?
}

public enum CatalogProviderCategory: String, Decodable, Sendable {
    case subscription
    case api
    case aggregator
    case customEndpoint = "custom_endpoint"
    case local
}

public enum ProviderConnectionMethod: String, Decodable, Sendable {
    case account
    case oauth
    case apiKey = "api_key"
    case localSession = "local_session"
    case customEndpoint = "custom_endpoint"
}

public enum ProviderDirectoryState: String, Decodable, Sendable {
    case available
    case connecting
    case connected
    case degraded
    case disabled
    case reauthRequired = "reauth_required"
    case unavailable
}

public struct ProviderDirectoryCapabilities: Decodable, Sendable {
    public let modelDiscovery: Bool
    public let quotaDiscovery: Bool
    public let balanceDiscovery: Bool
    public let costDiscovery: Bool
    public let pricingDiscovery: Bool
}

public struct ProviderDirectoryEntry: Decodable, Sendable, Identifiable {
    public let integrationType: String
    public let displayName: String
    public let shortDescription: String?
    public let iconKey: String?
    public let category: CatalogProviderCategory
    public let connectionMethods: [ProviderConnectionMethod]
    public let state: ProviderDirectoryState
    public let connectedInstanceCount: Int
    public let capabilities: ProviderDirectoryCapabilities

    public var id: String { integrationType }
}

public struct CatalogProviderView: Decodable, Sendable, Identifiable {
    public let directory: ProviderDirectoryEntry
    public let instanceIds: [String]

    public var id: String { directory.integrationType }
}

public enum CatalogProductCategory: String, Decodable, Sendable {
    case subscription
    case api
    case aggregator
    case custom
    case local
}

public enum CatalogRouteAvailability: String, Decodable, Sendable {
    case available
    case temporarilyUnavailable = "temporarily_unavailable"
    case unknown
}

public enum CatalogVisibilityState: String, Codable, Sendable {
    case visible
    case hidden
    case inherit
}

public enum QuotaScopeKind: String, Decodable, Sendable {
    case provider
    case account
    case product
    case sharedPool = "shared_pool"
    case model
    case route
    case apiKey = "api_key"
    case providerDefined = "provider_defined"
}

public struct CatalogQuotaScope: Decodable, Sendable {
    public let kind: QuotaScopeKind
    public let providerId: String?
    public let accountId: String?
    public let productId: String?
    public let modelIdentityId: String?
    public let routeId: String?
    public let key: String?
}

public struct CatalogQuotaSummary: Decodable, Sendable, Identifiable {
    public let bucketId: String
    public let displayName: String
    public let metric: UsageMetric
    public let unit: String
    public let windowPolicy: UsageWindowPolicy?
    public let scope: CatalogQuotaScope
    public let status: UsageStatus
    public let used: Double?
    public let remaining: Double?
    public let limit: Double?
    public let usedFraction: Double?
    public let remainingFraction: Double?
    public let resetAt: String?
    public let providerResetText: String?
    public let constraining: Bool
    public let source: UsageSource?
    public let confidence: UsageConfidence?
    public let observedAt: String?
    public let stale: Bool?
    public let affectedRouteIds: [String]?

    public var id: String { bucketId }
}

public struct CatalogRouteProvider: Decodable, Sendable {
    public let id: String
    public let displayName: String
    public let iconKey: String?
}

public struct CatalogRouteProduct: Decodable, Sendable {
    public let id: String
    public let displayName: String
    public let category: CatalogProductCategory
}

public struct CatalogRouteModel: Decodable, Sendable {
    public let id: String
    public let displayName: String
    public let family: String?
    public let capabilities: [String]?
}

public struct CatalogFreshness: Decodable, Sendable {
    public let observedAt: String?
    public let stale: Bool
}

public struct CatalogRouteEntry: Decodable, Sendable, Identifiable {
    public let routeId: String
    public let modelIdentityId: String?
    public let provider: CatalogRouteProvider
    public let product: CatalogRouteProduct
    public let model: CatalogRouteModel
    public let offer: AccessOfferSummary
    public let quota: [CatalogQuotaSummary]
    public let availability: CatalogRouteAvailability
    public let visibility: CatalogVisibilityState
    public let freshness: CatalogFreshness?

    public var id: String { routeId }
}

public struct CatalogVisibilityPreference: Decodable, Sendable, Identifiable {
    public let scope: String
    public let providerId: String?
    public let productId: String?
    public let routeId: String?
    public let state: CatalogVisibilityState

    public var id: String {
        "\(scope):\(providerId ?? ""):\(productId ?? ""):\(routeId ?? "")"
    }
}

public struct CatalogVisibilityMutationResult: Decodable, Sendable {
    public let routeId: String
    public let state: CatalogVisibilityState
}

public struct UsageConnectionView: Decodable, Sendable, Identifiable {
    public let id: String
    public let type: String
    public let enabled: Bool
    public let hint: String?
}

public struct UsageConnectionTestResult: Decodable, Sendable {
    public let id: String
    public let status: String
}

public struct CustomEndpointConnectionInput: Sendable {
    public let instanceId: String?
    public let name: String
    public let endpointURL: String
    public let defaultModel: String?
    public let apiKey: String?
    public let discoverModels: Bool
    public let useInCMMChat: Bool
    public let usageEndpoint: String?
    public let billingEndpoint: String?
    public let quotaMode: String

    public init(
        instanceId: String? = nil,
        name: String,
        endpointURL: String,
        defaultModel: String? = nil,
        apiKey: String? = nil,
        discoverModels: Bool = true,
        useInCMMChat: Bool = true,
        usageEndpoint: String? = nil,
        billingEndpoint: String? = nil,
        quotaMode: String = "unknown"
    ) {
        self.instanceId = instanceId
        self.name = name
        self.endpointURL = endpointURL
        self.defaultModel = defaultModel
        self.apiKey = apiKey
        self.discoverModels = discoverModels
        self.useInCMMChat = useInCMMChat
        self.usageEndpoint = usageEndpoint
        self.billingEndpoint = billingEndpoint
        self.quotaMode = quotaMode
    }
}

public enum LifecycleStatus: String, Codable, Sendable {
    case active
    case paused
    case cancelled
    case expired
    case archived
}

public struct UsageOverview: Decodable, Sendable {
    public let generatedAt: String
    public let providerCount: Int
    public let productCount: Int
    public let modelCount: Int
    public let routeCount: Int
    public let quotaCount: Int
    public let warningCount: Int
    public let criticalCount: Int
    public let exhaustedCount: Int
}

public struct UsageMetric: Codable, Sendable, Hashable {
    public let kind: String
    public let currency: String?
    public let providerKey: String?

    public init(kind: String, currency: String? = nil, providerKey: String? = nil) {
        self.kind = kind
        self.currency = currency
        self.providerKey = providerKey
    }
}

public struct UsageWindowPolicy: Codable, Sendable, Hashable {
    public let kind: String
    public let durationSeconds: Double?
    public let calendarUnit: String?
    public let timezone: String?
    public let anchor: String?
    public let anchorDate: String?

    public init(
        kind: String,
        durationSeconds: Double? = nil,
        calendarUnit: String? = nil,
        timezone: String? = nil,
        anchor: String? = nil,
        anchorDate: String? = nil
    ) {
        self.kind = kind
        self.durationSeconds = durationSeconds
        self.calendarUnit = calendarUnit
        self.timezone = timezone
        self.anchor = anchor
        self.anchorDate = anchorDate
    }
}

public struct Provider: Decodable, Sendable, Identifiable {
    public let id: String
    public let displayName: String
    public let kind: String
    public let status: String
    public let createdAt: String
    public let updatedAt: String
}

public struct ProviderUsageView: Decodable, Sendable, Identifiable {
    public let provider: Provider
    public let pressure: ProviderPressureView

    public var id: String { provider.id }
}

public struct Product: Decodable, Sendable, Identifiable {
    public let id: String
    public let providerId: String
    public let displayName: String
    public let kind: String
}

public struct ProviderPressureView: Decodable, Sendable {
    public let providerId: String
    public let status: UsageStatus
    public let routes: [RouteHealth]
}

public struct RouteHealth: Decodable, Sendable, Identifiable {
    public let accessRouteId: String
    public let status: UsageStatus
    public let constraints: [QuotaConstraint]
    public let primaryConstraint: QuotaConstraint?

    public var id: String { accessRouteId }
}

public struct ModelIdentity: Decodable, Sendable, Identifiable {
    public let id: String
    public let canonicalName: String
    public let vendor: String
    public let family: String?
    public let version: String?
    public let lifecycle: String
    public let aliases: [String]
}

public struct ModelConstraintView: Decodable, Sendable {
    public let modelIdentityId: String
    public let routes: [RouteHealth]
}

public struct ModelUsageView: Decodable, Sendable, Identifiable {
    public let model: ModelIdentity
    public let constraints: ModelConstraintView

    public var id: String { model.id }
}

public struct AccessRoute: Decodable, Sendable, Identifiable {
    public let id: String
    public let accountId: String
    public let productId: String
    public let subscriptionPeriodId: String?
    public let modelIdentityId: String?
    public let providerModelId: String
    public let displayName: String
    public let status: String
}

public struct RouteUsageView: Decodable, Sendable, Identifiable {
    public let route: AccessRoute
    public let health: RouteHealth

    public var id: String { route.id }
}

public struct QuotaConstraint: Decodable, Sendable, Identifiable {
    public let bucketId: String
    public let bindingId: String
    public let status: UsageStatus
    public let enforcement: String
    public let metric: UsageMetric
    public let unit: String
    public let priority: Int?
    public let remainingFraction: Double?
    public let resetAt: String?
    public let predictedExhaustionAt: String?
    public let source: UsageSource?
    public let confidence: UsageConfidence?

    public var id: String { bindingId }
}

public struct QuotaBucket: Decodable, Sendable, Identifiable {
    public let id: String
    public let accountId: String
    public let productId: String
    public let quotaGroupId: String?
    public let displayName: String
    public let metric: UsageMetric
    public let windowPolicy: UsageWindowPolicy
    public let limitValue: Double?
    public let unit: String
    public let enforcement: String
    public let status: UsageStatus
    public let providerKey: String?
}

public struct QuotaSnapshot: Decodable, Sendable, Identifiable {
    public let id: String
    public let quotaBucketId: String
    public let observedAt: String
    public let usedValue: Double?
    public let remainingValue: Double?
    public let limitValue: Double?
    public let usedFraction: Double?
    public let remainingFraction: Double?
    public let resetAt: String?
    public let providerResetText: String?
    public let source: UsageSource
    public let confidence: UsageConfidence
    public let stalenessAfter: String
}

public struct ReconciledQuotaState: Decodable, Sendable {
    public let selected: QuotaSnapshot?
    public let stale: Bool?
}

public struct QuotaForecast: Decodable, Sendable {
    public let predictedExhaustionAt: String?
    public let willExhaustBeforeReset: Bool?
    public let confidence: UsageConfidence
}

public struct QuotaUsageView: Decodable, Sendable, Identifiable {
    public let bucket: QuotaBucket
    public let bucketId: String
    public let status: UsageStatus
    public let reconciled: ReconciledQuotaState
    public let forecast: QuotaForecast

    public var id: String { bucketId }
}

public struct SubscriptionPeriod: Decodable, Sendable, Identifiable {
    public let id: String
    public let accountId: String
    public let productId: String
    public let status: LifecycleStatus
    public let startedAt: String
    public let endedAt: String?
    public let billingAmount: Double?
    public let billingCurrency: String?
}

public struct UsageEvent: Decodable, Sendable, Identifiable {
    public let id: String
    public let occurredAt: String
    public let providerId: String
    public let accountId: String
    public let productId: String
    public let accessRouteId: String?
    public let modelIdentityId: String?
    public let inputTokens: Double?
    public let outputTokens: Double?
    public let cachedInputTokens: Double?
    public let cachedOutputTokens: Double?
    public let requests: Double?
    public let providerUnits: Double?
    public let providerUnitName: String?
    public let costAmount: Double?
    public let costCurrency: String?
    public let source: UsageSource
    public let confidence: UsageConfidence
}

public struct CostEvent: Decodable, Sendable, Identifiable {
    public let id: String
    public let occurredAt: String
    public let providerId: String
    public let accountId: String
    public let productId: String
    public let accessRouteId: String?
    public let amount: Double
    public let currency: String
    public let kind: String
    public let source: UsageSource
    public let confidence: UsageConfidence
}

public struct UsageAlertView: Decodable, Sendable, Identifiable {
    public let bucketId: String
    public let status: UsageStatus
    public let kind: String

    public var id: String { "\(bucketId):\(kind)" }
}

public struct UsageDashboardSnapshot: Sendable {
    public let overview: UsageOverview
    public let providers: [ProviderUsageView]
    public let products: [Product]
    public let models: [ModelUsageView]
    public let routes: [RouteUsageView]
    public let quotas: [QuotaUsageView]
    public let history: [UsageEvent]
    public let costs: [CostEvent]
    public let subscriptions: [SubscriptionPeriod]
    public let alerts: [UsageAlertView]

    public var overallStatus: UsageStatus {
        let statuses = providers.map(\.pressure.status) + quotas.map(\.status)
        guard let first = statuses.first else { return .unknown }
        return statuses.dropFirst().reduce(first) { UsageStatus.worse($0, $1) }
    }

    public func products(for providerId: String) -> [Product] {
        products.filter { $0.providerId == providerId }
    }
}
