import Foundation
import RooflineCore
import Security

/// Where the homeowner's request id and bearer token live (REDESIGN: the Keychain, never a plain file). A lost token cannot
/// be recovered from the server (it keeps only a hash), so this is the only copy.
protocol SessionVault: Sendable {
    func load() -> HomeownerSession?
    func save(_ session: HomeownerSession) throws
    func clear()
}

struct VaultError: Error, LocalizedError {
    var status: OSStatus
    var errorDescription: String? { "The Keychain refused to save your request (\(status))." }
}

/// The Keychain, one generic-password item. `AfterFirstUnlockThisDeviceOnly`: readable while the phone is in use, not
/// copied to another phone by a backup restore.
final class KeychainSessionVault: SessionVault, @unchecked Sendable {
    private let service: String
    private let account = "homeowner-request"

    init(service: String = "com.premjeetech.winchoice.measure.session") {
        self.service = service
    }

    private var base: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    func load() -> HomeownerSession? {
        var q = base
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(HomeownerSession.self, from: data)
    }

    func save(_ session: HomeownerSession) throws {
        let data = try JSONEncoder().encode(session)
        SecItemDelete(base as CFDictionary)
        var q = base
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(q as CFDictionary, nil)
        guard status == errSecSuccess else { throw VaultError(status: status) }
    }

    func clear() {
        SecItemDelete(base as CFDictionary)
    }
}

/// In memory: previews and tests (the logic tests never touch the real Keychain).
final class MemorySessionVault: SessionVault, @unchecked Sendable {
    private let lock = NSLock()
    private var session: HomeownerSession?

    init(_ session: HomeownerSession? = nil) {
        self.session = session
    }

    func load() -> HomeownerSession? {
        lock.lock()
        defer { lock.unlock() }
        return session
    }

    func save(_ session: HomeownerSession) throws {
        lock.lock()
        defer { lock.unlock() }
        self.session = session
    }

    func clear() {
        lock.lock()
        defer { lock.unlock() }
        session = nil
    }
}

/// The request in use right now, readable from any thread (the outbox sends windows off the main actor). The vault keeps it
/// between launches; this keeps it for this run even if the phone refused to save it (a full Keychain, an unsigned test build).
final class SessionHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var current: HomeownerSession?

    func set(_ session: HomeownerSession?) {
        lock.lock()
        defer { lock.unlock() }
        current = session
    }

    func session(for requestId: String) -> HomeownerSession? {
        lock.lock()
        defer { lock.unlock() }
        return current?.requestId == requestId ? current : nil
    }
}
