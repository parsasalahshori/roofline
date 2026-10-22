import Foundation
import RooflineCore

// Checks for measuring a window from a frozen photo (FrozenView.swift, FrozenMeasure.swift) and for snapping a corner onto the frame's
// corner in the picture (CornerSnap.swift): the 3D corners from a synthetic depth map and lens numbers, the one set of numbers for the
// plates, the status and what is sent, photos combined by median, and the corner picks the owner's phone got wrong.

// MARK: - A frozen frame to measure

private let lens = CameraIntrinsics(fx: 1400, fy: 1400, cx: 960, cy: 720, width: 1920, height: 1440)
/// The upright photo: the native image turned a quarter clockwise.
private let photoW = 1440.0, photoH = 1920.0
private let wallZ = -2.0
private let wallPlane = Plane(point: Vec3(0, 0, wallZ), normal: Vec3(0, 0, 1))!

/// An iPhone held upright, looking along -z (turned about the vertical axis by `yawDeg`): the native image's x axis runs DOWN the world,
/// its y axis to the RIGHT.
private func uprightPhone(at origin: Vec3, yawDeg: Double = 0) -> Mat4 {
    let a = yawDeg * .pi / 180
    func turn(_ v: Vec3) -> Vec3 { Vec3(v.x * cos(a) + v.z * sin(a), v.y, -v.x * sin(a) + v.z * cos(a)) }
    return Mat4.rigid(right: turn(Vec3(0, -1, 0)), up: turn(Vec3(1, 0, 0)), back: turn(Vec3(0, 0, 1)), origin: origin)
}

/// Depth of a wall at z = -2 with a window's frame standing `proud` metres in front of it: the opening's glass is `recess` behind the wall,
/// a ring of frame `ring` wide round the opening is proud, the rest is the wall.
private func depthMap(camera cam: Mat4, window: (cx: Double, cy: Double, w: Double, h: Double), proud: Double, recess: Double = 0.1, ring: Double = 0.06) -> FrozenDepth {
    let (w, h) = (256, 192)
    let k = lens.scaled(toWidth: Double(w), height: Double(h))
    var d = [Float](repeating: 0, count: w * h)
    for y in 0..<h {
        for x in 0..<w {
            let origin = cam.translation
            guard let r = ImageMapping.ray(throughNativePixel: Vec2(Double(x) + 0.5, Double(y) + 0.5), cameraTransform: cam, intrinsics: k) else { continue }
            // Which surface does this pixel see? Test the frame's face first (the opening and its ring), else the wall
            var hit = Plane(point: Vec3(0, 0, wallZ), normal: Vec3(0, 0, 1))!.intersect(rayOrigin: origin, direction: r.direction)
            if let onFace = Plane(point: Vec3(0, 0, wallZ + proud), normal: Vec3(0, 0, 1))!.intersect(rayOrigin: origin, direction: r.direction) {
                let dx = abs(onFace.x - window.cx), dy = abs(onFace.y - window.cy)
                let inOpening = dx <= window.w / 2 && dy <= window.h / 2
                let inRing = dx <= window.w / 2 + ring && dy <= window.h / 2 + ring
                if inOpening {
                    hit = Plane(point: Vec3(0, 0, wallZ - recess), normal: Vec3(0, 0, 1))!.intersect(rayOrigin: origin, direction: r.direction)
                } else if inRing {
                    hit = onFace
                }
            }
            if let p = hit { d[y * w + x] = Float(-cam.inverseRigid.transform(p).z) }
        }
    }
    return FrozenDepth(width: w, height: h, depthM: d, confidence: [UInt8](repeating: 2, count: w * h))
}

private let windowCentre = (cx: 0.3, cy: 1.4)
private let trueW = 36 * inch, trueH = 60 * inch

/// The corners of the 36 x 60 in opening on a plane at `z`: TL, TR, BR, BL.
private func openingCorners(z: Double) -> [Vec3] { rect(w: trueW, h: trueH, cx: windowCentre.cx, cy: windowCentre.cy, z: z) }

private func frozenView(proud: Double, withDepth: Bool = true, yaw: Double = 6) -> FrozenView {
    let cam = uprightPhone(at: Vec3(0.1, 1.5, 0.2), yawDeg: yaw)
    let depth = withDepth ? depthMap(camera: cam, window: (windowCentre.cx, windowCentre.cy, trueW, trueH), proud: proud) : nil
    return FrozenView(cameraTransform: cam, intrinsics: lens, wall: wallPlane, depth: depth, photoWidthPx: photoW, photoHeightPx: photoH)
}

private func photoPoints(_ view: FrozenView, _ world: [Vec3]) -> [Vec2] { world.compactMap { view.photoPixel(ofWorld: $0) } }

/// Plane coordinates in inches (s right, t up from the opening's top-left corner) on the frame's plane at z.
private func onFrame(_ s: Double, _ t: Double, z: Double) -> Vec3 {
    let tl = openingCorners(z: z)[0]
    return Vec3(tl.x + s * inch, tl.y + t * inch, z)
}

private func previewOf(_ r: FrozenResult) -> WindowPreview? {
    let scale = WindowPhotoScale.ar(ArScale(pointsM: r.windowPointsM, trackingLostCount: 0, device: .arkitLidar, cornerSpreadM: r.windowSpreadM))
    let input = PhotoWindowInput(id: "w", uploadId: nil, label: nil, windowKey: nil, corners: nil, scale: scale, room: "Bedroom 1", style: nil)
    return LocalWindowPreview.of(input, imageWidthPx: 0, imageHeightPx: 0)
}

// MARK: - A picture of a window corner

/// A square grey patch of `n` px with a bright opening whose top-left corner is at `corner`, its edges turned by `deg`; edges are `soft`
/// px wide. `stripes` adds look-alike edges (offset px from the true vertical edge, brightness share of the opening's).
private func cornerPatch(n: Int = 141, corner: (Double, Double), deg: Double = 0, soft: Double = 1.2, bright: Double = 190, dark: Double = 70,
                         noise: Double = 0, flipX: Bool = false, flipY: Bool = false, stripes: [(offset: Double, width: Double, share: Double)] = [],
                         horizontal: Bool = true) -> GrayPatch {
    var seed: UInt64 = 12345
    func rnd() -> Double {
        seed = seed &* 6364136223846793005 &+ 1442695040888963407
        return Double(seed >> 33) / Double(1 << 31)
    }
    func ramp(_ d: Double) -> Double { min(1, max(0, (d + soft) / (2 * soft))) }
    let a = deg * .pi / 180
    var px = [UInt8](repeating: 0, count: n * n)
    for y in 0..<n {
        for x in 0..<n {
            let sx = Double(flipX ? n - 1 - x : x) + 0.5, sy = Double(flipY ? n - 1 - y : y) + 0.5
            let dx = sx - corner.0, dy = sy - corner.1
            let u = dx * cos(a) + dy * sin(a)
            let v = -dx * sin(a) + dy * cos(a)
            var level = ramp(u) * (horizontal ? ramp(v) : 1)
            for s in stripes { level = max(level, s.share * ramp(u - s.offset) * ramp(-(u - s.offset - s.width))) }
            var value = dark + (bright - dark) * level
            if noise > 0 { value += (rnd() - 0.5) * 2 * noise }
            px[y * n + x] = UInt8(min(255, max(0, value.rounded())))
        }
    }
    return GrayPatch(width: n, height: n, pixels: px)
}

private func distance(_ a: Vec2, _ b: (Double, Double)) -> Double { ((a.x - b.0) * (a.x - b.0) + (a.y - b.1) * (a.y - b.1)).squareRoot() }

let frozenChecks: [Check] = [
    Check("FrozenView: ARKit's wall on the wrong surface (1.2 m in front of the window's wall, like a sofa's back) is replaced by the wall round the window") { ctx in
        let good = frozenView(proud: 0, yaw: 6)
        let wrongWall = Plane(point: Vec3(0, 0, wallZ + 1.2), normal: Vec3(0, 0, 1))!
        let bad = FrozenView(cameraTransform: good.cameraTransform, intrinsics: good.intrinsics, wall: wrongWall, depth: good.depth,
                             photoWidthPx: good.photoWidthPx, photoHeightPx: good.photoHeightPx)
        let px = photoPoints(bad, openingCorners(z: wallZ))
        let r = FrozenMeasure.measure(view: bad, photoPx: px)
        ctx.near(r?.widthIn, 36, 0.25, "width with the wrong ARKit wall")
        ctx.near(r?.heightIn, 60, 0.25, "height with the wrong ARKit wall")
        // ARKit's wall right: nothing changes
        let ok = FrozenMeasure.measure(view: good, photoPx: photoPoints(good, openingCorners(z: wallZ)))
        ctx.near(ok?.widthIn, 36, 0.25)
        ctx.near(ok?.heightIn, 60, 0.25)
    },

    Check("FrozenDepth: readings become world points on the wall; low confidence, holes and far readings are left out") { ctx in
        let cam = uprightPhone(at: Vec3(0, 1.5, 0))
        var d = FrozenDepth(width: 8, height: 6, depthM: [Float](repeating: 2, count: 48), confidence: [UInt8](repeating: 2, count: 48))
        let centre = lens.scaled(toWidth: 8, height: 6)
        let pts = d.points(aroundNative: Vec2(960, 720), radiusM: 0.5, cameraTransform: cam, intrinsics: lens)
        ctx.expect(pts.count >= 9, "points near the middle: \(pts.count)")
        for p in pts { ctx.near(p.z, -2, 1e-9, "on the wall z=-2") }
        // The pixel under the middle of the image is straight ahead
        let mid = ImageMapping.unproject(Vec2(4.5, 3.5), depth: 2, cameraTransform: cam, intrinsics: centre)
        ctx.expect(pts.contains { $0.distance(to: mid) < 1e-9 }, "the pixel at (4, 3)")
        // Low and medium confidence, a hole, and a reading beyond 10 m are not used
        d.confidence[3 * 8 + 4] = 1
        d.depthM[3 * 8 + 3] = 0
        d.depthM[2 * 8 + 4] = 12
        d.depthM[2 * 8 + 3] = .nan
        ctx.equal(d.reading(4, 3), nil)
        ctx.equal(d.reading(3, 3), nil)
        ctx.equal(d.reading(4, 2), nil)
        ctx.equal(d.reading(3, 2), nil)
        ctx.near(d.reading(5, 3), 2, 1e-6)
        ctx.equal(d.points(aroundNative: Vec2(960, 720), radiusM: 0.5, cameraTransform: cam, intrinsics: lens).count, pts.count - 4)
        // Off the image: nothing
        ctx.equal(d.points(aroundNative: Vec2(-50, 720), radiusM: 0.5, cameraTransform: cam, intrinsics: lens).count, 0)
        // A frame without a confidence map trusts its readings
        let plain = FrozenDepth(width: 8, height: 6, depthM: [Float](repeating: 2, count: 48))
        ctx.expect(plain.reading(1, 1) != nil)
        ctx.expect(!FrozenDepth(width: 8, height: 6, depthM: [1, 2]).isValid)
    },

    Check("FrozenView: corners dragged on the photo come back to the window's true size, with the frame 4 cm proud of the wall") { ctx in
        let proud = 0.04
        let view = frozenView(proud: proud)
        let truth = openingCorners(z: wallZ + proud)
        let px = photoPoints(view, truth)
        ctx.equal(px.count, 4)
        // The photo is upright: the top-left of the window is the top-left of the photo, and the window is right of the middle
        ctx.expect(px[0].x < px[1].x && px[0].y < px[3].y, "upright photo")
        ctx.expect(px[0].x > 0 && px[2].x < photoW && px[0].y > 0 && px[2].y < photoH, "all in the photo")
        // The photo's pixels and the camera's agree with a by-hand projection
        let native = ImageMapping.project(truth[0], cameraTransform: view.cameraTransform, intrinsics: lens)!
        let portrait = ImageMapping.nativeToPortrait(native, nativeWidth: 1920, nativeHeight: 1440)
        ctx.near(px[0].x, portrait.x, 1e-9)
        ctx.near(px[0].y, portrait.y, 1e-9)
        let back = view.nativePixel(fromPhoto: px[0])
        ctx.near(back.x, native.x, 1e-9)
        ctx.near(back.y, native.y, 1e-9)

        // With depth: the frame's plane is found (4 cm in front of the wall) and the corners land on it
        let plane = view.framePlane(photoPx: px)
        ctx.near(wallPlane.signedDistance(plane.point), proud, 0.004, "frame plane found by depth")
        let w = view.worldCorners(photoPx: px)
        for i in 0..<4 { ctx.near(w?.points[i].distance(to: truth[i]), 0, 0.004, "corner \(i)") }
        let r = FrozenMeasure.measure(view: view, photoPx: px)
        ctx.near(r?.widthIn, 36, 0.1)
        ctx.near(r?.heightIn, 60, 0.15)
        ctx.equal(r?.disagrees, false)
        ctx.equal(r?.needsCheck, false)
        // Two pixels of error in every corner (a fingertip and a blurry edge) costs a few hundredths of an inch
        let off = zip(px, [(2.0, -2.0), (-2.0, 1.0), (1.5, 2.0), (-1.0, -2.0)]).map { Vec2($0.x + $1.0, $0.y + $1.1) }
        let rough = FrozenMeasure.measure(view: view, photoPx: off)
        ctx.near(rough?.widthIn, 36, 0.25)
        ctx.near(rough?.heightIn, 60, 0.25)

        // The same photo on the wall alone (no depth): the corners are taken to be 4 cm further back than they are, and the window
        // reads about 2% too big. That is what the depth is for.
        let flat = frozenView(proud: proud, withDepth: false)
        let wrong = FrozenMeasure.measure(view: flat, photoPx: px)
        ctx.expect((wrong?.widthIn ?? 0) > 36.5, "no depth: \(wrong?.widthIn ?? 0)")
        ctx.equal(flat.device, .arkit)
        ctx.equal(view.device, .arkitLidar)
        // Depth that does not see the frame (all holes) is the wall too
        var empty = view
        empty.depth = FrozenDepth(width: 256, height: 192, depthM: [Float](repeating: 0, count: 256 * 192), confidence: [])
        ctx.equal(empty.framePlane(photoPx: px), empty.wall)
        // A frame flush with the wall needs no move
        let flush = frozenView(proud: 0)
        let flushPx = photoPoints(flush, openingCorners(z: wallZ))
        ctx.near(wallPlane.signedDistance(flush.framePlane(photoPx: flushPx).point), 0, 0.003)
        ctx.near(FrozenMeasure.measure(view: flush, photoPx: flushPx)?.widthIn, 36, 0.1)
        // A ray that cannot reach the wall (a plane behind the camera) gives nothing
        var bad = view
        bad.wall = Plane(point: Vec3(0, 0, 3), normal: Vec3(0, 0, -1))!
        bad.depth = nil
        ctx.expect(FrozenMeasure.measure(view: bad, photoPx: px) == nil)
        ctx.expect(FrozenMeasure.measure(view: view, photoPx: Array(px.prefix(3))) == nil)
    },

    Check("FrozenResult: one set of numbers. Plates, status, the rectangle sent and the server's sizing all give the same width and height") { ctx in
        // The owner's window: top 18 5/8 against a bottom of 18 7/8, so the old plates and the old HUD said different things
        let view = frozenView(proud: 0, withDepth: false, yaw: 0)
        let z = wallZ
        let handles = [onFrame(0, 0, z: z), onFrame(18.625, 0.2, z: z), onFrame(18.875, -35.2, z: z), onFrame(-0.1, -35.7, z: z)]
        let px = photoPoints(view, handles)
        guard let r = FrozenMeasure.measure(view: view, photoPx: px), let fit = r.finished.fit, let drawing = FrozenMeasure.drawing(r, view: view) else {
            return ctx.expect(false, "no result")
        }
        // The corners as placed are kept as dots; what is drawn and sent is the rectangle
        ctx.equal(r.handlePointsM.count, 4)
        for i in 0..<4 { ctx.near(r.handlePointsM[i].distance(to: handles[i]), 0, 1e-6, "dot \(i) where it was left") }
        let p = r.windowPointsM
        ctx.near(p[0].y, p[1].y, 1e-12, "level top")
        ctx.near(p[3].y, p[2].y, 1e-12, "level bottom")
        ctx.near(p[0].x, p[3].x, 1e-12, "plumb left")
        ctx.near(p[1].x, p[2].x, 1e-12, "plumb right")
        // Drawn straight too: with the phone square on, the outline in the photo is a rectangle of the photo
        ctx.near(drawing.outline[0].x, drawing.outline[3].x, 1e-6)
        ctx.near(drawing.outline[1].x, drawing.outline[2].x, 1e-6)
        ctx.near(drawing.outline[0].y, drawing.outline[1].y, 1e-6)
        ctx.near(drawing.outline[3].y, drawing.outline[2].y, 1e-6)
        // One width: the fit's, the server's sizing of what is sent, the live readout, the preview the label sheet and the list use
        let sent = sizeFromArPoints(r.windowPointsM, device: .arkit, cornerSpreadM: r.windowSpreadM)
        let live = LiveReadout.from(corners: r.windowPointsM, aim: nil, device: .arkit)
        let preview = previewOf(r)
        for w in [fit.widthIn, sent?.widthIn, live.widthIn, preview?.widthIn, p[0].distance(to: p[1]) * inchesPerMetre, p[3].distance(to: p[2]) * inchesPerMetre] {
            ctx.near(w, r.widthIn, 1e-9, "width")
        }
        for h in [fit.heightIn, sent?.heightIn, live.heightIn, preview?.heightIn, p[0].distance(to: p[3]) * inchesPerMetre, p[1].distance(to: p[2]) * inchesPerMetre] {
            ctx.near(h, r.heightIn, 1e-9, "height")
        }
        // The words are the same too: the mean of 18 5/8 and 18 7/8 is 18 3/4 everywhere
        ctx.equal(r.widthText, "18 3/4")
        ctx.equal(r.widthText, Eighths.format(preview?.widthIn ?? 0))
        ctx.equal(r.heightText, Eighths.format(preview?.heightIn ?? 0))
        // The plate sits on the side it measures
        ctx.near(drawing.widthPlate.y, drawing.outline[0].y, 1e-6)
        ctx.near(drawing.heightPlate.x, drawing.outline[0].x, 1e-6)
    },

    Check("FrozenResult: the corner that looks off is named only when it is clearly one; otherwise the person is told to check them all") { ctx in
        let view = frozenView(proud: 0, withDepth: false, yaw: 0)
        let z = wallZ
        func true4() -> [(Double, Double)] { [(0, 0), (36, 0), (36, -60), (0, -60)] }
        func result(_ c: [(Double, Double)], order: [Int] = [0, 1, 2, 3]) -> FrozenResult? {
            FrozenMeasure.measure(view: view, photoPx: photoPoints(view, order.map { onFrame(c[$0].0, c[$0].1, z: z) }))
        }
        // Corners on the frame: nothing flagged, a good window
        let clean = result(true4())
        ctx.equal(clean?.disagrees, false)
        ctx.equal(clean?.flaggedHandle, nil)
        ctx.equal(clean?.hint, FrozenCopy.looksRight)
        ctx.equal(clean?.needsCheck, false)
        // Owner: the top-left corner too low, the right one fine. It could as well be the top-right too high: none is named
        var tl = true4()
        tl[0] = (0, -1.9)
        let a = result(tl)
        ctx.equal(a?.disagrees, true)
        ctx.equal(a?.flaggedHandle, nil, "TL low only")
        ctx.equal(a?.hint, FrozenCopy.checkCorners)
        ctx.equal(a?.needsCheck, true, "the doubt is carried")
        // The top edge slanting up to the right
        var slant = true4()
        slant[1] = (36, 1.9)
        ctx.equal(result(slant)?.flaggedHandle, nil, "top slant")
        ctx.equal(result(slant)?.hint, FrozenCopy.checkCorners)
        // One corner off both along and across the frame: that one, whichever tap order the handles came in
        for order in [[0, 1, 2, 3], [2, 0, 3, 1], [3, 2, 1, 0]] {
            for bad in 0..<4 {
                var c = true4()
                c[bad] = (c[bad].0 + (bad == 0 || bad == 3 ? -1.6 : 1.6), c[bad].1 + (bad < 2 ? 1.5 : -1.5))
                let r = result(c, order: order)
                ctx.equal(r?.disagrees, true, "order \(order) corner \(bad)")
                ctx.equal(r?.flaggedHandle, order.firstIndex(of: bad), "order \(order) corner \(bad)")
                if let h = r?.flaggedHandle { ctx.equal(r?.hint, FrozenCopy.offCorner(handle: h)) }
            }
        }
        // The hint names the corner by its number on screen (1 to 4)
        ctx.equal(FrozenCopy.offCorner(handle: 1), "Corner 2 looks off the frame. Drag it onto the corner.")
        // Two corners off: no one to blame
        var two = true4()
        two[0] = (1.5, -1.5)
        two[2] = (34.5, -61.5)
        ctx.equal(result(two)?.flaggedHandle, nil)
        ctx.equal(result(two)?.hint, FrozenCopy.checkCorners)
        // The window to send is still one level rectangle in every one of these cases
        for c in [tl, slant, two] {
            guard let r = result(c) else { ctx.expect(false, "no result"); continue }
            let p = r.windowPointsM
            ctx.near(p[0].y, p[1].y, 1e-12)
            ctx.near(p[0].x, p[3].x, 1e-12)
            ctx.near(p[0].distance(to: p[1]), p[3].distance(to: p[2]), 1e-12)
        }
    },

    Check("FrozenMeasure.combine: photos of one window combine by median; one wrong photo does not move it; photos that disagree say check") { ctx in
        let view = frozenView(proud: 0, withDepth: false, yaw: 0)
        let z = wallZ
        func measure(_ c: [(Double, Double)]) -> FrozenResult? {
            FrozenMeasure.measure(view: view, photoPx: photoPoints(view, c.map { onFrame($0.0, $0.1, z: z) }))
        }
        func window(_ w: Double, _ h: Double, dx: Double = 0, dy: Double = 0) -> [(Double, Double)] { [(dx, dy), (dx + w, dy), (dx + w, dy - h), (dx, dy - h)] }
        guard let a = measure(window(36, 60)), let b = measure(window(36.1, 60.05, dx: 0.05)), let c = measure(window(35.95, 59.9, dx: -0.05, dy: 0.05)),
              let wrong = measure(window(37.8, 61.4)) else { return ctx.expect(false, "no results") }
        // One photo is itself
        let one = FrozenMeasure.combine([a], viewer: view.viewer, device: .arkit)
        ctx.equal(one?.photos, 1)
        ctx.equal(one?.result, a)
        // Two that agree
        let two = FrozenMeasure.combine([a, b], viewer: view.viewer, device: .arkit)
        ctx.equal(two?.photos, 2)
        ctx.equal(two?.disagrees, false)
        ctx.near(two?.result.widthIn, 36.05, 0.02)
        ctx.near(two?.result.heightIn, 60.025, 0.02)
        // Three, one of them a long way out: the middle one wins
        let three = FrozenMeasure.combine([a, wrong, c], viewer: view.viewer, device: .arkit)
        ctx.equal(three?.photos, 3)
        ctx.expect(abs((three?.result.widthIn ?? 0) - 36) < 0.1, "median width \(three?.result.widthIn ?? 0)")
        ctx.expect(abs((three?.result.heightIn ?? 0) - 60) < 0.15, "median height \(three?.result.heightIn ?? 0)")
        ctx.equal(three?.disagrees, true, "the wrong photo is nearly 2 in out at its right corners")
        ctx.equal(three?.result.needsCheck, true)
        ctx.expect((three?.disagreeIn ?? 0) > FrozenMeasure.maxDisagreeIn)
        // The combined window is one rectangle, sized once
        if let r = three?.result, let fit = r.finished.fit {
            let p = r.windowPointsM
            ctx.near(p[0].y, p[1].y, 1e-9)
            ctx.near(p[0].distance(to: p[1]), p[3].distance(to: p[2]), 1e-9)
            ctx.near(fit.widthIn, r.widthIn, 1e-9)
            ctx.near(previewOf(r)?.widthIn, r.widthIn, 1e-9)
        } else {
            ctx.expect(false, "no combined rectangle")
        }
        // Agreeing photos do not need a check on account of being combined
        let agree = FrozenMeasure.combine([a, b, c], viewer: view.viewer, device: .arkit)
        ctx.equal(agree?.disagrees, false)
        ctx.equal(agree?.result.needsCheck, false)
        ctx.expect(FrozenMeasure.combine([], viewer: view.viewer, device: .arkit) == nil)
    },

    Check("CornerSnap: a corner let go near a window corner lands on it, at all four corners, with blur, a lean and noise") { ctx in
        let truth = (70.3, 66.7)
        let radius = CornerSnap.radius(forPhotoWidth: 1440)
        ctx.near(radius, 25, 0)
        // Starting points around it: up-right, down-left, far along each edge, on top of it
        for start in [(79.0, 60.0), (58.0, 77.0), (92.0, 68.0), (71.0, 49.0), (70.3, 66.7)] {
            let patch = cornerPatch(corner: truth)
            let s = CornerSnap.snap(corner: Vec2(start.0, start.1), in: patch, radius: radius)
            ctx.expect(s != nil, "snapped from \(start)")
            ctx.expect(s.map { distance($0.point, truth) < 0.6 } ?? false, "from \(start): got \(String(describing: s?.point)), want \(truth)")
        }
        // Soft edges (a blurry photo), a 3 degree lean, noise, a low-contrast frame
        let variants: [(String, GrayPatch)] = [
            ("blurred", cornerPatch(corner: truth, soft: 2.6)),
            ("leaning 3 degrees", cornerPatch(corner: truth, deg: 3)),
            ("leaning -4 degrees", cornerPatch(corner: truth, deg: -4)),
            ("noisy", cornerPatch(corner: truth, noise: 7)),
            ("low contrast", cornerPatch(corner: truth, bright: 130, dark: 90, noise: 1.5)),
        ]
        for (name, patch) in variants {
            let s = CornerSnap.snap(corner: Vec2(77, 61), in: patch, radius: radius)
            ctx.expect(s.map { distance($0.point, truth) < 1.0 } ?? false, "\(name): got \(String(describing: s?.point))")
        }
        // The other three corners of a window (the picture mirrored)
        let n = 141.0
        for (fx, fy) in [(true, false), (false, true), (true, true)] {
            let want = (fx ? n - truth.0 : truth.0, fy ? n - truth.1 : truth.1)
            let patch = cornerPatch(corner: truth, flipX: fx, flipY: fy)
            let start = Vec2(want.0 + (fx ? -8 : 8), want.1 + (fy ? 7 : -7))
            let s = CornerSnap.snap(corner: start, in: patch, radius: radius)
            ctx.expect(s.map { distance($0.point, want) < 0.7 } ?? false, "mirrored \(fx),\(fy): got \(String(describing: s?.point)), want \(want)")
        }
        // A real second edge beside it that is much weaker (a thin trim at 40%) does not pull the corner off the frame
        let trim = cornerPatch(corner: truth, stripes: [(offset: -13, width: 3, share: 0.3)])
        let t = CornerSnap.snap(corner: Vec2(75, 63), in: trim, radius: radius)
        ctx.expect(t.map { distance($0.point, truth) < 1.0 } ?? false, "weak trim: got \(String(describing: t?.point))")
        // Many starts, leans, blurs and noise: nearly all snap, and the ones that do land within a pixel of the corner (never somewhere else)
        var seed: UInt64 = 99
        func rnd() -> Double {
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            return Double(seed >> 33) / Double(1 << 31)
        }
        var snapped = 0, wrong = 0
        let trials = 40
        for _ in 0..<trials {
            let patch = cornerPatch(corner: truth, deg: (rnd() - 0.5) * 8, soft: 1 + rnd() * 1.6, noise: 5 * rnd())
            let start = Vec2(truth.0 + (rnd() - 0.5) * 36, truth.1 + (rnd() - 0.5) * 36)
            if let s = CornerSnap.snap(corner: start, in: patch, radius: radius) {
                snapped += 1
                if distance(s.point, truth) > 1.2 { wrong += 1 }
            }
        }
        ctx.equal(wrong, 0, "never lands elsewhere")
        ctx.expect(snapped >= trials * 9 / 10, "snapped \(snapped) of \(trials)")
        // The pixels are the photo's: a bigger photo scales the radius
        ctx.near(CornerSnap.radius(forPhotoWidth: 3024), 53, 0)
        ctx.equal(CornerSnap.halfSize(forRadius: 25), 65)
    },

    Check("CornerSnap: when the picture is not clear the corner stays where it was let go") { ctx in
        let truth = (70.3, 66.7)
        let radius = 25.0
        let start = Vec2(78, 62)
        // Nothing there: a flat wall with sensor noise
        var flatPixels = [UInt8](repeating: 128, count: 141 * 141)
        for i in 0..<flatPixels.count { flatPixels[i] = UInt8(126 + (i * 7919) % 5) }
        let flat = GrayPatch(width: 141, height: 141, pixels: flatPixels)
        ctx.expect(CornerSnap.snap(corner: start, in: flat, radius: radius) == nil, "flat")
        // One edge and no other: a window edge with no corner in reach
        ctx.expect(CornerSnap.snap(corner: start, in: cornerPatch(corner: truth, horizontal: false), radius: radius) == nil, "only a vertical edge")
        // Two look-alike edges (frame and casing, the same strength, 9 px apart): which one is the corner?
        let casing = cornerPatch(corner: truth, stripes: [(offset: -15, width: 6, share: 1.0)])
        ctx.expect(CornerSnap.snap(corner: Vec2(66, 62), in: casing, radius: radius) == nil, "equal look-alikes")
        // The corner is further away than the radius
        ctx.expect(CornerSnap.snap(corner: Vec2(truth.0 + 40, truth.1 - 30), in: cornerPatch(corner: truth), radius: radius) == nil, "too far")
        // A very faint frame: below the gradient floor
        ctx.expect(CornerSnap.snap(corner: start, in: cornerPatch(corner: truth, bright: 76, dark: 70), radius: radius) == nil, "faint")
        // A tiny or broken patch
        ctx.expect(CornerSnap.snap(corner: start, in: GrayPatch(width: 2, height: 2, pixels: [0, 0, 0, 0]), radius: radius) == nil)
        ctx.expect(CornerSnap.snap(corner: start, in: GrayPatch(width: 10, height: 10, pixels: [0]), radius: radius) == nil)
        ctx.expect(CornerSnap.snap(corner: Vec2(.nan, 1), in: cornerPatch(corner: truth), radius: radius) == nil)
        // Lines that lean too far to be a window's (45 degrees) are not a frame's edges
        ctx.expect(CornerSnap.snap(corner: start, in: cornerPatch(corner: truth, deg: 40), radius: radius) == nil, "leaning 40 degrees")
    },
]
