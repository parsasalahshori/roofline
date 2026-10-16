#if STAFF_APP
import Foundation
import RooflineCore

/// An error to show a person: the server's own sentence when it gave one.
struct APIError: Error, LocalizedError, Equatable {
    var status: Int?
    var message: String
    var field: String?

    var errorDescription: String? { message }
    var isUnauthorized: Bool { status == 401 }

    var transport: TransportError { TransportError(status: status, message: message) }
}

/// The Roofline API over URLSession. Sessions are the server's cookie (HttpOnly, SameSite=Lax), kept in
/// HTTPCookieStorage.shared so the sheet-photo web view can be handed the same cookie. Native requests send no
/// Origin header, so the server's cross-site check (apps/api/src/app.ts blockCrossSiteMutations) lets them through.
final class APIClient: @unchecked Sendable {
    private let lock = NSLock()
    private var _baseURL: URL
    private var _onUnauthorized: (@Sendable () -> Void)?
    let session: URLSession

    init(baseURL: URL) {
        _baseURL = baseURL
        let config = URLSessionConfiguration.default
        config.httpCookieStorage = HTTPCookieStorage.shared
        config.httpCookieAcceptPolicy = .always
        config.httpShouldSetCookies = true
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 120
        config.waitsForConnectivity = false
        session = URLSession(configuration: config)
    }

    var baseURL: URL {
        get { lock.lock(); defer { lock.unlock() }; return _baseURL }
        set { lock.lock(); _baseURL = newValue; lock.unlock() }
    }

    /// Called when the server answers 401 (the session ended) to anything but sign-in.
    var onUnauthorized: (@Sendable () -> Void)? {
        get { lock.lock(); defer { lock.unlock() }; return _onUnauthorized }
        set { lock.lock(); _onUnauthorized = newValue; lock.unlock() }
    }

    // MARK: Requests

    private func url(_ path: String, _ query: [URLQueryItem]) -> URL {
        var c = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { c.queryItems = query }
        return c.url!
    }

    /// Sends a request and returns the body of a 2xx answer; anything else is an APIError.
    @discardableResult
    func send(_ method: String, _ path: String, query: [URLQueryItem] = [], json: Encodable? = nil, body: Data? = nil, contentType: String? = nil) async throws -> (Data, HTTPURLResponse) {
        var req = URLRequest(url: url(path, query))
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let json = json {
            req.httpBody = try JSONEncoder().encode(AnyEncodableBox(json))
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        } else if let body = body {
            req.httpBody = body
            req.setValue(contentType ?? "application/octet-stream", forHTTPHeaderField: "Content-Type")
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw APIError(status: nil, message: Self.networkMessage(error), field: nil)
        }
        guard let http = response as? HTTPURLResponse else { throw APIError(status: nil, message: "No answer from the server.", field: nil) }
        guard (200..<300).contains(http.statusCode) else {
            let body = try? JSONDecoder().decode(ApiErrorBody.self, from: data)
            let fallback = http.statusCode == 401 ? "Please sign in again." : "The server answered \(http.statusCode)."
            if http.statusCode == 401, path != "api/auth/login" { onUnauthorized?() }
            throw APIError(status: http.statusCode, message: body?.error ?? fallback, field: body?.field)
        }
        return (data, http)
    }

    func get<T: Decodable>(_ path: String, query: [URLQueryItem] = [], as type: T.Type) async throws -> T {
        let (data, _) = try await send("GET", path, query: query)
        return try decode(T.self, data)
    }

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError(status: nil, message: "The server's answer could not be read (\(error.localizedDescription)).", field: nil)
        }
    }

    static func networkMessage(_ error: Error) -> String {
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain {
            switch ns.code {
            case NSURLErrorNotConnectedToInternet, NSURLErrorNetworkConnectionLost:
                return "No connection. It will be sent when the phone is back online."
            case NSURLErrorCannotConnectToHost, NSURLErrorCannotFindHost:
                return "Cannot reach the Roofline server. Check the server address and that Tailscale is on."
            case NSURLErrorTimedOut:
                return "The server took too long to answer."
            case NSURLErrorAppTransportSecurityRequiresSecureConnection:
                return "This server needs https (use the Tailscale https address)."
            default:
                break
            }
        }
        return ns.localizedDescription
    }

    // MARK: Auth

    func login(email: String, password: String) async throws -> AuthMe {
        struct Body: Encodable { let email: String; let password: String }
        let (data, _) = try await send("POST", "api/auth/login", json: Body(email: email, password: password))
        return try decode(AuthMe.self, data)
    }

    func me() async throws -> AuthMe { try await get("api/auth/me", as: AuthMe.self) }

    func logout() async {
        _ = try? await send("POST", "api/auth/logout")
    }

    // MARK: Jobs and addresses

    func myJobs() async throws -> [Job] {
        try await get("api/jobs", query: [URLQueryItem(name: "assigned", value: "me"), URLQueryItem(name: "limit", value: "100")], as: JobsResponse.self).jobs
    }

    func property(id: String) async throws -> Property {
        try await get("api/properties/\(id)", as: Property.self)
    }

    func searchProperties(_ q: String) async throws -> [Property] {
        try await get("api/properties", query: [URLQueryItem(name: "q", value: q), URLQueryItem(name: "limit", value: "25")], as: PropertiesResponse.self).properties
    }

    // MARK: Window measurements

    /// The latest windows measurement for an address, or nil when it has none (GET ?propertyId=, the server change).
    func latestMeasurement(propertyId: String) async throws -> WindowMeasurementView? {
        do {
            let (data, _) = try await send("GET", "api/window-measurements", query: [URLQueryItem(name: "propertyId", value: propertyId)])
            return decodeLatestMeasurement(data)
        } catch let e as APIError where e.status == 404 {
            return nil
        }
    }

    /// Starts a windows measurement for an address (the server works out the walls estimate; this can take seconds).
    func createMeasurement(propertyId: String) async throws -> WindowMeasurementView {
        struct Body: Encodable { let propertyId: String }
        let (data, _) = try await send("POST", "api/window-measurements", json: Body(propertyId: propertyId))
        return try decode(WindowMeasurementView.self, data)
    }

    func measurement(id: String) async throws -> WindowMeasurementView {
        try await get("api/window-measurements/\(id)", as: WindowMeasurementView.self)
    }

    /// The upright JPEG (EXIF orientation 1) as the raw body: {id, widthPx, heightPx}.
    func uploadPhoto(measurementId: String, jpeg: Data) async throws -> WindowPhotoUpload {
        let (data, _) = try await send("POST", "api/window-measurements/\(measurementId)/uploads", body: jpeg, contentType: "image/jpeg")
        return try decode(WindowPhotoUpload.self, data)
    }

    /// Appends one window (POST /:id/photo-windows, the server change). A server without that route answers 404 for
    /// it while the measurement itself is there: then the window is added with a PATCH of the whole list (the old
    /// way, which can lose a window someone saved on the web at the same moment).
    func appendWindow(measurementId: String, window: PhotoWindowInput) async throws {
        do {
            try await send("POST", "api/window-measurements/\(measurementId)/photo-windows", json: window)
        } catch let e as APIError where e.status == 404 {
            let view = try await measurement(id: measurementId) // a 404 here: the measurement itself is gone
            var list = view.adjustments?.photoWindows ?? []
            list.removeAll { $0.id == window.id }
            // A server without the append route predates `device` / `cornerSpreadM` too (its schema is strict)
            var old = window
            if case .ar(var s) = old.scale {
                s.device = nil
                s.cornerSpreadM = nil
                old.scale = .ar(s)
            }
            list.append(old)
            struct Patch: Encodable { let photoWindows: [PhotoWindowInput] }
            try await send("PATCH", "api/window-measurements/\(measurementId)", json: Patch(photoWindows: list))
            _ = e
        }
    }

    func deleteWindow(measurementId: String, windowId: String) async throws {
        do {
            try await send("DELETE", "api/window-measurements/\(measurementId)/photo-windows/\(windowId)")
        } catch let e as APIError where e.status == 404 {
            let view = try await measurement(id: measurementId)
            let list = (view.adjustments?.photoWindows ?? []).filter { $0.id != windowId }
            struct Patch: Encodable { let photoWindows: [PhotoWindowInput] }
            try await send("PATCH", "api/window-measurements/\(measurementId)", json: Patch(photoWindows: list))
            _ = e
        }
    }

    func setAllWindowsMeasured(measurementId: String, _ value: Bool) async throws -> WindowMeasurementView {
        struct Patch: Encodable { let photosCoverAllWindows: Bool }
        let (data, _) = try await send("PATCH", "api/window-measurements/\(measurementId)", json: Patch(photosCoverAllWindows: value))
        return try decode(WindowMeasurementView.self, data)
    }
}

/// Lets `send` take any Encodable.
private struct AnyEncodableBox: Encodable {
    let value: Encodable
    init(_ value: Encodable) { self.value = value }
    func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}

/// The outbox's network: the API client.
struct APIOutboxTransport: OutboxTransport {
    let api: APIClient

    func uploadPhoto(measurementId: String, jpeg: Data) async throws -> WindowPhotoUpload {
        do { return try await api.uploadPhoto(measurementId: measurementId, jpeg: jpeg) } catch let e as APIError { throw Self.map(e) }
    }

    func appendWindow(measurementId: String, window: PhotoWindowInput) async throws {
        do { try await api.appendWindow(measurementId: measurementId, window: window) } catch let e as APIError { throw Self.map(e) }
    }

    /// A 401 is not the window's fault: it waits (retryable) until the person signs in again.
    static func map(_ e: APIError) -> TransportError {
        e.isUnauthorized ? TransportError(status: nil, message: "Sign in again to send this window.") : e.transport
    }

    func windowExists(measurementId: String, windowId: String) async throws -> Bool {
        do {
            let v = try await api.measurement(id: measurementId)
            return (v.adjustments?.photoWindows ?? []).contains { $0.id == windowId } || (v.photoWindows ?? []).contains { $0.id == windowId }
        } catch let e as APIError { throw Self.map(e) }
    }
}
#endif
