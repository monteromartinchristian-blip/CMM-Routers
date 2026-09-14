import Foundation
import Security

public protocol UsageCredentialStore: AnyObject {
    func readToken() throws -> String?
    func saveToken(_ token: String) throws
    func deleteToken() throws
}

public extension UsageCredentialStore {
    func readTokenOffMainThread() async throws -> String? {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                do {
                    continuation.resume(returning: try self.readToken())
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    func saveTokenOffMainThread(_ token: String) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            DispatchQueue.global(qos: .utility).async {
                do {
                    try self.saveToken(token)
                    continuation.resume()
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    func deleteTokenOffMainThread() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            DispatchQueue.global(qos: .utility).async {
                do {
                    try self.deleteToken()
                    continuation.resume()
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }
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
    public static let defaultReadAccount = "local-api"
    public static let defaultManagementAccount = "local-management-api"
    public static let defaultAccount = defaultReadAccount

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

public final class MemoryUsageCredentialStore: UsageCredentialStore {
    private let lock = NSLock()
    private var token: String?

    public init(token: String? = nil) {
        self.token = token
    }

    public func readToken() throws -> String? {
        lock.lock()
        defer { lock.unlock() }
        return token
    }

    public func saveToken(_ token: String) throws {
        lock.lock()
        defer { lock.unlock() }
        self.token = token
    }

    public func deleteToken() throws {
        lock.lock()
        defer { lock.unlock() }
        token = nil
    }
}
