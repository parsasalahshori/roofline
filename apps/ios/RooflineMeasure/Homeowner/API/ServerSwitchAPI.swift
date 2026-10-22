import Foundation
import RooflineCore

/// The live API with a swappable server and company: a tester changes them in the hidden server sheet and the app uses the
/// new ones at once (no force-quit). Everything else talks to this, never to the live client directly.
final class ServerSwitchAPI: HomeownerAPI, @unchecked Sendable {
    private let lock = NSLock()
    private var inner: LiveHomeownerAPI

    init(_ live: LiveHomeownerAPI) { inner = live }

    private var current: LiveHomeownerAPI { lock.lock(); defer { lock.unlock() }; return inner }

    func swap(baseURL: URL, slug: String) {
        lock.lock(); defer { lock.unlock() }
        inner = LiveHomeownerAPI(baseURL: baseURL, slug: slug, features: inner.features, urlSession: inner.urlSession)
    }

    var features: HomeownerFeatures { current.features }
    func company() async throws -> HomeownerCompany { try await current.company() }
    func createRequest(address: String, services: [HomeownerService]) async throws -> HomeownerCreated { try await current.createRequest(address: address, services: services) }
    func view(_ s: HomeownerSession) async throws -> HomeownerRequestView { try await current.view(s) }
    func uploadPhoto(_ s: HomeownerSession, jpeg: Data) async throws -> WindowPhotoUpload { try await current.uploadPhoto(s, jpeg: jpeg) }
    func addWindow(_ s: HomeownerSession, window: PhotoWindowInput) async throws -> HomeownerRequestView { try await current.addWindow(s, window: window) }
    func deleteWindow(_ s: HomeownerSession, windowId: String) async throws -> HomeownerRequestView { try await current.deleteWindow(s, windowId: windowId) }
    func setEstimatedTotal(_ s: HomeownerSession, total: Int?) async throws -> HomeownerRequestView { try await current.setEstimatedTotal(s, total: total) }
    func fileContact(_ s: HomeownerSession, contact: HomeownerContact) async throws -> HomeownerRequestView { try await current.fileContact(s, contact: contact) }
    func slots(_ s: HomeownerSession) async throws -> HomeownerSlots { try await current.slots(s) }
    func book(_ s: HomeownerSession, choice: HomeownerBookingChoice) async throws -> HomeownerRequestView { try await current.book(s, choice: choice) }
    func status(_ s: HomeownerSession) async throws -> HomeownerStatus { try await current.status(s) }
    func detectWindows(_ s: HomeownerSession, jpeg: Data, timeout: TimeInterval) async throws -> WindowDetection { try await current.detectWindows(s, jpeg: jpeg, timeout: timeout) }
    func uploadDebugCapture(_ s: HomeownerSession, captureId: String, file: String, data: Data) async throws { try await current.uploadDebugCapture(s, captureId: captureId, file: file, data: data) }
}
