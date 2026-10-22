import CoreGraphics
import RooflineCore
import UIKit
import XCTest
@testable import WinChoice

/// The frozen-photo measuring screen's logic, off the camera: the drawn sample window as a frozen frame (the simulator has no AR), Apple
/// Vision proposing its corners on the still, a stray corner snapping onto the frame in the picture, and the one set of numbers the plates,
/// the status card and the saved window all show. The maths under it (3D corners from a depth map and lens numbers, the fit, the
/// corner that looks off, photos combined) is checked in RooflineCore's checks. What only an iPhone can show: the real camera frame,
/// ARKit's wall plane, the depth sensor, and a finger dragging a dot.
@MainActor
final class FreezeFrameTests: XCTestCase {
    private let scene = SampleFrozen.scene()
    private lazy var capture = SampleFrozen.capture(scene)

    private func vec(_ p: CGPoint) -> Vec2 { Vec2(Double(p.x), Double(p.y)) }
    private func distance(_ a: CGPoint, _ b: CGPoint) -> CGFloat { hypot(a.x - b.x, a.y - b.y) }

    func testTheDrawnWindowMeasuresItsDrawnSizeFromTheFrozenFrame() throws {
        let r = try XCTUnwrap(FrozenMeasure.measure(view: capture.view, photoPx: scene.frameCorners.map(vec)))
        XCTAssertEqual(r.widthIn, SampleScene.widthIn, accuracy: 0.05)
        XCTAssertEqual(r.heightIn, SampleScene.heightIn, accuracy: 0.08)
        XCTAssertFalse(r.disagrees)
        XCTAssertFalse(r.needsCheck)
    }

    func testVisionFindsTheWindowOnTheStillAndEachCornerSnapsOntoTheFrame() throws {
        let cg = try XCTUnwrap(UIImage(data: capture.jpeg)?.cgImage)
        let found = try XCTUnwrap(FreezeProposal.corners(in: cg, view: capture.view), "a believable window on this wall")
        XCTAssertEqual(found.count, 4)
        for (p, truth) in zip(found, scene.frameCorners) {
            XCTAssertLessThan(distance(p, truth), 3, "corner at \(p), frame corner at \(truth)")
        }
        let r = try XCTUnwrap(FrozenMeasure.measure(view: capture.view, photoPx: found.map(vec)))
        XCTAssertEqual(r.widthIn, SampleScene.widthIn, accuracy: 0.3)
        XCTAssertEqual(r.heightIn, SampleScene.heightIn, accuracy: 0.4)
    }

    func testAPhotoWithNoWindowGivesNoProposal() throws {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let plain = UIGraphicsImageRenderer(size: SampleFrozen.photoSize, format: format).image { ctx in
            UIColor(white: 0.6, alpha: 1).setFill()
            ctx.fill(CGRect(origin: .zero, size: SampleFrozen.photoSize))
        }
        XCTAssertNil(FreezeProposal.corners(in: try XCTUnwrap(plain.cgImage), view: capture.view))
    }

    func testACornerLetGoNearTheFrameLandsOnItAndAFlatPictureLeavesItAlone() throws {
        let image = scene.image(withCard: false)
        let cg = try XCTUnwrap(image.cgImage)
        for truth in scene.frameCorners {
            // A fingertip's distance off, in each direction
            for (dx, dy) in [(9.0, -7.0), (-10.0, 8.0), (5.0, 12.0)] {
                let stray = CGPoint(x: truth.x + dx, y: truth.y + dy)
                let snapped = try XCTUnwrap(PhotoSnap.snap(stray, in: cg), "from \(stray)")
                XCTAssertLessThan(distance(snapped, truth), 1.5, "snapped to \(snapped), frame corner at \(truth)")
            }
        }
        // Too far from any corner (a third of the way along the frame): left where it was let go
        let mid = CGPoint(x: scene.frameCorners[0].x + 300, y: scene.frameCorners[0].y + 500)
        XCTAssertNil(PhotoSnap.snap(mid, in: cg))
        // Nothing to find on a plain wall
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
    }

    func testThePlatesTheStatusAndTheSavedWindowShowOneSetOfNumbers() throws {
        let points = SampleFrozen.shaky(scene)
        let editing = FreezeEditing(capture: capture, earlier: [], points: points)
        let r = try XCTUnwrap(editing.combined?.result)
        // The status card and the plates are the same numbers
        XCTAssertEqual(editing.widthIn, r.widthIn)
        XCTAssertEqual(editing.heightIn, r.heightIn)
        XCTAssertEqual(editing.plates.map(\.inches), [r.widthIn, r.heightIn])
        XCTAssertEqual(editing.widthText, Eighths.format(editing.plates[0].inches))
        XCTAssertEqual(editing.heightText, Eighths.format(editing.plates[1].inches))
        // What is saved is sized by the phone's own preview (the label sheet and the list): the same width and height again
        let scale = WindowPhotoScale.ar(ArScale(pointsM: r.windowPointsM, trackingLostCount: 0, device: .arkit, cornerSpreadM: r.windowSpreadM))
        let input = PhotoWindowInput(id: "w", uploadId: nil, label: nil, windowKey: nil, corners: nil, scale: scale, room: "Bedroom 1", style: nil)
        let preview = try XCTUnwrap(LocalWindowPreview.of(input, imageWidthPx: 0, imageHeightPx: 0))
        XCTAssertEqual(preview.widthIn, r.widthIn, accuracy: 1e-9)
        XCTAssertEqual(preview.heightIn, r.heightIn, accuracy: 1e-9)
        XCTAssertEqual(Eighths.format(preview.widthIn), editing.widthText)
        // The outline drawn is the level rectangle, not the slanted shape the dots make
        let o = editing.outline
        XCTAssertEqual(o.count, 4)
        XCTAssertEqual(o[0].y, o[1].y, accuracy: 1e-6, "level top")
        XCTAssertEqual(o[3].y, o[2].y, accuracy: 1e-6, "level bottom")
        XCTAssertEqual(o[0].x, o[3].x, accuracy: 1e-6, "upright left")
        XCTAssertEqual(o[1].x, o[2].x, accuracy: 1e-6, "upright right")
        XCTAssertGreaterThan(points[2].x - points[3].x, points[1].x - points[0].x + 20, "the dots themselves are not a rectangle")
        // The plates sit on the middle of the top and left sides, a little inside them
        XCTAssertEqual(editing.plates[0].point.y, o[0].y, accuracy: 1e-6)
        XCTAssertEqual(editing.plates[1].point.x, o[0].x, accuracy: 1e-6)
        XCTAssertGreaterThan(editing.plates[0].offset.height, 0)
        XCTAssertGreaterThan(editing.plates[1].offset.width, 0)
    }

    func testTheBottomLeftDotThatWasFarOffTheFrameIsTheOneNamed() throws {
        let editing = FreezeEditing(capture: capture, earlier: [], points: SampleFrozen.shaky(scene))
        XCTAssertEqual(editing.flaggedHandle, 3)
        XCTAssertEqual(editing.hint(.editing), "Corner 4 looks off the frame. Drag it onto the corner.")
        XCTAssertTrue(editing.needsCheck, "corners that did not line up are marked")
        XCTAssertTrue(editing.canUse, "the person can still use it")
        // Corners on the frame: nothing flagged, nothing to check
        let clean = FreezeEditing(capture: capture, earlier: [], points: scene.frameCorners)
        XCTAssertNil(clean.flaggedHandle)
        XCTAssertFalse(clean.needsCheck)
        XCTAssertEqual(clean.hint(.editing), FrozenCopy.looksRight)
        XCTAssertEqual(clean.hint(.proposed), FrozenCopy.foundWindow)
        XCTAssertEqual(clean.hint(.notFound), FrozenCopy.notFound)
        XCTAssertEqual(clean.hint(.looking), FrozenCopy.looking)
    }

    func testOnlyTheTopLeftDotLowOnTheFrameNamesNoCornerAndSaysToCheckThemAll() throws {
        var points = scene.frameCorners
        let pxPerIn = (points[1].x - points[0].x) / CGFloat(SampleScene.widthIn)
        points[0].y += 1.9 * pxPerIn
        let editing = FreezeEditing(capture: capture, earlier: [], points: points)
        XCTAssertNil(editing.flaggedHandle, "a low top-left and a high top-right look the same")
        XCTAssertEqual(editing.hint(.editing), FrozenCopy.checkCorners)
        XCTAssertTrue(editing.needsCheck)
    }

    func testAnEarlierPhotoMakesTheShownSizeTheMedianAndTheOutlineTheCombinedOne() throws {
        let first = try XCTUnwrap(FrozenMeasure.measure(view: capture.view, photoPx: scene.frameCorners.map(vec)))
        // The same window again, 0.2 in wider as this photo's dots have it
        var points = scene.frameCorners
        let pxPerIn = (points[1].x - points[0].x) / CGFloat(SampleScene.widthIn)
        points[1].x += 0.2 * pxPerIn
        points[2].x += 0.2 * pxPerIn
        let editing = FreezeEditing(capture: capture, earlier: [first], points: points)
        XCTAssertEqual(editing.photos, 2)
        XCTAssertEqual(editing.combined?.photos, 2)
        XCTAssertEqual(editing.widthIn ?? 0, SampleScene.widthIn + 0.1, accuracy: 0.05, "the middle of the two")
        XCTAssertEqual(editing.current?.widthIn ?? 0, SampleScene.widthIn + 0.2, accuracy: 0.05, "this photo alone")
        // The plates show the combined numbers; so does the outline (its width in the photo is the combined width)
        XCTAssertEqual(editing.plates[0].inches, editing.widthIn)
        let o = editing.outline
        XCTAssertEqual(Double(o[1].x - o[0].x), (editing.widthIn ?? 0) * Double(pxPerIn), accuracy: 1.5)
        XCTAssertEqual(editing.combined?.disagrees, false)
        // A photo that disagrees by inches says so
        var far = scene.frameCorners
        far[1].x += 2.5 * pxPerIn
        far[2].x += 2.5 * pxPerIn
        let off = FreezeEditing(capture: capture, earlier: [first], points: far)
        XCTAssertEqual(off.combined?.disagrees, true)
        XCTAssertTrue(off.hint(.editing).hasPrefix("Your photos differ by"))
        XCTAssertTrue(off.needsCheck)
    }

    func testFewerThanFourDotsMeasureNothingAndDoNotCrash() {
        let editing = FreezeEditing(capture: capture, earlier: [], points: Array(scene.frameCorners.prefix(3)))
        XCTAssertNil(editing.current)
        XCTAssertNil(editing.combined)
        XCTAssertTrue(editing.outline.isEmpty)
        XCTAssertTrue(editing.plates.isEmpty)
        XCTAssertFalse(editing.canUse)
        XCTAssertEqual(editing.hint(.editing), FrozenCopy.notMeasurable)
    }

    func testTheCaptureScreenSaysWhatToDoAtEachStep() {
        var m = ArCaptureModel()
        XCTAssertFalse(m.canCapture, "no wall yet")
        XCTAssertEqual(m.hint, "Move the phone slowly to find the wall.")
        m.phase = .ready
        XCTAssertTrue(m.canCapture)
        XCTAssertEqual(m.buttonLabel, "Capture")
        XCTAssertEqual(ArCaptureModel.readyHint(photosTaken: 0), "Stand 3 to 5 feet back so the whole window is on screen, then tap Capture.")
        XCTAssertEqual(ArCaptureModel.readyHint(photosTaken: 1), "Photo 2 of 3: the same window again, from a slightly different spot.")
        m.phase = .holding
        XCTAssertFalse(m.canCapture, "one capture at a time")
        XCTAssertEqual(m.buttonLabel, "Hold still")
    }
}
