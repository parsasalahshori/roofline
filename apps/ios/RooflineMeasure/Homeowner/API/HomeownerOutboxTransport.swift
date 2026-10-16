import Foundation
import RooflineCore

/// The outbox over the homeowner endpoints: `measurementId` is the REQUEST id, the photo goes to POST .../uploads and the
/// window to POST .../windows with the request's bearer token. The window POST is idempotent on the window id (a retry
/// after a lost answer is a 200 and changes nothing), so there is nothing to look up before sending again.
struct HomeownerOutboxTransport: OutboxTransport {
    let api: HomeownerAPI
    /// The saved session of a request id (the Keychain), nil when there is none.
    let session: @Sendable (String) -> HomeownerSession?
    /// Every window answer is a fresh view of the request (new quote, the window sized): handed to the store.
    let onView: @Sendable (HomeownerRequestView) -> Void

    private func saved(_ requestId: String) throws -> HomeownerSession {
        guard let s = session(requestId) else {
            throw TransportError(status: 401, message: "Your saved request is no longer valid. Please start a new one.")
        }
        return s
    }

    func uploadPhoto(measurementId: String, jpeg: Data) async throws -> WindowPhotoUpload {
        do {
            return try await api.uploadPhoto(try saved(measurementId), jpeg: jpeg)
        } catch let e as HomeownerAPIError {
            throw e.transport
        }
    }

    func appendWindow(measurementId: String, window: PhotoWindowInput) async throws {
        do {
            let view = try await api.addWindow(try saved(measurementId), window: window)
            onView(view)
        } catch let e as HomeownerAPIError {
            throw e.transport
        }
    }

    func windowExists(measurementId: String, windowId: String) async throws -> Bool {
        // The window call is idempotent: sending it again is the check
        false
    }
}
