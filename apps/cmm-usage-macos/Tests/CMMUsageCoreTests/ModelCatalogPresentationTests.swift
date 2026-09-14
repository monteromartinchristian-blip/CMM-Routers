import XCTest
@testable import CMMUsageCore

final class ModelCatalogPresentationTests: XCTestCase {
    func testHidingOpenRouterClaudeKeepsSiblingClaudeRoutesVisible() throws {
        let routes = try fixtureRoutes()
        let visible = ModelCatalogPresenter.visibleRoutes(routes)

        XCTAssertTrue(visible.contains(where: { $0.routeId == "route:anthropic:claude" }))
        XCTAssertTrue(visible.contains(where: { $0.routeId == "route:google:claude" }))
        XCTAssertFalse(visible.contains(where: { $0.routeId == "route:openrouter:claude" }))
    }

    func testProviderAndProductGroupsReportMixedState() throws {
        let groups = ModelCatalogPresenter.groups(try fixtureRoutes())
        let openRouter = try XCTUnwrap(groups.first { $0.provider.id == "provider:openrouter" })
        XCTAssertEqual(openRouter.selectionState, .mixed)
        XCTAssertEqual(openRouter.products.first?.selectionState, .mixed)
    }

    func testSearchMatchesFriendlyModelProviderAndProductNames() throws {
        let routes = try fixtureRoutes()
        XCTAssertEqual(ModelCatalogPresenter.filteredRoutes(routes, query: "GOAT", filter: .all).map(\.routeId), ["route:command"])
        XCTAssertEqual(Set(ModelCatalogPresenter.filteredRoutes(routes, query: "OpenRouter", filter: .all).map(\.routeId)), Set(["route:openrouter:claude", "route:openrouter:qwen"]))
        XCTAssertEqual(Set(ModelCatalogPresenter.filteredRoutes(routes, query: "Claude", filter: .all).map(\.routeId)), Set(["route:anthropic:claude", "route:google:claude", "route:openrouter:claude"]))
    }

    func testFiltersAndPickerUseTheSameRouteVisibility() throws {
        let routes = try fixtureRoutes()
        XCTAssertEqual(ModelCatalogPresenter.filteredRoutes(routes, query: "", filter: .hidden).map(\.routeId), ["route:openrouter:claude"])
        XCTAssertEqual(ModelCatalogPresenter.filteredRoutes(routes, query: "", filter: .promo).map(\.routeId), ["route:openrouter:qwen"])
        XCTAssertEqual(ModelCatalogPresenter.pickerRoutes(routes).map(\.routeId), ModelCatalogPresenter.visibleRoutes(routes).map(\.routeId))
    }

    private func fixtureRoutes() throws -> [CatalogRouteEntry] {
        let json = #"""
        {"data":[
          {"routeId":"route:anthropic:claude","provider":{"id":"provider:anthropic","displayName":"Anthropic"},"product":{"id":"product:anthropic","displayName":"Claude Max","category":"subscription"},"model":{"id":"model:claude","displayName":"Claude Sonnet","family":"Claude"},"offer":{"kind":"INCLUDED"},"quota":[],"availability":"available","visibility":"visible"},
          {"routeId":"route:google:claude","provider":{"id":"provider:google","displayName":"Google AI Pro"},"product":{"id":"product:google","displayName":"AI Pro","category":"subscription"},"model":{"id":"model:claude","displayName":"Claude Sonnet","family":"Claude"},"offer":{"kind":"INCLUDED"},"quota":[],"availability":"available","visibility":"visible"},
          {"routeId":"route:openrouter:claude","provider":{"id":"provider:openrouter","displayName":"OpenRouter"},"product":{"id":"product:openrouter","displayName":"Prepaid API","category":"aggregator"},"model":{"id":"model:claude","displayName":"Claude Sonnet","family":"Claude"},"offer":{"kind":"PAYG"},"quota":[],"availability":"available","visibility":"hidden"},
          {"routeId":"route:openrouter:qwen","provider":{"id":"provider:openrouter","displayName":"OpenRouter"},"product":{"id":"product:openrouter","displayName":"Prepaid API","category":"aggregator"},"model":{"id":"model:qwen","displayName":"Qwen Flash","family":"Qwen"},"offer":{"kind":"PROMO"},"quota":[],"availability":"available","visibility":"visible"},
          {"routeId":"route:command","provider":{"id":"provider:command","displayName":"Command Code"},"product":{"id":"product:goat","displayName":"GOAT","category":"subscription"},"model":{"id":"model:command","displayName":"Command Code"},"offer":{"kind":"INCLUDED"},"quota":[],"availability":"available","visibility":"visible"}
        ]}
        """#
        return try JSONDecoder().decode(UsageListResponse<CatalogRouteEntry>.self, from: Data(json.utf8)).data
    }
}
