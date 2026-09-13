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
