import CoreGraphics
import RooflineCore
import UIKit
import XCTest
@testable import WinChoice

/// The AI window finder on the phone: the HTTP calls (a raw JPEG up, boxes and a quad back, no retry), what the store makes of each way the
/// server can answer, the photo it sends, where the proposal starts from, the testers' capture dump, and the standard-size line. The maths of
/// picking the box and the order of trust is checked in RooflineCore's checks; what only a real phone and the real server can show: the
/// real photo's edges, OWLv2 and SAM 2's answers on real windows, the real latency.
@MainActor
final class AiWindowTests: XCTestCase {
    private let session = HomeownerSession(requestId: "req-1", token: "tok-123", slug: "summit-ridge", address: "305 Ridgeway Dr", services: [.windows], createdAt: Date(), expiresAt: nil)
    private let scene = SampleFrozen.scene()
    private lazy var made = SampleFrozen.capture(scene)

    private func live(base: String = "http://stub.test") -> LiveHomeownerAPI {
        let c = URLSessionConfiguration.ephemeral
        c.protocolClasses = [StubURLProtocol.self]
        var api = LiveHomeownerAPI(baseURL: URL(string: base)!, slug: "summit-ridge")
        api.urlSession = URLSession(configuration: c)
        return api
    }

    override func setUp() {
        StubURLProtocol.seen = []
        StubURLProtocol.reply = { _ in (200, [:], Data("{}".utf8)) }
    }

    private func detection(_ capture: FrozenCapture? = nil, quality: Double = 0.93) -> WindowDetection {
        var d = DebugCaptureSample.sampleDetection(made.opening, view: (capture ?? made.capture).view)
        if var q = d.quad {
            q.quality = quality
            d.quad = q
        }
        return d
    }

    // MARK: HTTP

    func testDetectWindowsSendsTheRawJPEGWithTheTokenAndReadsBoxesAndAQuad() async throws {
        let answer = #"{"boxes":[{"x":0.27,"y":0.23,"w":0.49,"h":0.55,"confidence":0.29}],"picked":{"x":0.27,"y":0.23,"w":0.49,"h":0.55,"confidence":0.29},"quad":{"corners":[[0.27,0.23],[0.76,0.23],[0.76,0.78],[0.27,0.78]],"quality":0.94,"fill":1,"residual":0.001,"maskScore":0.9},"widthPx":768,"heightPx":1024,"detector":"owlv2","segmenter":"sam2","ms":1300,"msDetect":800,"msSegment":500}"#
        StubURLProtocol.reply = { _ in (200, [:], Data(answer.utf8)) }
        let photo = Data((0..<4096).map { UInt8($0 % 241) })
        let got = try await live().detectWindows(session, jpeg: photo, timeout: 6)
        let seen = try XCTUnwrap(StubURLProtocol.seen.last)
        XCTAssertEqual(seen.method, "POST")
        XCTAssertEqual(seen.path, "/api/public/homeowner/summit-ridge/requests/req-1/detect-windows")
        XCTAssertEqual(seen.headers["Authorization"], "Bearer tok-123")
        XCTAssertEqual(seen.headers["Content-Type"], "image/jpeg")
        XCTAssertEqual(seen.body, photo, "the bytes as they are")
        XCTAssertEqual(got.boxes.count, 1)
        XCTAssertEqual(got.quad?.quality ?? 0, 0.94, accuracy: 1e-9)
        XCTAssertEqual(got.picked?.confidence ?? 0, 0.29, accuracy: 1e-9)
    }

    func testARefusedOrBusyDetectorIsOneCallAndAClearCode() async throws {
        StubURLProtocol.reply = { _ in (503, [:], Data(#"{"error":"Finding windows automatically isn't available right now.","code":"detector_unavailable"}"#.utf8)) }
        do {
            _ = try await live().detectWindows(session, jpeg: Data([1, 2, 3]), timeout: 6)
            XCTFail("a 503 is an error")
        } catch let e as HomeownerAPIError {
            XCTAssertEqual(e.code, "detector_unavailable")
            XCTAssertEqual(e.status, 503)
        }
        // A 429 is not waited for and tried again (the person is looking at the photo): one call
        StubURLProtocol.seen = []
        StubURLProtocol.reply = { _ in (429, ["Retry-After": "1"], Data(#"{"error":"slow down","code":"rate_limited"}"#.utf8)) }
        do {
            _ = try await live().detectWindows(session, jpeg: Data([1, 2, 3]), timeout: 6)
            XCTFail("a 429 is an error")
        } catch let e as HomeownerAPIError {
            XCTAssertTrue(e.isRateLimited)
        }
        XCTAssertEqual(StubURLProtocol.seen.count, 1)
    }

    func testTheDebugDumpGoesToItsPathAndABuildWithNoServerAsksNothing() async throws {
        try await live().uploadDebugCapture(session, captureId: "3f1c2b7e-5d0a-4c1e-9a77-0b6d0f4e1a21", file: "depth.f32", data: Data([9, 9]))
        let seen = try XCTUnwrap(StubURLProtocol.seen.last)
        XCTAssertEqual(seen.path, "/api/public/homeowner/summit-ridge/requests/req-1/debug-captures/3f1c2b7e-5d0a-4c1e-9a77-0b6d0f4e1a21/depth.f32")
        XCTAssertEqual(seen.body, Data([9, 9]))
        // The placeholder address of a build with no server: no request at all
        StubURLProtocol.seen = []
        do {
            _ = try await live(base: "https://invalid.winchoice.example").detectWindows(session, jpeg: Data([1]), timeout: 6)
            XCTFail("no server")
        } catch let e as HomeownerAPIError {
            XCTAssertEqual(e.code, "no_server")
        }
        XCTAssertTrue(StubURLProtocol.seen.isEmpty)
    }

    // MARK: The store

    func testTheStoreSaysWhyItGotNothing() async throws {
        // On: the answer
        var config = FakeHomeownerAPI.Config()
        config.detection = detection()
        let h = StoreHarness(fake: FakeHomeownerAPI(config: config))
        try await h.open()
        let ok = await h.store.findWindow(jpeg: Data([1, 2, 3]))
        XCTAssertEqual(ok.status, "ok")
        XCTAssertEqual(ok.detection?.boxes.count, 1)
        let sizes = await h.fake.detectedPhotoSizes
        XCTAssertEqual(sizes, [3])
        // The server knows no detector
        let off = StoreHarness()
        try await off.open()
        let noDetector = await off.store.findWindow(jpeg: Data([1]))
        XCTAssertEqual(noDetector.status, "off")
        XCTAssertNil(noDetector.detection)
        // The phone has no signal (the store knows; or the call fails)
        h.store.offline = true
        let knownOffline = await h.store.findWindow(jpeg: Data([1]))
        XCTAssertEqual(knownOffline.status, "offline")
        let callsBefore = await h.fake.log.count
        _ = await h.store.findWindow(jpeg: Data([1]))
        let callsAfter = await h.fake.log.count
        XCTAssertEqual(callsAfter, callsBefore, "nothing is asked when the phone is known to be offline")
        h.store.offline = false
        h.api.offline = true
        let dropped = await h.store.findWindow(jpeg: Data([1]))
        XCTAssertEqual(dropped.status, "offline")
        h.api.offline = false
        // No saved request
        let fresh = StoreHarness()
        let none = await fresh.store.findWindow(jpeg: Data([1]))
        XCTAssertEqual(none.status, "no-session")
    }

    func testASlowServerIsLeftAfterTheTimeout() async throws {
        var config = FakeHomeownerAPI.Config()
        config.detection = detection()
        config.detectLatency = 2
        let h = StoreHarness(fake: FakeHomeownerAPI(config: config))
        try await h.open()
        let started = Date()
        let late = await h.store.findWindow(jpeg: Data([1]), timeout: 0.2)
        XCTAssertEqual(late.status, "timeout")
        XCTAssertLessThan(Date().timeIntervalSince(started), 1.5)
        XCTAssertNil(late.detection)
        XCTAssertEqual(AiFinding.timeoutSeconds, 6)
    }

    // MARK: The photo it sends

    func testThePhotoSentIsAboutAThousandPixelsAndASmallUprightJPEG() throws {
        let cg = try XCTUnwrap(UIImage(data: made.capture.jpeg)?.cgImage)
        XCTAssertEqual(max(cg.width, cg.height), 1920)
        let sent = try XCTUnwrap(DetectionPhoto.jpeg(from: cg))
        let back = try XCTUnwrap(UIImage(data: sent)?.cgImage)
        XCTAssertEqual(max(back.width, back.height), 1024)
        XCTAssertEqual(Double(back.width) / Double(back.height), Double(cg.width) / Double(cg.height), accuracy: 0.002, "the same shape: upright, not turned")
        XCTAssertLessThan(sent.count, 600_000)
        XCTAssertEqual(Array(sent.prefix(2)), [0xFF, 0xD8])
        // A small photo is not enlarged
        let tiny = try XCTUnwrap(DetectionPhoto.jpeg(from: try XCTUnwrap(UIImage(data: SampleScene.small.image(withCard: false).jpegData(compressionQuality: 0.8)!)?.cgImage)))
        XCTAssertEqual(max(try XCTUnwrap(UIImage(data: tiny)?.cgImage).height, 0), 1008)
    }

    // MARK: Where the proposal starts

    private func image(_ c: FrozenCapture) throws -> CGImage { try XCTUnwrap(UIImage(data: c.jpeg)?.cgImage) }

    func testTheAIWindowStartsTheRectangleAndTheDepthSensorIsUsedOnlyWhenItIsTheSameWindow() throws {
        let cap = made.capture
        let cg = try image(cap)
        let depth = FreezeProposal.depth(in: cg, view: cap.view)
        XCTAssertNotNil(depth)
        // Both see the window: the depth sensor's (better measured) rectangle
        let both = try XCTUnwrap(FreezeProposal.resolve(in: cg, view: cap.view, ai: detection(), depth: depth))
        XCTAssertEqual(both.source, .aiDepth)
        // No depth: the quad, each side set onto the frame in the photo
        var flat = cap.view
        flat.depth = nil
        let quad = try XCTUnwrap(FreezeProposal.resolve(in: cg, view: flat, ai: detection(), depth: nil))
        XCTAssertEqual(quad.source, .aiQuad)
        let size = try XCTUnwrap(FrozenMeasure.measure(rect: quad.rect, view: flat))
        XCTAssertEqual(size.widthIn, SampleScene.widthIn, accuracy: 1.5)
        XCTAssertEqual(size.heightIn, SampleScene.heightIn, accuracy: 1.5)
        // A quad that does not fit well: the box
        let box = try XCTUnwrap(FreezeProposal.resolve(in: cg, view: flat, ai: detection(quality: 0.5), depth: nil))
        XCTAssertEqual(box.source, .ai)
        // The AI found nothing: the old way, the depth sensor
        XCTAssertEqual(FreezeProposal.resolve(in: cg, view: cap.view, ai: WindowDetection(boxes: []), depth: depth)?.source, .depth)
        XCTAssertEqual(FreezeProposal.resolve(in: cg, view: cap.view, ai: nil, depth: depth)?.source, .depth)
    }

    // MARK: Standard sizes

    func testTheEditorAndTheListSayWhenASizeIsAStandardOne() throws {
        let cap = made.capture
        let rect = try XCTUnwrap(FrozenRect.bounding(of: made.opening, plane: cap.view.wall, viewer: cap.view.viewer))
        let editing = FreezeEditing(capture: cap, earlier: [], rect: rect)
        XCTAssertEqual(editing.standardSize?.label, "36 × 60")
        XCTAssertEqual(editing.standardSize?.sentence, "Looks like a standard 36 × 60 window")
        // A size that is nobody's standard says nothing
        var odd = rect
        odd.right += 6.0 / inchesPerMetre
        XCTAssertNil(FreezeEditing(capture: cap, earlier: [], rect: odd).standardSize)
        XCTAssertNil(FreezeEditing(capture: cap, earlier: [], rect: nil).standardSize)
        // The list's row
        let row = WindowRow(id: "w", number: 1, room: "Kitchen", name: nil, style: nil, widthIn: 35.625, heightIn: 59.625, uncertaintyIn: 0.25, needsCheck: false, reasons: [],
                            scale: .card(CardScale(cardCorners: [])), send: .sent)
        XCTAssertEqual(row.standardSizeLine, "Looks like a standard 36 × 60 window")
        var other = row
        other.widthIn = 31
        other.heightIn = 50
        XCTAssertNil(other.standardSizeLine)
        other.widthIn = nil
        XCTAssertNil(other.standardSizeLine)
    }

    // MARK: The testers' dump

    func testACaptureIsDumpedToAFolderAndReplaysFromIt() async throws {
        let h = StoreHarness()
        try await h.open()
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("capture-dump-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        h.store.debugCaptureFolder = folder
        let cap = made.capture
        h.store.dumpCapture(cap)
        let id = cap.id.uuidString.lowercased()
        let dir = folder.appendingPathComponent(id)
        let files = Set((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [])
        XCTAssertEqual(files, [DebugCapture.metaFile, DebugCapture.photoFile, DebugCapture.depthFile, DebugCapture.confidenceFile])
        // What the Mac reads back is the capture
        let bundle = try DebugCapture.Bundle.read(from: dir)
        XCTAssertEqual(bundle.view, cap.view)
        XCTAssertEqual(bundle.jpeg, cap.jpeg)
        XCTAssertEqual(bundle.meta.captureId, id)
        // The result joins it
        let rect = try XCTUnwrap(FrozenRect.bounding(of: made.opening, plane: cap.view.wall, viewer: cap.view.viewer))
        let result = DebugCapture.Result(captureId: id, source: "ai-quad", ai: AiAttempt(status: "ok", detection: detection(), ms: 900), proposed: DebugCapture.Rect(rect, view: cap.view),
                                         final: DebugCapture.Rect(rect, view: cap.view), usedAt: "2026-10-22T12:00:00Z", applied: true)
        h.store.dumpResult(result)
        XCTAssertEqual(try DebugCapture.Bundle.read(from: dir).result, result)
    }

    func testTheDumpGoesToTheServerOnlyWhenItsDumpIsOnAndStopsWhenItIsNot() async throws {
        var config = FakeHomeownerAPI.Config()
        config.debugCaptures = true
        let on = StoreHarness(fake: FakeHomeownerAPI(config: config))
        try await on.open()
        on.store.dumpCapture(made.capture)
        try await Task.sleep(nanoseconds: 300_000_000)
        let sent = await on.fake.debugFiles.map { String($0.split(separator: "/").last ?? "") }
        XCTAssertEqual(sent, [DebugCapture.metaFile, DebugCapture.photoFile, DebugCapture.depthFile, DebugCapture.confidenceFile])
        XCTAssertFalse(on.store.debugCapturesOff)
        // The server's dump is off (404): said once, and no more is sent
        let off = StoreHarness()
        try await off.open()
        off.store.dumpCapture(made.capture)
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertTrue(off.store.debugCapturesOff)
        let callsAfterFirst = await off.fake.log.filter { $0.hasPrefix("POST debug-captures") }.count
        XCTAssertEqual(callsAfterFirst, 1, "stopped after the first 404")
        off.store.dumpCapture(made.capture)
        try await Task.sleep(nanoseconds: 200_000_000)
        let callsAfterSecond = await off.fake.log.filter { $0.hasPrefix("POST debug-captures") }.count
        XCTAssertEqual(callsAfterSecond, 1)
    }
}
