import Foundation
import RooflineCore
import XCTest
@testable import WinChoice

/// How windows are listed and worded: one list from the server's windows and the phone's, whole inches and eighths, accuracy that
/// is never a bare plus-or-minus.
@MainActor
final class WindowRowTests: XCTestCase {
    private func row(scale: WindowPhotoScale, uncertainty: Double?, needsCheck: Bool) -> WindowRow {
        WindowRow(id: "w", number: 1, room: "Kitchen", name: nil, style: "double-hung", widthIn: 35.625, heightIn: 59.625, uncertaintyIn: uncertainty,
                  needsCheck: needsCheck, reasons: [], scale: scale, send: .sent)
    }

    private let cardScale = WindowPhotoScale.card(CardScale(cardCorners: [Vec2(0, 0), Vec2(10, 0), Vec2(10, 6), Vec2(0, 6)]))
    private let scanScale = WindowPhotoScale.roomplan(RoomPlanScale(widthM: 1, heightM: 1.2, confidence: .medium))
    private let arScale = WindowPhotoScale.ar(ArScale(pointsM: [Vec3(0, 1, -1), Vec3(1, 1, -1), Vec3(1, 0, -1), Vec3(0, 0, -1)], trackingLostCount: 0, device: .arkitLidar, cornerSpreadM: nil))

    // MARK: One list

    func testTheServersWindowsComeFirstThenTheOnesStillOnThePhone() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("rows-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let outbox = Outbox(directory: dir, transport: NoTransport())
        let onServer = FakeWindowSpec.mockupSeven[1].window(id: "on-server")
        let waiting = PhotoWindowInput(id: "still-here", uploadId: "up-1", label: "Hall, back", windowKey: nil, corners: nil, scale: scanScale, room: "Hall", style: nil)
        let sent = PhotoWindowInput(id: "on-server", uploadId: nil, label: nil, windowKey: nil, corners: nil, scale: scanScale, room: "Kitchen", style: "double-hung")
        _ = try await outbox.enqueue(window: waiting, measurementId: "req", address: nil, jpeg: nil, imageWidthPx: 0, imageHeightPx: 0, held: true)
        _ = try await outbox.enqueue(window: sent, measurementId: "req", address: nil, jpeg: nil, imageWidthPx: 0, imageHeightPx: 0)
        let items = await outbox.items
        let rows = WindowRows.merge(server: [onServer], outbox: items)
        XCTAssertEqual(rows.map { $0.id }, ["on-server", "still-here"], "a window the server has is not listed twice")
        XCTAssertEqual(rows.map { $0.number }, [1, 2])
        XCTAssertEqual(rows[0].send, .sent)
        XCTAssertEqual(rows[1].send, .needsStyle, "held for its style")
        XCTAssertEqual(rows[1].title, "Hall, back", "the name the homeowner gave")
        XCTAssertEqual(rows[0].title, "Kitchen", "or the room")
    }

    // MARK: To check

    func testOnlyAClearlyPoorRoomScanOrCardWindowIsFlagged() {
        // The server marks every scan and card window "check" (quote-grade by design); that alone is not worth the homeowner's worry
        XCTAssertFalse(row(scale: scanScale, uncertainty: 1, needsCheck: true).flagged)
        XCTAssertTrue(row(scale: scanScale, uncertainty: 2, needsCheck: true).flagged)
        XCTAssertFalse(row(scale: cardScale, uncertainty: 0.5, needsCheck: true).flagged)
        XCTAssertTrue(row(scale: cardScale, uncertainty: 2.5, needsCheck: true).flagged)
        XCTAssertTrue(row(scale: arScale, uncertainty: 0.2, needsCheck: true).flagged, "an AR window the server marked is flagged")
        XCTAssertFalse(row(scale: arScale, uncertainty: 0.2, needsCheck: false).flagged)
        XCTAssertFalse(row(scale: scanScale, uncertainty: 5, needsCheck: false).flagged, "nothing is flagged unless the server said check")
    }

    func testARoomLineCountsTheWindowsAndTheOnesToCheck() {
        var rows = [row(scale: arScale, uncertainty: 0.1, needsCheck: false)]
        XCTAssertEqual(RoomSummary.line(for: "Kitchen", in: rows), "1 window measured")
        rows.append(row(scale: arScale, uncertainty: 0.5, needsCheck: true))
        XCTAssertEqual(RoomSummary.line(for: "kitchen", in: rows), "2 windows · 1 to check")
        XCTAssertEqual(RoomSummary.line(for: "Hall", in: rows), "Not started")
    }

    // MARK: Words

    func testSizesAreWholeInchesAndReducedEighths() {
        XCTAssertEqual(SizeWording.text(35.625), "35 5/8")
        XCTAssertEqual(SizeWording.text(35.5), "35 1/2", "never 35 4/8")
        XCTAssertEqual(SizeWording.text(35.75), "35 3/4")
        XCTAssertEqual(SizeWording.text(35.97), "36")
        XCTAssertEqual(SizeWording.text(36), "36")
        XCTAssertEqual(SizeWording.text(0.5), "1/2")
        XCTAssertEqual(SizeWording.sizeText(widthIn: 35.625, heightIn: 59.625), "35 5/8 × 59 5/8 in")
        let r = row(scale: arScale, uncertainty: 0.1, needsCheck: false)
        XCTAssertEqual(r.sizeText, "35 5/8 × 59 5/8")
        XCTAssertEqual(r.sizeTextWithUnit, "35 5/8 × 59 5/8 in")
        XCTAssertEqual(r.spokenSize, "35 and 5 eighths by 59 and 5 eighths inches")
        var unsized = r
        unsized.widthIn = nil
        XCTAssertEqual(unsized.sizeText, "Size after upload")
    }

    func testAccuracyIsRoundedUpAndNeverABareAboutPlusMinus() {
        XCTAssertEqual(SizeWording.accuracy(0.125), "about 1/8 inch")
        XCTAssertEqual(SizeWording.accuracy(0.13), "about 1/4 inch", "rounded up: the app never claims to be more exact than it measured")
        XCTAssertEqual(SizeWording.accuracy(0.6), "about 5/8 inch")
        XCTAssertEqual(SizeWording.accuracy(0.7), "about 3/4 inch")
        XCTAssertEqual(SizeWording.accuracy(1.5), "about 1 1/2 inches")
        XCTAssertEqual(SizeWording.accuracyShort(0.1), "about 1/8 in")
        XCTAssertEqual(SizeWording.plusMinus(1), "about ±1 in")
        XCTAssertEqual(SizeWording.plusMinusEach(1), "about ±1 in each")
        XCTAssertEqual(SizeWording.accuracyRange(lowIn: 0.25, highIn: 0.5), "About 1/4 to 1/2 inch")
        XCTAssertEqual(SizeWording.spokenAccuracy(0.125), "about an eighth of an inch")
    }

    func testTheStackedFractionIsSetTightAgainstTheWholeNumber() {
        // Whole number, raised numerator, slash, lowered denominator: "35" "5" "/" "8" with no space between
        XCTAssertEqual(String(SizeFormat.attributed(35.625, size: 20).characters), "355/8")
        XCTAssertEqual(String(SizeFormat.attributed(36, size: 20).characters), "36")
        XCTAssertEqual(String(SizeFormat.pair(35.625, 59.625, size: 20, unit: true).characters), "355/8\u{2005}×\u{2005}595/8 in")
    }

    func testEachMethodSaysWhatItCanDoInWholeWords() {
        let pro = StoreHarness(capabilities: .depthSensorPhone("iPhone 15 Pro")).store
        XCTAssertEqual(pro.methodAccuracy(.corners).text, "About 1/8 inch · best")
        XCTAssertTrue(pro.methodAccuracy(.corners).best)
        XCTAssertEqual(pro.methodAccuracy(.roomScan).text, "About 1 inch · good for a quote")
        XCTAssertEqual(pro.methodAccuracy(.card).text, "About 1/4 to 1/2 inch")
        let basic = StoreHarness(capabilities: MeasureCapabilities(deviceName: "iPhone 14", corners: true, depthSensor: false, roomScan: false, camera: true)).store
        XCTAssertEqual(basic.methodAccuracy(.corners).text, "About 3/8 inch")
        XCTAssertFalse(basic.methodAccuracy(.corners).best)
        for m in MeasureMethod.allCases {
            XCTAssertFalse(pro.methodAccuracy(m).text.contains("±"), "a plus-or-minus is only written after 'about'")
            XCTAssertFalse(pro.methodAccuracy(m).text.localizedCaseInsensitiveContains("lidar"), "'depth sensor', not LiDAR")
        }
    }

    func testTheMeasureMethodTheHomeownerStartsOnMatchesThePhone() {
        XCTAssertEqual(StoreHarness(capabilities: .depthSensorPhone("iPhone 15 Pro")).store.defaultMethod, .corners)
        XCTAssertEqual(StoreHarness(capabilities: MeasureCapabilities(deviceName: "iPhone 11", corners: true, depthSensor: false, roomScan: false, camera: true)).store.defaultMethod, .corners)
        XCTAssertEqual(StoreHarness(capabilities: MeasureCapabilities(deviceName: "iPhone SE", corners: false, depthSensor: false, roomScan: false, camera: true)).store.defaultMethod, .card)
        let basic = StoreHarness(capabilities: MeasureCapabilities(deviceName: "iPhone 11", corners: true, depthSensor: false, roomScan: false, camera: true)).store
        XCTAssertFalse(basic.isAvailable(.roomScan), "room scan needs the depth sensor")
        XCTAssertTrue(basic.isAvailable(.card))
    }

    func testTheStyleLabelsAreThePlainWordsTheServerUses() {
        XCTAssertEqual(HomeownerStore.styleLabel("double-hung"), "Double-hung")
        XCTAssertEqual(HomeownerStore.styleLabel("slider-2"), "Slider, 2 panes")
        XCTAssertEqual(HomeownerStore.styleLabel("picture"), "Picture (does not open)")
        XCTAssertEqual(StyleLabel.split("Casement (cranks open)").title, "Casement")
        XCTAssertEqual(StyleLabel.split("Casement (cranks open)").detail, "cranks open")
        XCTAssertEqual(StyleLabel.split("Arch top").detail, nil)
    }
}

/// An outbox transport that is never called (the rows tests only read the outbox's items).
struct NoTransport: OutboxTransport {
    func uploadPhoto(measurementId: String, jpeg: Data) async throws -> WindowPhotoUpload { throw TransportError(status: nil, message: "unused") }
    func appendWindow(measurementId: String, window: PhotoWindowInput) async throws { throw TransportError(status: nil, message: "unused") }
    func windowExists(measurementId: String, windowId: String) async throws -> Bool { false }
}
