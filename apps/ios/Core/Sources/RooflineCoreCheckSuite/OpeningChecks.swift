import Foundation
import RooflineCore

// Checks for finding the window opening from the depth map (OpeningFinder.swift) and for the rectangle the person edits (FrozenRect.swift).
// The scenes are drawn in the world and photographed by a synthetic camera: a wall at 1.6 m with a 21 x 44 in opening in it, and in front
// of the wall or in the opening whatever makes real windows hard: blinds hung inside the recess, a lamp standing in front of one corner, a
// valance above, a picture on the wall beside it, a casing round it.

// MARK: - A camera and a scene

private let lens = CameraIntrinsics(fx: 700, fy: 700, cx: 480, cy: 360, width: 960, height: 720)
private let photoW = 720.0, photoH = 960.0
private let wallZ = -1.6
private let wallPlane = Plane(point: Vec3(0, 0, wallZ), normal: Vec3(0, 0, 1))!

/// An iPhone held upright at `origin`, turned about the vertical axis by `yawDeg` (negative looks toward +x).
private func phone(at origin: Vec3, yawDeg: Double) -> Mat4 {
    let a = yawDeg * .pi / 180
    func turn(_ v: Vec3) -> Vec3 { Vec3(v.x * cos(a) + v.z * sin(a), v.y, -v.x * sin(a) + v.z * cos(a)) }
    return Mat4.rigid(right: turn(Vec3(0, -1, 0)), up: turn(Vec3(1, 0, 0)), back: turn(Vec3(0, 0, 1)), origin: origin)
}

/// A rectangle (x0 ... x1, y0 ... y1 in the wall's plane coordinates, metres) standing `offset` metres in front of the wall (+) or behind it (-).
private struct Patch {
    var x0: Double, x1: Double, y0: Double, y1: Double
    var offset: Double
    func contains(_ x: Double, _ y: Double) -> Bool { x >= x0 && x <= x1 && y >= y0 && y <= y1 }
}

private struct Scene {
    /// The opening in the wall, 21 x 44 in.
    var opening = Patch(x0: 0.1 - 0.2667, x1: 0.1 + 0.2667, y0: 1.45 - 0.5588, y1: 1.45 + 0.5588, offset: 0)
    /// How far behind the wall the glass is; 0 or less: the glass returns nothing.
    var recess = 0.10
    /// The casing round the opening: this wide, standing this far proud (the opening's own edge is at the wall's plane).
    var ring = 0.07
    var ringOffset = 0.0
    var blinds: Patch?
    /// Things standing off the wall, in front of the opening or of the wall.
    var front: [Patch] = []
    /// Things on the wall (a picture, at the wall's own depth).
    var onWall: [Patch] = []

    static func standard() -> Scene {
        var s = Scene()
        let o = s.opening
        // Blinds hung inside the recess over the top of the opening
        s.blinds = Patch(x0: o.x0, x1: o.x1, y0: o.y1 - 0.45, y1: o.y1, offset: -0.05)
        // A lamp standing in front of the lower-left corner, a valance above the window
        s.front = [Patch(x0: o.x0 - 0.10, x1: o.x0 + 0.12, y0: o.y0 - 0.05, y1: o.y0 + 0.35, offset: 0.35),
                   Patch(x0: o.x0 - 0.10, x1: o.x1 + 0.10, y0: o.y1 + 0.10, y1: o.y1 + 0.30, offset: 0.12)]
        // A picture on the wall to the right
        s.onWall = [Patch(x0: o.x1 + 0.35, x1: o.x1 + 0.85, y0: 1.2, y1: 1.9, offset: 0.03)]
        return s
    }
}

private func plane(z: Double, in origin: Vec3, _ dir: Vec3, offset: Double) -> (x: Double, y: Double, t: Double)? {
    let zz = wallZ + offset
    guard abs(dir.z) > 1e-9 else { return nil }
    let t = (zz - origin.z) / dir.z
    guard t > 0 else { return nil }
    return (origin.x + dir.x * t, origin.y + dir.y * t, t)
}

/// The depth map (256 x 192, metres along the camera's view direction, 0 where nothing returns) that the camera would read.
private func depthMap(_ scene: Scene, camera cam: Mat4, confidence: UInt8 = 2) -> FrozenDepth {
    let (w, h) = (256, 192)
    let k = lens.scaled(toWidth: Double(w), height: Double(h))
    let inverse = cam.inverseRigid
    var d = [Float](repeating: 0, count: w * h)
    for y in 0..<h {
        for x in 0..<w {
            guard let r = ImageMapping.ray(throughNativePixel: Vec2(Double(x) + 0.5, Double(y) + 0.5), cameraTransform: cam, intrinsics: k) else { continue }
            let o = r.origin, dir = r.direction
            var nearest: Double?
            func take(_ t: Double) { if nearest == nil || t < nearest! { nearest = t } }
            for p in scene.front + scene.onWall {
                if let hit = plane(z: wallZ, in: o, dir, offset: p.offset), p.contains(hit.x, hit.y) { take(hit.t) }
            }
            if let wallHit = plane(z: wallZ, in: o, dir, offset: 0) {
                if scene.opening.contains(wallHit.x, wallHit.y) {
                    if let b = scene.blinds, let hit = plane(z: wallZ, in: o, dir, offset: b.offset), b.contains(hit.x, hit.y) {
                        take(hit.t)
                    } else if scene.recess > 0, let hit = plane(z: wallZ, in: o, dir, offset: -scene.recess) {
                        take(hit.t)
                    }
                } else {
                    let ring = Patch(x0: scene.opening.x0 - scene.ring, x1: scene.opening.x1 + scene.ring, y0: scene.opening.y0 - scene.ring, y1: scene.opening.y1 + scene.ring, offset: scene.ringOffset)
                    if let hit = plane(z: wallZ, in: o, dir, offset: ring.offset), ring.contains(hit.x, hit.y) { take(hit.t) } else { take(wallHit.t) }
                }
            }
            if let t = nearest { d[y * w + x] = Float(-inverse.transform(o + dir * t).z) }
        }
    }
    return FrozenDepth(width: w, height: h, depthM: d, confidence: [UInt8](repeating: confidence, count: w * h))
}

private func view(_ scene: Scene, depth: Bool = true, camera: Mat4? = nil, confidence: UInt8 = 2) -> FrozenView {
    let cam = camera ?? phone(at: Vec3(0, 1.5, 0), yawDeg: -3.6)
    return FrozenView(cameraTransform: cam, intrinsics: lens, wall: wallPlane, depth: depth ? depthMap(scene, camera: cam, confidence: confidence) : nil,
                      photoWidthPx: photoW, photoHeightPx: photoH)
}

// MARK: - The photo of the scene

private func ramp(_ d: Double, soft: Double) -> Double { min(1, max(0, 0.5 + d / (2 * soft))) }

/// 1 inside the patch, 0 outside, with edges `soft` metres wide.
private func mask(_ x: Double, _ y: Double, _ p: Patch, soft: Double) -> Double {
    ramp(x - p.x0, soft: soft) * ramp(p.x1 - x, soft: soft) * ramp(y - p.y0, soft: soft) * ramp(p.y1 - y, soft: soft)
}

/// The photo the camera would take, in grey: the wall light, the casing lighter, the opening dark with the blinds' slats, the lamp and the
/// picture drawn where their own planes put them.
private func grayPhoto(_ scene: Scene, view v: FrozenView) -> (pixels: [UInt8], width: Int, height: Int) {
    let w = Int(photoW), h = Int(photoH)
    var px = [UInt8](repeating: 0, count: w * h)
    let soft = 0.003
    let o = scene.opening
    let outer = Patch(x0: o.x0 - scene.ring, x1: o.x1 + scene.ring, y0: o.y0 - scene.ring, y1: o.y1 + scene.ring, offset: 0)
    for y in 0..<h {
        for x in 0..<w {
            guard let ray = ImageMapping.ray(throughNativePixel: v.nativePixel(fromPhoto: Vec2(Double(x) + 0.5, Double(y) + 0.5)), cameraTransform: v.cameraTransform, intrinsics: v.intrinsics),
                  let hit = plane(z: wallZ, in: ray.origin, ray.direction, offset: 0) else { continue }
            var value = 190.0
            value += (215 - value) * mask(hit.x, hit.y, outer, soft: soft)
            let inside = mask(hit.x, hit.y, o, soft: soft)
            var opening = 70.0
            if let b = scene.blinds, let bh = plane(z: wallZ, in: ray.origin, ray.direction, offset: b.offset) {
                // Slats every 2 cm, a little lighter than the glass
                let slat = Int((bh.y / 0.02).rounded(.down)) % 2 == 0 ? 82.0 : 70.0
                opening += (slat - opening) * mask(bh.x, bh.y, b, soft: soft)
            }
            value += (opening - value) * inside
            for p in scene.onWall {
                if let ph = plane(z: wallZ, in: ray.origin, ray.direction, offset: p.offset) {
                    let m = mask(ph.x, ph.y, p, soft: soft)
                    let art = mask(ph.x, ph.y, Patch(x0: p.x0 + 0.03, x1: p.x1 - 0.03, y0: p.y0 + 0.03, y1: p.y1 - 0.03, offset: 0), soft: soft)
                    value += (60 - value) * m
                    value += (150 - value) * art
                }
            }
            for p in scene.front {
                if let ph = plane(z: wallZ, in: ray.origin, ray.direction, offset: p.offset) {
                    value += (120 - value) * mask(ph.x, ph.y, p, soft: soft)
                }
            }
            px[y * w + x] = UInt8(min(255, max(0, value.rounded())))
        }
    }
    return (px, w, h)
}

private func patchSource(_ photo: (pixels: [UInt8], width: Int, height: Int)) -> OpeningFinder.PatchSource {
    { x, y, w, h in
        guard x >= 0, y >= 0, x + w <= photo.width, y + h <= photo.height else { return nil }
        var out = [UInt8](repeating: 0, count: w * h)
        for yy in 0..<h { for xx in 0..<w { out[yy * w + xx] = photo.pixels[(y + yy) * photo.width + x + xx] } }
        return GrayPatch(width: w, height: h, pixels: out)
    }
}

private let inchTol = 0.25 * inch

private func truth(_ s: Scene) -> (left: Double, right: Double, top: Double, bottom: Double) { (s.opening.x0, s.opening.x1, s.opening.y1, s.opening.y0) }

private func edgesNear(_ ctx: CheckContext, _ r: FrozenRect?, _ s: Scene, _ tol: Double, _ what: String, line: UInt = #line) {
    guard let r = r else { return ctx.expect(false, "\(what): nothing found", line: line) }
    let t = truth(s)
    // The plane's own axes are the wall's x and y here (a wall facing +z, up is +y), measured from the plane's point
    let p = r.plane.point
    ctx.near(r.left + p.x, t.left, tol, "\(what) left", line: line)
    ctx.near(r.right + p.x, t.right, tol, "\(what) right", line: line)
    ctx.near(r.top + p.y, t.top, tol, "\(what) top", line: line)
    ctx.near(r.bottom + p.y, t.bottom, tol, "\(what) bottom", line: line)
}

let openingChecks: [Check] = [
    Check("OpeningFinder: the opening is where the wall isn't: blinds in the recess, a lamp in front, a valance above and a picture on the wall do not move it") { ctx in
        let scene = Scene.standard()
        let v = view(scene)
        let found = OpeningFinder.find(view: v, reticle: Vec2(photoW / 2, photoH / 2))
        // The casing is 3 cm proud of the wall and the frame's plane is found from it: the opening is measured on that plane
        edgesNear(ctx, found?.rect, scene, inchTol, "depth only")
        ctx.expect((found?.fill ?? 0) > 0.6, "fill \(found?.fill ?? 0)")
        ctx.equal(found?.refined, [false, false, false, false])
        // The size is the window's: 21 x 44 in
        let r = found?.rect
        ctx.near((r?.widthM ?? 0) * inchesPerMetre, 21, 0.3)
        ctx.near((r?.heightM ?? 0) * inchesPerMetre, 44, 0.3)
        if let f = found { ctx.expect(OpeningFinder.isPlausible(f.rect, fromDepth: true)) }
        // A different camera, further left and turned the other way
        let v2 = view(scene, camera: phone(at: Vec3(-0.4, 1.6, 0.2), yawDeg: -12))
        edgesNear(ctx, OpeningFinder.find(view: v2, reticle: Vec2(photoW / 2, photoH / 2))?.rect, scene, 0.0075, "from the left")
        // The glass returns nothing at all (bright outdoors): the same opening
        var dark = scene
        dark.recess = 0
        edgesNear(ctx, OpeningFinder.find(view: view(dark), reticle: Vec2(photoW / 2, photoH / 2))?.rect, dark, inchTol, "glass with no readings")
        // Blinds hanging in front of the opening's plane (a valance-like box over the top) do not make the top edge lower: nothing proud
        // decides an edge, so an opening whose top is covered by something in front has no top edge from the depth: it is not guessed
        var covered = scene
        covered.front.append(Patch(x0: scene.opening.x0 - 0.2, x1: scene.opening.x1 + 0.2, y0: scene.opening.y1 - 0.5, y1: scene.opening.y1 + 0.3, offset: 0.12))
        let c = OpeningFinder.find(view: view(covered), reticle: Vec2(photoW / 2, photoH / 2))
        if let c = c { ctx.expect(c.rect.top + c.rect.plane.point.y <= scene.opening.y1 + inchTol, "never above the true top") }
    },

    Check("OpeningFinder: a valance sitting right on the frame's top: the opening is still found, its top where the valance starts") { ctx in
        var scene = Scene.standard()
        let o = scene.opening
        // The owner's window: the valance box hangs over the top of the frame (3 cm over it, no wall or casing showing between), 12 cm proud
        scene.ring = 0
        scene.front = [scene.front[0], Patch(x0: o.x0 - 0.12, x1: o.x1 + 0.12, y0: o.y1 - 0.03, y1: o.y1 + 0.15, offset: 0.12)]
        let found = OpeningFinder.find(view: view(scene), reticle: Vec2(photoW / 2, photoH / 2))
        ctx.expect(found != nil, "found with three wall sides and the valance on top")
        guard let r = found?.rect else { return }
        let t = truth(scene), p = r.plane.point
        ctx.near(r.left + p.x, t.left, 0.0075)
        ctx.near(r.right + p.x, t.right, 0.0075)
        ctx.near(r.bottom + p.y, t.bottom, 0.0075)
        // The valance hides the top 3 cm (and a little more from a camera below it): never above the true top, at most about 2.5 in below it
        ctx.expect(r.top + p.y <= t.top + 0.0075, "not above the true top")
        ctx.expect(r.top + p.y >= t.top - 0.065, "top \(r.top + p.y) vs \(t.top)")
    },

    Check("OpeningFinder: each side is set onto the edge in the photo within 3 cm, and left where the depth put it when the picture is not clear") { ctx in
        let scene = Scene.standard()
        let v = view(scene)
        let photo = grayPhoto(scene, view: v)
        let depthOnly = OpeningFinder.find(view: v, reticle: Vec2(photoW / 2, photoH / 2))
        let found = OpeningFinder.find(view: v, reticle: Vec2(photoW / 2, photoH / 2), photo: patchSource(photo))
        ctx.equal(found?.refined, [true, true, true, true], "every side found its edge")
        edgesNear(ctx, found?.rect, scene, 0.004, "with the photo")
        // Never worse than the depth alone
        if let a = depthOnly?.rect, let b = found?.rect {
            let t = truth(scene), p = a.plane.point
            func err(_ r: FrozenRect) -> Double { [abs(r.left + p.x - t.left), abs(r.right + p.x - t.right), abs(r.top + p.y - t.top), abs(r.bottom + p.y - t.bottom)].max() ?? 0 }
            ctx.expect(err(b) <= err(a) + 1e-9, "photo \(err(b)) vs depth \(err(a))")
        }
        // A photo with nothing in it: the depth's edges stay
        let blank = (pixels: [UInt8](repeating: 128, count: photo.pixels.count), width: photo.width, height: photo.height)
        let kept = OpeningFinder.find(view: v, reticle: Vec2(photoW / 2, photoH / 2), photo: patchSource(blank))
        ctx.equal(kept?.refined, [false, false, false, false])
        ctx.equal(kept?.rect, depthOnly?.rect)
        // A photo source that cannot give a patch: the depth's edges stay
        let none = OpeningFinder.find(view: v, reticle: Vec2(photoW / 2, photoH / 2), photo: { _, _, _, _ in nil })
        ctx.equal(none?.rect, depthOnly?.rect)
    },

    Check("OpeningFinder: no opening to find: no depth, the middle on a solid wall, an opening off the picture, a hole too small, a leaky one") { ctx in
        let scene = Scene.standard()
        // No depth sensor
        ctx.expect(OpeningFinder.find(view: view(scene, depth: false), reticle: Vec2(photoW / 2, photoH / 2)) == nil)
        // A solid wall: nothing is behind it
        var solid = Scene()
        solid.opening = Patch(x0: 5, x1: 6, y0: 1, y1: 2, offset: 0)
        ctx.expect(OpeningFinder.find(view: view(solid), reticle: Vec2(photoW / 2, photoH / 2)) == nil)
        // A window as big as the picture: it runs off the edge and cannot be measured
        var huge = Scene()
        huge.opening = Patch(x0: -3, x1: 3, y0: -1, y1: 4, offset: 0)
        ctx.expect(OpeningFinder.find(view: view(huge), reticle: Vec2(photoW / 2, photoH / 2)) == nil)
        // A hole 9 cm across (a vent): not a window
        var vent = Scene()
        vent.opening = Patch(x0: 0.05, x1: 0.14, y0: 1.4, y1: 1.49, offset: 0)
        ctx.expect(OpeningFinder.find(view: view(vent), reticle: Vec2(photoW / 2, photoH / 2)) == nil)
        // Aimed at the wall beside the window, far from it: the middle's own opening is none
        var aside = Scene.standard()
        aside.opening = Patch(x0: 0.9, x1: 1.43, y0: 0.9, y1: 2.0, offset: 0)
        aside.blinds = nil
        aside.front = []
        aside.onWall = []
        let wide = view(aside)
        // The middle of the picture is wall; the window is well off to the side: only an opening near the middle is taken
        let farReticle = OpeningFinder.find(view: wide, reticle: Vec2(photoW / 2, photoH / 2))
        ctx.expect(farReticle == nil || (farReticle?.rect.left ?? 0) + (farReticle?.rect.plane.point.x ?? 0) > 0.8, "the window it finds is the one beside, or none")
        // Readings of low confidence only: the whole wall is 'no reading', and it runs off the picture
        ctx.expect(OpeningFinder.find(view: view(scene, confidence: 1), reticle: Vec2(photoW / 2, photoH / 2)) == nil)
        // Plausibility: a sash is not a window when only Vision found it; depth knows better
        let sash = FrozenRect(plane: wallPlane, viewer: Vec3(0, 1.5, 0), left: 0, right: 17 * inch, top: 12.75 * inch, bottom: 0)!
        let whole = FrozenRect(plane: wallPlane, viewer: Vec3(0, 1.5, 0), left: 0, right: 21 * inch, top: 44 * inch, bottom: 0)!
        ctx.expect(!OpeningFinder.isPlausible(sash, fromDepth: false), "a 17 x 12 3/4 in sash")
        ctx.expect(OpeningFinder.isPlausible(whole, fromDepth: false))
        ctx.expect(OpeningFinder.isPlausible(sash, fromDepth: true))
        let wall = FrozenRect(plane: wallPlane, viewer: Vec3(0, 1.5, 0), left: 0, right: 5, top: 2.5, bottom: 0)!
        ctx.expect(!OpeningFinder.isPlausible(wall, fromDepth: true), "a whole wall")
    },

    Check("FrozenRect: the dots are the rectangle. Dragging a corner moves its two edges, a side handle moves one, and what is drawn is what is measured") { ctx in
        // A plain wall and opening: the casing is not proud, so the frame's plane is the wall's
        let scene = Scene()
        let v = view(scene)
        let corners = [scene.opening.x0, scene.opening.x1].flatMap { x in [scene.opening.y1, scene.opening.y0].map { y in Vec3(x, y, wallZ) } }
        // TL, TR, BR, BL on the wall plane
        let tl = corners[0], tr = corners[2], br = corners[3], bl = corners[1]
        let px = [tl, tr, br, bl].compactMap { v.photoPixel(ofWorld: $0) }
        guard px.count == 4, let start = FrozenRect.fromPhoto(corners: px, view: v) else { return ctx.expect(false, "no rectangle") }
        ctx.near(start.widthM * inchesPerMetre, 21, 0.05)
        ctx.near(start.heightM * inchesPerMetre, 44, 0.05)
        guard let handles = start.handlePhotoPoints(view: v) else { return ctx.expect(false, "no handles") }
        ctx.equal(handles.count, 8)
        // The corner handles are exactly the four photo points; the side handles are in the middle of their sides
        for i in 0..<4 { ctx.near(handles[i].x, px[i].x, 1e-6); ctx.near(handles[i].y, px[i].y, 1e-6) }
        ctx.near(handles[4].x, (handles[0].x + handles[1].x) / 2, 3.0, "top handle in the middle of the top")

        // Drag the top-left dot 30 px right and 20 px down: the left and top edges move, the right and bottom do not
        let target = Vec2(handles[0].x + 30, handles[0].y + 20)
        let moved = start.moved(.topLeft, toPhoto: target, view: v)
        ctx.near(moved.right, start.right, 1e-12)
        ctx.near(moved.bottom, start.bottom, 1e-12)
        ctx.expect(moved.left > start.left && moved.top < start.top)
        // The dot is where the finger put it, and the neighbours' edges followed: TR's top and BL's left are the new ones
        let after = moved.handlePhotoPoints(view: v)!
        ctx.near(after[0].x, target.x, 1e-6, "dot under the finger x")
        ctx.near(after[0].y, target.y, 1e-6, "dot under the finger y")
        let world = moved.cornersM
        ctx.near(world[1].y, world[0].y, 1e-12, "TR on the new top")
        ctx.near(world[3].x, world[0].x, 1e-12, "BL on the new left")
        ctx.near(world[2].x, world[1].x, 1e-12)
        ctx.near(world[2].y, world[3].y, 1e-12)
        // Each other corner of the other three handles is in the same place on the photo it was (they did not move)
        for i in [2] { ctx.near(after[i].x, handles[i].x, 1e-6); ctx.near(after[i].y, handles[i].y, 1e-6) }

        // A side handle moves one edge only: the right side, 25 px to the right and 40 px DOWN (only the sideways part counts)
        let side = start.moved(.right, toPhoto: Vec2(handles[5].x + 25, handles[5].y + 40), view: v)
        ctx.near(side.left, start.left, 1e-12)
        ctx.near(side.top, start.top, 1e-12)
        ctx.near(side.bottom, start.bottom, 1e-12)
        ctx.expect(side.right > start.right)
        let top = start.moved(.top, toPhoto: Vec2(handles[4].x - 50, handles[4].y - 30), view: v)
        ctx.near(top.left, start.left, 1e-12)
        ctx.near(top.right, start.right, 1e-12)
        ctx.expect(top.top > start.top)
        // The sides never cross: a corner dragged past the opposite one stops 4 in short of it
        let crossed = start.moved(.topLeft, toPhoto: Vec2(handles[2].x + 100, handles[2].y + 100), view: v)
        ctx.expect(crossed.left <= crossed.right - FrozenRect.minSideM + 1e-9)
        ctx.expect(crossed.top >= crossed.bottom + FrozenRect.minSideM - 1e-9)

        // What is measured is the rectangle: the four corners are the dots, and the width and height are its sides
        for r in [start, moved, side, top] {
            guard let m = FrozenMeasure.measure(rect: r, view: v), let drawn = FrozenMeasure.drawing(m, view: v), let dots = r.handlePhotoPoints(view: v) else { return ctx.expect(false, "no result") }
            ctx.near(m.widthIn, r.widthM * inchesPerMetre, 1e-9, "width")
            ctx.near(m.heightIn, r.heightM * inchesPerMetre, 1e-9, "height")
            for i in 0..<4 {
                ctx.near(m.windowPointsM[i].distance(to: r.cornersM[i]), 0, 1e-9, "sent corner \(i) is the rectangle's")
                ctx.near(drawn.outline[i].x, dots[i].x, 1e-6, "drawn through the dot \(i)")
                ctx.near(drawn.outline[i].y, dots[i].y, 1e-6)
            }
            ctx.equal(m.disagrees, false)
            ctx.equal(m.needsCheck, false)
            // The server's sizing of what is sent gives the same numbers
            let sent = sizeFromArPoints(m.windowPointsM, device: .arkitLidar, cornerSpreadM: m.windowSpreadM)
            ctx.near(sent?.widthIn, m.widthIn, 1e-9)
            ctx.near(sent?.heightIn, m.heightIn, 1e-9)
        }
        // A pixel that looks past the plane changes nothing
        ctx.equal(start.moved(.topLeft, toPhoto: Vec2(.nan, 3), view: v), start)
    },

    Check("FrozenRect.rebased: the plane is found again from the corners as they were left; a plane that did not change leaves the dots alone") { ctx in
        // A frame standing 4 cm proud of the wall: the opening's depth readings say so, the wall plane does not
        var scene = Scene()
        scene.ring = 0.07
        scene.ringOffset = 0.04
        let v = view(scene)
        let o = scene.opening
        // The corners of the opening on the frame's face (4 cm in front of the wall), as the photo shows them
        let onFace = [Vec3(o.x0, o.y1, wallZ + 0.04), Vec3(o.x1, o.y1, wallZ + 0.04), Vec3(o.x1, o.y0, wallZ + 0.04), Vec3(o.x0, o.y0, wallZ + 0.04)]
        let px = onFace.compactMap { v.photoPixel(ofWorld: $0) }
        // A rectangle on the wall plane through those photo points: a little too big (the wall is further than the frame)
        guard let wallRect = FrozenRect.fromPhoto(corners: px, view: FrozenView(cameraTransform: v.cameraTransform, intrinsics: lens, wall: wallPlane, depth: nil, photoWidthPx: photoW, photoHeightPx: photoH)) else {
            return ctx.expect(false, "no rectangle")
        }
        let bigger = wallRect.widthM * inchesPerMetre
        let rebased = wallRect.rebased(view: v)
        ctx.expect(rebased != wallRect, "the plane moved to the frame's face")
        ctx.near(abs(rebased.plane.signedDistance(Vec3(0, 0, wallZ))), 0.04, 0.005, "frame 4 cm in front of the wall")
        ctx.expect(rebased.widthM * inchesPerMetre < bigger - 0.2, "smaller on the nearer plane: \(rebased.widthM * inchesPerMetre) vs \(bigger)")
        ctx.near(rebased.widthM * inchesPerMetre, 21, 0.2)
        // The dots did not move on the photo (the same rays, a nearer plane)
        let before = wallRect.handlePhotoPoints(view: v)!, after = rebased.handlePhotoPoints(view: v)!
        for i in 0..<8 { ctx.near(before[i].x, after[i].x, 0.5, "dot \(i) x"); ctx.near(before[i].y, after[i].y, 0.5, "dot \(i) y") }
        // Already on the frame's plane: left alone
        ctx.equal(rebased.rebased(view: v), rebased)
        // With no depth there is nothing to find again
        let flat = FrozenView(cameraTransform: v.cameraTransform, intrinsics: lens, wall: wallPlane, depth: nil, photoWidthPx: photoW, photoHeightPx: photoH)
        ctx.equal(wallRect.rebased(view: flat), wallRect)
    },

    // MARK: - The AI window finder (AiWindow.swift)

    Check("AiWindow: a box or a quad round the window becomes a level rectangle on the frame's plane; the photo's edges pull each side onto the frame, 6 cm either way") { ctx in
        let scene = Scene()
        let v = view(scene)
        let photo = grayPhoto(scene, view: v)
        let reticle = Vec2(photoW / 2, photoH / 2)
        // A box a little loose all round the opening, as the model draws it: 4 cm out
        let loose = aiBox(scene, v, marginM: 0.04)
        guard let raw = AiWindow.rect(from: loose, view: v) else { return ctx.expect(false, "no rectangle from the box") }
        ctx.near(raw.widthM * inchesPerMetre, 21 + 2 * 0.04 * inchesPerMetre, 0.8, "the box's own width")
        // Without the photo: the box's rectangle as it is
        let plain = WindowProposal.choose(view: v, ai: WindowDetection(boxes: [loose]), depth: nil, photo: nil, vision: { nil })
        ctx.equal(plain?.source, .ai)
        ctx.equal(plain?.refined, [false, false, false, false])
        ctx.expect(plain?.rect == raw)
        // With the photo: every side finds the real frame line
        let refined = WindowProposal.choose(view: v, ai: WindowDetection(boxes: [loose]), depth: nil, photo: patchSource(photo), vision: { nil })
        ctx.equal(refined?.source, .ai)
        ctx.equal(refined?.refined, [true, true, true, true], "every side found its edge")
        edgesNear(ctx, refined?.rect, scene, 0.006, "box + photo")
        // A box 5.5 cm out is still inside the 6 cm search; one 9 cm out is not pulled all the way (it keeps what it cannot reach)
        let far = WindowProposal.choose(view: v, ai: WindowDetection(boxes: [aiBox(scene, v, marginM: 0.055)]), depth: nil, photo: patchSource(photo), vision: { nil })
        edgesNear(ctx, far?.rect, scene, 0.008, "a box 5.5 cm out")
        let wild = WindowProposal.choose(view: v, ai: WindowDetection(boxes: [aiBox(scene, v, marginM: 0.09)]), depth: nil, photo: patchSource(photo), vision: { nil })
        ctx.expect((wild?.rect.widthM ?? 0) * inchesPerMetre > 21.3, "a box 9 cm out is not dragged all the way in")
        // A quad that fits well is the start instead of the box; a poor fit is not
        let tight = aiQuad(scene, v, marginM: 0.02, quality: 0.95)
        let fromQuad = WindowProposal.choose(view: v, ai: WindowDetection(boxes: [loose], quad: tight), depth: nil, photo: nil, vision: { nil })
        ctx.equal(fromQuad?.source, .aiQuad)
        ctx.near((fromQuad?.rect.widthM ?? 0) * inchesPerMetre, 21 + 2 * 0.02 * inchesPerMetre, 0.8, "the quad's own width")
        let quadRefined = WindowProposal.choose(view: v, ai: WindowDetection(boxes: [loose], quad: tight), depth: nil, photo: patchSource(photo), vision: { nil })
        edgesNear(ctx, quadRefined?.rect, scene, 0.006, "quad + photo")
        let poor = WindowProposal.choose(view: v, ai: WindowDetection(boxes: [loose], quad: aiQuad(scene, v, marginM: 0.02, quality: 0.6)), depth: nil, photo: nil, vision: { nil })
        ctx.equal(poor?.source, .ai)
        // A quad on some other thing than the box the person aimed at is not used
        var elsewhere = aiQuad(scene, v, marginM: 0.02, quality: 0.95)
        elsewhere.corners = elsewhere.corners.map { [$0[0] * 0.3 + 0.7, $0[1] * 0.3 + 0.05] }
        let off = WindowProposal.choose(view: v, ai: WindowDetection(boxes: [loose], quad: elsewhere), depth: nil, photo: nil, vision: { nil })
        ctx.equal(off?.source, .ai)
        _ = reticle
    },

    Check("WindowProposal: the AI window first; the depth sensor's opening only when it is the same window; Vision only when neither exists") { ctx in
        let scene = Scene()
        let v = view(scene)
        let photo = grayPhoto(scene, view: v)
        let reticle = Vec2(photoW / 2, photoH / 2)
        let loose = aiBox(scene, v, marginM: 0.04)
        let ai = WindowDetection(boxes: [loose])
        guard let depthFound = OpeningFinder.find(view: v, reticle: reticle, photo: patchSource(photo)) else { return ctx.expect(false, "depth found nothing") }
        var visionAsked = 0
        let vision: () -> FrozenRect? = {
            visionAsked += 1
            return depthFound.rect
        }
        // The depth opening and the AI box are the same window: the depth sensor's rectangle (already on the frame's edges) is used
        let same = WindowProposal.choose(view: v, ai: ai, depth: depthFound, photo: patchSource(photo), vision: vision)
        ctx.equal(same?.source, .aiDepth)
        ctx.expect(same?.rect == depthFound.rect)
        // The owner's phone: the depth finds the wall round the window, not the window. The AI is right, the depth is not: the AI wins
        var onWall = depthFound
        onWall.rect.left -= 0.6
        onWall.rect.right += 0.6
        onWall.rect.top += 0.5
        let disagree = WindowProposal.choose(view: v, ai: ai, depth: onWall, photo: patchSource(photo), vision: vision)
        ctx.equal(disagree?.source, .ai)
        edgesNear(ctx, disagree?.rect, scene, 0.006, "the AI beats a wall-sized depth opening")
        // A depth opening that is only a pane of the window (half of it) is not the same window either
        var pane = depthFound
        pane.rect.right = pane.rect.left + pane.rect.widthM * 0.45
        ctx.equal(WindowProposal.choose(view: v, ai: ai, depth: pane, photo: patchSource(photo), vision: vision)?.source, .ai)
        // No AI box (nothing held the middle): the depth sensor's opening
        let picture = DetectedBox(x: 0.8, y: 0.1, w: 0.15, h: 0.15, confidence: 0.5)
        let noBox = WindowProposal.choose(view: v, ai: WindowDetection(boxes: [picture]), depth: depthFound, photo: patchSource(photo), vision: vision)
        ctx.equal(noBox?.source, .depth)
        ctx.expect(noBox?.rect == depthFound.rect)
        ctx.equal(WindowProposal.choose(view: v, ai: nil, depth: depthFound, photo: nil, vision: vision)?.source, .depth)
        ctx.equal(visionAsked, 0, "Vision is never asked while the AI or the depth found a window")
        // Neither: Vision
        let fallback = WindowProposal.choose(view: v, ai: WindowDetection(boxes: []), depth: nil, photo: nil, vision: vision)
        ctx.equal(fallback?.source, .vision)
        ctx.equal(visionAsked, 1)
        // Nothing at all
        ctx.expect(WindowProposal.choose(view: v, ai: nil, depth: nil, photo: nil, vision: { nil }) == nil)
        // A box that is not a window's size (a sliver of a pane, 5 cm) is not a rectangle
        let tiny = DetectedBox(x: 0.45, y: 0.45, w: 0.06, h: 0.06, confidence: 0.4)
        ctx.expect(AiWindow.rect(from: tiny, view: v) == nil)
    },

    Check("AiWindow.photoIoU: the same rectangle overlaps itself fully, a far one not at all, a half-shifted one a third") { ctx in
        let scene = Scene()
        let v = view(scene)
        guard let a = FrozenRect(plane: wallPlane, viewer: v.viewer, left: -0.3, right: 0.3, top: 1.8, bottom: 1.0) else { return ctx.expect(false, "rect") }
        ctx.near(AiWindow.photoIoU(a, a, view: v), 1, 1e-9)
        var far = a
        far.left += 3
        far.right += 3
        ctx.near(AiWindow.photoIoU(a, far, view: v), 0, 1e-9)
        var half = a
        half.left += 0.3
        half.right += 0.3
        ctx.near(AiWindow.photoIoU(a, half, view: v), 1.0 / 3.0, 0.03)
    },
]

// MARK: - What the server's boxes and quads look like for a scene

/// The box a detector draws round the opening, `marginM` out on every side, as fractions of the photo.
private func aiBox(_ scene: Scene, _ v: FrozenView, marginM m: Double) -> DetectedBox {
    let corners = openingCorners(scene, v, marginM: m)
    let xs = corners.map { $0.x }, ys = corners.map { $0.y }
    let (x0, x1, y0, y1) = (xs.min()! / photoW, xs.max()! / photoW, ys.min()! / photoH, ys.max()! / photoH)
    return DetectedBox(x: x0, y: y0, w: x1 - x0, h: y1 - y0, confidence: 0.4)
}

/// The window quad (TL, TR, BR, BL) the segmenter draws, `marginM` out on every side.
private func aiQuad(_ scene: Scene, _ v: FrozenView, marginM m: Double, quality: Double) -> DetectedQuad {
    DetectedQuad(corners: openingCorners(scene, v, marginM: m).map { [$0.x / photoW, $0.y / photoH] }, quality: quality)
}

/// The opening's corners TL, TR, BR, BL (grown by `marginM`) on the photo, in its pixels.
private func openingCorners(_ scene: Scene, _ v: FrozenView, marginM m: Double) -> [Vec2] {
    let o = scene.opening
    let world = [Vec3(o.x0 - m, o.y1 + m, wallZ), Vec3(o.x1 + m, o.y1 + m, wallZ), Vec3(o.x1 + m, o.y0 - m, wallZ), Vec3(o.x0 - m, o.y0 - m, wallZ)]
    return world.compactMap { v.photoPixel(ofWorld: $0) }
}
