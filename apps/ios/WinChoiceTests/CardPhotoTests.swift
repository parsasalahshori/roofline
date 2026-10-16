import CoreGraphics
import Foundation
import RooflineCore
import XCTest
@testable import WinChoice

/// The card method as the app uses it: the phone-side port of the server's card model (CardSizing), fed the way the card screens
/// feed it, on the drawn sample photo (a 35 5/8 x 59 5/8 in window with a bank card on the glass, 3024 x 4032 px).
@MainActor
final class CardPhotoTests: XCTestCase {
    private let scene = SampleScene.photo
    private func vec(_ p: CGPoint) -> Vec2 { Vec2(Double(p.x), Double(p.y)) }
    private var card: [Vec2] { CardSizing.cardCornersForAPI(scene.cardCorners.map(vec))! }
    private var window: [Vec2] { CardSizing.orderedQuad(scene.frameCorners.map(vec))! }

    func testTheSamplePhotoSizesTheWayTheRealServerSizedIt() throws {
        // The real server (the homeowner API demo) read this same photo, with these same corners and no focal length in it, as
        // 34 1/8 x 57 1/8 in: the card is assumed an inch off the glass, so a drawn photo with the card ON the glass reads about 4% small
        XCTAssertNil(CardSizing.problem(cardCorners: card, windowCorners: window, imageWidthPx: 3024, imageHeightPx: 4032))
        let size = try XCTUnwrap(CardSizing.size(cardCorners: card, windowCorners: window, imageWidthPx: 3024, imageHeightPx: 4032))
        XCTAssertEqual(SizeWording.text(size.widthIn), "34 1/8")
        XCTAssertEqual(SizeWording.text(size.heightIn), "57 1/8")
        XCTAssertEqual(size.quality, .check, "a card photo is quote grade: the free visit measures every window again")
        XCTAssertLessThan(size.uncertaintyHeightIn, 1.5)
    }

    func testTheOrderTheCornersWereTappedInDoesNotChangeTheAnswer() throws {
        let straight = try XCTUnwrap(CardSizing.size(cardCorners: card, windowCorners: window, imageWidthPx: 3024, imageHeightPx: 4032))
        // The window tapped from the bottom left, the card tapped the other way round
        let f = scene.frameCorners.map(vec)
        let shuffledWindow = try XCTUnwrap(CardSizing.orderedQuad([f[3], f[0], f[1], f[2]]))
        let c = scene.cardCorners.map(vec)
        let shuffledCard = try XCTUnwrap(CardSizing.cardCornersForAPI([c[2], c[1], c[0], c[3]]))
        let again = try XCTUnwrap(CardSizing.size(cardCorners: shuffledCard, windowCorners: shuffledWindow, imageWidthPx: 3024, imageHeightPx: 4032))
        XCTAssertEqual(again.widthIn, straight.widthIn, accuracy: 1e-9)
        XCTAssertEqual(again.heightIn, straight.heightIn, accuracy: 1e-9)
    }

    func testAKnownLensIsTrustedMoreThanAnUnknownOne() throws {
        let unknown = try XCTUnwrap(CardSizing.size(cardCorners: card, windowCorners: window, imageWidthPx: 3024, imageHeightPx: 4032, focal35mm: nil))
        let known = try XCTUnwrap(CardSizing.size(cardCorners: card, windowCorners: window, imageWidthPx: 3024, imageHeightPx: 4032, focal35mm: 26))
        XCTAssertEqual(known.widthIn, unknown.widthIn, accuracy: 1e-9, "no focal length in the photo means the 26 mm the server assumes")
        XCTAssertLessThan(known.uncertaintyHeightIn, unknown.uncertaintyHeightIn, "a focal length the photo states has 3% doubt, an assumed one 10%")
        let other = try XCTUnwrap(CardSizing.size(cardCorners: card, windowCorners: window, imageWidthPx: 3024, imageHeightPx: 4032, focal35mm: 52))
        XCTAssertNotEqual(other.widthIn, known.widthIn, "the lens enters the model (a little, for a photo taken straight on)")
        let nonsense = try XCTUnwrap(CardSizing.size(cardCorners: card, windowCorners: window, imageWidthPx: 3024, imageHeightPx: 4032, focal35mm: 4000))
        XCTAssertEqual(nonsense.widthIn, unknown.widthIn, accuracy: 1e-9, "a focal length nobody believes is 'did not say', as on the server")
    }

    func testCrossedWindowCornersGetTheServersSentenceInsteadOfANumber() {
        let f = scene.frameCorners.map(vec)
        let crossed = [f[0], f[2], f[1], f[3]]
        let sentence = CardSizing.problem(cardCorners: card, windowCorners: crossed, imageWidthPx: 3024, imageHeightPx: 4032)
        XCTAssertNotNil(sentence)
        XCTAssertTrue(sentence?.contains("cross") == true, sentence ?? "")
    }

    func testACornerOffThePhotoIsAProblem() {
        var w = window
        w[0] = Vec2(-40, w[0].y)
        let sentence = CardSizing.problem(cardCorners: card, windowCorners: w, imageWidthPx: 3024, imageHeightPx: 4032)
        XCTAssertNotNil(sentence, "a window corner outside the photo")
    }

    func testACardTooSmallToTapIsAProblemWithAReason() {
        // The card a few pixels wide: nobody can tap its corners
        let tiny = [Vec2(1500, 2000), Vec2(1520, 2000), Vec2(1520, 2013), Vec2(1500, 2013)]
        let sentence = CardSizing.problem(cardCorners: tiny, windowCorners: window, imageWidthPx: 3024, imageHeightPx: 4032)
        XCTAssertNotNil(sentence)
        XCTAssertTrue(sentence?.localizedCaseInsensitiveContains("card") == true, sentence ?? "")
    }

    func testTheListShowsTheCardWindowsSizeAtOnceWithTheLensItWasTakenWith() async throws {
        let h = StoreHarness()
        try await h.open()
        let photo = try XCTUnwrap(PhotoPreparation.prepare(scene.image(withCard: true), metadata: [kCGImagePropertyExifDictionary as String: [kCGImagePropertyExifFocalLenIn35mmFilm as String: 26]]))
        XCTAssertEqual(photo.focal35mm, 26)
        let session = MeasureSession(method: .card, room: "Bedroom 1", number: 1)
        h.store.capture(scale: .card(CardScale(cardCorners: card)), corners: window, jpeg: photo.jpeg, widthPx: photo.widthPx, heightPx: photo.heightPx, focal35mm: photo.focal35mm, in: session)
        let withLens = try XCTUnwrap(h.store.pending?.preview)
        h.store.capture(scale: .card(CardScale(cardCorners: card)), corners: window, jpeg: photo.jpeg, widthPx: photo.widthPx, heightPx: photo.heightPx, focal35mm: nil, in: session)
        let withoutLens = try XCTUnwrap(h.store.pending?.preview)
        XCTAssertEqual(SizeWording.sizeText(widthIn: withLens.widthIn, heightIn: withLens.heightIn), "34 1/8 × 57 1/8 in")
        XCTAssertLessThan(withLens.uncertaintyIn ?? 99, withoutLens.uncertaintyIn ?? 0, "the label sheet is surer when the photo says which lens took it")
        XCTAssertTrue(withLens.isShowable)
    }

    func testACardWindowGoesToTheServerWithItsCardCornersAndFrameCorners() async throws {
        let h = StoreHarness()
        try await h.open()
        let photo = try XCTUnwrap(PhotoPreparation.prepare(scene.image(withCard: true)))
        let session = MeasureSession(method: .card, room: "Bedroom 1", number: 1)
        h.store.capture(scale: .card(CardScale(cardCorners: card)), corners: window, jpeg: photo.jpeg, widthPx: photo.widthPx, heightPx: photo.heightPx, in: session)
        let id = try XCTUnwrap(h.store.pending?.id)
        await h.store.savePending(room: "Bedroom 1", name: "")
        await h.settle()
        await h.store.setStyle("double-hung", for: id)
        await h.settle()
        await h.store.refresh()
        let sent = try XCTUnwrap(h.store.view?.windows.first { $0.id == id })
        XCTAssertEqual(sent.input.scale.kind, "card", "the scale kind the server's card branch reads")
        XCTAssertEqual(sent.input.corners?.count, 4)
        XCTAssertEqual(sent.input.room, "Bedroom 1")
        XCTAssertEqual(h.store.windowRows.first?.methodLine.isEmpty, false)
    }
}
