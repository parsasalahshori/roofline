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
}
