import XCTest
@testable import CMMUsageCore

final class ProviderPresentationTests: XCTestCase {
    private let decoder = JSONDecoder()

    func testPrimaryNavigationUsesFrozenProductDestinations() {
        XCTAssertEqual(
            UsageNavigationDestination.allCases.map(\.title),
            ["Overview", "Quotas", "Models", "Providers", "Free & Promo", "History", "Costs", "Alerts", "Settings"]
        )
    }

    func testProviderGroupsKeepConnectedDegradedAndAvailableStatesIndependent() throws {
        let providers = try decodeProviders()
        let groups = ProviderCatalogPresenter.groups(for: .accounts, providers: providers)

        XCTAssertEqual(groups.connected.map(\.directory.integrationType), ["chatgpt-subscription", "command-code"])
        XCTAssertEqual(groups.available.map(\.directory.integrationType), ["claude-subscription"])
        XCTAssertEqual(groups.connected.first(where: { $0.directory.integrationType == "command-code" })?.directory.state, .degraded)
        XCTAssertEqual(groups.connected.first(where: { $0.directory.integrationType == "chatgpt-subscription" })?.directory.state, .connected)
    }

    func testAPIKeyGroupingAndSafeHintNeverExposeRawSecret() throws {
        let providers = try decodeProviders()
        let groups = ProviderCatalogPresenter.groups(for: .apiKeys, providers: providers)
        XCTAssertEqual(groups.connected.map(\.directory.integrationType), ["openrouter"])

        XCTAssertEqual(ProviderCatalogPresenter.safeCredentialHint("••••a4f1"), "••••a4f1")
        XCTAssertEqual(ProviderCatalogPresenter.safeCredentialHint("sk-secret-value"), "Stored securely")
        XCTAssertEqual(ProviderCatalogPresenter.safeCredentialHint(nil), "Add key")
    }

    func testEmptyStateIsActionable() {
        XCTAssertTrue(ProviderCatalogPresenter.emptyStateDetail(for: .accounts).contains("Connect"))
        XCTAssertTrue(ProviderCatalogPresenter.emptyStateDetail(for: .apiKeys).contains("API key"))
        XCTAssertTrue(ProviderCatalogPresenter.emptyStateDetail(for: .customEndpoints).contains("endpoint"))
    }

    private func decodeProviders() throws -> [CatalogProviderView] {
        let json = #"""
        {"data":[
          {"directory":{"integrationType":"command-code","displayName":"Command Code","shortDescription":"Subscription usage","category":"subscription","connectionMethods":["local_session","account"],"state":"degraded","connectedInstanceCount":1,"capabilities":{"modelDiscovery":true,"quotaDiscovery":true,"balanceDiscovery":true,"costDiscovery":false,"pricingDiscovery":false}},"instanceIds":["command-code-demo"]},
          {"directory":{"integrationType":"chatgpt-subscription","displayName":"ChatGPT / Codex","shortDescription":"Subscription usage","category":"subscription","connectionMethods":["local_session","account"],"state":"connected","connectedInstanceCount":1,"capabilities":{"modelDiscovery":true,"quotaDiscovery":true,"balanceDiscovery":false,"costDiscovery":false,"pricingDiscovery":false}},"instanceIds":["chatgpt-demo"]},
          {"directory":{"integrationType":"claude-subscription","displayName":"Claude","shortDescription":"Subscription usage","category":"subscription","connectionMethods":["local_session","account"],"state":"available","connectedInstanceCount":0,"capabilities":{"modelDiscovery":true,"quotaDiscovery":true,"balanceDiscovery":false,"costDiscovery":false,"pricingDiscovery":false}},"instanceIds":[]},
          {"directory":{"integrationType":"openrouter","displayName":"OpenRouter","shortDescription":"API credits","category":"aggregator","connectionMethods":["api_key"],"state":"connected","connectedInstanceCount":1,"capabilities":{"modelDiscovery":true,"quotaDiscovery":true,"balanceDiscovery":true,"costDiscovery":false,"pricingDiscovery":false}},"instanceIds":["openrouter-demo"]},
          {"directory":{"integrationType":"deepseek","displayName":"DeepSeek","shortDescription":"API balance","category":"api","connectionMethods":["api_key"],"state":"available","connectedInstanceCount":0,"capabilities":{"modelDiscovery":true,"quotaDiscovery":true,"balanceDiscovery":true,"costDiscovery":false,"pricingDiscovery":false}},"instanceIds":[]}
        ]}
        """#
        return try decoder.decode(UsageListResponse<CatalogProviderView>.self, from: Data(json.utf8)).data
    }
}
