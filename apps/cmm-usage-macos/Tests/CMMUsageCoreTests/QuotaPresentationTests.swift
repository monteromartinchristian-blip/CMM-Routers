import XCTest
@testable import CMMUsageCore

final class QuotaPresentationTests: XCTestCase {
    private let decoder = JSONDecoder()

    func testFormatsProviderNativeQuotaMetricsWithoutUniversalPercentage() throws {
        let quotas = try decodeQuotas(#"""
        [
          {"bucketId":"percentage","displayName":"Weekly utilization","metric":{"kind":"percentage"},"unit":"fraction","windowPolicy":{"kind":"provider_reported"},"scope":{"kind":"product","productId":"p"},"status":"healthy","usedFraction":0.61,"remainingFraction":0.39,"constraining":false},
          {"bucketId":"credits","displayName":"Monthly credits","metric":{"kind":"credits"},"unit":"credits","windowPolicy":{"kind":"billing_cycle","anchorDate":"2026-09-07","timezone":"UTC"},"scope":{"kind":"product","productId":"p"},"status":"healthy","remaining":35,"constraining":true,"affectedRouteIds":["r"]},
          {"bucketId":"tokens","displayName":"Token pool","metric":{"kind":"tokens"},"unit":"tokens","windowPolicy":{"kind":"fixed_calendar","calendarUnit":"day","timezone":"UTC"},"scope":{"kind":"shared_pool","productId":"p"},"status":"healthy","remaining":800000,"limit":2000000,"constraining":false,"affectedRouteIds":["r1","r2"]},
          {"bucketId":"requests","displayName":"Daily requests","metric":{"kind":"requests"},"unit":"requests","windowPolicy":{"kind":"fixed_calendar","calendarUnit":"day","timezone":"UTC"},"scope":{"kind":"route","routeId":"r"},"status":"healthy","remaining":42,"limit":100,"constraining":false,"affectedRouteIds":["r"]},
          {"bucketId":"currency","displayName":"Prepaid balance","metric":{"kind":"currency","currency":"USD"},"unit":"USD","windowPolicy":{"kind":"none"},"scope":{"kind":"shared_pool","productId":"p"},"status":"healthy","remaining":7.31,"constraining":false,"affectedRouteIds":["r1","r2"]},
          {"bucketId":"native","displayName":"5-hour window","metric":{"kind":"provider_defined","providerKey":"window_units"},"unit":"provider units","windowPolicy":{"kind":"rolling_duration","durationSeconds":18000},"scope":{"kind":"product","productId":"p"},"status":"healthy","remaining":14,"limit":14,"constraining":true,"affectedRouteIds":["r"]}
        ]
        """#)

        XCTAssertEqual(quotas[0].primaryValueText, "61% used")
        XCTAssertEqual(quotas[1].primaryValueText, "35 credits remaining")
        XCTAssertEqual(quotas[2].primaryValueText, "800K tokens remaining")
        XCTAssertEqual(quotas[3].primaryValueText, "42 / 100 requests remaining")
        XCTAssertEqual(quotas[4].primaryValueText, "$7.31 balance remaining")
        XCTAssertEqual(quotas[5].primaryValueText, "14 / 14 provider units remaining")
        XCTAssertEqual(quotas[0].progressFraction, 0.61, accuracy: 0.0001)
        XCTAssertNil(quotas[1].progressFraction)
        XCTAssertEqual(quotas[2].progressFraction, 0.6, accuracy: 0.0001)
    }

    func testResetAndPrioritySemanticsRemainExplicit() throws {
        let quotas = try decodeQuotas(#"""
        [
          {"bucketId":"supplemental","displayName":"Free credits","metric":{"kind":"credits"},"unit":"credits","windowPolicy":{"kind":"none"},"scope":{"kind":"product","productId":"p"},"status":"unknown","remaining":0,"constraining":false},
          {"bucketId":"rolling","displayName":"5-hour window","metric":{"kind":"provider_defined","providerKey":"window_units"},"unit":"provider units","windowPolicy":{"kind":"rolling_duration","durationSeconds":18000},"scope":{"kind":"product","productId":"p"},"status":"healthy","remaining":14,"limit":14,"constraining":true,"affectedRouteIds":["r"]},
          {"bucketId":"shared","displayName":"Shared pool","metric":{"kind":"tokens"},"unit":"tokens","windowPolicy":{"kind":"fixed_calendar","calendarUnit":"day","timezone":"UTC"},"scope":{"kind":"shared_pool","productId":"p"},"status":"warning","remaining":800000,"limit":2000000,"constraining":false,"affectedRouteIds":["r1","r2"]}
        ]
        """#)

        XCTAssertEqual(quotas[0].resetText, "No reset")
        XCTAssertEqual(quotas[1].resetText, "Unknown reset")
        XCTAssertTrue(quotas[0].isSupplementalBalance)
        XCTAssertFalse(quotas[2].isSupplementalBalance)
        XCTAssertEqual(quotas.sortedForPresentation.map(\.bucketId), ["rolling", "shared", "supplemental"])
    }

    private func decodeQuotas(_ array: String) throws -> [CatalogQuotaSummary] {
        try decoder.decode(UsageListResponse<CatalogQuotaSummary>.self, from: Data("{\"data\":\(array)}".utf8)).data
    }
}
