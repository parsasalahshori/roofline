import Foundation
import RooflineCore

/// The scan outbox over the homeowner endpoints: each photo goes up the same way a window's photo does (POST .../uploads), then the scan itself
/// to POST .../scans with the request's bearer token. A server without the scans route answers 404, which the outbox reads as "not yet".
struct HomeownerScanTransport: ScanTransport {
    let api: HomeownerAPI
    let session: @Sendable (String) -> HomeownerSession?

    private func saved(_ requestId: String) throws -> HomeownerSession {
        guard let s = session(requestId) else {
            throw TransportError(status: 401, message: "Your saved request is no longer valid. Please start a new one.")
        }
        return s
    }

    func uploadFrame(measurementId: String, jpeg: Data) async throws -> WindowPhotoUpload {
        do {
            return try await api.uploadPhoto(try saved(measurementId), jpeg: jpeg)
        } catch let e as HomeownerAPIError {
            throw e.transport
        }
    }

    func postScan(measurementId: String, body: Data) async throws -> WindowScanAnswer {
        do {
            return try await api.postScan(try saved(measurementId), body: body)
        } catch let e as HomeownerAPIError {
            throw e.transport
        }
    }
}
