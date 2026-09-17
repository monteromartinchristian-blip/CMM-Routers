import XCTest
@testable import CMMUsageCore

final class UsageDecodingTests: XCTestCase {
    private let decoder = JSONDecoder()

    func testDecodesProviderPressureAndIndependentRouteConstraints() throws {
        let json = #"""
        {
          "data": [
            {
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
                "routes": [
                  {
                    "accessRouteId": "route:example",
                    "status": "critical",
                    "constraints": [
                      {
                        "bucketId": "bucket:5h",
                        "bindingId": "binding:5h",
                        "status": "healthy",
                        "enforcement": "hard",
                        "metric": { "kind": "percentage" },
                        "unit": "fraction",
                        "remainingFraction": 0.62,
                        "resetAt": "2026-09-13T15:00:00.000Z",
                        "source": "provider_official_api",
                        "confidence": "exact"
                      },
                      {
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
                    ],
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
                  }
                ]
              }
            }
          ]
        }
        """#

        let response = try decoder.decode(UsageListResponse<ProviderUsageView>.self, from: Data(json.utf8))

        XCTAssertEqual(response.data.first?.provider.displayName, "Example AI")
        XCTAssertEqual(response.data.first?.pressure.status, .critical)
        XCTAssertEqual(response.data.first?.pressure.routes.first?.constraints.count, 2)
        XCTAssertEqual(response.data.first?.pressure.routes.first?.primaryConstraint?.bucketId, "bucket:weekly")
        XCTAssertEqual(response.data.first?.pressure.routes.first?.primaryConstraint?.remainingFraction, 0.08)
        XCTAssertEqual(response.data.first?.pressure.routes.first?.primaryConstraint?.source, .providerOfficialAPI)
        XCTAssertEqual(response.data.first?.pressure.routes.first?.primaryConstraint?.confidence, .exact)
    }

    func testDecodesQuotaSnapshotWithoutInventingUnknownAbsoluteValues() throws {
        let json = #"""
        {
          "data": [
            {
              "bucket": {
                "id": "bucket:weekly",
                "accountId": "account:example",
                "productId": "product:example",
                "displayName": "Weekly",
                "metric": { "kind": "percentage" },
                "windowPolicy": { "kind": "provider_reported" },
                "unit": "fraction",
                "enforcement": "hard",
                "status": "critical",
                "metadata": {}
              },
              "bucketId": "bucket:weekly",
              "status": "critical",
              "reconciled": {
                "selected": {
                  "id": "snapshot:weekly",
                  "quotaBucketId": "bucket:weekly",
                  "observedAt": "2026-09-13T12:00:00.000Z",
                  "usedFraction": 0.92,
                  "remainingFraction": 0.08,
                  "resetAt": "2026-09-14T09:00:00.000Z",
                  "source": "provider_official_api",
                  "confidence": "exact",
                  "stalenessAfter": "2026-09-13T12:10:00.000Z"
                },
                "stale": false
              },
              "forecast": {
                "willExhaustBeforeReset": true,
                "predictedExhaustionAt": "2026-09-13T20:00:00.000Z",
                "confidence": "calculated"
              }
            }
          ]
        }
        """#

        let response = try decoder.decode(UsageListResponse<QuotaUsageView>.self, from: Data(json.utf8))
        let quota = try XCTUnwrap(response.data.first)

        XCTAssertNil(quota.bucket.limitValue)
        XCTAssertNil(quota.reconciled.selected?.remainingValue)
        XCTAssertEqual(quota.reconciled.selected?.remainingFraction, 0.08)
        XCTAssertEqual(quota.reconciled.selected?.resetAt, "2026-09-14T09:00:00.000Z")
        XCTAssertEqual(quota.reconciled.selected?.stalenessAfter, "2026-09-13T12:10:00.000Z")
        XCTAssertEqual(quota.forecast.predictedExhaustionAt, "2026-09-13T20:00:00.000Z")
    }

    func testDecodesSubscriptionLifecycleAndBilling() throws {
        let json = #"""
        {
          "data": [
            {
              "id": "subscription:example",
              "accountId": "account:example",
              "productId": "product:example",
              "status": "active",
              "startedAt": "2026-09-01T00:00:00.000Z",
              "billingAmount": 20,
              "billingCurrency": "USD",
              "metadata": {}
            }
          ]
        }
        """#

        let response = try decoder.decode(UsageListResponse<SubscriptionPeriod>.self, from: Data(json.utf8))

        XCTAssertEqual(response.data.first?.status, .active)
        XCTAssertEqual(response.data.first?.billingAmount, 20)
        XCTAssertEqual(response.data.first?.billingCurrency, "USD")
    }

    func testDecodesCatalogOffersNativeQuotasUnknownsAndSharedPool() throws {
        let offers = ["FREE", "PROMO", "INCLUDED", "TRIAL", "PAYG", "UNKNOWN"]
        let routes = offers.enumerated().map { index, offer in
            """
            {
              "routeId": "route:\(index)",
              "provider": { "id": "provider:demo", "displayName": "Demo" },
              "product": { "id": "product:demo", "displayName": "Demo Plan", "category": "subscription" },
              "model": { "id": "model:\(index)", "displayName": "Model \(index)" },
              "offer": { "kind": "\(offer)", "source": "provider_official_api", "confidence": "exact" },
              "quota": \(index == 0 ? """
                [
                  {
                    "bucketId": "bucket:credits",
                    "displayName": "Credits",
                    "metric": { "kind": "credits" },
                    "unit": "credits",
                    "scope": { "kind": "product", "productId": "product:demo" },
                    "status": "healthy",
                    "remaining": 35,
                    "constraining": true,
                    "source": "provider_official_api",
                    "confidence": "exact",
                    "stale": false,
                    "affectedRouteIds": ["route:0"]
                  },
                  {
                    "bucketId": "bucket:shared",
                    "displayName": "Shared pool",
                    "metric": { "kind": "currency", "currency": "USD" },
                    "unit": "USD",
                    "scope": { "kind": "shared_pool", "productId": "product:demo" },
                    "status": "healthy",
                    "remaining": 7.31,
                    "constraining": false,
                    "source": "provider_official_api",
                    "confidence": "exact",
                    "stale": false,
                    "affectedRouteIds": ["route:0", "route:1"]
                  },
                  {
                    "bucketId": "bucket:tokens",
                    "displayName": "Tokens",
                    "metric": { "kind": "tokens" },
                    "unit": "tokens",
                    "scope": { "kind": "route", "routeId": "route:0" },
                    "status": "healthy",
                    "remaining": 800000,
                    "limit": 2000000,
                    "constraining": false,
                    "stale": false,
                    "affectedRouteIds": ["route:0"]
                  },
                  {
                    "bucketId": "bucket:requests",
                    "displayName": "Requests",
                    "metric": { "kind": "requests" },
                    "unit": "requests",
                    "scope": { "kind": "route", "routeId": "route:0" },
                    "status": "healthy",
                    "remaining": 42,
                    "limit": 100,
                    "constraining": false,
                    "stale": false,
                    "affectedRouteIds": ["route:0"]
                  },
                  {
                    "bucketId": "bucket:native",
                    "displayName": "Provider units",
                    "metric": { "kind": "provider_defined", "providerKey": "window_units" },
                    "unit": "provider units",
                    "scope": { "kind": "product", "productId": "product:demo" },
                    "status": "unknown",
                    "constraining": false,
                    "stale": true,
                    "affectedRouteIds": ["route:0"]
                  }
                ]
              """ : "[]"),

              "visibility":{"visibleOn":["cmmchat_model_picker","admin_console"]}
            }
            """
        }.joined(separator: ",")
        let json = "{\"data\":[\(routes)]}"

        let response = try decoder.decode(UsageListResponse<CatalogRouteEntry>.self, from: Data(json.utf8))

        XCTAssertEqual(Set(response.data.map(\.offer.kind)), Set(AccessOfferKind.allCases))
        let first = try XCTUnwrap(response.data.first)
        XCTAssertEqual(Set(first.quota.map(\.metric.kind)), Set(["credits", "currency", "tokens", "requests", "provider_defined"]))
        let shared = try XCTUnwrap(first.quota.first { $0.scope.kind == .sharedPool })
        XCTAssertEqual(shared.affectedRouteIds, ["route:0", "route:1"])
        XCTAssertNil(shared.limit)
        XCTAssertNil(shared.resetAt)
        XCTAssertFalse(Mirror(reflecting: first).children.compactMap(\.label).contains("credentialRef"))
    }
}
