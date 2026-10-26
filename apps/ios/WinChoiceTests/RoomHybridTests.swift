import CoreImage
import Foundation
import RooflineCore
import UIKit
import XCTest
@testable import WinChoice

/// The room-scan hybrid (pan, close-ups, Measure and check) on drawn data: the real marks pipeline runs on photos drawn of a made-up 35 5/8 x 59 5/8 in
/// window, starting from "Apple's" window a little too big and off to one side. RoomPlan and the camera are not here (the simulator has neither): the
/// model is driven the way the pan and the camera drive it, with plain values.
@MainActor
final class RoomHybridTests: XCTestCase {
    private static let frames = DebugHybridScene.panFrames()
    private static let closeups = DebugHybridScene.closeups()

    private func model(room: String = "Bedroom 1") -> RoomHybridModel {
        DebugHybridScene.model(room: room)
    }

    // MARK: The pan's photos

    func testAPanPhotoTurnsUprightAgainLikeTheCamerasOwn() throws {
        let view = DebugScanScene.view(at: Vec3(0, 1.45, 0.1), look: DebugScanScene.centre)
        let upright = DebugScanScene.render(view)
        let native = try XCTUnwrap(DebugHybridScene.native(of: upright))
        let turned = try XCTUnwrap(FrameCapture.uprightJPEG(fromNative: native))
        XCTAssertEqual(turned.1, 720)
        XCTAssertEqual(turned.2, 960)
        // the same picture: compare a coarse grey grid
        func grid(_ data: Data) throws -> [Double] {
            let ci = try XCTUnwrap(CIImage(data: data))
            let ctx = CIContext()
            var px = [UInt8](repeating: 0, count: 12 * 16 * 4)
            ctx.render(ci.transformed(by: CGAffineTransform(scaleX: 12 / ci.extent.width, y: 16 / ci.extent.height)), toBitmap: &px, rowBytes: 12 * 4,
                       bounds: CGRect(x: 0, y: 0, width: 12, height: 16), format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
            return stride(from: 0, to: px.count, by: 4).map { Double(px[$0]) }
        }
        let a = try grid(try XCTUnwrap(upright.jpegData(compressionQuality: 0.9))), b = try grid(turned.0)
        let diff = zip(a, b).map { abs($0 - $1) }.reduce(0, +) / Double(a.count)
        XCTAssertLessThan(diff, 6, "the upright copy of the native photo is the drawn picture, not turned the wrong way")
    }

    // MARK: Apple's window to a measured window

    func testAppleSWindowStartsAScanThatMeasuresTheDrawnWindowWithinASixteenth() throws {
        let corners = DebugHybridScene.appleCorners()
        let estimate = try XCTUnwrap(HybridEstimate(cornersM: corners, widthM: corners[0].distance(to: corners[1]), heightM: corners[0].distance(to: corners[3]), confidence: .high,
                                                    basis: .dimensions, viewer: Vec3(0, 1.45, 0.1)))
        let ids = PanFrameSelector.select(Self.frames.map { $0.meta }, corners: estimate.cornersM)
        XCTAssertGreaterThanOrEqual(ids.count, 3, "the pan's photos see the window")
        let pan = ids.compactMap { id in Self.frames.first { $0.id == id } }
        let built = try XCTUnwrap(HybridScanBuilder.build(estimate: estimate, windowId: WindowIds.new(), scanId: "s", pan: pan, closeups: Self.closeups))
        let s = built.draft.solution
        XCTAssertEqual(s.widthIn ?? 0, SampleScene.widthIn, accuracy: 1.0 / 16, "\(s.quality)")
        XCTAssertEqual(s.heightIn ?? 0, SampleScene.heightIn, accuracy: 1.0 / 16, "\(s.quality)")
        XCTAssertEqual(s.status, .measured, "\(s.quality)")
        XCTAssertEqual(s.quality.closeups, 4)
        XCTAssertTrue(built.draft.usedMarks.allSatisfy { $0.source != .projected })
        // Apple's guess about the key photo is not evidence on its own
        XCTAssertEqual(built.shots.first?.kind, .regular, "the key photo is a regular photo")
        XCTAssertEqual(built.shots.map { $0.id }, (1...built.shots.count).map { "f\($0)" }, "photos are numbered f1 ... in order")
    }

    // MARK: The flow

    func testThePanListCloseupsMeasureAndResultsFlow() async throws {
        let m = model()
        XCTAssertEqual(m.flow.stage, .windows, "Apple built the room: the list of windows")
        XCTAssertEqual(m.flow.items.map { $0.letter }, ["A", "B", "C", "D"])
        XCTAssertEqual(m.flow.items.map { $0.measurable }, [true, true, false, true], "the pan saw A, B and D; no photo saw C")
        XCTAssertFalse(m.flow.canMeasure, "no close-ups yet: the button is off, however many pan photos there are")
        let (a, b, c, d) = (m.flow.items[0].id, m.flow.items[1].id, m.flow.items[2].id, m.flow.items[3].id)
        m.openCloseups(c)
        XCTAssertEqual(m.flow.stage, .windows, "a window the pan did not see takes no close-ups")
        // close-ups in any order: B first, then A
        m.debugCloseups(b, DebugHybridScene.closeups([2, 3]))
        XCTAssertEqual(m.flow.stage, .windows)
        XCTAssertEqual(m.flow.item(b)?.closeups, [false, false, true, true])
        XCTAssertTrue(m.flow.canMeasure)
        m.debugCloseups(a, DebugHybridScene.closeups())
        XCTAssertTrue(m.flow.item(a)?.isFinished == true)
        m.setSkipped(d, true)
        XCTAssertEqual(m.flow.qualifying.map { $0.id }, [a, b])
        // Measure and check
        await m.measureAndCheck()
        XCTAssertEqual(m.flow.stage, .results)
        XCTAssertEqual(m.flow.item(a)?.outcome, .measured, "window A was measured from its photos and close-ups")
        XCTAssertNotNil(m.window(a)?.scan)
        XCTAssertEqual(m.flow.item(d)?.outcome, .appleSize, "the skipped window keeps Apple's size")
        XCTAssertEqual(m.flow.item(c)?.outcome, .appleSize, "so does the one the pan did not see")
        XCTAssertNil(m.window(c)?.scan)
        XCTAssertNil(m.window(d)?.scan)
        XCTAssertNotNil(m.flow.item(b)?.outcome)
        // the size shown for a measured window is the scan's: the drawn window's, not Apple's (1.4 cm too big)
        let sizeA = m.size(of: try XCTUnwrap(m.window(a)))
        XCTAssertTrue(sizeA.fromScan)
        XCTAssertEqual(sizeA.widthIn, SampleScene.widthIn, accuracy: 1.0 / 16)
        let sizeC = m.size(of: try XCTUnwrap(m.window(c)))
        XCTAssertFalse(sizeC.fromScan)
        XCTAssertEqual(sizeC.widthIn, m.window(c)?.estimate.widthIn ?? 0, accuracy: 1e-9)
        // back to the list for more close-ups clears the results but keeps the close-ups
        m.reopenList()
        XCTAssertEqual(m.flow.stage, .windows)
        XCTAssertNil(m.window(a)?.scan)
        XCTAssertEqual(m.window(a)?.closeups.count, 4)
    }

    func testEachScannedWindowGoesOutAsAValidScanForItsOwnWindow() async throws {
        let m = model()
        let (a, b) = (m.flow.items[0].id, m.flow.items[1].id)
        m.debugCloseups(a, DebugHybridScene.closeups())
        m.debugCloseups(b, DebugHybridScene.closeups())
        await m.measureAndCheck()
        let items = m.saveItems()
        XCTAssertEqual(items.count, 4, "every window of the list is saved: two scanned, two with Apple's size")
        XCTAssertEqual(items.filter { $0.staged != nil }.count, 2)
        for item in items {
            guard let staged = item.staged else {
                guard case .roomplan = item.scale else { return XCTFail("a window nobody measured further is sent as Apple's roomplan size") }
                continue
            }
            XCTAssertEqual(staged.draft.windowId, item.windowId, "the scan belongs to the window it is saved with")
            // every photo has its JPEG, and the body the server reads is within its limits
            XCTAssertEqual(Set(staged.jpegs.keys), Set(staged.draft.frames.map { $0.frameId }))
            let uploads = Dictionary(uniqueKeysWithValues: staged.draft.frames.map { ($0.frameId, "up-\($0.frameId)") })
            let payload = try XCTUnwrap(staged.draft.payload(uploadIds: uploads, app: "test", device: "iPhone"))
            XCTAssertNil(payload.problem)
            XCTAssertGreaterThanOrEqual(payload.frames.count, ScanLimits.minFrames)
            XCTAssertTrue(payload.frames.contains { $0.kind == .closeup }, "close-ups ride along")
            XCTAssertTrue(payload.frames.contains { $0.kind == .regular }, "the pan's photos ride along")
            XCTAssertNoThrow(try payload.json())
            // the photo the window keeps is one of the scan's, with the opening drawn in it
            XCTAssertEqual(item.corners?.count, 4)
            XCTAssertNotNil(item.jpeg)
            XCTAssertEqual(item.name.hasPrefix("Bedroom 1, window "), true)
        }
        // the measured one is sent as an AR window from the depth-sensor phone; the other kept Apple's size only if the scan was far from it
        let first = try XCTUnwrap(items.first)
        if first.usesScan {
            guard case .ar(let ar) = first.scale else { return XCTFail("a scan that may be used is an AR window") }
            XCTAssertEqual(ar.device, .arkitLidar)
            XCTAssertEqual(ar.pointsM.count, 4)
        }
    }

    func testAWindowLeftOutOfTheListIsNotSavedAndOneWithoutCloseupsKeepsAppleSSize() async throws {
        let m = model()
        let (a, b, c) = (m.flow.items[0].id, m.flow.items[1].id, m.flow.items[2].id)
        m.debugCloseups(a, DebugHybridScene.closeups())
        m.setIncluded(b, false)
        await m.measureAndCheck()
        let items = m.saveItems().filter { $0.windowId != m.flow.items[3].id }
        XCTAssertEqual(items.map { $0.windowId }, [a, c], "B was left out")
        XCTAssertNil(items[1].staged, "no close-ups: no scan")
        guard case .roomplan(let apple) = items[1].scale else { return XCTFail("Apple's size") }
        XCTAssertEqual(apple.widthM, m.window(c)?.estimate.widthM ?? 0, accuracy: 1e-9)
    }

    func testNoWindowsFoundIsItsOwnEnd() {
        let m = RoomHybridModel(room: "Den")
        m.panBuilt([], frames: [])
        XCTAssertEqual(m.flow.stage, .empty)
        XCTAssertFalse(m.flow.canMeasure)
    }

    // MARK: Saving

    func testSavingGoesThroughTheOutboxAndTheScanOutboxLikeAnyOtherWindow() async throws {
        let h = StoreHarness()
        try await h.open()
        let m = model(room: "Kitchen")
        let (a, b) = (m.flow.items[0].id, m.flow.items[1].id)
        m.debugCloseups(a, DebugHybridScene.closeups())
        m.debugCloseups(b, DebugHybridScene.closeups([0, 1, 2]))
        await m.measureAndCheck()
        let items = m.saveItems()
        await h.store.saveRoomHybrid(items, room: "Kitchen")
        await h.settle()
        await h.store.refresh()
        XCTAssertEqual(h.store.windowRows.count, 4)
        XCTAssertEqual(Set(h.store.windowRows.map { $0.id }), Set(items.map { $0.windowId }))
        XCTAssertTrue(h.store.rooms.contains("Kitchen"))
        XCTAssertEqual(h.store.notice?.kind, .info)
        let queued = await h.store.scanOutbox.items
        XCTAssertEqual(queued.count, 2, "the two scanned windows have their scan saved")
        XCTAssertTrue(queued.allSatisfy { $0.armed }, "armed with the window: it goes up once the window is on the server")
        XCTAssertEqual(Set(queued.map { $0.windowId }), Set(items.filter { $0.staged != nil }.map { $0.windowId }))
        // the windows wait for their style, and the scans wait for the windows; picking the styles sends both
        await h.store.setStyleForAll("double-hung")
        await h.settle()
        await h.store.scanOutbox.syncAll()
        let sent = await h.fake.scans
        XCTAssertEqual(sent.count, 2)
        for body in sent {
            let payload = try JSONDecoder().decode(WindowScanPayload.self, from: body)
            XCTAssertNil(payload.problem)
            XCTAssertTrue(items.contains { $0.windowId == payload.windowId })
        }
    }

    // MARK: The method

    func testTheHybridIsTheRecommendedWayOnADepthSensorPhoneAndTheAppleScansAreAsTheyWere() {
        let pro = StoreHarness(capabilities: .depthSensorPhone("iPhone 15 Pro")).store
        XCTAssertTrue(pro.isAvailable(.roomCloseups))
        XCTAssertEqual(pro.defaultMethod, .roomCloseups)
        XCTAssertEqual(pro.methodTag(.roomCloseups).text, "Most exact (recommended)")
        XCTAssertTrue(pro.methodTag(.roomCloseups).best)
        XCTAssertTrue(MeasureMethod.roomCloseups.usesRoomPlan)
        XCTAssertFalse(MeasureMethod.roomCloseups.isRoomPlan, "Apple's sizes only are the two other room scans")
        // "Quick scan (Apple)" and "Scan the whole room" are exactly as before
        XCTAssertTrue(pro.isAvailable(.quickScan))
        XCTAssertEqual(pro.methodTag(.quickScan).text, "Recommended for speed")
        XCTAssertEqual(pro.methodAccuracy(.quickScan).text, "Good for a quote")
        XCTAssertEqual(pro.methodTag(.roomScan).text, "Every window in the room")
        let basic = StoreHarness(capabilities: MeasureCapabilities(deviceName: "iPhone 14", corners: true, depthSensor: false, roomScan: false, camera: true)).store
        XCTAssertFalse(basic.isAvailable(.roomCloseups))
        XCTAssertNotEqual(basic.defaultMethod, .roomCloseups)
        XCTAssertEqual(MeasureMethod(rawValue: "roomCloseups"), .roomCloseups)
    }

    func testTheMethodScreenStartsOnTheRecommendedWayOnlyTheFirstTime() {
        let pro = StoreHarness(capabilities: .depthSensorPhone("iPhone 15 Pro")).store
        pro.method = .corners
        pro.selectStartingMethod()
        XCTAssertEqual(pro.method, .roomCloseups, "nothing remembered: the recommended way is selected")
        // a way already in use stays selected
        let remembered = StoreHarness(capabilities: .depthSensorPhone("iPhone 15 Pro")).store
        remembered.progress.lastMethod = MeasureMethod.quickScan.rawValue
        remembered.method = .quickScan
        remembered.selectStartingMethod()
        XCTAssertEqual(remembered.method, .quickScan)
        // a way this phone cannot do is never kept
        let basic = StoreHarness(capabilities: MeasureCapabilities(deviceName: "iPhone 14", corners: true, depthSensor: false, roomScan: false, camera: true)).store
        basic.method = .roomCloseups
        basic.selectStartingMethod()
        XCTAssertNotEqual(basic.method, .roomCloseups)
    }
}
