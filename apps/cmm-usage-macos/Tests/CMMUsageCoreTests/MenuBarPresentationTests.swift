import XCTest
@testable import CMMUsageCore

final class MenuBarPresentationTests: XCTestCase {
    func testFriendlyGoatIdentityAndIndependentQuotaLines() throws {
        let routes = try decodeRoutes()
        let quotas = try decodeQuotas()

        let products = MenuBarPresenter.productSummaries(routes: routes, quotas: quotas)
        let goat = try XCTUnwrap(products.first)

        XCTAssertEqual(goat.productName, "GOAT")
        XCTAssertEqual(goat.quotaLines.map(\.valueText), ["35 credits remaining", "61% used"])
        XCTAssertEqual(goat.quotaLines.map(\.resetText), ["Unknown reset", "Unknown reset"])
        XCTAssertEqual(goat.quotaLines.count, 2, "heterogeneous quotas must remain independent instead of becoming one aggregate percentage")
        XCTAssertFalse(goat.quotaLines.contains { $0.id == "claimable" }, "claimable capacity must not masquerade as an active menu-bar quota")
    }

    func testDeepLinkDestinationMapping() throws {
        XCTAssertEqual(UsageNavigationDestination.fromDeepLink(URL(string: "cmm-usage://models")!), .models)
        XCTAssertEqual(UsageNavigationDestination.fromDeepLink(URL(string: "cmm-usage://providers")!), .providers)
        XCTAssertEqual(UsageNavigationDestination.fromDeepLink(URL(string: "cmm-usage://quotas")!), .quotas)
        XCTAssertEqual(UsageNavigationDestination.fromDeepLink(URL(string: "cmm-usage://free-promo")!), .freePromo)
        XCTAssertNil(UsageNavigationDestination.fromDeepLink(URL(string: "https://example.com/models")!))
    }

    func testFreeCapacityCountIncludesClaimableAllowance() throws {
        let promotions = try JSONDecoder().decode(
            UsageListResponse<CatalogRouteEntry>.self,
            from: Data(#"{"data":[{"routeId":"route:free","provider":{"id":"provider:kira","displayName":"Kira AI"},"product":{"id":"product:kira","displayName":"Community access","category":"api"},"model":{"id":"model:qwen","displayName":"Qwen Free"},"offer":{"kind":"FREE"},"quota":[],"availability":"available","visibility":"visible"}]}"#.utf8)
        ).data

        XCTAssertEqual(MenuBarPresenter.freeCapacityCount(promotions: promotions, quotas: try decodeQuotas()), 2)
    }

    private func decodeRoutes() throws -> [CatalogRouteEntry] {
        let json = #"""
        {"data":[
          {"routeId":"route:goat","provider":{"id":"provider:command","displayName":"Command Code"},"product":{"id":"product:goat","displayName":"individual-goat","category":"subscription"},"model":{"id":"model:command","displayName":"Command Code"},"offer":{"kind":"INCLUDED"},"quota":[],"availability":"available","visibility":"visible"}
        ]}
        """#
        return try JSONDecoder().decode(UsageListResponse<CatalogRouteEntry>.self, from: Data(json.utf8)).data
    }

    private func decodeQuotas() throws -> [CatalogQuotaSummary] {
        let json = #"""
        {"data":[
          {"bucketId":"credits","displayName":"Monthly plan credits","metric":{"kind":"credits"},"unit":"credits","windowPolicy":{"kind":"provider_reported"},"scope":{"kind":"product","productId":"product:goat"},"status":"healthy","remaining":35,"constraining":true,"affectedRouteIds":["route:goat"]},
          {"bucketId":"weekly","displayName":"Weekly usage","metric":{"kind":"percentage"},"unit":"fraction","windowPolicy":{"kind":"provider_reported"},"scope":{"kind":"product","productId":"product:goat"},"status":"healthy","usedFraction":0.61,"constraining":false,"affectedRouteIds":["route:goat"]},
          {"bucketId":"claimable","displayName":"Bonus available","metric":{"kind":"tokens"},"unit":"tokens","windowPolicy":{"kind":"none"},"scope":{"kind":"product","productId":"product:goat"},"status":"healthy","remaining":50000000,"limit":50000000,"constraining":false,"entitlement":{"state":"claimable","eligibility":"requires_auth","amount":50000000,"unit":"tokens","actionLabel":"Sign in to claim","requiresExplicitUserAction":true,"appliesToRouteIds":["route:goat"]}}
        ]}
        """#
        return try JSONDecoder().decode(UsageListResponse<CatalogQuotaSummary>.self, from: Data(json.utf8)).data
    }
}
