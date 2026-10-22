import Foundation
import RooflineCore

/// What the server accepts beyond the contract's first draft (docs/windows/homeowner-api.md). The live API turns on only
/// what that document lists; the fake (previews, tests, screenshots) can turn everything on so the whole design shows.
struct HomeownerFeatures: Equatable, Sendable {
    /// A window colour (the "Color" row of the style screen) in the window's body.
    var windowColor = false
    /// A best time to call (morning, afternoon, evening) in the call-me booking.
    var bestTime = false

    /// The contract as written: neither is in it.
    static let contract = HomeownerFeatures()
    static let all = HomeownerFeatures(windowColor: true, bestTime: true)
}

/// Everything the app asks of the homeowner server. The live one talks HTTP (LiveHomeownerAPI); the fake keeps a request
/// in memory (FakeHomeownerAPI) for previews, tests and the DEBUG launch argument. Calls that need the request's token
/// take the saved session (request id + bearer token).
protocol HomeownerAPI: Sendable {
    var features: HomeownerFeatures { get }

    /// GET /company
    func company() async throws -> HomeownerCompany
    /// POST /requests (looks the address up, a few seconds)
    func createRequest(address: String, services: [HomeownerService]) async throws -> HomeownerCreated
    /// GET /requests/:id
    func view(_ s: HomeownerSession) async throws -> HomeownerRequestView
    /// POST /requests/:id/uploads (one photo, raw JPEG)
    func uploadPhoto(_ s: HomeownerSession, jpeg: Data) async throws -> WindowPhotoUpload
    /// POST /requests/:id/windows (idempotent on the window id)
    func addWindow(_ s: HomeownerSession, window: PhotoWindowInput) async throws -> HomeownerRequestView
    /// DELETE /requests/:id/windows/:windowId
    func deleteWindow(_ s: HomeownerSession, windowId: String) async throws -> HomeownerRequestView
    /// PATCH /requests/:id {estimatedTotalOverride}; nil takes it back to the address estimate
    func setEstimatedTotal(_ s: HomeownerSession, total: Int?) async throws -> HomeownerRequestView
    /// POST /requests/:id/contact
    func fileContact(_ s: HomeownerSession, contact: HomeownerContact) async throws -> HomeownerRequestView
    /// GET /requests/:id/slots
    func slots(_ s: HomeownerSession) async throws -> HomeownerSlots
    /// POST /requests/:id/book
    func book(_ s: HomeownerSession, choice: HomeownerBookingChoice) async throws -> HomeownerRequestView
    /// GET /requests/:id/status
    func status(_ s: HomeownerSession) async throws -> HomeownerStatus
    /// POST /requests/:id/detect-windows: the windows an AI detector sees in one upright JPEG (a frozen frame at about 1024 px), and the
    /// picked one's four corners when the server cuts it out. Best-effort: the caller marks the window by hand when this throws.
    func detectWindows(_ s: HomeownerSession, jpeg: Data, timeout: TimeInterval) async throws -> WindowDetection
    /// POST /requests/:id/debug-captures/:captureId/:file: a tester build's dump of one Capture (see DebugCapture). 404 when the server's dump is off.
    func uploadDebugCapture(_ s: HomeownerSession, captureId: String, file: String, data: Data) async throws
}

extension HomeownerAPI {
    /// A server (or a test double) that does not look for windows: the caller carries on by hand.
    func detectWindows(_ s: HomeownerSession, jpeg: Data, timeout: TimeInterval) async throws -> WindowDetection {
        throw HomeownerAPIError(status: 503, message: "Finding windows automatically isn't available right now.", code: "detector_unavailable")
    }

    func uploadDebugCapture(_ s: HomeownerSession, captureId: String, file: String, data: Data) async throws {
        throw HomeownerAPIError(status: 404, message: "We couldn't find that.", code: "debug_captures_off")
    }
}
