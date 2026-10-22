import Foundation
import RooflineCore

// Checks for the rectangle a window's four corners are fitted to (RectangleFit.swift): equal sides, the size the server would give back,
// the corner that looks off, the corner placed again, and the mark on a window whose corners did not line up.

/// Plane coordinates in inches (s right, t up from the top-left corner) on a wall facing +z at z = -2, as world metres.
private func onWall(_ s: Double, _ t: Double) -> Vec3 { Vec3(-0.5 + s / inchesPerMetre, 1.9 + t / inchesPerMetre, -2) }

private let viewer = Vec3(0, 1.4, 0)
private let wallPlane = Plane(point: Vec3(0, 0, -2), normal: Vec3(0, 0, 1))!

/// TL, TR, BR, BL from plane coordinates in inches.
private func quad(_ p: [(Double, Double)]) -> [Vec3] { p.map { onWall($0.0, $0.1) } }

/// A 36 x 60 in window, TL, TR, BR, BL.
private let trueCorners: [(Double, Double)] = [(0, 0), (36, 0), (36, -60), (0, -60)]

/// The owner's first real-iPhone window, rebuilt from the sides the HUD showed: top 29 1/2, bottom 31 5/8, left 49 7/8, right 47 1/8
/// (a skewed trapezoid: the bottom edge climbs to the right and the bottom-left corner sits outside the frame).
private let skewed: [(Double, Double)] = [(0, 0), (29.5, 0), (30.5, -47.1), (-1, -49.86)]

private func dist(_ a: Vec3, _ b: Vec3) -> Double { a.distance(to: b) * inchesPerMetre }

private func fit(_ p: [Vec3], spread: [Double] = []) -> RectangleFit? {
    RectangleFit.fit(ordered: p, plane: wallPlane, viewer: viewer, spreadM: spread)
}

let rectangleFitChecks: [Check] = [
    Check("RectangleFit: the owner's skewed window becomes one rectangle with equal sides, and the server sizes it as the HUD does") { ctx in
        let raw = quad(skewed)
        // As placed: the sides are the ones the owner saw
        let r = fit(raw)
        ctx.near(r?.topIn, 29.5, 0.01)
        ctx.near(r?.bottomIn, 31.62, 0.05)
        ctx.near(r?.leftIn, 49.87, 0.02)
        ctx.near(r?.rightIn, 47.11, 0.02)
        guard let f = r else { return ctx.expect(false, "no fit") }
        // The rectangle: top = bottom, left = right, level, 90 degree corners
        let p = f.pointsM
        ctx.near(dist(p[0], p[1]), dist(p[3], p[2]), 1e-9, "top = bottom")
        ctx.near(dist(p[0], p[3]), dist(p[1], p[2]), 1e-9, "left = right")
        ctx.near(p[0].y, p[1].y, 1e-12, "level top")
        ctx.near(p[3].y, p[2].y, 1e-12, "level bottom")
        ctx.near(p[0].x, p[3].x, 1e-12, "plumb left")
        ctx.near(p[1].x, p[2].x, 1e-12, "plumb right")
        // The mean of the placed sides, as the old readout had it: 30 1/2 x 48 1/2
        ctx.near(f.widthIn, 30.5, 0.1)
        ctx.near(f.heightIn, 48.5, 0.1)
        ctx.near(dist(p[0], p[1]), f.widthIn, 1e-9)
        ctx.near(dist(p[0], p[3]), f.heightIn, 1e-9)
        // The server's own sizing of the corners that are sent gives back exactly the width and height the HUD shows, and a rectangle is good
        let size = sizeFromArPoints(p, device: .arkitLidar)
        ctx.near(size?.widthIn, f.widthIn, 1e-9)
        ctx.near(size?.heightIn, f.heightIn, 1e-9)
        ctx.equal(size?.quality, .good)
        let live = LiveReadout.from(corners: p, aim: nil, device: .arkitLidar)
        ctx.near(live.widthIn, f.widthIn, 1e-9)
        ctx.near(live.heightIn, f.heightIn, 1e-9)
        // As placed the server would have called it 'check' (top and bottom differ by 7%): the corners disagree with the rectangle
        ctx.equal(sizeFromArPoints(raw, device: .arkitLidar)?.quality, .check)
        ctx.expect(f.disagrees)
        ctx.expect(f.flaggedCorner == 2 || f.flaggedCorner == 3, "a bottom corner, got \(String(describing: f.flaggedCorner))")
        ctx.equal(f.tiltDeg, 0)
        // The raw corners are kept as they were
        ctx.equal(f.rawPointsM, raw)
    },

    Check("RectangleFit: one corner placed off the frame is the corner that is flagged, whichever it is") { ctx in
        for bad in 0..<4 {
            var c = trueCorners
            c[bad] = (c[bad].0 + 1.6, c[bad].1 - 1.2)
            let f = fit(quad(c))
            ctx.equal(f?.disagrees, true, "corner \(bad) off by 2 in")
            ctx.equal(f?.flaggedCorner, bad, "corner \(bad)")
            // And the other way
            var d = trueCorners
            d[bad] = (d[bad].0 - 1.3, d[bad].1 + 1.9)
            ctx.equal(fit(quad(d))?.flaggedCorner, bad, "corner \(bad) the other way")
        }
        // A corner off along the frame only (the bottom-left too far left): the left edge slants, so it is that corner or the one above it:
        // the one that is less sure is flagged, then the lower one
        var c = trueCorners
        c[3] = (-1.5, -60)
        ctx.equal(fit(quad(c))?.flaggedCorner, 3, "tied: the lower corner")
        ctx.equal(fit(quad(c), spread: [0.009, 0.001, 0.001, 0.002])?.flaggedCorner, 0, "tied: the one with the larger spread")
        ctx.equal(fit(quad(c), spread: [0.001, 0.001, 0.001, 0.009])?.flaggedCorner, 3)
    },

    Check("RectangleFit: corners that agree make a rectangle and no flag; a level fit unless the window is really turned") { ctx in
        // A few millimetres of noise on each coordinate
        let jitter: [(Double, Double)] = [(0.08, -0.05), (-0.04, 0.09), (0.06, 0.03), (-0.07, -0.06)]
        var c = trueCorners
        for i in 0..<4 { c[i] = (c[i].0 + jitter[i].0, c[i].1 + jitter[i].1) }
        let raw = quad(c)
        let f = fit(raw)
        ctx.equal(f?.disagrees, false)
        ctx.equal(f?.flaggedCorner, nil)
        ctx.near(f?.widthIn, 36, 0.1)
        ctx.near(f?.heightIn, 60, 0.1)
        ctx.expect((f?.residualIn.max() ?? 9) < 0.15)
        // Spreads for the server stay the corners' own
        let own = [0.002, 0.001, 0.003, 0.002]
        let spreads = f?.spreadM(corner: own) ?? []
        for i in 0..<4 { ctx.expect(spreads[i] >= own[i] && spreads[i] < FitLimits.checkSpreadM, "spread \(i)") }
        // A window really turned in its plane by 6 degrees: all four sides say so, the rectangle is turned with them and fits exactly
        let a = 6.0 * Double.pi / 180
        let turned = trueCorners.map { (cos(a) * $0.0 - sin(a) * $0.1, sin(a) * $0.0 + cos(a) * $0.1) }
        let t = fit(quad(turned))
        ctx.near(t?.tiltDeg, 6, 1e-6)
        ctx.equal(t?.disagrees, false)
        ctx.near(t?.widthIn, 36, 1e-6)
        ctx.near(t?.heightIn, 60, 1e-6)
        ctx.expect((t?.residualIn.max() ?? 9) < 1e-6)
        // Turned by a degree: that is the phone's doing, not the window's: level, and nothing flagged
        let b = 1.0 * Double.pi / 180
        let slight = trueCorners.map { (cos(b) * $0.0 - sin(b) * $0.1, sin(b) * $0.0 + cos(b) * $0.1) }
        let s = fit(quad(slight))
        ctx.equal(s?.tiltDeg, 0)
        ctx.equal(s?.disagrees, false)
        // Not a rectangle at all: a floor has no "up"
        let floor = Plane(point: Vec3(0, 0, 0), normal: Vec3(0, 1, 0))!
        let onFloor = [Vec3(0, 0, 0), Vec3(1, 0, 0), Vec3(1, 0, 1), Vec3(0, 0, 1)]
        ctx.expect(RectangleFit.fit(ordered: onFloor, plane: floor, viewer: Vec3(0, 2, 0)) == nil)
        ctx.expect(RectangleFit.fit(ordered: Array(raw.prefix(3)), plane: wallPlane, viewer: viewer) == nil)
    },

    Check("CornerCapture.finished: the window to send is the fitted rectangle, the corners as placed are kept, and one corner can be placed again") { ctx in
        var c = CornerCapture()
        c.setTracking(normal: true)
        c.setWallPlane(wallPlane, viewer: viewer)
        // A 36 x 60 in window whose bottom-left corner was placed 2 in off the frame; tapped BR, TL, BL, TR
        let raw = quad([(0, 0), (36, 0), (36, -60), (-1.6, -61.2)])
        for p in [raw[2], raw[0], raw[3], raw[1]] { ctx.equal(c.place(CornerEstimate(point: p, spreadM: 0.002, used: 15, rejected: 0)).isPlaced, true) }
        guard let f = c.finished(viewer: viewer), let fit = f.fit else { return ctx.expect(false, "no fit") }
        // The corners as placed are in `pointsM`; the rectangle is what is sent
        for i in 0..<4 { ctx.near(f.pointsM[i].distance(to: raw[i]), 0, 1e-9, "raw \(i)") }
        ctx.equal(f.windowPointsM, fit.pointsM)
        ctx.expect(f.windowSpreadM.allSatisfy { $0 >= 0.002 })
        ctx.equal(f.tapIndex, [1, 3, 0, 2], "TL was tapped second, TR fourth, BR first, BL third")
        // The corner that looks off is the bottom-left (display number 4): it was the third tap
        ctx.equal(f.flaggedCorner, 3)
        ctx.equal(c.removeCorner(at: f.tapIndex[3]), true)
        ctx.equal(c.corners.count, 3)
        ctx.expect(!c.isComplete)
        ctx.expect(c.wallPlane != nil, "the wall stays: the other three corners are still on it")
        ctx.expect(c.finished(viewer: viewer) == nil)
        // Placed again, on the frame this time
        ctx.equal(c.place(CornerEstimate(point: onWall(0, -60), spreadM: 0.002, used: 15, rejected: 0)).isPlaced, true)
        let g = c.finished(viewer: viewer)
        ctx.equal(g?.fit?.disagrees, false, "the corners now agree")
        ctx.equal(g?.flaggedCorner, nil)
        ctx.near(g?.fit?.widthIn, 36, 1e-6)
        ctx.near(g?.fit?.heightIn, 60, 1e-6)
        // Out of range: nothing removed
        ctx.equal(c.removeCorner(at: 9), false)
        ctx.equal(c.corners.count, 4)
        // Removing the last one lets the wall go
        var d = CornerCapture()
        d.setTracking(normal: true)
        d.setWallPlane(wallPlane, viewer: viewer)
        _ = d.place(CornerEstimate(point: raw[0], spreadM: 0.002, used: 15, rejected: 0))
        d.removeCorner(at: 0)
        ctx.expect(d.wallPlane == nil)
    },

    Check("RectangleFit: a window on a wall turned away from the phone is fitted in its own plane, level") { ctx in
        let r = rect(w: 36 * inch, h: 60 * inch, cx: 0, cy: 1.2, z: -2)
        let pivot = Vec3(0, 1.2, -2)
        let turned = yaw(r, 30, pivot: pivot)
        let eye = Vec3(0.3, 1.4, 0.2)
        var c = CornerCapture()
        c.setTracking(normal: true)
        for p in turned { _ = c.place(CornerEstimate(point: p, spreadM: 0.002, used: 15, rejected: 0)) }
        let f = c.finished(viewer: eye)
        ctx.equal(f?.fit?.disagrees, false)
        ctx.near(f?.fit?.widthIn, 36, 1e-6)
        ctx.near(f?.fit?.heightIn, 60, 1e-6)
        ctx.equal(f?.fit?.tiltDeg, 0)
        // Level: the top two corners at one height
        let p = f?.windowPointsM ?? []
        ctx.near(p.count == 4 ? p[0].y - p[1].y : 9, 0, 1e-9)
        ctx.near(p.count == 4 ? p[3].y - p[2].y : 9, 0, 1e-9)
    },

    Check("RectangleFit.spreadM and the preview: a window whose corners did not line up says so, a clean one does not") { ctx in
        guard let bad = fit(quad(skewed)), let good = fit(quad(trueCorners)) else { return ctx.expect(false, "no fit") }
        let own = [0.002, 0.002, 0.002, 0.002]
        let badSpreads = bad.spreadM(corner: own)
        // Every corner's spread is at least how far it was from the rectangle, the flagged one at least a centimetre
        for i in 0..<4 { ctx.expect(badSpreads[i] >= bad.residualIn[i] / inchesPerMetre - 1e-12, "residual \(i)") }
        ctx.expect(badSpreads[bad.worstCorner] >= FitLimits.checkSpreadM)
        ctx.equal(good.spreadM(corner: own), own, "a clean rectangle keeps the corners' own spreads")
        // The same rectangle through the preview the label sheet and the list use: size as the HUD, check when they did not line up
        func preview(_ f: RectangleFit) -> WindowPreview? {
            let scale = WindowPhotoScale.ar(ArScale(pointsM: f.pointsM, trackingLostCount: 0, device: .arkitLidar, cornerSpreadM: f.spreadM(corner: own)))
            let input = PhotoWindowInput(id: "w", uploadId: nil, label: nil, windowKey: nil, corners: nil, scale: scale, room: "Bedroom 1", style: nil)
            return LocalWindowPreview.of(input, imageWidthPx: 0, imageHeightPx: 0)
        }
        let pb = preview(bad), pg = preview(good)
        ctx.near(pb?.widthIn, bad.widthIn, 1e-9)
        ctx.near(pb?.heightIn, bad.heightIn, 1e-9)
        ctx.equal(pb?.needsCheck, true)
        ctx.expect(pb?.reasons.isEmpty == false)
        ctx.equal(pg?.needsCheck, false)
        ctx.expect((pb?.uncertaintyIn ?? 0) > (pg?.uncertaintyIn ?? 9), "the doubt shows in the \"about\"")
    },
]

private extension CornerCapture.PlaceResult {
    var isPlaced: Bool { if case .placed = self { return true } else { return false } }
}
