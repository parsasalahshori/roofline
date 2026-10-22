import CoreGraphics
import RooflineCore
import UIKit
import XCTest
@testable import WinChoice

/// Proposing the corners: Apple Vision on the drawn sample photo (a 35 5/8 x 59 5/8 in window with a bank card on the glass,
/// 3024 x 4032 px), what the card screen puts on the photo, and the AR screen's outline controls. Vision runs here on the CPU in the
/// simulator; the decisions it feeds (`AutoCorners`, `ArAutoCorners`) are checked on their own in RooflineCore's checks. The live AR
/// look (a camera, the wall plane, the depth sensor) can only run on an iPhone.
@MainActor
final class AutoCornersTests: XCTestCase {
    private let scene = SampleScene.photo
    private func vec(_ p: CGPoint) -> Vec2 { Vec2(Double(p.x), Double(p.y)) }

    private func found() throws -> AutoCornerProposal {
        let cg = try XCTUnwrap(scene.image(withCard: true).cgImage)
        return WindowRectangleDetector.propose(in: cg)
    }

    func testVisionFindsTheCardAndTheInsideOfTheFrameOnTheSamplePhoto() throws {
        let proposal = try found()
        let window = try XCTUnwrap(proposal.window, "the window").corners
        let taps = try XCTUnwrap(proposal.cardTaps, "the card")
        // The glass opening (what the sample calls the inside of the frame), not the trim round it, within 40 px of 3024
        let truth = try XCTUnwrap(CardSizing.orderedQuad(scene.frameCorners.map(vec)))
        for i in 0..<4 {
            XCTAssertEqual(window[i].x, truth[i].x, accuracy: 40, "window corner \(i) x")
            XCTAssertEqual(window[i].y, truth[i].y, accuracy: 40, "window corner \(i) y")
        }
        // The card, to a few pixels (the drawn card has square corners: its taps sit about 1 to 2% of the card inside them)
        let card = try XCTUnwrap(CardSizing.orderedQuad(scene.cardCorners.map(vec)))
        for i in 0..<4 {
            XCTAssertEqual(taps[i].x, card[i].x, accuracy: 8, "card corner \(i) x")
            XCTAssertEqual(taps[i].y, card[i].y, accuracy: 8, "card corner \(i) y")
        }
    }

    func testTheFoundCornersSizeTheWindowLikeTappedOnesAndTheServerWouldTakeThem() throws {
        let photo = try XCTUnwrap(PhotoPreparation.prepare(scene.image(withCard: true)))
        let proposal = CardPhotoFlow.checked(try found(), widthPx: Double(photo.widthPx), heightPx: Double(photo.heightPx))
        let taps = try XCTUnwrap(proposal.cardTaps)
        let card = try XCTUnwrap(CardSizing.cardCornersForAPI(taps))
        let window = try XCTUnwrap(CardSizing.orderedQuad(try XCTUnwrap(proposal.window).corners))
        XCTAssertNil(CardSizing.problem(cardCorners: card, windowCorners: window, imageWidthPx: Double(photo.widthPx), imageHeightPx: Double(photo.heightPx)))
        let size = try XCTUnwrap(CardSizing.size(cardCorners: card, windowCorners: window, imageWidthPx: Double(photo.widthPx), imageHeightPx: Double(photo.heightPx)))
        // Tapped by hand on this photo the model reads 34 1/8 x 57 1/8 in (CardPhotoTests); the found corners are within 3% of that
        XCTAssertEqual(size.widthIn, 34.125, accuracy: 34.125 * 0.03)
        XCTAssertEqual(size.heightIn, 57.125, accuracy: 57.125 * 0.03)
        XCTAssertEqual(size.quality, .check, "a card photo is quote grade whoever placed the corners")
    }

    func testAPhotoWithNothingInItProposesNothing() throws {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let plain = UIGraphicsImageRenderer(size: CGSize(width: 1200, height: 1600), format: format).image { ctx in
            UIColor(white: 0.55, alpha: 1).setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 1200, height: 1600))
        }
        let proposal = WindowRectangleDetector.propose(in: try XCTUnwrap(plain.cgImage))
        XCTAssertTrue(proposal.isEmpty, "nothing found means the screens carry on with taps")
        // A zero-size picture does not crash
        XCTAssertTrue(AutoCorners.propose([], imageWidth: 0, imageHeight: 0).isEmpty)
    }

    func testWhatGoesOnThePhotoIsInsideItAndNeverACardTheServerWouldRefuse() {
        let w = 3024.0, h = 4032.0
        let window = PickedQuad(corners: [Vec2(-5, 100), Vec2(3030, 100), Vec2(3030, 3000), Vec2(-5, 3000)], confidence: 1)
        let card = PickedQuad(corners: [Vec2(900, 2900), Vec2(1072, 2900), Vec2(1072, 3009), Vec2(900, 3009)], confidence: 1)
        let ok = CardPhotoFlow.checked(AutoCornerProposal(window: window, card: card), widthPx: w, heightPx: h)
        XCTAssertEqual(ok.window?.corners.first, Vec2(0, 100), "a corner a hair off the photo is put on it")
        XCTAssertTrue(ok.window?.corners.allSatisfy { $0.x >= 0 && $0.x <= w && $0.y >= 0 && $0.y <= h } == true)
        XCTAssertNotNil(ok.card)
        // A card as big as the window: the server would refuse the pair, so neither is put on the photo
        let huge = PickedQuad(corners: [Vec2(100, 200), Vec2(2900, 200), Vec2(2900, 2800), Vec2(100, 2800)], confidence: 1)
        XCTAssertTrue(CardPhotoFlow.checked(AutoCornerProposal(window: window, card: huge), widthPx: w, heightPx: h).isEmpty)
        // A window with no card is kept (the card screen taps; the window screen has its corners)
        let alone = CardPhotoFlow.checked(AutoCornerProposal(window: window, card: nil), widthPx: w, heightPx: h)
        XCTAssertNotNil(alone.window)
        XCTAssertNil(alone.card)
    }

    func testTheOutlineIsOfferedOnlyBeforeAnyCornerIsPlacedAndInPlainWords() {
        var m = ArHudModel()
        m.phase = .ready
        XCTAssertFalse(m.hasProposal, "no outline, no button")
        m.proposal = [CGPoint(x: 100, y: 100), CGPoint(x: 300, y: 100), CGPoint(x: 300, y: 500), CGPoint(x: 100, y: 500)]
        XCTAssertTrue(m.hasProposal)
        m.readout = LiveReadout(widthIn: 30, heightIn: nil, placed: 1)
        XCTAssertFalse(m.hasProposal, "a corner tapped by hand puts the outline away")
        m.readout = LiveReadout()
        m.phase = .sampling(0.4)
        XCTAssertFalse(m.hasProposal)
        m.phase = .ready
        m.proposal = Array(m.proposal.prefix(3))
        XCTAssertFalse(m.hasProposal, "three points are not an outline")
        XCTAssertEqual(ArHudModel.proposalHint, "We found your window. Use these corners, or tap them yourself.")
    }
}
