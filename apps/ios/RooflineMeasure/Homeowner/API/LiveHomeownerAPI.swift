import Foundation
import RooflineCore

/// The homeowner API over HTTP: /api/public/homeowner/:slug (docs/windows/homeowner-api.md). Signed out: the only
/// credential is the request's bearer token. Errors carry the server's own sentence (`error`) and machine `code`.
struct LiveHomeownerAPI: HomeownerAPI {
    let baseURL: URL
    let slug: String
    var features: HomeownerFeatures = .contract
    /// Injected in tests (a URLProtocol stub); the app's own session has no cookies and no cache.
    var urlSession: URLSession = LiveHomeownerAPI.makeSession()

    static func makeSession() -> URLSession {
        let c = URLSessionConfiguration.ephemeral
        c.httpCookieStorage = nil
        c.httpShouldSetCookies = false
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.waitsForConnectivity = false
        c.timeoutIntervalForRequest = 30
        return URLSession(configuration: c)
    }

    private var root: URL { baseURL.appendingPathComponent("api/public/homeowner/\(slug)") }

    // MARK: Calls

    func company() async throws -> HomeownerCompany {
        try decode(HomeownerCompany.self, from: try await send("GET", "company"))
    }

    func createRequest(address: String, services: [HomeownerService]) async throws -> HomeownerCreated {
        let body = try JSONEncoder().encode(HomeownerCreateBody(address: address, services: services))
        // The first look-up of an address measures it from above: a few seconds, so a longer wait than the others
        return try decode(HomeownerCreated.self, from: try await send("POST", "requests", json: body, timeout: 75))
    }

    func view(_ s: HomeownerSession) async throws -> HomeownerRequestView {
        try decode(HomeownerRequestView.self, from: try await send("GET", "requests/\(s.requestId)", token: s.token))
    }

    func uploadPhoto(_ s: HomeownerSession, jpeg: Data) async throws -> WindowPhotoUpload {
        try decode(WindowPhotoUpload.self, from: try await send("POST", "requests/\(s.requestId)/uploads", token: s.token, raw: jpeg, contentType: "image/jpeg", timeout: 120))
    }

    func addWindow(_ s: HomeownerSession, window: PhotoWindowInput) async throws -> HomeownerRequestView {
        let body = try JSONEncoder().encode(window)
        return try decode(HomeownerRequestView.self, from: try await send("POST", "requests/\(s.requestId)/windows", token: s.token, json: body))
    }

    func deleteWindow(_ s: HomeownerSession, windowId: String) async throws -> HomeownerRequestView {
        try decode(HomeownerRequestView.self, from: try await send("DELETE", "requests/\(s.requestId)/windows/\(windowId)", token: s.token))
    }

    func setEstimatedTotal(_ s: HomeownerSession, total: Int?) async throws -> HomeownerRequestView {
        // null takes it back to the address estimate: the key must be present, with a null
        let body: Data
        if let total = total {
            body = Data(#"{"estimatedTotalOverride":\#(total)}"#.utf8)
        } else {
            body = Data(#"{"estimatedTotalOverride":null}"#.utf8)
        }
        return try decode(HomeownerRequestView.self, from: try await send("PATCH", "requests/\(s.requestId)", token: s.token, json: body))
    }

    func fileContact(_ s: HomeownerSession, contact: HomeownerContact) async throws -> HomeownerRequestView {
        let body = try JSONEncoder().encode(contact)
        return try decode(HomeownerRequestView.self, from: try await send("POST", "requests/\(s.requestId)/contact", token: s.token, json: body))
    }

    func slots(_ s: HomeownerSession) async throws -> HomeownerSlots {
        let data = try await send("GET", "requests/\(s.requestId)/slots", token: s.token)
        guard let slots = HomeownerSlots.decode(data) else { throw unreadable() }
        return slots
    }

    func book(_ s: HomeownerSession, choice: HomeownerBookingChoice) async throws -> HomeownerRequestView {
        let body = try JSONEncoder().encode(HomeownerBookBody(choice, sendBestTime: features.bestTime))
        return try decode(HomeownerRequestView.self, from: try await send("POST", "requests/\(s.requestId)/book", token: s.token, json: body))
    }

    func status(_ s: HomeownerSession) async throws -> HomeownerStatus {
        try decode(HomeownerStatus.self, from: try await send("GET", "requests/\(s.requestId)/status", token: s.token))
    }

    /// A build with no server in its file points at an address that fails plainly (`.example`): nothing to ask.
    var hasServer: Bool { !(baseURL.host ?? "").hasSuffix(".example") }

    func detectWindows(_ s: HomeownerSession, jpeg: Data, timeout: TimeInterval) async throws -> WindowDetection {
        guard hasServer else { throw HomeownerAPIError(status: nil, message: Self.offlineMessage, code: "no_server") }
        // One try, no waiting for a 429: the person is looking at the photo, and drags the corners themselves instead
        let data = try await sendOnce("POST", "requests/\(s.requestId)/detect-windows", token: s.token, json: nil, raw: jpeg, contentType: "image/jpeg", timeout: timeout)
        return try decode(WindowDetection.self, from: data)
    }

    func postScan(_ s: HomeownerSession, body: Data) async throws -> WindowScanAnswer {
        guard hasServer else { throw HomeownerAPIError(status: nil, message: Self.offlineMessage, code: "no_server") }
        return try decode(WindowScanAnswer.self, from: try await send("POST", "requests/\(s.requestId)/scans", token: s.token, json: body, timeout: 60))
    }

    func uploadDebugCapture(_ s: HomeownerSession, captureId: String, file: String, data: Data) async throws {
        guard hasServer else { throw HomeownerAPIError(status: nil, message: Self.offlineMessage, code: "no_server") }
        _ = try await sendOnce("POST", "requests/\(s.requestId)/debug-captures/\(captureId)/\(file)", token: s.token, json: nil, raw: data, contentType: "application/octet-stream", timeout: 120)
    }

    // MARK: HTTP

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw unreadable()
        }
    }

    private func unreadable() -> HomeownerAPIError {
        HomeownerAPIError(status: 200, message: "WinChoice sent an answer this version of the app can't read. Please update the app.", code: "unreadable")
    }

    /// One call; a 429 is retried once after its Retry-After (at most 10 seconds), then reported.
    private func send(_ method: String, _ path: String, token: String? = nil, json: Data? = nil, raw: Data? = nil, contentType: String? = nil, timeout: TimeInterval = 30) async throws -> Data {
        do {
            return try await sendOnce(method, path, token: token, json: json, raw: raw, contentType: contentType, timeout: timeout)
        } catch let e as HomeownerAPIError where e.isRateLimited {
            guard let wait = e.retryAfter, wait <= 10 else { throw e }
            try? await Task.sleep(nanoseconds: UInt64(max(wait, 0.5) * 1_000_000_000))
            return try await sendOnce(method, path, token: token, json: json, raw: raw, contentType: contentType, timeout: timeout)
        }
    }

    private func sendOnce(_ method: String, _ path: String, token: String?, json: Data?, raw: Data?, contentType: String?, timeout: TimeInterval) async throws -> Data {
        var req = URLRequest(url: root.appendingPathComponent(path), timeoutInterval: timeout)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token = token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let data: Data
        let response: URLResponse
        do {
            if let raw = raw {
                req.setValue(contentType ?? "application/octet-stream", forHTTPHeaderField: "Content-Type")
                (data, response) = try await urlSession.upload(for: req, from: raw)
            } else {
                if let json = json {
                    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    req.httpBody = json
                }
                (data, response) = try await urlSession.data(for: req)
            }
        } catch {
            throw Self.networkError(error)
        }
        guard let http = response as? HTTPURLResponse else { throw HomeownerAPIError(status: nil, message: Self.offlineMessage) }
        guard (200..<300).contains(http.statusCode) else { throw Self.serverError(http, data) }
        return data
    }

    static let offlineMessage = "We couldn't reach WinChoice. Check your connection and try again."

    static func networkError(_ error: Error) -> HomeownerAPIError {
        if (error as? URLError)?.code == .cancelled { return HomeownerAPIError(status: nil, message: "Cancelled.", code: "cancelled") }
        return HomeownerAPIError(status: nil, message: offlineMessage)
    }

    /// The server's own `{ error, field?, code }`, else a plain sentence for the status.
    static func serverError(_ http: HTTPURLResponse, _ data: Data) -> HomeownerAPIError {
        struct Body: Decodable { var error: String?; var field: String?; var code: String? }
        let body = try? JSONDecoder().decode(Body.self, from: data)
        let fallback: String
        switch http.statusCode {
        case 401: fallback = "Your saved request is no longer valid. Please start a new one."
        case 404: fallback = "We couldn't find that. Please start a new request."
        case 429: fallback = "That's a lot of requests at once. Please wait a moment and try again."
        case 500...599: fallback = "WinChoice had a problem on its side. Please try again in a minute."
        default: fallback = "That didn't go through. Please try again."
        }
        let retryAfter = http.value(forHTTPHeaderField: "Retry-After").flatMap(Double.init)
        return HomeownerAPIError(status: http.statusCode, message: (body?.error).flatMap { $0.isEmpty ? nil : $0 } ?? fallback, field: body?.field, code: body?.code, retryAfter: retryAfter)
    }
}
