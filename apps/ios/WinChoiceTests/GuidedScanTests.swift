import Foundation
import RooflineCore
import XCTest
@testable import WinChoice

/// The guided scan on the phone: the marks pipeline on drawn photos (the real corner finder, the real maths), and a scan going to the server
/// only after its window, surviving a server that does not have the route yet.
@MainActor
final class GuidedScanTests: XCTestCase {
    /// Ten drawn photos (six regular, four close-ups) of the 35 5/8 x 59 5/8 in window: rendered once.
    private static let shots = DebugScanScene.fullScan()

    private func estimate(off: Double = 0.012) -> [Vec3] {
        DebugScanScene.corners.enumerated().map { i, p in p + Vec3(i % 2 == 0 ? -off : off, i < 2 ? off : -off, 0) }
    }

    private func build(windowId: String = WindowIds.new()) throws -> ScanProcessing.Built {
        try XCTUnwrap(ScanProcessing.build(shots: Self.shots, estimate: estimate(), keySource: .ai, scanId: UUID().uuidString.lowercased(), windowId: windowId, images: ScanImages()))
    }

    func testTheMarksPipelineMeasuresTheDrawnWindowWithinASixteenth() throws {
        let built = try build()
        let s = built.draft.solution
        XCTAssertEqual(s.widthIn ?? 0, SampleScene.widthIn, accuracy: 1.0 / 16)
        XCTAssertEqual(s.heightIn ?? 0, SampleScene.heightIn, accuracy: 1.0 / 16)
        XCTAssertEqual(s.status, .measured, "\(s.quality)")
        XCTAssertEqual(s.quality.closeups, 4)
        XCTAssertTrue(s.quality.framesPerCorner.allSatisfy { $0 >= 6 }, "\(s.quality.framesPerCorner)")
        XCTAssertTrue(built.draft.usedMarks.allSatisfy { $0.source != .projected })
        for c in 0..<4 { XCTAssertEqual(s.confidence(corner: c), .sure) }
        // the window's own frame is looked for too (or estimated)
        XCTAssertNotNil(built.draft.windowFrame)
    }

    func testAMarkTheEstimateGotWrongIsFoundAgainInEveryPhoto() throws {
        // an estimate 1.7 cm out each way (2.4 cm) at every corner: the photos pull the marks back onto the corners
        let built = try XCTUnwrap(ScanProcessing.build(shots: Self.shots, estimate: estimate(off: 0.017), keySource: .snap, scanId: "s", windowId: WindowIds.new(), images: ScanImages()))
        let s = built.draft.solution
        XCTAssertEqual(s.widthIn ?? 0, SampleScene.widthIn, accuracy: 0.1)
        XCTAssertEqual(s.heightIn ?? 0, SampleScene.heightIn, accuracy: 0.1)
    }

    func testDraggingAMarkWorksTheAnswerOutAgain() throws {
        let model = GuidedScanModel()
        model.debugLoad(shots: Self.shots, estimate: estimate(), check: false)
        XCTAssertTrue(model.isMeasured)
        let shot = Self.shots[1]
        let m = try XCTUnwrap(model.draft?.usedMarks.first { $0.frameId == shot.id && $0.corner == 2 })
        model.moveMark(shotId: shot.id, corner: 2, toNative: Vec2(m.x + 30, m.y + 30))
        XCTAssertFalse(model.isMeasured, "a mark dragged 40 px off the corner fails the gates")
        XCTAssertEqual(model.draft?.usedMarks.filter { $0.source == .user }.count, 1)
        model.moveMark(shotId: shot.id, corner: 2, toNative: Vec2(m.x, m.y))
        XCTAssertTrue(model.isMeasured, "put back, it passes again")
        XCTAssertNotNil(model.finalWindow())
    }

    private func captureWithScan(_ h: StoreHarness, windowId: String) throws {
        let built = try build(windowId: windowId)
        var jpegs: [String: Data] = [:]
        for s in Self.shots { jpegs[s.id] = s.nativeJPEG }
        let scene = SampleScene.small
        let photo = PhotoPreparation.prepare(scene.image(withCard: false))
        let w = SampleScene.widthIn / inchesPerMetre, hh = SampleScene.heightIn / inchesPerMetre
        let scale = WindowPhotoScale.ar(ArScale(pointsM: [Vec3(0, hh, -1.5), Vec3(w, hh, -1.5), Vec3(w, 0, -1.5), Vec3(0, 0, -1.5)], trackingLostCount: 0, device: .arkitLidar, cornerSpreadM: [0.001, 0.001, 0.001, 0.001]))
        h.store.capture(scale: scale, corners: scene.frameCorners.map { Vec2(Double($0.x), Double($0.y)) }, jpeg: photo?.jpeg, widthPx: photo?.widthPx ?? 0, heightPx: photo?.heightPx ?? 0,
                        windowId: windowId, scan: HomeownerStore.StagedScan(draft: built.draft, jpegs: jpegs),
                        in: MeasureSession(method: .corners, room: "Kitchen", number: h.store.nextWindowNumber))
    }

    func testAScanWaitsForItsWindowThenGoesToTheServerOnce() async throws {
        let h = StoreHarness()
        try await h.open()
        let id = WindowIds.new()
        try captureWithScan(h, windowId: id)
        await h.store.scanStaging?.value
        var items = await h.store.scanOutbox.items
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items.first?.armed, false, "staged: nothing is sent while the window is still being named")
        await h.store.scanOutbox.syncAll()
        var scans = await h.fake.scans
        XCTAssertEqual(scans.count, 0)
        // Saved: the window's photo goes up, the window waits for its style, so its scan waits too
        await h.store.savePending(room: "Kitchen", name: "")
        await h.settle()
        await h.store.scanOutbox.syncAll()
        scans = await h.fake.scans
        XCTAssertEqual(scans.count, 0, "the window is not on the server yet")
        items = await h.store.scanOutbox.items
        XCTAssertEqual(items.first?.uploadIds.count, Self.shots.count, "every photo is up already")
        // The style is picked: the window goes, then the scan
        await h.store.setStyle("double-hung", for: id)
        await h.settle()
        await h.store.scanOutbox.syncAll()
        scans = await h.fake.scans
        XCTAssertEqual(scans.count, 1)
        let payload = try JSONDecoder().decode(WindowScanPayload.self, from: scans[0])
        XCTAssertEqual(payload.windowId, id)
        XCTAssertEqual(payload.frames.count, Self.shots.count)
        XCTAssertEqual(payload.result.status, .measured)
        XCTAssertNil(payload.problem)
        await h.store.scanOutbox.syncAll()
        let again = await h.fake.scans
        XCTAssertEqual(again.count, 1, "sent once")
    }

    func testAServerWithoutTheScanRouteKeepsTheScanQuietly() async throws {
        let h = StoreHarness()
        try await h.open()
        h.api.scansMissing = true
        let id = WindowIds.new()
        try captureWithScan(h, windowId: id)
        await h.store.scanStaging?.value
        await h.store.savePending(room: "Kitchen", name: "")
        await h.store.setStyle("double-hung", for: id)
        await h.settle()
        await h.store.scanOutbox.syncAll()
        let items = await h.store.scanOutbox.items
        XCTAssertEqual(items.first?.state, .waiting, "kept for later")
        XCTAssertNil(items.first?.lastError, "and nothing is said about it")
        XCTAssertEqual(h.store.notice?.kind, .info, "no error on the screen (only the window's own 'Saved')")
        XCTAssertFalse(h.store.notice?.text.lowercased().contains("scan") ?? false)
        XCTAssertEqual(h.store.windowRows.count, 1, "the window itself is saved and sent")
    }

    func testLeavingTheWindowOutDropsItsScan() async throws {
        let h = StoreHarness()
        try await h.open()
        try captureWithScan(h, windowId: WindowIds.new())
        await h.store.scanStaging?.value
        let staged = await h.store.scanOutbox.items
        XCTAssertEqual(staged.count, 1)
        h.store.discardPending()
        try await Task.sleep(nanoseconds: 200_000_000)
        let left = await h.store.scanOutbox.items
        XCTAssertEqual(left.count, 0)
    }
}
