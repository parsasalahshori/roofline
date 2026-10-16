import Foundation
import Observation
import RooflineCore
import SwiftUI

/// The app's state: where the server is, who is signed in, the outbox and the test-data log.
@MainActor
@Observable
final class AppModel {
    enum Phase: Equatable {
        case starting
        case signedOut
        case signedIn(AuthMe)
    }

    private(set) var phase: Phase = .starting
    private(set) var serverURL: String
    /// The outbox as last persisted (the list view and the badges read this).
    private(set) var outboxItems: [OutboxItem] = []
    var lastSyncError: String?

    let api: APIClient
    let outbox: Outbox
    let passes: TestPassLog

    private static let serverKey = "serverURL"

    init() {
        let saved = UserDefaults.standard.string(forKey: Self.serverKey).flatMap(ServerAddress.normalize) ?? ServerAddress.defaultURL
        serverURL = saved
        let api = APIClient(baseURL: URL(string: saved)!)
        self.api = api
        let support = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
            ?? FileManager.default.temporaryDirectory
        outbox = Outbox(directory: support.appendingPathComponent("Outbox", isDirectory: true), transport: APIOutboxTransport(api: api))
        passes = TestPassLog(fileURL: support.appendingPathComponent("TestData/passes.json"))
        api.onUnauthorized = { [weak self] in
            Task { @MainActor in self?.sessionEnded() }
        }
    }

    var me: AuthMe? {
        if case .signedIn(let m) = phase { return m }
        return nil
    }

    var pendingCount: Int { outboxItems.filter { $0.state != .done }.count }
    var failedCount: Int { outboxItems.filter { $0.state == .failed }.count }

    // MARK: Start, sign in, sign out

    func start() async {
        await outbox.setObserver { [weak self] items in
            Task { @MainActor in self?.outboxItems = items }
        }
        do {
            try await outbox.load()
        } catch {
            lastSyncError = "The saved outbox could not be read: \(error.localizedDescription)"
        }
        do {
            phase = .signedIn(try await api.me())
            await sync()
        } catch {
            // Not signed in, or offline at launch: sign in (the outbox keeps its windows for later)
            phase = .signedOut
        }
    }

    func signIn(email: String, password: String) async throws {
        let me = try await api.login(email: email.trimmingCharacters(in: .whitespaces), password: password)
        phase = .signedIn(me)
        await sync()
    }

    func signOut() async {
        await api.logout()
        phase = .signedOut
    }

    /// The server answered 401 somewhere: back to sign-in (the outbox keeps everything).
    func sessionEnded() {
        if case .signedIn = phase { phase = .signedOut }
    }

    /// Hidden setting. Returns false when the address is not usable.
    func setServer(_ text: String) -> Bool {
        guard let s = ServerAddress.normalize(text), let url = URL(string: s) else { return false }
        serverURL = s
        api.baseURL = url
        UserDefaults.standard.set(s, forKey: Self.serverKey)
        return true
    }

    // MARK: Outbox

    /// Sends what is waiting. Safe to call often (one sync at a time).
    func sync() async {
        guard me != nil else { return }
        await outbox.syncAll()
    }

    func retry(_ id: String) async {
        try? await outbox.retry(id: id)
        _ = await outbox.send(id: id)
    }

    func removeFromOutbox(_ id: String) async {
        try? await outbox.remove(id: id)
    }

    func clearSent() async {
        try? await outbox.clearDone()
    }

    /// Saves a measured window: its JPEG and JSON on disk, a test-data row, then tries to send it now.
    func save(window: PhotoWindowInput, measurementId: String, address: String?, jpeg: Data, widthPx: Int, heightPx: Int, pass: TestPass?) async throws {
        _ = try await outbox.enqueue(window: window, measurementId: measurementId, address: address, jpeg: jpeg, imageWidthPx: widthPx, imageHeightPx: heightPx)
        if let pass = pass { try? await passes.append(pass) }
        Task { await self.sync() }
    }
}
