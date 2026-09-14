import Foundation

public struct UsageCredentialStores {
    public let read: UsageCredentialStore
    public let management: UsageCredentialStore

    public init(read: UsageCredentialStore, management: UsageCredentialStore) {
        self.read = read
        self.management = management
    }
}

public enum CMMUsageModule {
    public static let demoFixtureEnvironmentKey = "CMM_USAGE_DEMO_FIXTURE"
    public static let demoReadToken = "cmm-usage-public-demo-read"
    public static let demoManagementToken = "cmm-usage-public-demo-management"

    public static func credentialStores(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> UsageCredentialStores {
        if environment[demoFixtureEnvironmentKey] == "1" {
            return UsageCredentialStores(
                read: MemoryUsageCredentialStore(token: demoReadToken),
                management: MemoryUsageCredentialStore(token: demoManagementToken)
            )
        }
        return UsageCredentialStores(
            read: KeychainUsageCredentialStore(account: KeychainUsageCredentialStore.defaultReadAccount),
            management: KeychainUsageCredentialStore(account: KeychainUsageCredentialStore.defaultManagementAccount)
        )
    }
}
