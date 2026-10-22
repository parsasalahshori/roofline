import Foundation
import RooflineCore

// Checks for the window's own frame inside the opening (WindowFrameFinder.swift): the edge about 1.75 cm in from the opening's edge, found
// in the photo from each side, with blinds in the window (slats are strong level lines too), a cord, and a frame edge the blind hides.
// The scenes are painted on a wall 1.6 m away and photographed by a synthetic camera, so the finder sees a real perspective view.

private let lens = CameraIntrinsics(fx: 700, fy: 700, cx: 480, cy: 360, width: 960, height: 720)
private let photoW = 720, photoH = 960
private let wallZ = -1.6
private let wallPlane = Plane(point: Vec3(0, 0, wallZ), normal: Vec3(0, 0, 1))!

private func phone(at origin: Vec3, yawDeg: Double) -> Mat4 {
    let a = yawDeg * .pi / 180
    func turn(_ v: Vec3) -> Vec3 { Vec3(v.x * cos(a) + v.z * sin(a), v.y, -v.x * sin(a) + v.z * cos(a)) }
    return Mat4.rigid(right: turn(Vec3(0, -1, 0)), up: turn(Vec3(1, 0, 0)), back: turn(Vec3(0, 0, 1)), origin: origin)
}

private struct FrameScene {
    /// The opening: where the wall stops (x0 ... x1, y0 ... y1 on the wall, metres).
    var x0 = 0.1 - 0.30, x1 = 0.1 + 0.30, y0 = 1.45 - 0.55, y1 = 1.45 + 0.55
    /// How far in the window's own edge is on the left, right, top and bottom.
    var insets = [0.0175, 0.0175, 0.0175, 0.0175]
    /// Blinds in the window: slats every 4.5 cm with a dark gap line, the first slat starting at the frame's top edge.
    var slats = true
    /// The first slat as bright as the frame, so there is no edge where the frame's top ends (a head rail hiding it).
    var headRailHidesFrame = false
    /// A dark cord 4 mm wide, this far in from the opening's left edge (nil: none).
    var cordIn: Double? = 0.045
    var wall = 150.0, frame = 232.0, glass = 95.0

    var frameLeft: Double { x0 + insets[0] }
    var frameRight: Double { x1 - insets[1] }
    var frameTop: Double { y1 - insets[2] }
    var frameBottom: Double { y0 + insets[3] }
}

private func ramp(_ d: Double, soft: Double) -> Double { min(1, max(0, 0.5 + d / (2 * soft))) }

private func box(_ x: Double, _ y: Double, _ x0: Double, _ x1: Double, _ y0: Double, _ y1: Double, soft: Double = 0.003) -> Double {
    ramp(x - x0, soft: soft) * ramp(x1 - x, soft: soft) * ramp(y - y0, soft: soft) * ramp(y1 - y, soft: soft)
}

private func photo(of s: FrameScene, view v: FrozenView, noise: Bool = true) -> OpeningFinder.PatchSource {
    var px = [UInt8](repeating: 0, count: photoW * photoH)
    var seed: UInt64 = 12345
    for y in 0..<photoH {
        for x in 0..<photoW {
            guard let ray = ImageMapping.ray(throughNativePixel: v.nativePixel(fromPhoto: Vec2(Double(x) + 0.5, Double(y) + 0.5)), cameraTransform: v.cameraTransform, intrinsics: v.intrinsics),
                  let hit = wallPlane.intersect(rayOrigin: ray.origin, direction: ray.direction) else { continue }
            let (wx, wy) = (hit.x, hit.y)
            var value = s.wall
            value += (s.frame - value) * box(wx, wy, s.x0, s.x1, s.y0, s.y1)
            let inner = box(wx, wy, s.frameLeft, s.frameRight, s.frameBottom, s.frameTop)
            var behind = s.glass
            if s.slats {
                // (the pattern is taken at the nearest point inside the frame, so the soft edge of the frame does not blend in a gap that is not there)
                let down = s.frameTop - min(max(wy, s.frameBottom), s.frameTop)
                let slat = down.truncatingRemainder(dividingBy: 0.045) < 0.034
                behind = slat ? (s.headRailHidesFrame && down < 0.034 ? s.frame : 205) : 70
            }
            value += (behind - value) * inner
            if let c = s.cordIn {
                let cordX = s.x0 + c
                value += (50 - value) * box(wx, wy, cordX - 0.002, cordX + 0.002, s.frameBottom, s.frameTop, soft: 0.002) * inner
            }
            if noise {
                seed = seed &* 6364136223846793005 &+ 1442695040888963407
                value += Double(Int((seed >> 33) % 5)) - 2
            }
            px[y * photoW + x] = UInt8(min(255, max(0, value.rounded())))
        }
    }
    return { x, y, w, h in
        guard x >= 0, y >= 0, w > 0, h > 0, x + w <= photoW, y + h <= photoH else { return nil }
        var out = [UInt8](repeating: 0, count: w * h)
        for yy in 0..<h { for xx in 0..<w { out[yy * w + xx] = px[(y + yy) * photoW + x + xx] } }
        return GrayPatch(width: w, height: h, pixels: out)
    }
}

private func view(camera: Mat4? = nil) -> FrozenView {
    FrozenView(cameraTransform: camera ?? phone(at: Vec3(0, 1.5, 0), yawDeg: -3.6), intrinsics: lens, wall: wallPlane, depth: nil,
               photoWidthPx: Double(photoW), photoHeightPx: Double(photoH))
}

private func openingRect(_ s: FrameScene, _ v: FrozenView) -> FrozenRect {
    FrozenRect(plane: wallPlane, viewer: v.viewer, left: s.x0, right: s.x1, top: s.y1, bottom: s.y0)!
}

/// The frame's edges against the scene's, in the wall's own coordinates.
private func expectFrame(_ ctx: CheckContext, _ found: WindowFrameFinder.Found?, _ s: FrameScene, tol: Double, _ what: String, line: UInt = #line) {
    guard let f = found else { return ctx.expect(false, "\(what): no window frame found", line: line) }
    let p = f.rect.plane.point
    ctx.near(f.rect.left + p.x, s.frameLeft, tol, "\(what) left", line: line)
    ctx.near(f.rect.right + p.x, s.frameRight, tol, "\(what) right", line: line)
    ctx.near(f.rect.top + p.y, s.frameTop, tol, "\(what) top", line: line)
    ctx.near(f.rect.bottom + p.y, s.frameBottom, tol, "\(what) bottom", line: line)
}

private let eighth = 0.125 * 0.0254

let frameChecks: [Check] = [
    Check("WindowFrameFinder: the frame's edge 1.75 cm inside the opening is found on every side, to an eighth of an inch, with blinds and a cord in the window") { ctx in
        let s = FrameScene()
        let v = view()
        let src = photo(of: s, view: v)
        let opening = openingRect(s, v)
        let found = WindowFrameFinder.find(opening: opening, view: v, photo: src)
        expectFrame(ctx, found, s, tol: eighth, "blinds and a cord")
        ctx.equal(found?.seen, [true, true, true, true], "every side found its own edge")
        // Inside the opening, and 35 mm narrower and shorter than it
        if let f = found {
            ctx.expect(f.rect.left >= opening.left && f.rect.right <= opening.right && f.rect.top <= opening.top && f.rect.bottom >= opening.bottom, "inside the opening")
            ctx.near(opening.widthM - f.widthM, 0.035, eighth, "narrower by two insets")
            ctx.near(opening.heightM - f.heightM, 0.035, eighth, "shorter by two insets")
        }
        // Each side alone finds the same edge (first one in from the opening's side)
        for side in WindowFrameFinder.Side.allCases {
            let e = WindowFrameFinder.first(of: WindowFrameFinder.edges(of: side, opening: opening, view: v, photo: src))
            ctx.near(e?.insetM, 0.0175, 0.003, "\(side) inset")
        }
    },

    Check("WindowFrameFinder: a frame that is thicker (3 cm) and one that is thinner (1 cm) are measured as they are") { ctx in
        for inset in [0.03, 0.01] {
            var s = FrameScene()
            s.insets = [inset, inset, inset, inset]
            s.slats = false
            s.cordIn = nil
            let v = view()
            let opening = openingRect(s, v)
            expectFrame(ctx, WindowFrameFinder.find(opening: opening, view: v, photo: photo(of: s, view: v)), s, tol: eighth, "inset \(inset)")
        }
    },

    Check("WindowFrameFinder: a window seen from the side and below, off to the left, is found where it is") { ctx in
        let s = FrameScene()
        let v = view(camera: phone(at: Vec3(-0.5, 1.2, 0.2), yawDeg: -14))
        let found = WindowFrameFinder.find(opening: openingRect(s, v), view: v, photo: photo(of: s, view: v))
        expectFrame(ctx, found, s, tol: 1.5 * eighth, "from the left and below")
    },

    Check("WindowFrameFinder: a head rail as bright as the frame hides the frame's top edge: the first slat gap is not taken for it, and the top takes the other sides' thickness") { ctx in
        var s = FrameScene()
        s.headRailHidesFrame = true
        let v = view()
        let src = photo(of: s, view: v)
        let opening = openingRect(s, v)
        // The first clear edge down from the top is the slat gap, 1.75 + 3.4 cm in
        let top = WindowFrameFinder.first(of: WindowFrameFinder.edges(of: .top, opening: opening, view: v, photo: src))
        ctx.expect((top?.insetM ?? 0) > 0.04 || top == nil, "top edge \(top?.insetM ?? -1)")
        // That does not agree with the other three sides, so it is dropped and the median inset stands in
        let found = WindowFrameFinder.find(opening: opening, view: v, photo: src)
        expectFrame(ctx, found, s, tol: eighth, "hidden top")
        ctx.equal(found?.seen, [true, true, false, true], "the top is filled in")
    },

    Check("WindowFrameFinder: two sides with a visible edge are enough (the others take their thickness), one is not, and a flat photo gives nothing") { ctx in
        // Only the left and right sides have a frame edge: the top and bottom are flush with the opening
        var s = FrameScene()
        s.slats = false
        s.cordIn = nil
        s.insets = [0.0175, 0.0175, 0, 0]
        let v = view()
        let opening = openingRect(s, v)
        let two = WindowFrameFinder.find(opening: opening, view: v, photo: photo(of: s, view: v))
        ctx.equal(two?.seen, [true, true, false, false], "left and right found their own")
        ctx.near(two?.insetsM[2], 0.0175, 0.003, "the top takes the sides' thickness")
        ctx.near(two?.widthM, 0.6 - 0.035, eighth, "width")
        // One side alone is not enough
        var one = s
        one.insets = [0.0175, 0, 0, 0]
        ctx.expect(WindowFrameFinder.find(opening: opening, view: v, photo: photo(of: one, view: v)) == nil, "one side")
        // Nothing but a flat grey picture, and a photo source that gives nothing
        let blank: OpeningFinder.PatchSource = { _, _, w, h in GrayPatch(width: w, height: h, pixels: [UInt8](repeating: 128, count: w * h)) }
        ctx.expect(WindowFrameFinder.find(opening: opening, view: v, photo: blank) == nil, "a flat grey photo")
        ctx.expect(WindowFrameFinder.find(opening: opening, view: v, photo: { _, _, _, _ in nil }) == nil, "no patches")
    },

    Check("WindowFrameFinder: the pieces: first clear edge, thin lines, the sides that agree, the rectangle from the insets") { ctx in
        typealias E = WindowFrameFinder.Edge
        // The FIRST edge inward that is clear, not the strongest: a faint frame edge ahead of strong slat gaps and cords
        let list = [E(insetM: 0.02, step: 20, brighterInside: true), E(insetM: 0.05, step: 120, brighterInside: false)]
        ctx.near(WindowFrameFinder.first(of: list)?.insetM, 0.02, 1e-9)
        // ... but not one that is lost next to a much stronger one (under a tenth of it)
        let faint = [E(insetM: 0.02, step: 13, brighterInside: true), E(insetM: 0.05, step: 200, brighterInside: false)]
        ctx.near(WindowFrameFinder.first(of: faint)?.insetM, 0.05, 1e-9)
        ctx.expect(WindowFrameFinder.first(of: []) == nil)
        // A dark line is a step down and a step up right after: both go
        let line = [E(insetM: 0.030, step: 30, brighterInside: false), E(insetM: 0.036, step: 28, brighterInside: true), E(insetM: 0.06, step: 20, brighterInside: true)]
        ctx.equal(WindowFrameFinder.withoutThinLines(line).map { $0.insetM }, [0.06])
        // Opposite steps further apart than a line is wide stay: a frame's face between the opening's edge and the blind
        let wide = [E(insetM: 0.0175, step: 30, brighterInside: true), E(insetM: 0.04, step: 28, brighterInside: false)]
        ctx.equal(WindowFrameFinder.withoutThinLines(wide).count, 2)
        // Insets that agree stay, one that does not is dropped; two that do not agree: none
        let kept = WindowFrameFinder.agreeing([0.0175, 0.019, 0.05, 0.0165])
        ctx.equal(kept.map { $0 != nil }, [true, true, false, true])
        ctx.equal(WindowFrameFinder.agreeing([0.0175, nil, 0.05, nil]).compactMap { $0 }.count, 0)
        ctx.equal(WindowFrameFinder.agreeing([nil, nil, nil, 0.02]).compactMap { $0 }.count, 0)
        // The rectangle: a missing side takes the median of the others; fewer than two sides: none
        let v = view()
        let opening = FrozenRect(plane: wallPlane, viewer: v.viewer, left: 0, right: 0.6, top: 1.1, bottom: 0)!
        let made = WindowFrameFinder.assemble(insets: [0.02, 0.02, nil, 0.04], opening: opening)
        ctx.equal(made?.seen, [true, true, false, true])
        ctx.near(made?.insetsM[2], 0.02, 1e-9, "median of 0.02 0.02 0.04")
        ctx.near(made?.widthM, 0.56, 1e-9)
        ctx.near(made?.heightM, 1.1 - 0.02 - 0.04, 1e-9)
        ctx.expect(WindowFrameFinder.assemble(insets: [0.02, nil, nil, nil], opening: opening) == nil)
    },

    Check("WindowFrameFinder: the window's size is the opening's less the insets, written as the screens write it") { ctx in
        let v = view()
        let opening = FrozenRect(plane: wallPlane, viewer: v.viewer, left: 0, right: 0.88, top: 1.415, bottom: 0)!
        guard let made = WindowFrameFinder.assemble(insets: [0.0175, 0.0175, 0.0175, 0.0175], opening: opening),
              let result = FrozenMeasure.measure(rect: opening, view: v), let size = made.size(inOpening: result) else { return ctx.expect(false, "no size") }
        ctx.near(size.widthIn, result.widthIn - 0.035 * inchesPerMetre, 1e-9)
        ctx.near(size.heightIn, result.heightIn - 0.035 * inchesPerMetre, 1e-9)
        ctx.near(size.widthIn, 0.845 * inchesPerMetre, 0.03, "88 cm opening, 84.5 cm window")
        ctx.equal(TwoSizes.openingLine(widthIn: 34.625, heightIn: 55.75), "Opening 34 5/8 × 55 3/4 in")
        ctx.equal(TwoSizes.windowLine(WindowFrameSize(widthIn: 33.25, heightIn: 54.375)), "Window about 33 1/4 × 54 3/8 in")
        ctx.equal(WindowFrameSize(widthIn: 33.25, heightIn: 54.375).line, "Window about 33 1/4 × 54 3/8 in")
        // It rides on the result without changing anything else about it
        var r = result
        r.windowFrame = size
        ctx.equal(r.size, result.size)
        ctx.equal(r.windowFrame, size)
        let data = try JSONEncoder().encode(size)
        ctx.equal(try JSONDecoder().decode(WindowFrameSize.self, from: data), size)
    },
]
