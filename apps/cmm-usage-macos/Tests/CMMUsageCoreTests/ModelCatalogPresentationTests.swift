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

    func testQuotaHierarchyPrefersModelSpecificLimitForCollapsedRouteSummary() throws {
        let routeJSON = #"""
        {"routeId":"route:kira:qwen-38","provider":{"id":"kira","displayName":"Kira AI"},"product":{"id":"kira-free","displayName":"Community access","category":"api"},"model":{"id":"qwen-38","displayName":"Qwen 3.8 Flash Free","family":"Qwen 3.8"},"offer":{"kind":"FREE"},"quota":[{"bucketId":"general","displayName":"General free allowance","metric":{"kind":"tokens"},"unit":"tokens","windowPolicy":{"kind":"fixed_calendar","calendarUnit":"day","timezone":"UTC"},"scope":{"kind":"shared_pool","productId":"kira-free"},"status":"healthy","remaining":68000000,"limit":80000000,"constraining":true,"affectedRouteIds":["route:kira:qwen-37","route:kira:qwen-38"]},{"bucketId":"model","displayName":"Qwen 3.8 Flash daily allowance","metric":{"kind":"tokens"},"unit":"tokens","windowPolicy":{"kind":"fixed_calendar","calendarUnit":"day","timezone":"UTC"},"scope":{"kind":"route","routeId":"route:kira:qwen-38"},"status":"healthy","remaining":24000000,"limit":30000000,"constraining":false,"affectedRouteIds":["route:kira:qwen-38"]}],"visibility":{"visibleOn":["cmmchat_model_picker","admin_console"]}}
        """#
        let route = try JSONDecoder().decode(CatalogRouteEntry.self, from: Data(routeJSON.utf8))
        let hierarchy = ModelCatalogPresenter.quotaHierarchy(for: route, allQuotas: route.quota)

        XCTAssertEqual(hierarchy.headlineQuota?.bucketId, "model")
    }

    private func fixtureRoutes() throws -> [CatalogRouteEntry] {
        let json = #"""
        {"data":[
          {"routeId":"route:anthropic:claude","provider":{"id":"provider:anthropic","displayName":"Anthropic"},"product":{"id":"product:anthropic","displayName":"Claude Max","category":"subscription"},"model":{"id":"model:claude","displayName":"Claude Sonnet","family":"Claude"},"offer":{"kind":"INCLUDED"},"quota":[],"visibility":{"visibleOn":["cmmchat_model_picker","admin_console"]}},
          {"routeId":"route:google:claude","provider":{"id":"provider:google","displayName":"Google AI Pro"},"product":{"id":"product:google","displayName":"AI Pro","category":"subscription"},"model":{"id":"model:claude","displayName":"Claude Sonnet","family":"Claude"},"offer":{"kind":"INCLUDED"},"quota":[],"visibility":{"visibleOn":["cmmchat_model_picker","admin_console"]}},
          {"routeId":"route:openrouter:claude","provider":{"id":"provider:openrouter","displayName":"OpenRouter"},"product":{"id":"product:openrouter","displayName":"Prepaid API","category":"aggregator"},"model":{"id":"model:claude","displayName":"Claude Sonnet","family":"Claude"},"offer":{"kind":"PAYG"},"quota":[],"visibility":{"visibleOn":["admin_console"]}},
          {"routeId":"route:openrouter:qwen","provider":{"id":"provider:openrouter","displayName":"OpenRouter"},"product":{"id":"product:openrouter","displayName":"Prepaid API","category":"aggregator"},"model":{"id":"model:qwen","displayName":"Qwen Flash","family":"Qwen"},"offer":{"kind":"PROMO"},"quota":[],"visibility":{"visibleOn":["cmmchat_model_picker","admin_console"]}},
          {"routeId":"route:command","provider":{"id":"provider:command","displayName":"Command Code"},"product":{"id":"product:goat","displayName":"GOAT","category":"subscription"},"model":{"id":"model:command","displayName":"Command Code"},"offer":{"kind":"INCLUDED"},"quota":[],"visibility":{"visibleOn":["cmmchat_model_picker","admin_console"]}}
        ]}
        """#
        return try JSONDecoder().decode(UsageListResponse<CatalogRouteEntry>.self, from: Data(json.utf8)).data
    }
}
