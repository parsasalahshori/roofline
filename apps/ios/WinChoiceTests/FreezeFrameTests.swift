import CoreGraphics
import RooflineCore
import UIKit
import XCTest
@testable import WinChoice

/// The frozen-photo measuring screen's logic, off the camera: the drawn sample window as a frozen frame with a synthetic depth map (the
/// simulator has no AR), the depth sensor finding the opening (also with blinds, a lamp, a valance and a picture in the way), Vision as
/// the fallback, a corner snapping onto the frame in the picture, and the rectangle whose corners are the dots. The maths under it
/// (the opening from a depth map, the rectangle editing, the 3D corners, photos combined) is checked in RooflineCore's checks. What only an
/// iPhone can show: the real camera frame, ARKit's wall plane, the depth sensor's real readings at a window, and a finger dragging a dot.
@MainActor
final class FreezeFrameTests: XCTestCase {
    private let scene = SampleFrozen.scene()
    private lazy var made = SampleFrozen.capture(scene)
    private var capture: FrozenCapture { made.capture }

    private func vec(_ p: CGPoint) -> Vec2 { Vec2(Double(p.x), Double(p.y)) }
    private func distance(_ a: CGPoint, _ b: CGPoint) -> CGFloat { hypot(a.x - b.x, a.y - b.y) }
    private func image(_ c: FrozenCapture) throws -> CGImage { try XCTUnwrap(UIImage(data: c.jpeg)?.cgImage) }

    func testTheDepthSensorFindsTheSampleWindowAndItsSizeIsTheDrawnOne() throws {
        let found = try XCTUnwrap(FreezeProposal.rect(in: try image(capture), view: capture.view))
        XCTAssertEqual(found.source, .depth)
        let r = try XCTUnwrap(FrozenMeasure.measure(rect: found.rect, view: capture.view))
        XCTAssertEqual(r.widthIn, SampleScene.widthIn, accuracy: 0.3)
        XCTAssertEqual(r.heightIn, SampleScene.heightIn, accuracy: 0.3)
        // The corners are the opening's own (millimetres)
        for (p, truth) in zip(r.windowPointsM, made.opening) { XCTAssertLessThan(p.distance(to: truth), 0.006) }
    }

    func testTheOwnersWindowWithBlindsALampAValanceAndAPictureGivesTheWholeFrame() throws {
        let clutterScene = SampleFrozen.scene(clutter: true)
        let m = SampleFrozen.capture(clutterScene, clutter: true)
        let found = try XCTUnwrap(FreezeProposal.rect(in: try image(m.capture), view: m.capture.view))
        XCTAssertEqual(found.source, .depth)
        let r = try XCTUnwrap(FrozenMeasure.measure(rect: found.rect, view: m.capture.view))
        // The whole opening: not the lower sash (about a third of the height), not the picture
        XCTAssertEqual(r.widthIn, SampleScene.widthIn, accuracy: 0.5)
        XCTAssertEqual(r.heightIn, SampleScene.heightIn, accuracy: 0.5)
        for (p, truth) in zip(r.windowPointsM, m.opening) { XCTAssertLessThan(p.distance(to: truth), 0.012) }
    }

    func testWithNoDepthSensorVisionsWindowIsUsedAndASashAloneIsNot() throws {
        var view = capture.view
        view.depth = nil
        let found = try XCTUnwrap(FreezeProposal.rect(in: try image(capture), view: view), "the whole window holds the middle of the picture")
        XCTAssertEqual(found.source, .photo)
        let r = try XCTUnwrap(FrozenMeasure.measure(rect: found.rect, view: view))
        XCTAssertEqual(r.widthIn, SampleScene.widthIn, accuracy: 1.0)
        XCTAssertEqual(r.heightIn, SampleScene.heightIn, accuracy: 1.5)
        // A photo of only a lower sash (17 x 12 3/4 in at this scale) around the middle: a whole window is not that small
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let pxPerIn = (scene.frameCorners[1].x - scene.frameCorners[0].x) / CGFloat(SampleScene.widthIn)
        let sashPhoto = UIGraphicsImageRenderer(size: SampleFrozen.photoSize, format: format).image { ctx in
            UIColor(white: 0.75, alpha: 1).setFill()
            ctx.fill(CGRect(origin: .zero, size: SampleFrozen.photoSize))
            UIColor(white: 0.2, alpha: 1).setFill()
            let w = 17 * pxPerIn, h = 12.75 * pxPerIn
            ctx.fill(CGRect(x: (SampleFrozen.photoSize.width - w) / 2, y: SampleFrozen.photoSize.height / 2 - h / 2, width: w, height: h))
        }
        XCTAssertNil(FreezeProposal.rect(in: try XCTUnwrap(sashPhoto.cgImage), view: view), "a sash is not offered as the window")
    }

    func testACornerLetGoNearTheFrameLandsOnItAndAFlatPictureLeavesItAlone() throws {
        let cg = try image(capture)
        for truth in scene.frameCorners {
            for (dx, dy) in [(9.0, -7.0), (-10.0, 8.0), (5.0, 12.0)] {
                let stray = CGPoint(x: truth.x + dx, y: truth.y + dy)
                let snapped = try XCTUnwrap(PhotoSnap.snap(stray, in: cg), "from \(stray)")
                XCTAssertLessThan(distance(snapped, truth), 1.5, "snapped to \(snapped), frame corner at \(truth)")
            }
        }
        // Too far from any corner (a third of the way along the frame): left where it was let go
        XCTAssertNil(PhotoSnap.snap(CGPoint(x: scene.frameCorners[0].x + 300, y: scene.frameCorners[0].y + 500), in: cg))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let plain = UIGraphicsImageRenderer(size: SampleFrozen.photoSize, format: format).image { ctx in
            UIColor(white: 0.6, alpha: 1).setFill()
            ctx.fill(CGRect(origin: .zero, size: SampleFrozen.photoSize))
        }
        XCTAssertNil(PhotoSnap.snap(CGPoint(x: 400, y: 600), in: try XCTUnwrap(plain.cgImage)))
        // The patch for a corner at the photo's very edge is cut at the edge
        let patch = try XCTUnwrap(PhotoSnap.patch(around: CGPoint(x: 3, y: 5), half: 65, in: cg))
        XCTAssertEqual(patch.origin.x, 0)
        XCTAssertEqual(patch.origin.y, 0)
        XCTAssertEqual(patch.0.width, 69)
        XCTAssertEqual(patch.0.height, 71)
        // A strip of grey pixels is what the photo holds there
        let strip = try XCTUnwrap(PhotoSnap.gray(cg, x: 10, y: 20, width: 40, height: 30))
        XCTAssertEqual(strip.pixels.count, 1200)
        XCTAssertNil(PhotoSnap.gray(cg, x: cg.width - 5, y: 0, width: 40, height: 30), "outside the photo")
    }

    func testTheDotsAreTheRectangleAndThePlatesTheStatusAndTheSentWindowShowItsNumbers() throws {
        let rect = try XCTUnwrap(SampleFrozen.off(made.opening, view: capture.view), "the left edge 1.6 in out, the bottom 1.4 in low")
        let editing = FreezeEditing(capture: capture, earlier: [], rect: rect)
        let r = try XCTUnwrap(editing.sent)
        // Eight handles: the four corners, then the middle of each side. The outline goes exactly through the corners
        XCTAssertEqual(editing.handles.count, 8)
        for i in 0..<4 { XCTAssertEqual(distance(editing.outline[i], editing.handles[i]), 0, accuracy: 1e-6, "outline through dot \(i)") }
        XCTAssertEqual(editing.handles[4].x, (editing.handles[0].x + editing.handles[1].x) / 2, accuracy: 0.5, "top handle in the middle of the top")
        XCTAssertEqual(editing.handles[7].y, (editing.handles[0].y + editing.handles[3].y) / 2, accuracy: 0.5)
        // What is measured is that rectangle's own sides: nothing was fitted or averaged
        XCTAssertEqual(r.widthIn, rect.widthM * inchesPerMetre, accuracy: 1e-9)
        XCTAssertEqual(r.heightIn, rect.heightM * inchesPerMetre, accuracy: 1e-9)
        XCTAssertEqual(r.widthIn, SampleScene.widthIn + 1.2, accuracy: 0.3, "1.6 in out on the left, 0.4 in in on the right")
        // The status card and the plates are the same numbers
        XCTAssertEqual(editing.widthIn, r.widthIn)
        XCTAssertEqual(editing.plates.map(\.inches), [r.widthIn, r.heightIn])
        XCTAssertEqual(editing.widthText, Eighths.format(editing.plates[0].inches))
        XCTAssertEqual(editing.heightText, Eighths.format(editing.plates[1].inches))
        // What is sent is sized by the phone's own preview (the label sheet and the list): the same width and height again
        let scale = WindowPhotoScale.ar(ArScale(pointsM: r.windowPointsM, trackingLostCount: 0, device: .arkitLidar, cornerSpreadM: r.windowSpreadM))
        let input = PhotoWindowInput(id: "w", uploadId: nil, label: nil, windowKey: nil, corners: nil, scale: scale, room: "Bedroom 1", style: nil)
        let preview = try XCTUnwrap(LocalWindowPreview.of(input, imageWidthPx: 0, imageHeightPx: 0))
        XCTAssertEqual(preview.widthIn, r.widthIn, accuracy: 1e-9)
        XCTAssertEqual(preview.heightIn, r.heightIn, accuracy: 1e-9)
        XCTAssertEqual(Eighths.format(preview.widthIn), editing.widthText)
        // A rectangle does not disagree with itself: no corner is flagged and nothing needs a check
        XCTAssertFalse(editing.needsCheck)
        XCTAssertFalse(r.disagrees)
        XCTAssertTrue(editing.canUse)
        // The plates sit on the middle of the top and left sides, a little inside them
        XCTAssertEqual(editing.plates[0].point.y, editing.outline[0].y, accuracy: 1e-6)
        XCTAssertEqual(editing.plates[1].point.x, editing.outline[0].x, accuracy: 1e-6)
        XCTAssertGreaterThan(editing.plates[0].offset.height, 0)
        XCTAssertGreaterThan(editing.plates[1].offset.width, 0)
    }

    func testDraggingACornerOrASideMovesTheEdgesAndTheDotStaysWhereTheFingerPutsIt() throws {
        let rect = try XCTUnwrap(FrozenRect.bounding(of: made.opening, plane: capture.view.wall, viewer: capture.view.viewer))
        let before = FreezeEditing(capture: capture, earlier: [], rect: rect)
        // Top-left dot 40 px right and 30 px down
        let target = CGPoint(x: before.handles[0].x + 40, y: before.handles[0].y + 30)
        let moved = rect.moved(.topLeft, toPhoto: vec(target), view: capture.view)
        let after = FreezeEditing(capture: capture, earlier: [], rect: moved)
        XCTAssertEqual(distance(after.handles[0], target), 0, accuracy: 1e-6, "the dot is under the finger")
        // The right side and the bottom did not move; the neighbours' edges followed
        XCTAssertEqual(distance(after.handles[2], before.handles[2]), 0, accuracy: 1e-6)
        XCTAssertEqual(after.handles[1].y, after.handles[0].y, accuracy: 1e-6, "TR is on the new top")
        XCTAssertEqual(after.handles[3].x, after.handles[0].x, accuracy: 1e-6, "BL is on the new left")
        XCTAssertLessThan(try XCTUnwrap(after.widthIn), try XCTUnwrap(before.widthIn))
        XCTAssertLessThan(try XCTUnwrap(after.heightIn), try XCTUnwrap(before.heightIn))
        // The right-hand square moves only the right side
        let side = rect.moved(.right, toPhoto: Vec2(Double(before.handles[5].x) + 30, Double(before.handles[5].y) + 60), view: capture.view)
        let sided = FreezeEditing(capture: capture, earlier: [], rect: side)
        XCTAssertEqual(try XCTUnwrap(sided.heightIn), try XCTUnwrap(before.heightIn), accuracy: 1e-9, "the sideways drag changes only the width")
        XCTAssertGreaterThan(try XCTUnwrap(sided.widthIn), try XCTUnwrap(before.widthIn))
    }

    func testTheHintSaysWhatToDoAtEachStageAndPhotosThatDisagreeSayCheck() throws {
        let rect = try XCTUnwrap(FrozenRect.bounding(of: made.opening, plane: capture.view.wall, viewer: capture.view.viewer))
        let alone = FreezeEditing(capture: capture, earlier: [], rect: rect)
        XCTAssertEqual(alone.hint(.looking), FrozenCopy.looking)
        XCTAssertEqual(alone.hint(.notFound), FrozenCopy.notFound)
        XCTAssertEqual(alone.hint(.proposedByDepth), FrozenCopy.foundByDepth)
        XCTAssertEqual(alone.hint(.proposedByPhoto), FrozenCopy.foundWindow)
        XCTAssertEqual(alone.hint(.editing), FrozenCopy.editing)
        XCTAssertNil(alone.agreement)
        // An earlier photo of the same window that is 2 in wider: this photo's rectangle is still what is drawn and sent, marked a check
        var wider = rect
        wider.right += 2.0 / inchesPerMetre
        let earlier = try XCTUnwrap(FrozenMeasure.measure(rect: wider, view: capture.view))
        let two = FreezeEditing(capture: capture, earlier: [earlier], rect: rect)
        XCTAssertTrue(two.photosDisagree)
        XCTAssertTrue(two.needsCheck)
        XCTAssertTrue(two.hint(.editing).hasPrefix("Your photos differ by"))
        XCTAssertEqual(try XCTUnwrap(two.widthIn), try XCTUnwrap(alone.widthIn), accuracy: 1e-9, "this photo's own rectangle")
        XCTAssertEqual(two.photos, 2)
        // An earlier photo that agrees is no check
        let near = try XCTUnwrap(FrozenMeasure.measure(rect: rect, view: capture.view))
        let agree = FreezeEditing(capture: capture, earlier: [near], rect: rect)
        XCTAssertFalse(agree.photosDisagree)
        XCTAssertFalse(agree.needsCheck)
        // No rectangle (a wall that was not in view): nothing to size and a plain word
        let none = FreezeEditing(capture: capture, earlier: [], rect: nil)
        XCTAssertFalse(none.canUse)
        XCTAssertTrue(none.handles.isEmpty)
        XCTAssertEqual(none.hint(.editing), FrozenCopy.notMeasurable)
    }

    func testTheCaptureScreenSaysWhatToDoAtEachStep() {
        var m = ArCaptureModel()
        XCTAssertFalse(m.canCapture, "no wall yet")
        XCTAssertEqual(m.hint, "Move the phone slowly to find the wall.")
        m.phase = .ready
        XCTAssertTrue(m.canCapture)
        XCTAssertEqual(m.buttonLabel, "Capture")
        XCTAssertEqual(ArCaptureModel.readyHint(photosTaken: 0), "Stand 3 to 5 feet back, aim the circle at the window, and tap Capture.")
        XCTAssertEqual(ArCaptureModel.readyHint(photosTaken: 1), "Photo 2 of 3: the same window again, from a slightly different spot.")
        m.phase = .holding
        XCTAssertFalse(m.canCapture, "one capture at a time")
        XCTAssertEqual(m.buttonLabel, "Hold still")
    }
}
