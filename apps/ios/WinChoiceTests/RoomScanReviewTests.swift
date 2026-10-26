import RooflineCore
import UIKit
import XCTest
@testable import WinChoice

/// The room scan's review (Apple's RoomPlan): which windows are kept, the room they go in, the sizes shown, and that what is kept goes
/// through the same outbox as every other measured window. RoomPlan itself cannot run in the simulator; its rules are in the Core checks.
@MainActor
final class RoomScanReviewTests: XCTestCase {
    private func row(_ letter: String, w: Double = 0.9, h: Double = 1.2, room: String = "Kitchen", confidence: RoomPlanConfidence = .high, included: Bool = true) -> ScanReviewRow {
        ScanReviewRow(id: UUID(), letter: letter, name: "Window \(letter)", room: room, included: included, widthM: w, heightM: h, confidence: confidence, styleKey: nil, photo: nil)
    }

    // MARK: Keep and drop

    func testALeftOutWindowIsNotAdded() {
        var model = ScanReviewModel(roomName: "Kitchen", rows: [row("A"), row("B"), row("C")])
        XCTAssertEqual(model.included.count, 3)
        XCTAssertEqual(model.addTitle, "Add 3 windows to Kitchen")
        model.toggle(model.rows[1].id)
        XCTAssertEqual(model.included.map { $0.letter }, ["A", "C"])
        XCTAssertEqual(model.addTitle, "Add 2 windows to Kitchen")
        model.toggle(model.rows[0].id)
        XCTAssertEqual(model.addTitle, "Add 1 window to Kitchen")
        model.toggle(model.rows[2].id)
        XCTAssertTrue(model.included.isEmpty)
        XCTAssertEqual(model.addTitle, "Add windows to Kitchen", "nothing kept: the button has nothing to add")
        model.toggle(model.rows[1].id)
        XCTAssertEqual(model.included.map { $0.letter }, ["B"], "a window left out can be taken back in")
        model.toggle(UUID())
        XCTAssertEqual(model.included.count, 1, "a window that is not in the list changes nothing")
    }

    func testTheTitleCountsWhatTheScanFound() {
        XCTAssertEqual(ScanReviewModel(roomName: "Hall", rows: []).title, "We didn't find a window")
        XCTAssertEqual(ScanReviewModel(roomName: "Hall", rows: [row("A")]).title, "We found 1 window")
        XCTAssertEqual(ScanReviewModel(roomName: "Hall", rows: [row("A"), row("B")]).title, "We found 2 windows")
        var model = ScanReviewModel(roomName: "Hall", rows: [row("A"), row("B")])
        model.toggle(model.rows[0].id)
        XCTAssertEqual(model.title, "We found 2 windows", "leaving one out does not change what was found")
    }

    // MARK: The room

    func testNamingTheRoomMovesTheWindowsStillInIt() {
        var model = ScanReviewModel(roomName: "Bedroom 1", rows: [row("A", room: "Bedroom 1"), row("B", room: "Bedroom 1"), row("C", room: "Hall")])
        XCTAssertTrue(model.rename(to: "  Guest   room "))
        XCTAssertEqual(model.roomName, "Guest room", "trimmed, one space between words")
        XCTAssertEqual(model.rows.map { $0.room }, ["Guest room", "Guest room", "Hall"], "a window moved on its own stays where it was put")
        XCTAssertEqual(model.addTitle, "Add 3 windows to Guest room")
    }

    func testABlankRoomNameChangesNothing() {
        var model = ScanReviewModel(roomName: "Kitchen", rows: [row("A")])
        XCTAssertFalse(model.rename(to: "   "))
        XCTAssertEqual(model.roomName, "Kitchen")
        XCTAssertEqual(model.rows[0].room, "Kitchen")
    }

    func testOneWindowCanGoToAnotherRoomAndStaysThereWhenTheRoomIsRenamed() {
        var model = ScanReviewModel(roomName: "Kitchen", rows: [row("A"), row("B")])
        model.move(model.rows[1].id, to: "Dining room")
        XCTAssertEqual(model.rows.map { $0.room }, ["Kitchen", "Dining room"])
        model.rename(to: "Galley")
        XCTAssertEqual(model.rows.map { $0.room }, ["Galley", "Dining room"])
        model.move(model.rows[0].id, to: "  ")
        XCTAssertEqual(model.rows[0].room, "Galley", "a blank room name is not a move")
    }

    // MARK: Sizes

    func testSizesAreShownToTheEighthLikeTheRestOfTheApp() {
        // 0.9 m = 35.433 in, 1.2 m = 47.244 in; 0.6 m = 23.622 in, 0.9 m = 35.433 in
        XCTAssertEqual(row("A").sizeText, "35 3/8 × 47 1/4 in")
        XCTAssertEqual(row("B", w: 0.6, h: 0.9).sizeText, "23 5/8 × 35 3/8 in")
        XCTAssertEqual(row("C", w: 36 / inchesPerMetre, h: 60 / inchesPerMetre).sizeText, "36 × 60 in", "whole inches stay whole")
    }

    func testTheWordsNeverClaimANumberOfInches() {
        for c in RoomPlanConfidence.allCases {
            let line = ScanWording.sourceLine(c)
            XCTAssertTrue(line.hasPrefix("Apple's scan"), line)
            XCTAssertNil(line.range(of: "[0-9±]", options: .regularExpression), "no accuracy number in '\(line)'")
        }
        XCTAssertEqual(ScanWording.confirmLine, "Apple's scan. We confirm every size at your visit.")
    }

    // MARK: What is saved

    func testWhatIsKeptIsSavedAsTheScanSawIt() {
        let a = row("A", w: 0.9, h: 1.2, room: "Kitchen", confidence: .medium)
        let corners = [Vec2(10, 10), Vec2(90, 10), Vec2(90, 120), Vec2(10, 120)]
        let withPhoto = a.scannedWindow(multiple: true, photo: (jpeg: Data([1, 2, 3]), widthPx: 100, heightPx: 150, corners: corners))
        XCTAssertEqual(withPhoto.name, "Kitchen, window A")
        XCTAssertEqual(withPhoto.widthM, 0.9)
        XCTAssertEqual(withPhoto.heightM, 1.2)
        XCTAssertEqual(withPhoto.confidence, .medium, "the confidence is Apple's own, not raised")
        XCTAssertEqual(withPhoto.corners, corners)
        XCTAssertEqual(withPhoto.imageWidthPx, 100)
        XCTAssertEqual(withPhoto.room, "Kitchen")
        let alone = a.scannedWindow(multiple: false, photo: nil)
        XCTAssertEqual(alone.name, "", "a single window is not named")
        XCTAssertNil(alone.jpeg)
        XCTAssertNil(alone.corners, "no photo, no outline: nothing is made up")
    }

    func testTheWindowsKeptGoThroughTheOutboxLikeAnyOther() async throws {
        let h = StoreHarness()
        try await h.open()
        var model = ScanReviewModel(roomName: "Bedroom 1", rows: [row("A"), row("B", w: 0.6, h: 0.9, confidence: .low), row("C")].map { var r = $0; r.room = "Bedroom 1"; return r })
        model.toggle(model.rows[2].id)
        model.rename(to: "Den")
        let chosen = model.included
        let list = chosen.map { $0.scannedWindow(multiple: chosen.count > 1, photo: nil) }
        await h.store.saveScanned(list, room: chosen.first?.room ?? "Den")
        await h.settle()
        await h.store.refresh()
        let rows = h.store.windowRows
        XCTAssertEqual(rows.count, 2, "the window that was left out is not saved")
        XCTAssertEqual(rows.map { $0.room }, ["Den", "Den"])
        XCTAssertTrue(h.store.rooms.contains("Den"), "the room the person named is in the home's rooms")
        for r in rows {
            guard case .roomplan = r.scale else { return XCTFail("a room scan window is sent as scale kind roomplan") }
        }
        XCTAssertEqual(Set(rows.map { $0.sizeTextWithUnit }), ["35 3/8 × 47 1/4 in", "23 5/8 × 35 3/8 in"])
    }

    // MARK: The method screen

    func testQuickScanNeedsTheDepthSensorLikeTheWholeRoomScan() {
        let pro = StoreHarness(capabilities: .depthSensorPhone("iPhone 15 Pro")).store
        XCTAssertTrue(pro.isAvailable(.quickScan))
        XCTAssertTrue(pro.isAvailable(.roomScan))
        let basic = StoreHarness(capabilities: MeasureCapabilities(deviceName: "iPhone 14", corners: true, depthSensor: false, roomScan: false, camera: true)).store
        XCTAssertFalse(basic.isAvailable(.quickScan))
        XCTAssertTrue(MeasureMethod.quickScan.isRoomPlan)
        XCTAssertTrue(MeasureMethod.roomScan.isRoomPlan)
        XCTAssertFalse(MeasureMethod.corners.isRoomPlan)
        XCTAssertEqual(MeasureMethod(rawValue: "quickScan"), .quickScan, "the last method is kept by this name")
    }

    func testTheRoomScanCardsPromiseASpeedNotAnAccuracy() {
        let pro = StoreHarness(capabilities: .depthSensorPhone("iPhone 15 Pro")).store
        XCTAssertEqual(pro.methodTag(.quickScan).text, "Recommended for speed")
        XCTAssertEqual(pro.methodAccuracy(.quickScan).text, "Good for a quote")
        XCTAssertEqual(pro.methodAccuracy(.roomScan).text, "Good for a quote")
        XCTAssertEqual(pro.defaultMethod, .roomCloseups, "the room scan with close-ups is the one it starts on (the quick scan is one tap away)")
    }
}
