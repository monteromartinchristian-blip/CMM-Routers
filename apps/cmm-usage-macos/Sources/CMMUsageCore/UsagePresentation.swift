import Foundation

public extension ProviderDirectoryState {
    var displayName: String {
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
}

public extension UsageStatus {
    var severityRank: Int {
        switch self {
        case .healthy: return 0
        case .unknown: return 1
        case .unavailable: return 2
        case .warning: return 3
        case .critical: return 4
        case .exhausted: return 5
        }
    }

    var displayName: String {
        switch self {
        case .healthy: return "Healthy"
        case .warning: return "Warning"
        case .critical: return "Critical"
        case .exhausted: return "Exhausted"
        case .unavailable: return "Unavailable"
        case .unknown: return "Unknown"
        }
    }

    static func worse(_ lhs: UsageStatus, _ rhs: UsageStatus) -> UsageStatus {
        lhs.severityRank >= rhs.severityRank ? lhs : rhs
    }
}

public extension QuotaUsageView {
    var remainingSummary: String {
        guard let snapshot = reconciled.selected else { return "Unknown" }
        if let remaining = snapshot.remainingValue {
            return "\(Self.numberFormatter.string(from: NSNumber(value: remaining)) ?? String(remaining)) \(bucket.unit) remaining"
        }
        if let fraction = snapshot.remainingFraction {
            let percent = Int((fraction * 100).rounded())
            return "\(percent)% remaining"
        }
        return "Unknown"
    }

    var resetSummary: String {
        guard let snapshot = reconciled.selected else { return "Unknown" }
        if let resetAt = snapshot.resetAt { return resetAt }
        if let providerResetText = snapshot.providerResetText, !providerResetText.isEmpty {
            return providerResetText
        }
        return bucket.windowPolicy.kind == "none" ? "No reset" : "Unknown"
    }

    var forecastSummary: String {
        guard let predicted = forecast.predictedExhaustionAt else { return "No exhaustion forecast" }
        return "Predicted exhaustion: \(predicted)"
    }

    var freshnessSummary: String {
        guard let selected = reconciled.selected else { return "No observation" }
        return reconciled.stale == true ? "Stale · \(selected.observedAt)" : "Fresh · \(selected.observedAt)"
    }

    private static let numberFormatter: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.maximumFractionDigits = 2
        formatter.minimumFractionDigits = 0
        return formatter
    }()
}

public extension CatalogQuotaSummary {
    var primaryValueText: String {
        switch metric.kind {
        case "percentage":
            if let usedFraction {
                return "\(Self.percent(usedFraction)) used"
            }
            if let remainingFraction {
                return "\(Self.percent(remainingFraction)) remaining"
            }
        case "currency":
            if let remaining {
                return "\(Self.currency(remaining, code: metric.currency ?? unit)) balance remaining"
            }
        case "requests":
            if let remaining, let limit {
                return "\(Self.compactNumber(remaining)) / \(Self.compactNumber(limit)) requests remaining"
            }
        case "provider_defined":
            if let remaining, let limit {
                return "\(Self.compactNumber(remaining)) / \(Self.compactNumber(limit)) \(unit) remaining"
            }
        default:
            break
        }

        if let remaining {
            return "\(Self.compactNumber(remaining)) \(unit) remaining"
        }
        if let used {
            return "\(Self.compactNumber(used)) \(unit) used"
        }
        return "Unknown"
    }

    var progressFraction: Double? {
        if let usedFraction {
            return Self.clamp(usedFraction)
        }
        if let remainingFraction {
            return Self.clamp(1 - remainingFraction)
        }
        guard let limit, limit > 0 else { return nil }
        if let used { return Self.clamp(used / limit) }
        if let remaining { return Self.clamp((limit - remaining) / limit) }
        return nil
    }

    var resetText: String {
        if let resetAt, !resetAt.isEmpty {
            return UsagePresentationDateFormatter.resetText(resetAt) ?? resetAt
        }
        if let providerResetText, !providerResetText.isEmpty { return providerResetText }
        return windowPolicy?.kind == "none" ? "No reset" : "Unknown reset"
    }

    var isSupplementalBalance: Bool {
        guard !constraining,
              windowPolicy?.kind == "none",
              affectedRouteIds?.isEmpty != false
        else { return false }
        return metric.kind == "credits" || metric.kind == "currency"
    }

    var scopeText: String {
        switch scope.kind {
        case .sharedPool: return "Shared pool"
        case .provider: return "Provider"
        case .account: return "Account"
        case .product: return "Product"
        case .model: return "Model"
        case .route: return "Route"
        case .apiKey: return "API key"
        case .providerDefined: return "Provider-defined"
        }
    }

    var freshnessText: String {
        if stale == true { return "Stale" }
        return observedAt == nil ? "Unknown freshness" : "Fresh"
    }

    private static func percent(_ fraction: Double) -> String {
        "\(Int((fraction * 100).rounded()))%"
    }

    private static func clamp(_ value: Double) -> Double {
        min(max(value, 0), 1)
    }

    private static func compactNumber(_ value: Double) -> String {
        let absolute = abs(value)
        let scaled: Double
        let suffix: String
        if absolute >= 1_000_000 {
            scaled = value / 1_000_000
            suffix = "M"
        } else if absolute >= 1_000 {
            scaled = value / 1_000
            suffix = "K"
        } else {
            scaled = value
            suffix = ""
        }
        let formatter = NumberFormatter()
        formatter.minimumFractionDigits = 0
        formatter.maximumFractionDigits = abs(scaled.rounded() - scaled) < 0.0001 ? 0 : 1
        return "\(formatter.string(from: NSNumber(value: scaled)) ?? String(scaled))\(suffix)"
    }

    private static func currency(_ value: Double, code: String) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.minimumFractionDigits = 2
        formatter.maximumFractionDigits = 2
        let amount = formatter.string(from: NSNumber(value: value)) ?? String(format: "%.2f", value)
        switch code.uppercased() {
        case "USD": return "$\(amount)"
        case "EUR": return "€\(amount)"
        case "GBP": return "£\(amount)"
        case "JPY": return "¥\(amount)"
        default: return "\(code.uppercased()) \(amount)"
        }
    }
}

public extension AccessOfferSummary {
    var validUntilText: String? {
        guard let validUntil, !validUntil.isEmpty else { return nil }
        return UsagePresentationDateFormatter.validUntilText(validUntil) ?? validUntil
    }
}

private enum UsagePresentationDateFormatter {
    static func resetText(_ value: String) -> String? {
        guard let date = parse(value) else { return nil }
        return resetFormatter.string(from: date)
    }

    static func validUntilText(_ value: String) -> String? {
        guard let date = parse(value) else { return nil }
        return validUntilFormatter.string(from: date)
    }

    private static func parse(_ value: String) -> Date? {
        if let date = fractionalISO8601.date(from: value) { return date }
        return ISO8601DateFormatter().date(from: value)
    }

    private static let fractionalISO8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let resetFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "'Resets' d MMM, HH:mm 'UTC'"
        return formatter
    }()

    private static let validUntilFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "'Until' d MMM yyyy"
        return formatter
    }()
}

public extension Array where Element == CatalogQuotaSummary {
    var sortedForPresentation: [CatalogQuotaSummary] {
        sorted { left, right in
            let leftTier = left.constraining ? 0 : left.isSupplementalBalance ? 2 : 1
            let rightTier = right.constraining ? 0 : right.isSupplementalBalance ? 2 : 1
            if leftTier != rightTier { return leftTier < rightTier }
            if left.status.severityRank != right.status.severityRank {
                return left.status.severityRank > right.status.severityRank
            }
            return left.displayName.localizedCaseInsensitiveCompare(right.displayName) == .orderedAscending
        }
    }
}
