import Foundation
import RooflineCore
import XCTest
@testable import WinChoice

/// The fake server with a switch for the connection: `offline = true` makes every call fail the way a phone with no signal does.
final class SwitchableAPI: HomeownerAPI, @unchecked Sendable {
    let fake: FakeHomeownerAPI
    private let lock = NSLock()
    private var isOffline = false

    init(_ fake: FakeHomeownerAPI) {
        self.fake = fake
    }

    var offline: Bool {
        get { lock.lock(); defer { lock.unlock() }; return isOffline }
        set { lock.lock(); isOffline = newValue; lock.unlock() }
    }

    var features: HomeownerFeatures { fake.features }

    private func gate() throws {
        // The live client turns every network failure into this one sentence
        if offline { throw HomeownerAPIError(status: nil, message: LiveHomeownerAPI.offlineMessage) }
    }

    func company() async throws -> HomeownerCompany { try gate(); return try await fake.company() }
    func createRequest(address: String, services: [HomeownerService]) async throws -> HomeownerCreated { try gate(); return try await fake.createRequest(address: address, services: services) }
    func view(_ s: HomeownerSession) async throws -> HomeownerRequestView { try gate(); return try await fake.view(s) }
    func uploadPhoto(_ s: HomeownerSession, jpeg: Data) async throws -> WindowPhotoUpload { try gate(); return try await fake.uploadPhoto(s, jpeg: jpeg) }
    func addWindow(_ s: HomeownerSession, window: PhotoWindowInput) async throws -> HomeownerRequestView { try gate(); return try await fake.addWindow(s, window: window) }
    func deleteWindow(_ s: HomeownerSession, windowId: String) async throws -> HomeownerRequestView { try gate(); return try await fake.deleteWindow(s, windowId: windowId) }
    func setEstimatedTotal(_ s: HomeownerSession, total: Int?) async throws -> HomeownerRequestView { try gate(); return try await fake.setEstimatedTotal(s, total: total) }
    func fileContact(_ s: HomeownerSession, contact: HomeownerContact) async throws -> HomeownerRequestView { try gate(); return try await fake.fileContact(s, contact: contact) }
    func slots(_ s: HomeownerSession) async throws -> HomeownerSlots { try gate(); return try await fake.slots(s) }
    func book(_ s: HomeownerSession, choice: HomeownerBookingChoice) async throws -> HomeownerRequestView { try gate(); return try await fake.book(s, choice: choice) }
    func status(_ s: HomeownerSession) async throws -> HomeownerStatus { try gate(); return try await fake.status(s) }
    func detectWindows(_ s: HomeownerSession, jpeg: Data, timeout: TimeInterval) async throws -> WindowDetection { try gate(); return try await fake.detectWindows(s, jpeg: jpeg, timeout: timeout) }
    func uploadDebugCapture(_ s: HomeownerSession, captureId: String, file: String, data: Data) async throws { try gate(); try await fake.uploadDebugCapture(s, captureId: captureId, file: file, data: data) }
}

/// A vault whose Keychain always refuses (an unsigned build, a full Keychain).
final class RefusingVault: SessionVault, @unchecked Sendable {
    func load() -> HomeownerSession? { nil }
    func save(_ session: HomeownerSession) throws { throw VaultError(status: -34018) }
    func clear() {}
}

func serverError(_ status: Int, _ code: String, _ message: String = "The server said no.", field: String? = nil) -> HomeownerAPIError {
    HomeownerAPIError(status: status, message: message, field: field, code: code)
}

/// A homeowner store over the in-memory fake server, the in-memory vault and a temp outbox folder: the screens' logic with no
/// network, no Keychain and no camera.
@MainActor
final class StoreHarness {
    let store: HomeownerStore
    let fake: FakeHomeownerAPI
    let api: SwitchableAPI
    let vault: SessionVault
    let progress: MemoryProgressStore
    let directory: URL

    init(fake: FakeHomeownerAPI = FakeHomeownerAPI(), vault: SessionVault = MemorySessionVault(), progress: MemoryProgressStore = MemoryProgressStore(),
         capabilities: MeasureCapabilities = .depthSensorPhone("iPhone 15 Pro")) {
        // The first launch of a fresh install clears the Keychain; a test that saved a session first must not lose it
        UserDefaults.standard.set(true, forKey: "winchoice.installed")
        self.fake = fake
        self.api = SwitchableAPI(fake)
        self.vault = vault
        self.progress = progress
        self.directory = FileManager.default.temporaryDirectory.appendingPathComponent("winchoice-test-\(UUID().uuidString)", isDirectory: true)
        self.store = HomeownerStore(api: api, vault: vault, progressStore: progress, outboxDirectory: directory, capabilities: capabilities)
    }

    deinit {
        try? FileManager.default.removeItem(at: directory)
    }

    /// A saved request with the windows given, opened the way the app opens it on a launch.
    func open(windows: [FakeWindowSpec] = [], contact: Bool = false, booked: Bool = false, step: HomeownerStep? = nil, services: [HomeownerService] = [.windows, .roof]) async throws {
        let session = await fake.seed(services: services, windows: windows, contact: contact, booked: booked)
        try vault.save(session)
        if let step = step {
            var saved = HomeownerProgress()
            saved.step = step
            progress.save(saved, requestId: session.requestId)
        }
        await store.bootstrap()
    }

    /// Sends what can be sent and lets the store see the outbox (its own copy arrives through a main-actor hop).
    func settle() async {
        for _ in 0..<3 {
            await store.outbox.syncAll()
            try? await Task.sleep(nanoseconds: 30_000_000)
        }
        store.outboxChanged(await store.outbox.items)
    }

    /// A finished measure, saved: an AR window on the drawn sample photo, its photo up, its style still to pick.
    @discardableResult
    func capture(room: String = "Kitchen", name: String = "", frosted: Bool = false) async -> String? {
        // A small drawn photo keeps the tests quick (same shape as the phone's 3:4)
        let scene = SampleScene.small
        let photo = PhotoPreparation.prepare(scene.image(withCard: false))
        let w = SampleScene.widthIn / inchesPerMetre, h = SampleScene.heightIn / inchesPerMetre
        let scale = WindowPhotoScale.ar(ArScale(pointsM: [Vec3(0, h, -1.5), Vec3(w, h, -1.5), Vec3(w, 0, -1.5), Vec3(0, 0, -1.5)], trackingLostCount: 0, device: .arkitLidar, cornerSpreadM: [0.001, 0.001, 0.001, 0.001]))
        let session = MeasureSession(method: .corners, room: room, number: store.nextWindowNumber)
        store.capture(scale: scale, corners: scene.frameCorners.map { Vec2(Double($0.x), Double($0.y)) }, jpeg: photo?.jpeg, widthPx: photo?.widthPx ?? 0, heightPx: photo?.heightPx ?? 0, in: session)
        let id = store.pending?.id
        await store.savePending(room: room, name: name, frosted: frosted)
        await settle()
        return id
    }
}

extension SampleScene {
    /// The 3:4 phone photo at a quarter of the size: the same drawn window and card.
    static let small = SampleScene(size: CGSize(width: 756, height: 1008), windowShare: 0.60)
}
