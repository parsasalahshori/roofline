import CoreGraphics
import RooflineCore
import XCTest
@testable import WinChoice

/// The AR screen's side of the rectangle fit: where the magnifier sits, the words for a corner that looks off the frame, and the numbers
/// the dots show while one corner is placed again. The fit itself (equal sides, the server's sizing of the fitted corners, the flagged
/// corner) is checked in RooflineCore's checks; the live AR screen can only run on an iPhone.
final class RectangleFitHudTests: XCTestCase {
    private let width: CGFloat = 402
    private let topBarBottom: CGFloat = 181

    func testTheMagnifierStaysTopLeftWhenNoCornerIsUnderIt() {
        XCTAssertEqual(LoupePlacement.side(avoiding: [], topBarBottom: topBarBottom, screenWidth: width), .leading)
        // Corners lower down the window, and the top ones well to the right of the left box
        let far = [CGPoint(x: 220, y: 215), CGPoint(x: 330, y: 215), CGPoint(x: 330, y: 640), CGPoint(x: 220, y: 640)]
        XCTAssertEqual(LoupePlacement.side(avoiding: far, topBarBottom: topBarBottom, screenWidth: width), .leading)
    }

    func testACornerUnderTheMagnifierMovesItToTheOtherSide() {
        // The owner's case: corner 1 under the magnifier at the top left
        let topLeft = [CGPoint(x: 76, y: 215), CGPoint(x: 220, y: 640)]
        XCTAssertEqual(LoupePlacement.side(avoiding: topLeft, topBarBottom: topBarBottom, screenWidth: width), .trailing)
        // A corner under the right side is no reason to move it there
        let topRight = [CGPoint(x: 325, y: 215)]
        XCTAssertEqual(LoupePlacement.side(avoiding: topRight, topBarBottom: topBarBottom, screenWidth: width), .leading)
    }

    func testAWindowWithATopCornerOnEachSideGetsTheMagnifierInTheMiddle() {
        let both = [CGPoint(x: 76, y: 215), CGPoint(x: 325, y: 215), CGPoint(x: 76, y: 640), CGPoint(x: 325, y: 640)]
        let side = LoupePlacement.side(avoiding: both, topBarBottom: topBarBottom, screenWidth: width)
        XCTAssertEqual(side, .center)
        // And in the middle it really covers none of them
        let box = LoupePlacement.box(side, topBarBottom: topBarBottom, screenWidth: width)
        XCTAssertTrue(both.allSatisfy { !box.contains($0) })
        // It sits below the width plate on the window's top side (a plate at the top is about 20 points above the corners)
        XCTAssertGreaterThan(box.minY + LoupePlacement.margin, 215 - 22 + 14, "the picture itself is below the plate above the top side")
    }

    func testWithACornerUnderEverySideTheFewestWinsAndATieStaysLeft() {
        let crowded = [CGPoint(x: 76, y: 215), CGPoint(x: 100, y: 240), CGPoint(x: 325, y: 215), CGPoint(x: 201, y: 260), CGPoint(x: 160, y: 300)]
        let side = LoupePlacement.side(avoiding: crowded, topBarBottom: topBarBottom, screenWidth: width)
        // Leading has two, trailing one, the middle two: trailing
        XCTAssertEqual(side, .trailing)
        let tie = [CGPoint(x: 76, y: 215), CGPoint(x: 325, y: 215), CGPoint(x: 201, y: 260)]
        XCTAssertEqual(LoupePlacement.side(avoiding: tie, topBarBottom: topBarBottom, screenWidth: width), .leading)
    }

    func testTheWordsForACornerThatLooksOffTheFrame() {
        XCTAssertEqual(ArHudModel.offCornerHint(corner: 4), "Corner 4 looks off the frame. Move it onto the corner and tap again.")
        XCTAssertEqual(ArHudModel.offCornerHint(corner: 1), "Corner 1 looks off the frame. Move it onto the corner and tap again.")
        XCTAssertEqual(ArHudModel.redoHint(corner: 4), "Aim the ring at the bottom-left corner (corner 4) again, then tap.")
        XCTAssertEqual(ArHudModel.redoHint(corner: 2), "Aim the ring at the top-right corner (corner 2) again, then tap.")
    }

    func testWhileOneCornerIsPlacedAgainTheOthersKeepTheirNumbers() {
        var m = ArHudModel()
        m.phase = .ready
        m.readout = LiveReadout(widthIn: 30, heightIn: 48, placed: 3)
        XCTAssertEqual(m.nextCorner, 4)
        XCTAssertEqual(m.buttonLabel, "Tap corner 4")
        XCTAssertEqual((0..<3).map { m.number(ofDot: $0) }, [1, 2, 3], "no numbers given: in order")
        // Corner 2 is being placed again: the dots that stay are 1, 3 and 4
        m.dotNumbers = [1, 3, 4]
        m.redoing = 2
        XCTAssertEqual((0..<3).map { m.number(ofDot: $0) }, [1, 3, 4])
        XCTAssertEqual(m.nextCorner, 2)
        XCTAssertEqual(m.buttonLabel, "Tap corner 2 again")
        // The outline offer is for the first corner only
        m.proposal = [CGPoint(x: 1, y: 1), CGPoint(x: 9, y: 1), CGPoint(x: 9, y: 9), CGPoint(x: 1, y: 9)]
        XCTAssertFalse(m.hasProposal)
    }

    func testTheSkewedSampleFlagsTheBottomLeftAndFitsALevelRectangle() {
        let k = SkewedSample(SampleScene(size: CGSize(width: 402, height: 874), windowShare: 0.5))
        XCTAssertEqual(k.flagged, 3, "the bottom-left corner was placed far off the frame")
        let f = k.fitted
        XCTAssertEqual(f[0].y, f[1].y, accuracy: 1e-6, "level top")
        XCTAssertEqual(f[3].y, f[2].y, accuracy: 1e-6, "level bottom")
        XCTAssertEqual(f[0].x, f[3].x, accuracy: 1e-6, "upright left")
        XCTAssertEqual(f[1].x, f[2].x, accuracy: 1e-6, "upright right")
        // The placed corners are not a rectangle: the bottom is longer than the top
        let top = k.raw[1].x - k.raw[0].x, bottom = k.raw[2].x - k.raw[3].x
        XCTAssertGreaterThan(bottom - top, 10)
    }
}
