import Foundation
import RooflineCore
import XCTest
@testable import WinChoice

/// The outbox over the homeowner endpoints: the photo goes up at once, the window waits for its style, a retry is safe.
final class HomeownerOutboxTests: XCTestCase {
    private var dir: URL!
    private var fake: FakeHomeownerAPI!
    private var api: SwitchableAPI!
    private var session: HomeownerSession!
    private var views: ViewBox!

    final class ViewBox: @unchecked Sendable {
        private let lock = NSLock()
        private var all: [HomeownerRequestView] = []
        func add(_ v: HomeownerRequestView) { lock.lock(); all.append(v); lock.unlock() }
        var last: HomeownerRequestView? { lock.lock(); defer { lock.unlock() }; return all.last }
        var count: Int { lock.lock(); defer { lock.unlock() }; return all.count }
    }

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("outbox-\(UUID().uuidString)", isDirectory: true)
        fake = FakeHomeownerAPI()
        api = SwitchableAPI(fake)
        session = await fake.seed()
        views = ViewBox()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private func outbox(session saved: HomeownerSession?, now: @escaping @Sendable () -> Date = { Date() }) -> Outbox {
        let box = views!
        let transport = HomeownerOutboxTransport(api: api, session: { id in saved?.requestId == id ? saved : nil }, onView: { box.add($0) })
        return Outbox(directory: dir, transport: transport, now: now)
    }

    /// A clock the test moves by hand.
    final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var date = Date(timeIntervalSince1970: 1_800_000_000)
        var now: Date { lock.lock(); defer { lock.unlock() }; return date }
        func advance(_ seconds: TimeInterval) { lock.lock(); date = date.addingTimeInterval(seconds); lock.unlock() }
    }

    /// The one item the outbox holds.
    private func only(_ outbox: Outbox) async throws -> OutboxItem {
        let items = await outbox.items
        return try XCTUnwrap(items.first)
    }

    private func jpeg() -> Data {
        PhotoPreparation.prepare(SampleScene.small.image(withCard: false))!.jpeg
    }

    private func window(_ id: String = WindowIds.new(), style: String? = nil) -> PhotoWindowInput {
        let w = SampleScene.widthIn / inchesPerMetre, h = SampleScene.heightIn / inchesPerMetre
        let scale = WindowPhotoScale.ar(ArScale(pointsM: [Vec3(0, h, -1.5), Vec3(w, h, -1.5), Vec3(w, 0, -1.5), Vec3(0, 0, -1.5)], trackingLostCount: 0, device: .arkitLidar, cornerSpreadM: [0.001, 0.001, 0.001, 0.001]))
        let c = SampleScene.small.frameCorners.map { Vec2(Double($0.x), Double($0.y)) }
        return PhotoWindowInput(id: id, uploadId: nil, label: nil, windowKey: nil, corners: c, scale: scale, room: "Kitchen", style: style)
    }

    func testThePhotoGoesAtOnceAndTheWindowWaitsForItsStyle() async throws {
        let outbox = outbox(session: session)
        let w = window()
        _ = try await outbox.enqueue(window: w, measurementId: session.requestId, address: nil, jpeg: jpeg(), imageWidthPx: 756, imageHeightPx: 1008, held: true)
        await outbox.syncAll()
        var calls = await fake.calls()
        XCTAssertEqual(calls.filter { $0 == "POST uploads" }.count, 1)
        XCTAssertEqual(calls.filter { $0.hasPrefix("POST windows") }.count, 0)
        var item = try await only(outbox)
        XCTAssertNotNil(item.uploadId, "the photo's id is kept for the window")
        XCTAssertTrue(item.isHeld)
        // The style arrives: the window is released and goes with the photo's id
        try await outbox.updateWindow(id: w.id, release: true) { $0.style = "double-hung" }
        await outbox.syncAll()
        item = try await only(outbox)
        XCTAssertEqual(item.state, .done)
        calls = await fake.calls()
        XCTAssertEqual(calls.filter { $0 == "POST uploads" }.count, 1, "the photo is not uploaded twice")
        XCTAssertEqual(calls.filter { $0.hasPrefix("POST windows") }.count, 1)
        let view = try XCTUnwrap(views.last)
        XCTAssertEqual(view.windows.count, 1, "the answer is a fresh view of the request")
        XCTAssertEqual(view.windows[0].input.uploadId, item.uploadId)
        XCTAssertEqual(view.windows[0].input.style, "double-hung")
    }

    func testALostAnswerIsSentAgainAndTheServerKeepsOneWindow() async throws {
        let outbox = outbox(session: session)
        let w = window(style: "double-hung")
        _ = try await outbox.enqueue(window: w, measurementId: session.requestId, address: nil, jpeg: jpeg(), imageWidthPx: 756, imageHeightPx: 1008)
        await outbox.syncAll()
        // The same window comes back (the app was killed before it heard "done")
        let item = try await only(outbox)
        _ = try await outbox.enqueue(window: item.window, measurementId: session.requestId, address: nil, jpeg: nil, imageWidthPx: 0, imageHeightPx: 0)
        await outbox.syncAll()
        let view = try await api.view(session)
        XCTAssertEqual(view.windows.filter { $0.id == w.id }.count, 1, "idempotent on the window id")
    }

    func testNoConnectionWaitsAndAnswersLaterDoNotLoseTheWindow() async throws {
        let outbox = outbox(session: session)
        let w = window(style: "double-hung")
        api.offline = true
        _ = try await outbox.enqueue(window: w, measurementId: session.requestId, address: nil, jpeg: jpeg(), imageWidthPx: 756, imageHeightPx: 1008)
        await outbox.syncAll()
        var item = try await only(outbox)
        XCTAssertEqual(item.state, .waiting)
        XCTAssertNotNil(item.lastError)
        api.offline = false
        await outbox.syncAll()
        item = try await only(outbox)
        XCTAssertEqual(item.state, .done)
    }

    func testARefusedWindowStopsAndSaysWhyAndRetryTakesItFromTheWindowStep() async throws {
        let outbox = outbox(session: session)
        let w = window()
        _ = try await outbox.enqueue(window: w, measurementId: session.requestId, address: nil, jpeg: jpeg(), imageWidthPx: 756, imageHeightPx: 1008, held: true)
        await outbox.syncAll()
        // The photo is up; now the style comes and the server refuses the window with a sentence
        await fake.failNext(serverError(422, "window_unsizable", "The window corners cross over each other."))
        try await outbox.updateWindow(id: w.id, release: true) { $0.style = "double-hung" }
        await outbox.syncAll()
        var item = try await only(outbox)
        XCTAssertEqual(item.state, .failed, "a refusal is not retried by itself")
        XCTAssertEqual(item.lastError, "The window corners cross over each other.")
        XCTAssertEqual(item.lastErrorStage, .window)
        let photoId = item.uploadId
        // "Try again": only the window goes, with the same photo
        try await outbox.retry(id: w.id)
        await outbox.syncAll()
        item = try await only(outbox)
        XCTAssertEqual(item.state, .done)
        XCTAssertEqual(item.uploadId, photoId)
        let uploads = await fake.calls().filter { $0 == "POST uploads" }.count
        XCTAssertEqual(uploads, 1, "the photo is not uploaded again")
    }

    func testAServerFailureIsRetriedByItself() async throws {
        let outbox = outbox(session: session)
        let w = window()
        _ = try await outbox.enqueue(window: w, measurementId: session.requestId, address: nil, jpeg: jpeg(), imageWidthPx: 756, imageHeightPx: 1008, held: true)
        await outbox.syncAll()
        await fake.failNext(serverError(500, "server_error", "WinChoice had a problem on its side."))
        try await outbox.updateWindow(id: w.id, release: true) { $0.style = "double-hung" }
        await outbox.syncAll()
        var item = try await only(outbox)
        XCTAssertEqual(item.state, .waiting, "a server's own failure is worth trying again")
        await outbox.syncAll()
        item = try await only(outbox)
        XCTAssertEqual(item.state, .done)
    }

    func testARateLimitWaitsForRetryAfterAndThenGoesByItself() async throws {
        let clock = Clock()
        let outbox = outbox(session: session, now: { clock.now })
        let w = window(style: "double-hung")
        // Too many photos at once: the server says 429, Retry-After 3 (nothing was stored)
        await fake.failNext(HomeownerAPIError(status: 429, message: "Too many photos are arriving at once. Please wait a moment.", code: "rate_limited", retryAfter: 3))
        _ = try await outbox.enqueue(window: w, measurementId: session.requestId, address: nil, jpeg: jpeg(), imageWidthPx: 756, imageHeightPx: 1008)
        await outbox.syncAll()
        var item = try await only(outbox)
        XCTAssertEqual(item.state, .waiting, "a 429 is not a refusal: no Retry button, it goes by itself")
        XCTAssertEqual(item.retryNotBefore, clock.now.addingTimeInterval(3))
        XCTAssertEqual(item.lastError, "Too many photos are arriving at once. Please wait a moment.")
        let callsAfterRefusal = await fake.calls().count
        // Before the wait is over nothing is sent
        clock.advance(1)
        await outbox.syncAll()
        let callsTooEarly = await fake.calls().count
        XCTAssertEqual(callsTooEarly, callsAfterRefusal, "the outbox does not knock while it is told to wait")
        // After it: the photo, then the window
        clock.advance(2.5)
        await outbox.syncAll()
        item = try await only(outbox)
        XCTAssertEqual(item.state, .done)
        XCTAssertNil(item.retryNotBefore)
        let calls = await fake.calls()
        XCTAssertEqual(calls.filter { $0 == "POST uploads" }.count, 2, "one refused, one taken")
        XCTAssertEqual(calls.filter { $0.hasPrefix("POST windows") }.count, 1)
    }

    func testAnUnknownRequestIsAFailureNotAnEndlessRetry() async throws {
        let outbox = outbox(session: nil)
        _ = try await outbox.enqueue(window: window(style: "double-hung"), measurementId: "someone-elses", address: nil, jpeg: jpeg(), imageWidthPx: 756, imageHeightPx: 1008)
        await outbox.syncAll()
        let item = try await only(outbox)
        XCTAssertEqual(item.state, .failed, "no saved token for the request: 401, not retryable")
    }

    func testTheOutboxSurvivesARelaunch() async throws {
        let first = outbox(session: session)
        let w = window()
        _ = try await first.enqueue(window: w, measurementId: session.requestId, address: nil, jpeg: jpeg(), imageWidthPx: 756, imageHeightPx: 1008, held: true)
        let second = outbox(session: session)
        try await second.load()
        let items = await second.items
        XCTAssertEqual(items.map { $0.id }, [w.id])
        let located = await second.jpegURL(for: items[0])
        let url = try XCTUnwrap(located)
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path), "the photo is on the phone's disk")
        try await second.removeAll(measurementId: session.requestId)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path), "and goes when the request does")
    }
}
