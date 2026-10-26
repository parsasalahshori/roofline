import Foundation
import RooflineCore
import XCTest
@testable import WinChoice

/// Answers every request of the live client with a canned reply and remembers what was sent.
final class StubURLProtocol: URLProtocol {
    struct Seen {
        var method: String
        var path: String
        var headers: [String: String]
        var body: Data
    }

    /// (status, headers, body) for the next request.
    static var reply: (Seen) -> (Int, [String: String], Data) = { _ in (200, [:], Data("{}".utf8)) }
    static var seen: [Seen] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 64 * 1024)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                body.append(buffer, count: n)
            }
            stream.close()
        }
        let seen = Seen(method: request.httpMethod ?? "", path: request.url?.path ?? "", headers: request.allHTTPHeaderFields ?? [:], body: body)
        Self.seen.append(seen)
        let (status, headers, data) = Self.reply(seen)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// The HTTP layer of the homeowner client: paths, the bearer token, the bodies, and how the server's errors read.
final class LiveAPITests: XCTestCase {
    private let session = HomeownerSession(requestId: "req-1", token: "tok-123", slug: "summit-ridge", address: "305 Ridgeway Dr", services: [.windows], createdAt: Date(), expiresAt: nil)

    private func api(features: HomeownerFeatures = .contract) -> LiveHomeownerAPI {
        let c = URLSessionConfiguration.ephemeral
        c.protocolClasses = [StubURLProtocol.self]
        var api = LiveHomeownerAPI(baseURL: URL(string: "http://stub.test")!, slug: "summit-ridge")
        api.urlSession = URLSession(configuration: c)
        api.features = features
        return api
    }

    override func setUp() {
        StubURLProtocol.seen = []
        StubURLProtocol.reply = { _ in (200, [:], Data("{}".utf8)) }
    }

    private func json(_ data: Data) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    func testCompanyNeedsNoTokenAndRequestsCarryTheBearerToken() async throws {
        StubURLProtocol.reply = { _ in (200, [:], Data(#"{ "name": "Summit Ridge Roofing" }"#.utf8)) }
        let company = try await api().company()
        XCTAssertEqual(company.name, "Summit Ridge Roofing")
        XCTAssertEqual(StubURLProtocol.seen.last?.path, "/api/public/homeowner/summit-ridge/company")
        XCTAssertNil(StubURLProtocol.seen.last?.headers["Authorization"])
        _ = try await api().view(session)
        XCTAssertEqual(StubURLProtocol.seen.last?.method, "GET")
        XCTAssertEqual(StubURLProtocol.seen.last?.path, "/api/public/homeowner/summit-ridge/requests/req-1")
        XCTAssertEqual(StubURLProtocol.seen.last?.headers["Authorization"], "Bearer tok-123")
    }

    func testNewRequestBodyHasTheAddressAndWindowsOnly() async throws {
        StubURLProtocol.reply = { _ in
            (201, [:], Data(#"{ "requestId": "r", "token": "t", "status": "ready", "home": { "address": "305 Ridgeway Dr" }, "estimate": {}, "services": ["windows"] }"#.utf8))
        }
        let made = try await api().createRequest(address: "305 Ridgeway Dr, Little Rock, AR", services: [.windows])
        XCTAssertEqual(made.requestId, "r")
        let seen = try XCTUnwrap(StubURLProtocol.seen.last)
        XCTAssertEqual(seen.method, "POST")
        XCTAssertEqual(seen.path, "/api/public/homeowner/summit-ridge/requests")
        XCTAssertNil(seen.headers["Authorization"], "a new request has no token yet")
        let body = json(seen.body)
        XCTAssertEqual(body["address"] as? String, "305 Ridgeway Dr, Little Rock, AR")
        XCTAssertEqual(body["services"] as? [String], ["windows"])
    }

    func testAPhotoGoesUpAsRawJPEG() async throws {
        StubURLProtocol.reply = { _ in (201, [:], Data(#"{ "id": "up-1", "widthPx": 3024, "heightPx": 4032 }"#.utf8)) }
        let photo = Data((0..<2048).map { UInt8($0 % 251) })
        let up = try await api().uploadPhoto(session, jpeg: photo)
        XCTAssertEqual(up.id, "up-1")
        let seen = try XCTUnwrap(StubURLProtocol.seen.last)
        XCTAssertEqual(seen.method, "POST")
        XCTAssertEqual(seen.path, "/api/public/homeowner/summit-ridge/requests/req-1/uploads")
        XCTAssertEqual(seen.headers["Content-Type"], "image/jpeg")
        XCTAssertEqual(seen.body, photo, "the bytes as they are, not wrapped in a form")
    }

    func testAWindowGoesInTheServersShape() async throws {
        let window = PhotoWindowInput(id: "w-1", uploadId: "up-1", label: "Over the sink", windowKey: nil, corners: [Vec2(10, 20), Vec2(300, 20), Vec2(300, 500), Vec2(10, 500)],
                                      scale: .card(CardScale(cardCorners: [Vec2(50, 60), Vec2(130, 60), Vec2(130, 110), Vec2(50, 110)])), room: "Kitchen", style: "double-hung")
        _ = try await api().addWindow(session, window: window)
        let seen = try XCTUnwrap(StubURLProtocol.seen.last)
        XCTAssertEqual(seen.method, "POST")
        XCTAssertEqual(seen.path, "/api/public/homeowner/summit-ridge/requests/req-1/windows")
        let body = json(seen.body)
        XCTAssertEqual(body["id"] as? String, "w-1")
        XCTAssertEqual(body["room"] as? String, "Kitchen")
        XCTAssertEqual(body["style"] as? String, "double-hung")
        XCTAssertEqual((body["scale"] as? [String: Any])?["kind"] as? String, "card")
        XCTAssertNil(body["windowKey"], "no nulls: a key the server does not know is not sent")
        _ = try await api().deleteWindow(session, windowId: "w-1")
        XCTAssertEqual(StubURLProtocol.seen.last?.method, "DELETE")
        XCTAssertEqual(StubURLProtocol.seen.last?.path, "/api/public/homeowner/summit-ridge/requests/req-1/windows/w-1")
    }

    func testIHaveMoreSendsTheNumberAndTakingItBackSendsANull() async throws {
        _ = try await api().setEstimatedTotal(session, total: 18)
        XCTAssertEqual(StubURLProtocol.seen.last?.method, "PATCH")
        XCTAssertEqual(json(StubURLProtocol.seen.last?.body ?? Data())["estimatedTotalOverride"] as? Int, 18)
        _ = try await api().setEstimatedTotal(session, total: nil)
        let body = json(StubURLProtocol.seen.last?.body ?? Data())
        XCTAssertTrue(body.keys.contains("estimatedTotalOverride"), "the key is there, with a null")
        XCTAssertTrue(body["estimatedTotalOverride"] is NSNull)
    }

    func testContactCarriesTheConsentVersionAndTheTickedBoxes() async throws {
        let contact = HomeownerContact(firstName: "Tia", lastName: "Bell", phone: "(501) 555-0177", email: "tia.bell@example.com", zip: "72205", contactConsent: true, textConsent: false, consentVersion: "2026-10-16")
        _ = try await api().fileContact(session, contact: contact)
        let seen = try XCTUnwrap(StubURLProtocol.seen.last)
        XCTAssertEqual(seen.path, "/api/public/homeowner/summit-ridge/requests/req-1/contact")
        let body = json(seen.body)
        XCTAssertEqual(body["consentVersion"] as? String, "2026-10-16")
        XCTAssertEqual(body["contactConsent"] as? Bool, true)
        XCTAssertEqual(body["textConsent"] as? Bool, false)
        XCTAssertEqual(body["firstName"] as? String, "Tia")
    }

    func testBookingAVisitOrAskingForACall() async throws {
        let slot = HomeownerSlot(start: "2026-10-17T14:00:00.000Z", end: "2026-10-17T15:00:00.000Z")
        _ = try await api().book(session, choice: .slot(slot))
        XCTAssertEqual(StubURLProtocol.seen.last?.path, "/api/public/homeowner/summit-ridge/requests/req-1/book")
        XCTAssertEqual(json(StubURLProtocol.seen.last?.body ?? Data())["slotStart"] as? String, "2026-10-17T14:00:00.000Z")
        _ = try await api().book(session, choice: .callMe(bestTime: "morning"))
        var body = json(StubURLProtocol.seen.last?.body ?? Data())
        XCTAssertEqual(body["callMe"] as? Bool, true)
        XCTAssertNil(body["bestTime"], "the server's contract has no best time: it is not sent")
        _ = try await api(features: .all).book(session, choice: .callMe(bestTime: "morning"))
        body = json(StubURLProtocol.seen.last?.body ?? Data())
        XCTAssertEqual(body["bestTime"] as? String, "morning")
    }

    func testTheServersOwnSentenceFieldAndCodeComeThrough() async throws {
        StubURLProtocol.reply = { _ in (400, [:], Data(#"{ "error": "That email address doesn't look right.", "field": "email", "code": "invalid_request" }"#.utf8)) }
        do {
            _ = try await api().fileContact(session, contact: HomeownerContact())
            XCTFail("expected an error")
        } catch let e as HomeownerAPIError {
            XCTAssertEqual(e.message, "That email address doesn't look right.")
            XCTAssertEqual(e.field, "email")
            XCTAssertEqual(e.code, "invalid_request")
            XCTAssertEqual(e.status, 400)
        }
    }

    func testAnExpiredOrUnknownTokenIsRecognised() async throws {
        StubURLProtocol.reply = { _ in (401, [:], Data(#"{ "error": "Your saved request ran out.", "code": "token_expired" }"#.utf8)) }
        do {
            _ = try await api().view(session)
            XCTFail("expected an error")
        } catch let e as HomeownerAPIError {
            XCTAssertTrue(e.isUnauthorized)
            XCTAssertTrue(e.isTokenExpired)
        }
        // No body at all: a plain sentence for the status, never a blank message
        StubURLProtocol.reply = { _ in (404, [:], Data()) }
        do {
            _ = try await api().view(session)
            XCTFail("expected an error")
        } catch let e as HomeownerAPIError {
            XCTAssertTrue(e.isGone)
            XCTAssertFalse(e.message.isEmpty)
        }
    }

    func testARateLimitIsRetriedOnceAfterItsWaitThenReported() async throws {
        var calls = 0
        StubURLProtocol.reply = { _ in
            calls += 1
            return calls == 1 ? (429, ["Retry-After": "1"], Data(#"{ "error": "Slow down.", "code": "rate_limited" }"#.utf8)) : (200, [:], Data("{}".utf8))
        }
        _ = try await api().view(session)
        XCTAssertEqual(calls, 2, "waited the second the server asked for, then sent it again")
        // A long wait is not sat through: the caller hears of it
        StubURLProtocol.reply = { _ in (429, ["Retry-After": "60"], Data(#"{ "error": "Too many new requests from this network. Try again in a while.", "code": "rate_limited" }"#.utf8)) }
        do {
            _ = try await api().view(session)
            XCTFail("expected an error")
        } catch let e as HomeownerAPIError {
            XCTAssertTrue(e.isRateLimited)
            XCTAssertEqual(e.retryAfter, 60)
            XCTAssertEqual(e.message, "Too many new requests from this network. Try again in a while.")
        }
    }

    func testAnAnswerThisVersionCannotReadSaysToUpdate() async throws {
        StubURLProtocol.reply = { _ in (200, [:], Data("this is not json".utf8)) }
        do {
            _ = try await api().view(session)
            XCTFail("expected an error")
        } catch let e as HomeownerAPIError {
            XCTAssertEqual(e.code, "unreadable")
            XCTAssertTrue(e.message.contains("update the app"))
        }
    }

    func testNoAnswerAtAllIsANetworkErrorWithPlainWords() async throws {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 2
        var api = LiveHomeownerAPI(baseURL: URL(string: "http://127.0.0.1:9")!, slug: "summit-ridge")
        api.urlSession = URLSession(configuration: c)
        do {
            _ = try await api.company()
            XCTFail("nothing listens on port 9")
        } catch let e as HomeownerAPIError {
            XCTAssertTrue(e.isNetwork)
            XCTAssertEqual(e.message, LiveHomeownerAPI.offlineMessage)
        }
    }
}
