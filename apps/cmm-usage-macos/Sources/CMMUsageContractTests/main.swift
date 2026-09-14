import Foundation
import CMMUsageCore

enum ContractFailure: Error, CustomStringConvertible {
    case expected(String)

    var description: String {
        switch self {
        case .expected(let message): return message
        }
    }
}

func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    guard condition() else { throw ContractFailure.expected(message) }
}

func testProviderPressureDecoding() throws {
    let json = #"""
    {
      "data": [{
        "provider": {
          "id": "provider:example",
          "displayName": "Example AI",
          "kind": "first_party",
          "status": "enabled",
          "metadata": {},
          "createdAt": "2026-09-13T12:00:00.000Z",
          "updatedAt": "2026-09-13T12:00:00.000Z"
        },
        "pressure": {
          "providerId": "provider:example",
          "status": "critical",
          "routes": [{
            "accessRouteId": "route:example",
            "status": "critical",
            "constraints": [{
              "bucketId": "bucket:weekly",
              "bindingId": "binding:weekly",
              "status": "critical",
              "enforcement": "hard",
              "metric": { "kind": "percentage" },
              "unit": "fraction",
              "remainingFraction": 0.08,
              "resetAt": "2026-09-14T09:00:00.000Z",
              "source": "provider_official_api",
              "confidence": "exact"
            }],
            "primaryConstraint": {
              "bucketId": "bucket:weekly",
              "bindingId": "binding:weekly",
              "status": "critical",
              "enforcement": "hard",
              "metric": { "kind": "percentage" },
              "unit": "fraction",
              "remainingFraction": 0.08,
              "resetAt": "2026-09-14T09:00:00.000Z",
              "source": "provider_official_api",
              "confidence": "exact"
            }
          }]
        }
      }]
    }
    """#
    let response = try JSONDecoder().decode(UsageListResponse<ProviderUsageView>.self, from: Data(json.utf8))
    try expect(response.data.first?.provider.displayName == "Example AI", "provider name should decode")
    try expect(response.data.first?.pressure.status == .critical, "provider pressure should decode")
    try expect(response.data.first?.pressure.routes.first?.primaryConstraint?.remainingFraction == 0.08, "primary quota should remain independent")
}

func testCatalogDecodingContract() throws {
    let offerKinds = ["FREE", "PROMO", "INCLUDED", "TRIAL", "PAYG", "UNKNOWN"]
    let routes = offerKinds.enumerated().map { index, offer in
        """
        {
          "routeId":"route:\(index)",
          "provider":{"id":"provider:demo","displayName":"Demo"},
          "product":{"id":"product:demo","displayName":"Demo","category":"api"},
          "model":{"id":"model:\(index)","displayName":"Model \(index)"},
          "offer":{"kind":"\(offer)"},
          "quota":\(index == 0 ? """
          [
            {
              "bucketId":"bucket:shared",
              "displayName":"Shared pool",
              "metric":{"kind":"currency","currency":"USD"},
              "unit":"USD",
              "scope":{"kind":"shared_pool","productId":"product:demo"},
              "status":"healthy",
              "remaining":7.31,
              "constraining":false,
              "stale":false,
              "affectedRouteIds":["route:0","route:1"]
            },
            {
              "bucketId":"bucket:native",
              "displayName":"Provider units",
              "metric":{"kind":"provider_defined","providerKey":"window_units"},
              "unit":"provider units",
              "scope":{"kind":"product","productId":"product:demo"},
              "status":"unknown",
              "constraining":false,
              "stale":true,
              "affectedRouteIds":["route:0"]
            }
          ]
          """ : "[]"),
          "availability":"available",
          "visibility":"visible"
        }
        """
    }.joined(separator: ",")
    let response = try JSONDecoder().decode(
        UsageListResponse<CatalogRouteEntry>.self,
        from: Data("{\"data\":[\(routes)]}".utf8)
    )

    try expect(Set(response.data.map(\.offer.kind)) == Set(AccessOfferKind.allCases), "all six offer kinds must decode")
    guard let shared = response.data.first?.quota.first(where: { $0.scope.kind == .sharedPool }) else {
        throw ContractFailure.expected("shared pool must decode")
    }
    try expect(shared.affectedRouteIds == ["route:0", "route:1"], "shared pool must retain affected route ids")
    try expect(shared.limit == nil && shared.resetAt == nil, "unknown quota limit/reset must stay optional")
    try expect(response.data.first?.quota.last?.metric.kind == "provider_defined", "provider-native metrics must stay distinct")
}

func testDemoCredentialModuleUsesOnlyPublicFixtureCredentials() throws {
    let stores = CMMUsageModule.credentialStores(environment: [CMMUsageModule.demoFixtureEnvironmentKey: "1"])
    let readToken = try stores.read.readToken()
    let managementToken = try stores.management.readToken()
    try expect(readToken == CMMUsageModule.demoReadToken, "demo read credential must be public fixture data")
    try expect(managementToken == CMMUsageModule.demoManagementToken, "demo management credential must be separate public fixture data")
}

func testProviderPresentationContract() throws {
    try expect(
        UsageNavigationDestination.allCases.map(\.title) == ["Overview", "Quotas", "Models", "Providers", "Free & Promo", "History", "Costs", "Alerts", "Settings"],
        "primary navigation must use the frozen product destinations"
    )
    try expect(ProviderDirectoryState.connected.displayName == "Connected", "connected provider state must have a friendly label")
    try expect(ProviderDirectoryState.reauthRequired.displayName == "Reconnect", "reauth provider state must avoid raw enum vocabulary")
    try expect(ProviderCatalogPresenter.safeCredentialHint("sk-secret-value") == "Stored securely", "raw API keys must never become display hints")
    try expect(ProviderCatalogPresenter.safeCredentialHint("••••a4f1") == "••••a4f1", "safe masked hints should remain useful")
    try expect(ProviderCatalogPresenter.emptyStateDetail(for: .customEndpoints).contains("endpoint"), "empty provider states must remain actionable")

    let json = #"""
    {"data":[
      {"directory":{"integrationType":"command-code","displayName":"Command Code","category":"subscription","connectionMethods":["account"],"state":"degraded","connectedInstanceCount":1,"capabilities":{"modelDiscovery":true,"quotaDiscovery":true,"balanceDiscovery":true,"costDiscovery":false,"pricingDiscovery":false}},"instanceIds":["cc"]},
      {"directory":{"integrationType":"chatgpt-subscription","displayName":"ChatGPT / Codex","category":"subscription","connectionMethods":["account"],"state":"connected","connectedInstanceCount":1,"capabilities":{"modelDiscovery":true,"quotaDiscovery":true,"balanceDiscovery":false,"costDiscovery":false,"pricingDiscovery":false}},"instanceIds":["chatgpt"]},
      {"directory":{"integrationType":"claude-subscription","displayName":"Claude","category":"subscription","connectionMethods":["account"],"state":"available","connectedInstanceCount":0,"capabilities":{"modelDiscovery":true,"quotaDiscovery":true,"balanceDiscovery":false,"costDiscovery":false,"pricingDiscovery":false}},"instanceIds":[]}
    ]}
    """#
    let providers = try JSONDecoder().decode(UsageListResponse<CatalogProviderView>.self, from: Data(json.utf8)).data
    let groups = ProviderCatalogPresenter.groups(for: .accounts, providers: providers)
    try expect(groups.connected.map(\.directory.integrationType) == ["chatgpt-subscription", "command-code"], "connected and degraded account providers must remain grouped as connected")
    try expect(groups.available.map(\.directory.integrationType) == ["claude-subscription"], "supported disconnected providers must remain visible")

    let connectedRouteProvider = try JSONDecoder().decode(
        CatalogRouteProvider.self,
        from: Data(#"{"id":"provider:demo:chatgpt","displayName":"ChatGPT / Codex"}"#.utf8)
    )
    let disconnectedRouteProvider = try JSONDecoder().decode(
        CatalogRouteProvider.self,
        from: Data(#"{"id":"provider:demo:kira","displayName":"Kira AI"}"#.utf8)
    )
    try expect(ProviderCatalogPresenter.isConnected(connectedRouteProvider, among: providers), "promotion routes should recognize a connected provider")
    try expect(!ProviderCatalogPresenter.isConnected(disconnectedRouteProvider, among: providers), "promotion routes without a connected provider must remain connectable opportunities")
}

func testModelCatalogPresentationContract() throws {
    let json = #"""
    {"data":[
      {"routeId":"anthropic-claude","provider":{"id":"anthropic","displayName":"Anthropic"},"product":{"id":"anthropic-pro","displayName":"Claude Max","category":"subscription"},"model":{"id":"claude","displayName":"Claude Sonnet"},"offer":{"kind":"INCLUDED"},"quota":[],"availability":"available","visibility":"visible"},
      {"routeId":"google-claude","provider":{"id":"google","displayName":"Google AI Pro"},"product":{"id":"google-pro","displayName":"AI Pro","category":"subscription"},"model":{"id":"claude","displayName":"Claude Sonnet"},"offer":{"kind":"INCLUDED"},"quota":[],"availability":"available","visibility":"visible"},
      {"routeId":"openrouter-claude","provider":{"id":"openrouter","displayName":"OpenRouter"},"product":{"id":"router","displayName":"Prepaid API","category":"aggregator"},"model":{"id":"claude","displayName":"Claude Sonnet"},"offer":{"kind":"PAYG"},"quota":[],"availability":"available","visibility":"hidden"},
      {"routeId":"openrouter-qwen","provider":{"id":"openrouter","displayName":"OpenRouter"},"product":{"id":"router","displayName":"Prepaid API","category":"aggregator"},"model":{"id":"qwen","displayName":"Qwen Flash"},"offer":{"kind":"PROMO"},"quota":[],"availability":"available","visibility":"visible"}
    ]}
    """#
    let routes = try JSONDecoder().decode(UsageListResponse<CatalogRouteEntry>.self, from: Data(json.utf8)).data
    try expect(ModelCatalogPresenter.visibleRoutes(routes).map(\.routeId) == ["anthropic-claude", "google-claude", "openrouter-qwen"], "route visibility must stay provider-route scoped")
    let openRouter = ModelCatalogPresenter.groups(routes).first { $0.provider.id == "openrouter" }
    try expect(openRouter?.selectionState == .mixed, "provider groups must expose mixed visibility")
    try expect(ModelCatalogPresenter.filteredRoutes(routes, query: "Qwen", filter: .all).map(\.routeId) == ["openrouter-qwen"], "search must match friendly model names")
    try expect(ModelCatalogPresenter.pickerRoutes(routes).map(\.routeId) == ModelCatalogPresenter.visibleRoutes(routes).map(\.routeId), "picker and editor must share the same visible catalog")
}

func testQuotaPresentationContract() throws {
    let json = #"""
    {"data":[
      {"bucketId":"percentage","displayName":"Weekly utilization","metric":{"kind":"percentage"},"unit":"fraction","windowPolicy":{"kind":"provider_reported"},"scope":{"kind":"product","productId":"p"},"status":"healthy","usedFraction":0.61,"remainingFraction":0.39,"constraining":false},
      {"bucketId":"credits","displayName":"Monthly credits","metric":{"kind":"credits"},"unit":"credits","windowPolicy":{"kind":"billing_cycle","anchorDate":"2026-09-07","timezone":"UTC"},"scope":{"kind":"product","productId":"p"},"status":"healthy","remaining":35,"constraining":true,"affectedRouteIds":["r"]},
      {"bucketId":"tokens","displayName":"Token pool","metric":{"kind":"tokens"},"unit":"tokens","windowPolicy":{"kind":"fixed_calendar","calendarUnit":"day","timezone":"UTC"},"scope":{"kind":"shared_pool","productId":"p"},"status":"warning","remaining":800000,"limit":2000000,"constraining":false,"affectedRouteIds":["r1","r2"]},
      {"bucketId":"requests","displayName":"Daily requests","metric":{"kind":"requests"},"unit":"requests","windowPolicy":{"kind":"fixed_calendar","calendarUnit":"day","timezone":"UTC"},"scope":{"kind":"route","routeId":"r"},"status":"healthy","remaining":42,"limit":100,"constraining":false,"affectedRouteIds":["r"]},
      {"bucketId":"currency","displayName":"Prepaid balance","metric":{"kind":"currency","currency":"USD"},"unit":"USD","windowPolicy":{"kind":"none"},"scope":{"kind":"shared_pool","productId":"p"},"status":"healthy","remaining":7.31,"constraining":false,"affectedRouteIds":["r1","r2"]},
      {"bucketId":"native","displayName":"5-hour window","metric":{"kind":"provider_defined","providerKey":"window_units"},"unit":"provider units","windowPolicy":{"kind":"rolling_duration","durationSeconds":18000},"scope":{"kind":"product","productId":"p"},"status":"healthy","remaining":14,"limit":14,"constraining":true,"affectedRouteIds":["r"]},
      {"bucketId":"supplemental","displayName":"Free credits","metric":{"kind":"credits"},"unit":"credits","windowPolicy":{"kind":"none"},"scope":{"kind":"product","productId":"p"},"status":"unknown","remaining":0,"constraining":false}
    ]}
    """#
    let quotas = try JSONDecoder().decode(UsageListResponse<CatalogQuotaSummary>.self, from: Data(json.utf8)).data
    try expect(quotas[0].primaryValueText == "61% used", "percentage-only quota must preserve provider percentage semantics")
    try expect(quotas[1].primaryValueText == "35 credits remaining", "credits must remain credits")
    try expect(quotas[2].primaryValueText == "800K tokens remaining", "token quotas need compact native units")
    try expect(quotas[3].primaryValueText == "42 / 100 requests remaining", "request quotas need native numerator/denominator")
    try expect(quotas[4].primaryValueText == "$7.31 balance remaining", "currency balance must remain currency")
    try expect(quotas[5].primaryValueText == "14 / 14 provider units remaining", "provider-defined units must remain provider units")
    try expect(abs((quotas[0].progressFraction ?? -1) - 0.61) < 0.0001, "provider-reported percentage may use its own native denominator")
    try expect(quotas[1].progressFraction == nil, "absolute balance without a ceiling must not invent a percentage bar")
    try expect(abs((quotas[2].progressFraction ?? -1) - 0.6) < 0.0001, "known token denominator should support real progress")
    try expect(quotas[5].resetText == "Unknown reset", "rolling quota without provider reset instant must remain unknown")
    try expect(quotas[6].resetText == "No reset", "non-resetting supplemental balance must say No reset")
    try expect(quotas[6].isSupplementalBalance, "unbound non-resetting balance must be visually subordinate")
    try expect(quotas.sortedForPresentation.first?.constraining == true && quotas.sortedForPresentation.last?.bucketId == "supplemental", "constraining quotas must lead and supplemental balances must trail")
}

final class MemoryCredentialStore: UsageCredentialStore {
    var token: String?

    init(token: String?) {
        self.token = token
    }

    func readToken() throws -> String? { token }
    func saveToken(_ token: String) throws { self.token = token }
    func deleteToken() throws { token = nil }
}

final class StubURLProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: ContractFailure.expected("missing URL handler"))
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

func testReadOnlyAPIClient() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubURLProtocol.self]
    let session = URLSession(configuration: configuration)
    let credentials = MemoryCredentialStore(token: "read-only-token")
    let client = CMMUsageAPIClient(
        baseURL: URL(string: "http://127.0.0.1:8790")!,
        credentialStore: credentials,
        session: session
    )

    StubURLProtocol.handler = { request in
        try expect(request.url?.path == "/v1/cmm/usage/providers", "client must stay on the Usage API")
        try expect(request.httpMethod == "GET", "provider fetch must be read-only")
        try expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer read-only-token", "client must use the scoped Usage credential")
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        let data = Data(#"{"data":[]}"#.utf8)
        return (response, data)
    }

    let providers = try await client.fetchProviders()
    try expect(providers.isEmpty, "provider response should decode")

    StubURLProtocol.handler = { request in
        try expect(request.url?.path == "/v1/cmm/usage/refresh-all", "refresh must use the Usage refresh endpoint")
        try expect(request.httpMethod == "POST", "refresh-all must be POST")
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        return (response, Data("[]".utf8))
    }
    _ = try await client.refreshAll()
}

func testCatalogReadsAndManagementMutationsUseSeparateCredentials() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubURLProtocol.self]
    let session = URLSession(configuration: configuration)
    let readCredentials = MemoryCredentialStore(token: "read-token")
    let managementCredentials = MemoryCredentialStore(token: "management-token")
    let client = CMMUsageAPIClient(
        baseURL: URL(string: "http://127.0.0.1:8790")!,
        credentialStore: readCredentials,
        managementCredentialStore: managementCredentials,
        session: session
    )

    StubURLProtocol.handler = { request in
        try expect(request.url?.path == "/v1/cmm/usage/catalog/providers", "catalog provider reads must use the safe catalog endpoint")
        try expect(request.httpMethod == "GET", "catalog provider fetch must be GET")
        try expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer read-token", "catalog reads must use the read credential")
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        return (response, Data(#"{"data":[]}"#.utf8))
    }
    _ = try await client.fetchCatalogProviders()

    StubURLProtocol.handler = { request in
        try expect(request.url?.path == "/v1/cmm/usage/catalog/quotas", "catalog quota reads must use the safe quota projection endpoint")
        try expect(request.httpMethod == "GET", "catalog quota fetch must be GET")
        try expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer read-token", "catalog quota reads must use the read credential")
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        let body = #"{"data":[{"bucketId":"bucket:demo","displayName":"5-hour window","metric":{"kind":"provider_defined","providerKey":"window_units"},"unit":"provider units","windowPolicy":{"kind":"rolling_duration","durationSeconds":18000},"scope":{"kind":"product","productId":"product:demo"},"status":"healthy","remaining":14,"limit":14,"constraining":true,"affectedRouteIds":["route:demo"]}]}"#
        return (response, Data(body.utf8))
    }
    let quota = try await client.fetchCatalogQuotas().first
    try expect(quota?.windowPolicy?.kind == "rolling_duration", "catalog quota window policy must decode without inference")

    StubURLProtocol.handler = { request in
        try expect(request.url?.path == "/v1/cmm/usage/catalog/visibility", "visibility mutation must use its privileged endpoint")
        try expect(request.httpMethod == "PATCH", "visibility mutation must be PATCH")
        try expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer management-token", "mutations must use the management credential")
        try expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json", "visibility mutation body must be JSON")
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        return (response, Data(#"{"routeId":"route:demo","state":"hidden"}"#.utf8))
    }
    let visibility = try await client.setRouteVisibility(routeId: "route:demo", state: .hidden)
    try expect(visibility.state == .hidden, "visibility mutation response should decode")
}

func testDashboardFetchAndSafePresentation() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubURLProtocol.self]
    let session = URLSession(configuration: configuration)
    let client = CMMUsageAPIClient(
        baseURL: URL(string: "http://127.0.0.1:8790")!,
        credentialStore: MemoryCredentialStore(token: "usage-token"),
        session: session
    )

    StubURLProtocol.handler = { request in
        let path = request.url!.path
        let body: String
        switch path {
        case "/v1/cmm/usage":
            body = #"{"generatedAt":"2026-09-13T12:00:00.000Z","providerCount":1,"productCount":1,"modelCount":1,"routeCount":1,"quotaCount":2,"warningCount":0,"criticalCount":1,"exhaustedCount":0}"#
        case "/v1/cmm/usage/providers":
            body = #"{"data":[{"provider":{"id":"provider:example","displayName":"Example AI","kind":"first_party","status":"enabled","metadata":{},"createdAt":"2026-09-13T12:00:00.000Z","updatedAt":"2026-09-13T12:00:00.000Z"},"pressure":{"providerId":"provider:example","status":"critical","routes":[]}}]}"#
        case "/v1/cmm/usage/products":
            body = #"{"data":[{"id":"product:example","providerId":"provider:example","displayName":"Example Pro","kind":"subscription","metadata":{}}]}"#
        case "/v1/cmm/usage/models":
            body = #"{"data":[{"model":{"id":"model:example","canonicalName":"Example Model","vendor":"Example","lifecycle":"active","aliases":[],"metadata":{}},"constraints":{"modelIdentityId":"model:example","routes":[]}}]}"#
        case "/v1/cmm/usage/routes":
            body = #"{"data":[{"route":{"id":"route:example","accountId":"account:example","productId":"product:example","modelIdentityId":"model:example","providerModelId":"example-model","displayName":"Example Model","status":"available","metadata":{}},"health":{"accessRouteId":"route:example","status":"critical","constraints":[]}}]}"#
        case "/v1/cmm/usage/quotas":
            body = #"{"data":[{"bucket":{"id":"bucket:weekly","accountId":"account:example","productId":"product:example","displayName":"Weekly","metric":{"kind":"percentage"},"windowPolicy":{"kind":"provider_reported"},"unit":"fraction","enforcement":"hard","status":"critical","metadata":{}},"bucketId":"bucket:weekly","status":"critical","reconciled":{"selected":{"id":"snapshot:weekly","quotaBucketId":"bucket:weekly","observedAt":"2026-09-13T12:00:00.000Z","remainingFraction":0.08,"resetAt":"2026-09-14T09:00:00.000Z","source":"provider_official_api","confidence":"exact","stalenessAfter":"2026-09-13T12:10:00.000Z"},"stale":false},"forecast":{"predictedExhaustionAt":"2026-09-13T20:00:00.000Z","willExhaustBeforeReset":true,"confidence":"calculated"}},{"bucket":{"id":"bucket:unknown","accountId":"account:example","productId":"product:example","displayName":"Monthly global","metric":{"kind":"provider_defined","providerKey":"monthly"},"windowPolicy":{"kind":"provider_reported"},"unit":"units","enforcement":"hard","status":"unknown","metadata":{}},"bucketId":"bucket:unknown","status":"unknown","reconciled":{"stale":true},"forecast":{"willExhaustBeforeReset":false,"confidence":"unknown"}}]}"#
        case "/v1/cmm/usage/history":
            body = #"{"data":[{"id":"usage:1","occurredAt":"2026-09-13T11:59:00.000Z","providerId":"provider:example","accountId":"account:example","productId":"product:example","accessRouteId":"route:example","requests":1,"source":"router_measured","confidence":"measured","metadata":{}}]}"#
        case "/v1/cmm/usage/costs":
            body = #"{"data":[{"id":"cost:1","occurredAt":"2026-09-13T11:59:00.000Z","providerId":"provider:example","accountId":"account:example","productId":"product:example","amount":0.01,"currency":"USD","kind":"usage","source":"provider_official_api","confidence":"exact","metadata":{}}]}"#
        case "/v1/cmm/usage/subscriptions":
            body = #"{"data":[{"id":"subscription:1","accountId":"account:example","productId":"product:example","status":"active","startedAt":"2026-09-01T00:00:00.000Z","billingAmount":20,"billingCurrency":"USD","metadata":{}}]}"#
        case "/v1/cmm/usage/alerts":
            body = #"{"data":[{"bucketId":"bucket:weekly","status":"critical","kind":"predicted_exhaustion"}]}"#
        default:
            throw ContractFailure.expected("unexpected dashboard path: \(path)")
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        return (response, Data(body.utf8))
    }

    let dashboard = try await client.fetchDashboard()
    try expect(dashboard.overallStatus == .critical, "dashboard should surface the worst real status")
    try expect(dashboard.providers.count == 1 && dashboard.products.count == 1, "dashboard should load provider/product data")
    try expect(dashboard.models.count == 1 && dashboard.routes.count == 1, "dashboard should load model/route data")
    try expect(dashboard.quotas.count == 2 && dashboard.subscriptions.count == 1, "dashboard should load quotas and subscriptions")
    try expect(dashboard.quotas[0].remainingSummary == "8% remaining", "known provider percentage should render directly")
    try expect(dashboard.quotas[1].remainingSummary == "Unknown", "unknown quota must not render as zero")
    try expect(dashboard.quotas[0].forecastSummary.contains("Predicted exhaustion"), "forecast should remain visible")
}

func testClientRejectsNonLoopbackBaseURL() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubURLProtocol.self]
    StubURLProtocol.handler = { _ in
        throw ContractFailure.expected("non-loopback client must fail before networking")
    }
    let client = CMMUsageAPIClient(
        baseURL: URL(string: "https://example.com")!,
        credentialStore: MemoryCredentialStore(token: "usage-token"),
        session: URLSession(configuration: configuration)
    )

    do {
        _ = try await client.fetchProviders()
        throw ContractFailure.expected("non-loopback base URL should be rejected")
    } catch CMMUsageAPIError.loopbackRequired {
        // Expected: the native client is physically unable to leave loopback.
    }
}

func testUnknownRollingResetPresentation() throws {
    let json = #"{"data":[{"bucket":{"id":"bucket:5h","accountId":"account:example","productId":"product:example","displayName":"5-hour window","metric":{"kind":"provider_defined","providerKey":"window"},"windowPolicy":{"kind":"rolling_duration","durationSeconds":18000},"unit":"provider_units","enforcement":"hard","status":"healthy"},"bucketId":"bucket:5h","status":"healthy","reconciled":{"selected":{"id":"snapshot:5h","quotaBucketId":"bucket:5h","observedAt":"2026-09-14T06:00:00.000Z","usedValue":0,"remainingValue":14,"limitValue":14,"source":"provider_official_cli","confidence":"exact","stalenessAfter":"2026-09-14T06:01:00.000Z"},"stale":false},"forecast":{"willExhaustBeforeReset":false,"confidence":"unknown"}}]}"#
    let response = try JSONDecoder().decode(UsageListResponse<QuotaUsageView>.self, from: Data(json.utf8))
    guard let quota = response.data.first else { throw ContractFailure.expected("rolling quota should decode") }
    try expect(quota.resetSummary == "Unknown", "rolling quota without a provider reset instant must remain Unknown")
}

func testNoResetPresentation() throws {
    let json = #"{"data":[{"bucket":{"id":"bucket:lifetime","accountId":"account:example","productId":"product:example","displayName":"Lifetime cap","metric":{"kind":"currency","currency":"USD"},"windowPolicy":{"kind":"none"},"unit":"USD","enforcement":"hard","status":"healthy"},"bucketId":"bucket:lifetime","status":"healthy","reconciled":{"selected":{"id":"snapshot:lifetime","quotaBucketId":"bucket:lifetime","observedAt":"2026-09-14T06:00:00.000Z","usedValue":25,"remainingValue":75,"limitValue":100,"source":"provider_official_api","confidence":"exact","stalenessAfter":"2026-09-14T06:01:00.000Z"},"stale":false},"forecast":{"willExhaustBeforeReset":false,"confidence":"unknown"}}]}"#
    let response = try JSONDecoder().decode(UsageListResponse<QuotaUsageView>.self, from: Data(json.utf8))
    guard let quota = response.data.first else { throw ContractFailure.expected("no-reset quota should decode") }
    try expect(quota.resetSummary == "No reset", "a provider-declared non-resetting quota must render as No reset")
}

do {
    try testProviderPressureDecoding()
    try testCatalogDecodingContract()
    try testDemoCredentialModuleUsesOnlyPublicFixtureCredentials()
    try testProviderPresentationContract()
    try testModelCatalogPresentationContract()
    try testQuotaPresentationContract()
    try await testReadOnlyAPIClient()
    try await testCatalogReadsAndManagementMutationsUseSeparateCredentials()
    try await testDashboardFetchAndSafePresentation()
    try await testClientRejectsNonLoopbackBaseURL()
    try testUnknownRollingResetPresentation()
    try testNoResetPresentation()
    print("CMMUsageContractTests: PASS")
} catch {
    fputs("CMMUsageContractTests: FAIL: \(error)\n", stderr)
    exit(1)
}
