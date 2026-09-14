import Foundation

public enum UsageNavigationDestination: String, CaseIterable, Identifiable, Sendable {
    case overview
    case quotas
    case models
    case providers
    case freePromo
    case history
    case costs
    case alerts
    case settings

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .overview: return "Overview"
        case .quotas: return "Quotas"
        case .models: return "Models"
        case .providers: return "Providers"
        case .freePromo: return "Free & Promo"
        case .history: return "History"
        case .costs: return "Costs"
        case .alerts: return "Alerts"
        case .settings: return "Settings"
        }
    }

    public static func fromDeepLink(_ url: URL) -> UsageNavigationDestination? {
        guard url.scheme?.lowercased() == "cmm-usage" else { return nil }
        let value = (url.host?.isEmpty == false ? url.host : url.path.split(separator: "/").first.map(String.init))?
            .lowercased()
        switch value {
        case "overview": return .overview
        case "quotas": return .quotas
        case "models": return .models
        case "providers": return .providers
        case "free-promo", "freepromo": return .freePromo
        case "history": return .history
        case "costs": return .costs
        case "alerts": return .alerts
        case "settings": return .settings
        default: return nil
        }
    }
}

public enum ProviderSettingsSection: String, CaseIterable, Identifiable, Sendable {
    case accounts
    case apiKeys
    case customEndpoints

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .accounts: return "Accounts"
        case .apiKeys: return "API Keys"
        case .customEndpoints: return "Custom Endpoints"
        }
    }
}

public struct ProviderPresentationGroups: Sendable {
    public let connected: [CatalogProviderView]
    public let available: [CatalogProviderView]

    public init(connected: [CatalogProviderView], available: [CatalogProviderView]) {
        self.connected = connected
        self.available = available
    }
}

public enum ProviderCatalogPresenter {
    private static let connectedStates: Set<ProviderDirectoryState> = [
        .connected,
        .connecting,
        .degraded,
        .reauthRequired,
    ]

    public static func groups(
        for section: ProviderSettingsSection,
        providers: [CatalogProviderView]
    ) -> ProviderPresentationGroups {
        let matching = providers.filter { provider in
            let methods = provider.directory.connectionMethods
            switch section {
            case .accounts:
                return methods.contains(.account) || methods.contains(.oauth) || methods.contains(.localSession)
            case .apiKeys:
                return methods.contains(.apiKey)
            case .customEndpoints:
                return methods.contains(.customEndpoint) || provider.directory.category == .customEndpoint
            }
        }
        let sorted = matching.sorted {
            $0.directory.displayName.localizedCaseInsensitiveCompare($1.directory.displayName) == .orderedAscending
        }
        return ProviderPresentationGroups(
            connected: sorted.filter { connectedStates.contains($0.directory.state) },
            available: sorted.filter { !connectedStates.contains($0.directory.state) }
        )
    }

    public static func isConnected(
        _ routeProvider: CatalogRouteProvider,
        among providers: [CatalogProviderView]
    ) -> Bool {
        providers.contains { provider in
            guard connectedStates.contains(provider.directory.state) else { return false }
            let integrationType = provider.directory.integrationType
            return routeProvider.displayName == provider.directory.displayName
                || routeProvider.id == integrationType
                || routeProvider.id.hasSuffix(":\(integrationType)")
        }
    }

    public static func safeCredentialHint(_ hint: String?) -> String {
        guard let hint, !hint.isEmpty else { return "Add key" }
        let suffix = hint.dropFirst(4)
        guard hint.hasPrefix("••••"), !suffix.isEmpty, suffix.count <= 4 else {
            return "Stored securely"
        }
        return hint
    }

    public static func emptyStateDetail(for section: ProviderSettingsSection) -> String {
        switch section {
        case .accounts:
            return "Connect a supported account to discover its models and quota metadata."
        case .apiKeys:
            return "Add an API key for a supported provider. Keys stay in secure credential storage."
        case .customEndpoints:
            return "Add an OpenAI-compatible endpoint and choose how CMM should discover its models."
        }
    }
}
