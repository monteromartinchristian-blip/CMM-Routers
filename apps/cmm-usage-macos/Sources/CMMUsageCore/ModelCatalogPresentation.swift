import Foundation

public enum CatalogSelectionState: String, Sendable {
    case visible
    case hidden
    case mixed
}

public enum ModelCatalogFilter: String, CaseIterable, Identifiable, Sendable {
    case all
    case included
    case free
    case promo
    case trial
    case payg
    case hidden

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .all: return "All"
        case .included: return "Included"
        case .free: return "Free"
        case .promo: return "Promo"
        case .trial: return "Trial"
        case .payg: return "PAYG"
        case .hidden: return "Hidden"
        }
    }
}

public struct ModelCatalogProductGroup: Identifiable, Sendable {
    public let product: CatalogRouteProduct
    public let routes: [CatalogRouteEntry]
    public let selectionState: CatalogSelectionState

    public var id: String { product.id }
}

public struct ModelCatalogProviderGroup: Identifiable, Sendable {
    public let provider: CatalogRouteProvider
    public let products: [ModelCatalogProductGroup]
    public let selectionState: CatalogSelectionState

    public var id: String { provider.id }
}

public enum ModelCatalogPresenter {
    public static func visibleRoutes(_ routes: [CatalogRouteEntry]) -> [CatalogRouteEntry] {
        routes.filter { $0.visibility == .visible }
    }

    public static func pickerRoutes(_ routes: [CatalogRouteEntry]) -> [CatalogRouteEntry] {
        visibleRoutes(routes)
    }

    public static func selectionState(_ routes: [CatalogRouteEntry]) -> CatalogSelectionState {
        guard !routes.isEmpty else { return .hidden }
        let visibleCount = routes.lazy.filter { $0.visibility == .visible }.count
        if visibleCount == 0 { return .hidden }
        if visibleCount == routes.count { return .visible }
        return .mixed
    }

    public static func groups(_ routes: [CatalogRouteEntry]) -> [ModelCatalogProviderGroup] {
        let providerBuckets = Dictionary(grouping: routes, by: { $0.provider.id })
        return providerBuckets.values.compactMap { providerRoutes in
            guard let provider = providerRoutes.first?.provider else { return nil }
            let productBuckets = Dictionary(grouping: providerRoutes, by: { $0.product.id })
            let products = productBuckets.values.compactMap { productRoutes -> ModelCatalogProductGroup? in
                guard let product = productRoutes.first?.product else { return nil }
                let sortedRoutes = productRoutes.sorted(by: routeSort)
                return ModelCatalogProductGroup(
                    product: product,
                    routes: sortedRoutes,
                    selectionState: selectionState(sortedRoutes)
                )
            }
            .sorted {
                $0.product.displayName.localizedCaseInsensitiveCompare($1.product.displayName) == .orderedAscending
            }
            return ModelCatalogProviderGroup(
                provider: provider,
                products: products,
                selectionState: selectionState(providerRoutes)
            )
        }
        .sorted {
            $0.provider.displayName.localizedCaseInsensitiveCompare($1.provider.displayName) == .orderedAscending
        }
    }

    public static func filteredRoutes(
        _ routes: [CatalogRouteEntry],
        query: String,
        filter: ModelCatalogFilter
    ) -> [CatalogRouteEntry] {
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return routes.filter { route in
            matches(filter, route: route) && matches(normalizedQuery, route: route)
        }
    }

    private static func matches(_ filter: ModelCatalogFilter, route: CatalogRouteEntry) -> Bool {
        switch filter {
        case .all: return true
        case .included: return route.offer.kind == .included
        case .free: return route.offer.kind == .free
        case .promo: return route.offer.kind == .promo
        case .trial: return route.offer.kind == .trial
        case .payg: return route.offer.kind == .payg
        case .hidden: return route.visibility == .hidden
        }
    }

    private static func matches(_ query: String, route: CatalogRouteEntry) -> Bool {
        guard !query.isEmpty else { return true }
        return [
            route.model.displayName,
            route.model.family,
            route.provider.displayName,
            route.product.displayName,
        ]
        .compactMap { $0 }
        .contains { $0.localizedCaseInsensitiveContains(query) }
    }

    private static func routeSort(_ left: CatalogRouteEntry, _ right: CatalogRouteEntry) -> Bool {
        let modelOrder = left.model.displayName.localizedCaseInsensitiveCompare(right.model.displayName)
        if modelOrder != .orderedSame { return modelOrder == .orderedAscending }
        return left.routeId < right.routeId
    }
}
