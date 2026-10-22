import Foundation

// Finding the window in a frozen frame by what the depth sensor sees: a window is where the wall ISN'T. In the LiDAR depth map the wall and
// its frame are at the wall's depth; the opening is deeper (the glass, the room outside, blinds hung inside the recess) or returns nothing at
// all (glass, bright outdoors). So the opening is the region of "behind the wall, or no reading" that holds the middle of the picture (the
// person aims the circle at the window). Things in FRONT of the wall (a lamp, a valance, a picture frame standing off it) are not the wall
// and not the window: they never decide where an edge is, only a wall-depth neighbour does. Each side of the opening is then the middle
// (median) of that side's boundary along its length, so a lamp covering one corner or a notch cannot move it, and is finally set onto the
// strongest edge in the photo within about 3 cm of it when the picture is clear. Vision's rectangle finder is only the fallback.

public enum OpeningFinder {
    public struct Found: Equatable, Sendable {
        public var rect: FrozenRect
        /// For left, right, top and bottom: the side was moved onto an edge in the photo (else it is where the depth put it).
        public var refined: [Bool]
        /// Depth pixels in the opening, and the share of the rectangle they fill.
        public var openingPixels: Int
        public var fill: Double
    }

    /// Gives a grey patch of the photo (x, y, width, height in its pixels, already inside the photo), for `Found.refined` sides.
    public typealias PatchSource = (_ x: Int, _ y: Int, _ width: Int, _ height: Int) -> GrayPatch?

    /// A reading this far behind the wall's plane (metres) is inside the opening: the glass, the reveal, blinds hung in the recess.
    public static let behindM = 0.02
    /// A reading this far in front of the plane is something standing off the wall (a lamp, a valance, a picture on a stand): neither wall
    /// nor window. A casing or a frame proud of the wall by less than this is the wall.
    public static let frontM = 0.06
    /// Each side is judged along its length in bins this long (metres), and needs this many bins with a clear boundary.
    public static let binM = 0.015
    public static let minBins = 6
    /// A window's sides, metres.
    public static let sideRangeM: ClosedRange<Double> = 0.2...3.5
    /// Of the rectangle, at least this share is opening (the rest may be a lamp in front, a mullion): less is a leak or a sliver.
    public static let minFill = 0.4
    /// When the middle of the picture is not itself in the opening, one is looked for this share of the depth map's width away.
    public static let seedSearchShare = 0.2
    /// A side is moved onto an edge of the photo only within this distance (metres) of where the depth put it.
    public static let refineRadiusM = 0.03
    /// A window found by Vision (no depth to check it) must have both sides at least this long: a sash or a pane is smaller.
    public static let visionMinSideM = 0.38

    /// Could this be a whole window? Sides in a window's range; with `fromDepth` false (Vision's outline, no depth to say what it is) both
    /// sides must also be long enough not to be a sash or a pane.
    public static func isPlausible(_ r: FrozenRect, fromDepth: Bool) -> Bool {
        let (w, h) = (r.widthM, r.heightM)
        guard sideRangeM.contains(w), sideRangeM.contains(h) else { return false }
        guard fromDepth else { return min(w, h) >= visionMinSideM }
        return true
    }

    private enum Kind: UInt8 {
        case void, behind, wall, front
    }

    /// The window opening in a frozen frame, or nil when the depth does not show one (no depth, the middle of the picture on a solid wall, an
    /// opening that runs off the picture, or not a window's size). `reticle`: the middle of the picture the person aimed at the window, in
    /// the photo's pixels. `photo`: the photo's grey pixels, to set each side onto its edge.
    public static func find(view: FrozenView, reticle: Vec2, photo: PatchSource? = nil) -> Found? {
        guard let depth = view.depth, depth.isValid else { return nil }
        let w = depth.width, h = depth.height
        let k = view.intrinsics.scaled(toWidth: Double(w), height: Double(h))
        let wall = view.wall

        // What each depth pixel is, against the wall's plane
        var kind = [Kind](repeating: .void, count: w * h)
        var signed = [Double](repeating: 0, count: w * h)
        for y in 0..<h {
            for x in 0..<w {
                guard let d = depth.reading(x, y) else { continue }
                let p = ImageMapping.unproject(Vec2(Double(x) + 0.5, Double(y) + 0.5), depth: d, cameraTransform: view.cameraTransform, intrinsics: k)
                let s = wall.signedDistance(p)
                signed[y * w + x] = s
                kind[y * w + x] = s < -behindM ? .behind : (s > frontM ? .front : .wall)
            }
        }
        func isOpening(_ i: Int) -> Bool { kind[i] == .void || kind[i] == .behind }

        // The opening that holds the middle of the picture
        let native = view.nativePixel(fromPhoto: reticle)
        let sx = min(w - 1, max(0, Int(native.x / view.intrinsics.width * Double(w)))), sy = min(h - 1, max(0, Int(native.y / view.intrinsics.height * Double(h))))
        guard let seed = nearestOpening(sx, sy, w: w, h: h, maxRing: Int(Double(w) * seedSearchShare), isOpening: isOpening) else { return nil }
        var inRegion = [Bool](repeating: false, count: w * h)
        var region: [Int] = []
        var stack = [seed]
        inRegion[seed] = true
        while let i = stack.popLast() {
            region.append(i)
            let x = i % w, y = i / w
            // An opening that reaches the edge of the picture is cut off (or has leaked): it cannot be measured
            if x == 0 || y == 0 || x == w - 1 || y == h - 1 { return nil }
            for j in [i - 1, i + 1, i - w, i + w] where !inRegion[j] && isOpening(j) {
                inRegion[j] = true
                stack.append(j)
            }
        }

        // Which region pixels border the wall (not a lamp, not the picture's edge), and where the wall's face is
        var bordersWall = [Bool](repeating: false, count: region.count)
        var faceOffsets: [Double] = []
        for (n, i) in region.enumerated() {
            for j in [i - 1, i + 1, i - w, i + w] where kind[j] == .wall {
                bordersWall[n] = true
                faceOffsets.append(signed[j])
            }
        }
        guard faceOffsets.count >= 8, let face = median(faceOffsets) else { return nil }
        let plane = wall.offset(by: face)
        guard let frame = FrozenRect(plane: plane, viewer: view.viewer, left: 0, right: 1, top: 1, bottom: 0) else { return nil }

        // The region on the plane: each pixel's ray, where it meets the frame's plane (what the opening lets the camera see)
        var st: [(s: Double, t: Double)] = []
        st.reserveCapacity(region.count)
        for i in region {
            let x = i % w, y = i / w
            let px = Vec2((Double(x) + 0.5) / Double(w) * view.intrinsics.width, (Double(y) + 0.5) / Double(h) * view.intrinsics.height)
            guard let ray = ImageMapping.ray(throughNativePixel: px, cameraTransform: view.cameraTransform, intrinsics: view.intrinsics),
                  let hit = frame.plane.intersect(rayOrigin: ray.origin, direction: ray.direction) else { return nil }
            st.append(frame.coords(of: hit))
        }
        // How big a depth pixel is on the plane: its centre is inside the opening, its edge is half a pixel further out
        let distance = max(0.3, view.viewer.distance(to: frame.point(s: median(st.map { $0.s }) ?? 0, t: median(st.map { $0.t }) ?? 0)))
        let pixelM = distance / max(k.fx, 1)

        // Each side: the middle of its boundary over bins along the side; a bin counts only where the boundary pixel borders the wall
        func edges(along key: (Int) -> Double, across value: (Int) -> Double) -> (lo: [Double], hi: [Double]) {
            var bins: [Int: (lo: Double, loWall: Bool, hi: Double, hiWall: Bool)] = [:]
            for n in 0..<region.count {
                let b = Int((key(n) / binM).rounded(.down)), v = value(n)
                if var e = bins[b] {
                    if v < e.lo { e.lo = v; e.loWall = bordersWall[n] }
                    if v > e.hi { e.hi = v; e.hiWall = bordersWall[n] }
                    bins[b] = e
                } else {
                    bins[b] = (v, bordersWall[n], v, bordersWall[n])
                }
            }
            return (bins.values.filter { $0.loWall }.map { $0.lo }, bins.values.filter { $0.hiWall }.map { $0.hi })
        }
        let sides = edges(along: { st[$0].t }, across: { st[$0].s })
        let ends = edges(along: { st[$0].s }, across: { st[$0].t })
        guard sides.lo.count >= minBins, sides.hi.count >= minBins, ends.lo.count >= minBins, ends.hi.count >= minBins,
              let left = median(sides.lo), let right = median(sides.hi), let bottom = median(ends.lo), let top = median(ends.hi) else { return nil }
        var rect = frame
        rect.left = left - pixelM / 2
        rect.right = right + pixelM / 2
        rect.bottom = bottom - pixelM / 2
        rect.top = top + pixelM / 2
        guard isPlausible(rect, fromDepth: true) else { return nil }
        let fill = Double(region.count) * pixelM * pixelM / max(rect.widthM * rect.heightM, 1e-9)
        guard fill >= minFill else { return nil }

        // The depth says more exactly where the frame's face is, and how it is turned, once the corners are known
        rect = rect.rebased(view: view)
        var refined = [false, false, false, false]
        if let photo = photo {
            let result = refineSides(rect, view: view, photo: photo)
            rect = result.rect
            refined = result.refined
        }
        return Found(rect: rect, refined: refined, openingPixels: region.count, fill: fill)
    }

    /// The nearest opening pixel to (x, y), looking out ring by ring; nil when none is within `maxRing`.
    private static func nearestOpening(_ x: Int, _ y: Int, w: Int, h: Int, maxRing: Int, isOpening: (Int) -> Bool) -> Int? {
        if isOpening(y * w + x) { return y * w + x }
        guard maxRing >= 1 else { return nil }
        for r in 1...maxRing {
            var best: (d: Int, i: Int)?
            for dy in -r...r {
                for dx in -r...r where max(abs(dx), abs(dy)) == r {
                    let xx = x + dx, yy = y + dy
                    guard xx >= 0, yy >= 0, xx < w, yy < h, isOpening(yy * w + xx) else { continue }
                    let d = dx * dx + dy * dy
                    if best == nil || d < best!.d { best = (d, yy * w + xx) }
                }
            }
            if let b = best { return b.i }
        }
        return nil
    }

    /// Each side set onto the strongest edge in the photo within `refineRadiusM` of where it is, when the picture is clear about one.
    static func refineSides(_ rect: FrozenRect, view: FrozenView, photo: PatchSource) -> (rect: FrozenRect, refined: [Bool]) {
        var out = rect
        var refined = [false, false, false, false]
        // Left, right (upright lines) and top, bottom (level ones): each side's ends pulled in a tenth, its middle, and the strip round it
        for (n, side) in [FrozenRect.Handle.left, .right, .top, .bottom].enumerated() {
            let upright = side == .left || side == .right
            let along0 = upright ? rect.bottom + rect.heightM * 0.1 : rect.left + rect.widthM * 0.1
            let along1 = upright ? rect.top - rect.heightM * 0.1 : rect.right - rect.widthM * 0.1
            let across: Double = { switch side { case .left: return rect.left; case .right: return rect.right; case .top: return rect.top; default: return rect.bottom } }()
            func at(_ along: Double, _ across: Double) -> Vec3 { upright ? rect.point(s: across, t: along) : rect.point(s: along, t: across) }
            guard let a = view.photoPixel(ofWorld: at(along0, across)), let b = view.photoPixel(ofWorld: at(along1, across)),
                  let beside = view.photoPixel(ofWorld: at((along0 + along1) / 2, across + refineRadiusM)) else { continue }
            let mid = Vec2((a.x + b.x) / 2, (a.y + b.y) / 2)
            // About 3 cm, in photo pixels, at this side
            let r = min(80, max(4, ((beside.x - mid.x) * (beside.x - mid.x) + (beside.y - mid.y) * (beside.y - mid.y)).squareRoot()))
            let margin = r + 14
            let half = min(180.0, (upright ? abs(b.y - a.y) : abs(b.x - a.x)) / 2)
            let box = upright ? (x: mid.x - margin, y: mid.y - half, w: 2 * margin, h: 2 * half) : (x: mid.x - half, y: mid.y - margin, w: 2 * half, h: 2 * margin)
            let x0 = max(0, Int(box.x.rounded())), y0 = max(0, Int(box.y.rounded()))
            let x1 = min(Int(view.photoWidthPx), Int((box.x + box.w).rounded())), y1 = min(Int(view.photoHeightPx), Int((box.y + box.h).rounded()))
            guard x1 - x0 >= 24, y1 - y0 >= 24, let patch = photo(x0, y0, x1 - x0, y1 - y0), patch.width == x1 - x0, patch.height == y1 - y0,
                  let line = CornerSnap.edgeLine(in: patch, near: Vec2(mid.x - Double(x0), mid.y - Double(y0)), radius: r, upright: upright) else { continue }
            let target = upright ? Vec2(mid.x + line.offset, mid.y) : Vec2(mid.x, mid.y + line.offset)
            guard let c = rect.coords(ofPhoto: target, view: view) else { continue }
            let value = upright ? c.s : c.t
            guard abs(value - across) <= refineRadiusM * 1.5 else { continue }
            switch side {
            case .left: out.left = min(value, out.right - FrozenRect.minSideM)
            case .right: out.right = max(value, out.left + FrozenRect.minSideM)
            case .top: out.top = max(value, out.bottom + FrozenRect.minSideM)
            default: out.bottom = min(value, out.top - FrozenRect.minSideM)
            }
            refined[n] = true
        }
        return (out, refined)
    }
}
