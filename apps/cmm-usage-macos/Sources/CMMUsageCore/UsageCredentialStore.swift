import Foundation
import Security

public protocol UsageCredentialStore: AnyObject {
    func readToken() throws -> String?
    func saveToken(_ token: String) throws
    func deleteToken() throws
}

public enum UsageCredentialStoreError: Error, LocalizedError {
    case unexpectedStatus(OSStatus)
    case invalidStoredValue

    public var errorDescription: String? {
        switch self {
        case .unexpectedStatus(let status):
            return "Keychain operation failed with status \(status)."
        case .invalidStoredValue:
            return "The stored CMM Usage credential is not valid UTF-8."
        }
    }
}

public final class KeychainUsageCredentialStore: UsageCredentialStore {
    public static let defaultService = "CMM Usage"
    public static let defaultAccount = "local-api"

    private let service: String
    private let account: String

    public init(
        service: String = KeychainUsageCredentialStore.defaultService,
        account: String = KeychainUsageCredentialStore.defaultAccount
    ) {
        self.service = service
        self.account = account
    }

    public func readToken() throws -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else {
            throw UsageCredentialStoreError.unexpectedStatus(status)
        }
        guard let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
            throw UsageCredentialStoreError.invalidStoredValue
        }
        return value
    }

    public func saveToken(_ token: String) throws {
        let data = Data(token.utf8)
        let updateStatus = SecItemUpdate(
            baseQuery as CFDictionary,
            [kSecValueData as String: data] as CFDictionary
        )
        if updateStatus == errSecSuccess { return }
        if updateStatus != errSecItemNotFound {
            throw UsageCredentialStoreError.unexpectedStatus(updateStatus)
        }

        var add = baseQuery
        add[kSecValueData as String] = data
        let addStatus = SecItemAdd(add as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw UsageCredentialStoreError.unexpectedStatus(addStatus)
        }
    }

    public func deleteToken() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw UsageCredentialStoreError.unexpectedStatus(status)
        }
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
