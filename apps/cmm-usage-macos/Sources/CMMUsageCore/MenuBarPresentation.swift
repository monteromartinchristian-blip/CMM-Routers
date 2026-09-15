import Foundation

public struct MenuBarQuotaLine: Identifiable, Sendable {
    public let id: String
    public let title: String
    public let valueText: String
    public let resetText: String
    public let status: UsageStatus
    public let constraining: Bool
}

public struct MenuBarProductSummary: Identifiable, Sendable {
    public let id: String
    public let providerName: String
    public let productName: String
    public let quotaLines: [MenuBarQuotaLine]
}

public enum MenuBarPresenter {
    public static func freeCapacityCount(
        promotions: [CatalogRouteEntry],
        quotas: [CatalogQuotaSummary]
    ) -> Int {
        promotions.count + quotas.filter(\.isClaimableEntitlement).count
    }

    public static func productSummaries(
        routes: [CatalogRouteEntry],
        quotas: [CatalogQuotaSummary]
    ) -> [MenuBarProductSummary] {
        Dictionary(grouping: routes, by: { $0.product.id }).values.compactMap { productRoutes in
            guard let first = productRoutes.first else { return nil }
            let routeIds = Set(productRoutes.map(\.routeId))
            let productQuotas = quotas.filter { quota in
                if quota.scope.productId == first.product.id { return true }
                return !(Set(quota.affectedRouteIds ?? []).isDisjoint(with: routeIds))
            }
            .filter { !$0.isSupplementalBalance && !$0.isClaimableEntitlement }
            .sortedForPresentation

            return MenuBarProductSummary(
                id: first.product.id,
                providerName: first.provider.displayName,
                productName: friendlyProductName(first.product.displayName),
                quotaLines: productQuotas.map {
                    MenuBarQuotaLine(
                        id: $0.bucketId,
                        title: $0.displayName,
                        valueText: $0.primaryValueText,
                        resetText: $0.resetText,
                        status: $0.status,
                        constraining: $0.constraining
                    )
                }
            )
        }
        .sorted { left, right in
            let providerOrder = left.providerName.localizedCaseInsensitiveCompare(right.providerName)
            if providerOrder != .orderedSame { return providerOrder == .orderedAscending }
            return left.productName.localizedCaseInsensitiveCompare(right.productName) == .orderedAscending
        }
    }

    public static func friendlyProductName(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "individual-goat"
            ? "GOAT"
            : raw
    }
}
