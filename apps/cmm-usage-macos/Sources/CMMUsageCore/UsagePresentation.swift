import Foundation

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
        return "No reset"
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
