import SwiftUI
import CMMUsageCore

extension UsageStatus {
    var symbolName: String {
        switch self {
        case .healthy: return "checkmark.circle.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .critical: return "exclamationmark.octagon.fill"
        case .exhausted: return "xmark.octagon.fill"
        case .unavailable: return "wifi.slash"
        case .unknown: return "questionmark.circle.fill"
        }
    }

    var tint: Color {
        switch self {
        case .healthy: return .green
        case .warning: return .yellow
        case .critical: return .orange
        case .exhausted: return .red
        case .unavailable: return .secondary
        case .unknown: return .secondary
        }
    }
}

struct StatusBadge: View {
    let status: UsageStatus

    var body: some View {
        Label(status.displayName, systemImage: status.symbolName)
            .font(.caption.weight(.semibold))
            .foregroundStyle(status.tint)
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(status.tint.opacity(0.12), in: Capsule())
            .accessibilityLabel("Status: \(status.displayName)")
    }
}

extension AccessOfferKind {
    var badgeTint: Color {
        switch self {
        case .free: return .green
        case .promo: return .blue
        case .included: return .secondary
        case .trial: return .orange
        case .payg: return .secondary
        case .unknown: return .secondary
        }
    }
}

struct AccessOfferBadge: View {
    let offer: AccessOfferSummary

    var body: some View {
        Text(offer.kind.rawValue)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(offer.kind.badgeTint)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(offer.kind.badgeTint.opacity(0.1), in: Capsule())
            .accessibilityLabel("Access: \(offer.kind.rawValue)")
    }
}

extension CatalogQuotaSummary {
    var compactRemainingText: String {
        if let remaining {
            if metric.kind == "currency", let currency = metric.currency {
                return remaining.formatted(.currency(code: currency))
            }
            return "\(remaining.formatted(.number.precision(.fractionLength(0...2)))) \(unit)"
        }
        if metric.kind == "percentage", let remainingFraction {
            return remainingFraction.formatted(.percent.precision(.fractionLength(0)))
        }
        return status.displayName
    }
}

struct SurfaceCard<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        content
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(.quaternary, lineWidth: 1)
            }
    }
}

struct MetricCard: View {
    let title: String
    let value: String
    let systemImage: String
    var subtitle: String? = nil

    var body: some View {
        SurfaceCard {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: systemImage)
                    .font(.title2)
                    .foregroundStyle(.secondary)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(value)
                        .font(.title2.weight(.semibold))
                    if let subtitle {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }
}

struct EmptyStateView: View {
    let title: String
    let detail: String
    let systemImage: String

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(.system(size: 34))
                .foregroundStyle(.secondary)
            Text(title).font(.headline)
            Text(detail)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, minHeight: 180)
        .padding(24)
    }
}

struct QuotaDetailCard: View {
    let quota: QuotaUsageView
    var compact = false

    var body: some View {
        SurfaceCard {
            VStack(alignment: .leading, spacing: compact ? 8 : 12) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(quota.bucket.displayName)
                            .font(compact ? .subheadline.weight(.semibold) : .headline)
                        Text(quota.bucket.metric.kind.replacingOccurrences(of: "_", with: " ").capitalized)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    StatusBadge(status: quota.status)
                }

                HStack(spacing: 18) {
                    valueColumn("Remaining", quota.remainingSummary)
                    valueColumn("Reset", quota.resetSummary)
                }

                if !compact {
                    Divider()
                    HStack(spacing: 18) {
                        valueColumn("Source", quota.reconciled.selected?.source.rawValue.replacingOccurrences(of: "_", with: " ").capitalized ?? "Unknown")
                        valueColumn("Confidence", quota.reconciled.selected?.confidence.rawValue.capitalized ?? "Unknown")
                        valueColumn("Freshness", quota.freshnessSummary)
                    }
                    if quota.forecast.predictedExhaustionAt != nil {
                        Label(quota.forecastSummary, systemImage: "clock.badge.exclamationmark")
                            .font(.caption)
                            .foregroundStyle(quota.forecast.willExhaustBeforeReset == true ? .orange : .secondary)
                    }
                }
            }
        }
    }

    private func valueColumn(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.caption.weight(.medium))
                .lineLimit(compact ? 1 : 2)
        }
    }
}
