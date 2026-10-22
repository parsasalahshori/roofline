import CoreGraphics
import RooflineCore
import UIKit
import XCTest
@testable import WinChoice

/// Two sizes for one photo-measured window: the OPENING (what is measured, shown big and sent) and the WINDOW's own frame just inside it
/// (shown next to it, kept on the phone, never sent). The finder itself is checked in RooflineCore's checks; here is how the screens and the
/// store carry it: the editor's card and outline, the list row, the label sheet's numbers, the phone's own memory of it.
@MainActor
final class TwoSizesTests: XCTestCase {
    private func image(_ c: FrozenCapture) throws -> CGImage { try XCTUnwrap(UIImage(data: c.jpeg)?.cgImage) }

    private func found(_ two: (capture: FrozenCapture, opening: FrozenRect)) throws -> FreezeFrameFound {
        let cg = try image(two.capture)
        let f = try XCTUnwrap(WindowFrameFinder.find(opening: two.opening, view: two.capture.view, photo: { x, y, w, h in PhotoSnap.gray(cg, x: x, y: y, width: w, height: h) }),
                              "the frame 1.75 cm inside the sample opening is found")
        return FreezeFrameFound(opening: two.opening, found: f)
    }

    func testTheEditorShowsTheOpeningAndTheWindowInsideItAndSendsTheOpening() throws {
        let two = try XCTUnwrap(SampleFrozen.twoSizes())
        let frame = try found(two)
        // The frame is about 3.5 cm narrower and shorter than the opening: 1 3/8 in
        let editing = FreezeEditing(capture: two.capture, earlier: [], rect: two.opening, frame: frame)
        let opening = try XCTUnwrap(editing.sent)
        let window = try XCTUnwrap(editing.windowSize)
        XCTAssertEqual(opening.widthIn, SampleScene.widthIn, accuracy: 0.3)
        XCTAssertEqual(window.widthIn, opening.widthIn - 0.035 * inchesPerMetre, accuracy: 0.2)
        XCTAssertEqual(window.heightIn, opening.heightIn - 0.035 * inchesPerMetre, accuracy: 0.2)
        XCTAssertEqual(window.line, "Window about \(SizeWording.sizeText(widthIn: window.widthIn, heightIn: window.heightIn))")
        // The dashed outline is inside the yellow one on every side
        XCTAssertEqual(editing.windowOutline.count, 4)
        let (xs, ys) = (editing.outline.map(\.x), editing.outline.map(\.y))
        for p in editing.windowOutline {
            XCTAssertGreaterThan(p.x, xs.min()! - 0.5); XCTAssertLessThan(p.x, xs.max()! + 0.5)
            XCTAssertGreaterThan(p.y, ys.min()! - 0.5); XCTAssertLessThan(p.y, ys.max()! + 0.5)
        }
        XCTAssertGreaterThan(editing.windowOutline[0].x, editing.outline[0].x + 5, "TL is in from the opening's TL")
        // What the plates say and what is sent is the opening's: nothing about the window changes it
        XCTAssertEqual(editing.plates.map(\.inches), [opening.widthIn, opening.heightIn])
        XCTAssertEqual(opening.windowFrame, nil)
        // Not found for THIS rectangle (the person dragged since): no window line, no dashed outline
        var moved = two.opening
        moved.left -= 0.05
        let stale = FreezeEditing(capture: two.capture, earlier: [], rect: moved, frame: frame)
        XCTAssertNotNil(stale.sent)
        XCTAssertEqual(stale.windowSize?.estimated, true, "a frame found for another rectangle is not used: estimated instead")
        XCTAssertTrue(stale.windowOutline.isEmpty)
        // No frame found at all: the opening, and the window estimated from a typical 1.75 cm frame (said to be an estimate)
        let alone = FreezeEditing(capture: two.capture, earlier: [], rect: two.opening)
        XCTAssertEqual(alone.windowSize?.estimated, true)
        XCTAssertEqual(alone.windowSize?.widthIn ?? 0, (alone.sent?.widthIn ?? 0) - 0.035 * inchesPerMetre, accuracy: 1e-9)
        XCTAssertTrue(alone.windowSize.map(TwoSizes.windowLine)?.hasSuffix("(estimated)") ?? false)
        XCTAssertEqual(alone.sent?.widthIn, opening.widthIn)
    }

    func testTheStandardSizeLineGoesByTheWindowWhenThereIsOneElseTheOpening() throws {
        let two = try XCTUnwrap(SampleFrozen.twoSizes())
        let withFrame = FreezeEditing(capture: two.capture, earlier: [], rect: two.opening, frame: try found(two))
        let without = FreezeEditing(capture: two.capture, earlier: [], rect: two.opening)
        let window = try XCTUnwrap(withFrame.windowSize)
        XCTAssertEqual(withFrame.standardSize, StandardWindowSizes.suggestion(widthIn: window.widthIn, heightIn: window.heightIn))
        XCTAssertEqual(without.standardSize, StandardWindowSizes.suggestion(widthIn: without.widthIn ?? 0, heightIn: without.heightIn ?? 0))
        // The list row too: a 36 x 60 opening with a 24 x 36 window inside it is a 24 x 36 window; without the window it is by the opening
        var row = WindowRow(id: "w", number: 1, room: "Kitchen", name: nil, style: nil, widthIn: 24.5, heightIn: 36.5, uncertaintyIn: 0.2, needsCheck: false, reasons: [],
                            scale: .roomplan(RoomPlanScale(widthM: 1, heightM: 1, confidence: .high)), send: .sent)
        let byOpening = row.standardSizeLine
        row.windowFrame = WindowFrameSize(widthIn: 23.25, heightIn: 35.25)
        XCTAssertEqual(row.standardSizeLine, StandardWindowSizes.line(widthIn: 23.25, heightIn: 35.25))
        XCTAssertEqual(row.windowSizeLine, "Window about 23 1/4 × 35 1/4 in")
        XCTAssertEqual(row.spokenWindowSize, "Window about 23 and a quarter by 35 and a quarter inches")
        row.windowFrame = nil
        XCTAssertEqual(row.standardSizeLine, byOpening)
        XCTAssertNil(row.windowSizeLine)
        // A row with no size yet shows no window line
        row.windowFrame = WindowFrameSize(widthIn: 23, heightIn: 35)
        row.widthIn = nil
        XCTAssertNil(row.windowSizeLine)
    }

    func testTheWindowsFrameIsKeptOnThePhoneByWindowIdAndNeverSent() async throws {
        let h = StoreHarness()
        try await h.open()
        let two = try XCTUnwrap(SampleFrozen.twoSizes())
        let frame = try found(two)
        let opening = try XCTUnwrap(FrozenMeasure.measure(rect: two.opening, view: two.capture.view))
        let size = try XCTUnwrap(frame.found.size(inOpening: opening))
        let scale = WindowPhotoScale.ar(ArScale(pointsM: opening.windowPointsM, trackingLostCount: 0, device: .arkitLidar, cornerSpreadM: opening.windowSpreadM))
        let session = MeasureSession(method: .corners, room: "Bedroom 1", number: 1)
        h.store.capture(scale: scale, corners: nil, jpeg: nil, widthPx: 0, heightPx: 0, windowFrame: size, in: session)
        let pending = try XCTUnwrap(h.store.pending)
        XCTAssertEqual(pending.windowFrame, size)
        // The pending window is on disk at once, with its frame (the app may be closed before "Save")
        let restored = try XCTUnwrap(h.store.pendingDisk.load(requestId: try XCTUnwrap(h.store.requestId)))
        XCTAssertEqual(restored.windowFrame, size)
        await h.store.savePending(room: "Bedroom 1", name: "")
        await h.settle()
        let row = try XCTUnwrap(h.store.windowRows.first { $0.id == pending.id })
        XCTAssertEqual(row.windowFrame, size)
        XCTAssertEqual(row.windowSizeLine, size.line)
        // What the server is sent is the opening: the scale's own four points, and nothing in the window's body names the frame
        let sent = try await h.store.outbox.items.first { $0.id == pending.id }.map { try JSONEncoder().encode($0.window) }
        let json = try XCTUnwrap(sent.flatMap { String(data: $0, encoding: .utf8) })
        XCTAssertFalse(json.localizedCaseInsensitiveContains("windowFrame"), json)
        XCTAssertFalse(json.contains("Window about"), json)
        // A style change makes a copy under a new id: its frame goes with it; a removed window's goes
        await h.store.setStyle("double-hung", for: pending.id)
        await h.settle()
        await h.store.refresh()
        let after = try XCTUnwrap(h.store.windowRows.first)
        XCTAssertEqual(after.windowFrame, size, "the copy has the frame")
        await h.store.removeWindow(after.id)
        XCTAssertNil(h.store.progress.windowFrames[after.id])
    }

    func testProgressWrittenBeforeThereWereTwoSizesStillReads() throws {
        let old = #"{"step":"list","rooms":["Kitchen"],"colors":{},"hasContact":false,"windowCount":1}"#.data(using: .utf8)!
        let progress = try JSONDecoder().decode(HomeownerProgress.self, from: old)
        XCTAssertEqual(progress.windowFrames, [:])
        var saved = HomeownerProgress()
        saved.windowFrames["w-1"] = WindowFrameSize(widthIn: 33.25, heightIn: 54.375)
        let again = try JSONDecoder().decode(HomeownerProgress.self, from: JSONEncoder().encode(saved))
        XCTAssertEqual(again.windowFrames["w-1"], WindowFrameSize(widthIn: 33.25, heightIn: 54.375))
    }
}
