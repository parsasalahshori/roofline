import Foundation

// The geometry of every window in the gallery, in inches, on a flat canonical rectangle (0,0) to (W,H): the opening the homeowner
// marked on the photo. Nothing here draws; it returns shapes in drawing order and the app paints them (Core Graphics for the
// photo, SwiftUI for the thumbnails) and warps them onto the photo's four corners with a Homography.
//
// y grows downward. The new frame is a ring of `frameFaceIn` round the opening (it covers the old frame); the sashes, glass,
// bars and hardware sit inside the opening.

/// One thing to draw.
public struct WindowShape: Equatable, Sendable {
    public enum Role: String, Sendable {
        /// The wall filler where a shape (arch, circle) does not fill the opening: `points` is the opening, `hole` the area to clear.
        case infill
        /// The outer frame: `points` is its outer edge, `hole` the opening it surrounds.
        case frame
        /// A sash or glazing bead: a ring with a `hole` where the glass is.
        case sash
        /// A solid board (the head and seat of a bay, a garden window's shelf).
        case board
        /// A pane of glass.
        case glass
        /// A grid bar (a thin quad).
        case muntin
        /// A thin line where two parts meet (stroked: `points` is a polyline).
        case seam
        /// A lock, latch, handle or crank.
        case hardware
    }

    public var role: Role
    /// What it is ("sash-upper", "lock", "crank", "colonial"...).
    public var tag: String
    public var points: [Vec2]
    public var hole: [Vec2]

    public init(_ role: Role, _ tag: String, _ points: [Vec2], hole: [Vec2] = []) {
        self.role = role
        self.tag = tag
        self.points = points
        self.hole = hole
    }
}

public struct WindowLayout: Sendable {
    public var type: VisualWindowType
    public var grid: VisualGrid
    public var widthIn: Double
    public var heightIn: Double
    /// How wide the new frame is, round the opening.
    public var frameFaceIn: Double
    /// In drawing order, back to front.
    public var shapes: [WindowShape]
    /// The window's outer edge (the frame's outside).
    public var silhouette: [Vec2]

    public func shapes(_ role: WindowShape.Role) -> [WindowShape] { shapes.filter { $0.role == role } }
    public var glass: [WindowShape] { shapes(.glass) }
    public var muntins: [WindowShape] { shapes(.muntin) }
    public var hardware: [WindowShape] { shapes(.hardware) }

    /// The box round the silhouette and any wall filler (which is the whole opening, and can reach past a small shape).
    public var bounds: (minX: Double, minY: Double, maxX: Double, maxY: Double) {
        let pts = silhouette + shapes(.infill).flatMap(\.points)
        return (pts.map(\.x).min() ?? 0, pts.map(\.y).min() ?? 0, pts.map(\.x).max() ?? 0, pts.map(\.y).max() ?? 0)
    }
}

/// Polygon helpers for the layouts (convex shapes only).
public enum WindowGeometry {
    public static func rect(_ x0: Double, _ y0: Double, _ x1: Double, _ y1: Double) -> [Vec2] {
        [Vec2(x0, y0), Vec2(x1, y0), Vec2(x1, y1), Vec2(x0, y1)]
    }

    public static func signedArea(_ p: [Vec2]) -> Double {
        var a = 0.0
        for i in 0..<p.count {
            let q = p[(i + 1) % p.count]
            a += p[i].x * q.y - q.x * p[i].y
        }
        return a / 2
    }

    /// Each edge's outward unit normal (so that for a convex polygon of either winding it points away from the inside).
    private static func outwardNormals(_ p: [Vec2]) -> [Vec2] {
        let sgn: Double = signedArea(p) >= 0 ? 1 : -1
        return (0..<p.count).map { i in
            let a = p[i], b = p[(i + 1) % p.count]
            let ex = b.x - a.x, ey = b.y - a.y
            let len = max(hypot(ex, ey), 1e-12)
            return Vec2(sgn * ey / len, -sgn * ex / len)
        }
    }

    /// The polygon moved out by `d` inches along every edge (a negative `d` moves it in); corners stay sharp (mitred).
    public static func offset(_ p: [Vec2], by d: Double) -> [Vec2] {
        guard p.count >= 3 else { return p }
        let n = outwardNormals(p)
        return (0..<p.count).map { i in
            let n1 = n[(i + p.count - 1) % p.count], n2 = n[i]
            let denom = 1 + n1.x * n2.x + n1.y * n2.y
            if denom < 1e-6 { return Vec2(p[i].x + n2.x * d, p[i].y + n2.y * d) }
            return Vec2(p[i].x + (n1.x + n2.x) * d / denom, p[i].y + (n1.y + n2.y) * d / denom)
        }
    }

    /// The part of the segment `a`-`b` inside a convex polygon, or nil when none of it is.
    public static func clip(_ a: Vec2, _ b: Vec2, to poly: [Vec2]) -> (Vec2, Vec2)? {
        guard poly.count >= 3 else { return nil }
        let n = outwardNormals(poly)
        var t0 = 0.0, t1 = 1.0
        let dx = b.x - a.x, dy = b.y - a.y
        for i in 0..<poly.count {
            let nx = n[i].x, ny = n[i].y
            let dist = (a.x - poly[i].x) * nx + (a.y - poly[i].y) * ny   // <= 0 inside
            let rate = dx * nx + dy * ny
            if abs(rate) < 1e-12 {
                if dist > 1e-9 { return nil }
            } else {
                let t = -dist / rate
                if rate > 0 { t1 = min(t1, t) } else { t0 = max(t0, t) }
                if t0 > t1 { return nil }
            }
        }
        return (Vec2(a.x + dx * t0, a.y + dy * t0), Vec2(a.x + dx * t1, a.y + dy * t1))
    }

    /// A thin quad round the segment, `width` inches across.
    public static func bar(_ a: Vec2, _ b: Vec2, width: Double) -> [Vec2] {
        let dx = b.x - a.x, dy = b.y - a.y
        let len = max(hypot(dx, dy), 1e-12)
        let nx = -dy / len * width / 2, ny = dx / len * width / 2
        return [Vec2(a.x + nx, a.y + ny), Vec2(b.x + nx, b.y + ny), Vec2(b.x - nx, b.y - ny), Vec2(a.x - nx, a.y - ny)]
    }

    public static func box(_ p: [Vec2]) -> (minX: Double, minY: Double, maxX: Double, maxY: Double) {
        (p.map(\.x).min() ?? 0, p.map(\.y).min() ?? 0, p.map(\.x).max() ?? 0, p.map(\.y).max() ?? 0)
    }

    /// Points of a (semi-)ellipse, `from` to `to` radians (0 = right, counter-clockwise on screen: the top is +pi/2).
    static func arc(cx: Double, cy: Double, rx: Double, ry: Double, from: Double, to: Double, steps: Int) -> [Vec2] {
        (0...steps).map { k in
            let th = from + (to - from) * Double(k) / Double(steps)
            return Vec2(cx + rx * cos(th), cy - ry * sin(th))
        }
    }
}

public enum WindowLayoutBuilder {
    /// How many columns and rows of lites a colonial grid puts in a pane this size (inches): about 16 in wide and 9 in tall each, at
    /// least 2 across a pane wider than 18 in, so a double-hung sash reads as 6 over 6.
    public static func colonialCounts(width w: Double, height h: Double) -> (cols: Int, rows: Int) {
        let cols = w < 18 ? 1 : min(max(Int((w / 16).rounded()), 2), 6)
        let rows = h < 10 ? 1 : min(max(Int((h / 9).rounded()), 2), 8)
        return (cols, rows)
    }

    public static func build(type: VisualWindowType, grid: VisualGrid, widthIn: Double, heightIn: Double) -> WindowLayout {
        var b = Builder(W: min(max(widthIn, 14), 150), H: min(max(heightIn, 14), 150), type: type, grid: grid)
        b.run()
        return b.layout()
    }

    // MARK: Builder

    private enum Zone { case upper, lower, single }

    private struct Pane {
        var poly: [Vec2]
        var zone: Zone
        var gridded: Bool
    }

    private struct Builder {
        let W: Double, H: Double
        let type: VisualWindowType
        let grid: VisualGrid
        /// The new frame's face, a sash stile, a casement stile, the visible meeting rail, a bar, a glazing bead.
        let F: Double, s: Double, sc = 1.45, m = 1.5, bar = 0.75, bead = 1.0
        var shapes: [WindowShape] = []
        var hardware: [WindowShape] = []
        var panes: [Pane] = []
        var silhouette: [Vec2] = []

        init(W: Double, H: Double, type: VisualWindowType, grid: VisualGrid) {
            self.W = W
            self.H = H
            self.type = type
            self.grid = grid
            let small = min(W, H)
            F = min(max(0.4 + 0.065 * small, 2.0), 3.0)
            s = min(max(0.045 * small, 1.3), 2.0)
        }

        typealias G = WindowGeometry

        // MARK: Pieces

        mutating func frame(base: [Vec2], isRect: Bool) {
            let outer = isRect ? G.rect(-F, -F, W + F, H + F) : G.offset(base, by: F)
            if !isRect { shapes.append(WindowShape(.infill, "infill", G.rect(0, 0, W, H), hole: outer)) }
            shapes.append(WindowShape(.frame, "frame", outer, hole: base))
            silhouette = outer
            if isRect {
                // A welded vinyl frame shows its mitred corners
                shapes.append(WindowShape(.seam, "mitre", [Vec2(-F, -F), Vec2(0, 0)]))
                shapes.append(WindowShape(.seam, "mitre", [Vec2(W + F, -F), Vec2(W, 0)]))
                shapes.append(WindowShape(.seam, "mitre", [Vec2(W + F, H + F), Vec2(W, H)]))
                shapes.append(WindowShape(.seam, "mitre", [Vec2(-F, H + F), Vec2(0, H)]))
            }
        }

        mutating func ring(_ outer: [Vec2], _ inner: [Vec2], _ tag: String, role: WindowShape.Role = .sash) {
            shapes.append(WindowShape(role, tag, outer, hole: inner))
        }

        mutating func glass(_ poly: [Vec2], zone: Zone = .single, gridded: Bool = true, tag: String = "glass") {
            shapes.append(WindowShape(.glass, tag, poly))
            panes.append(Pane(poly: poly, zone: zone, gridded: gridded))
        }

        mutating func seam(_ a: Vec2, _ b: Vec2, _ tag: String) {
            shapes.append(WindowShape(.seam, tag, [a, b]))
        }

        mutating func hw(_ tag: String, _ x0: Double, _ y0: Double, _ x1: Double, _ y1: Double) {
            hardware.append(WindowShape(.hardware, tag, G.rect(x0, y0, x1, y1)))
        }

        mutating func crank(x: Double, armTo dir: Double) {
            let cy = H + F * 0.5
            hardware.append(WindowShape(.hardware, "crank", G.arc(cx: x, cy: cy, rx: 0.7, ry: 0.7, from: 0, to: 2 * .pi, steps: 16)))
            let x1 = x + dir * 3.2
            hardware.append(WindowShape(.hardware, "crank-arm", G.rect(min(x, x1), cy - 0.3, max(x, x1), cy + 0.3)))
        }

        // MARK: Kinds

        mutating func run() {
            let opening = G.rect(0, 0, W, H)
            switch type {
            case .doubleHung, .singleHung: hung(opening)
            case .slider2: slider2(opening)
            case .slider3: slider3(opening)
            case .casement: casement(opening, pair: false)
            case .casementPair: casement(opening, pair: true)
            case .awning: awningOrHopper(opening, awning: true)
            case .hopper: awningOrHopper(opening, awning: false)
            case .picture: fixed(opening, isRect: true)
            case .pictureCasements: pictureCasements(opening)
            case .bay:
                let dw = W * 0.24, rc = min(max(0.07 * H, 2.5), 6)
                panels(opening, edges: [0, dw, W - dw, W], recess: [0, rc, rc, 0])
            case .bow:
                let rc = min(max(0.08 * H, 3), 7)
                panels(opening, edges: [0, 0.15 * W, 0.35 * W, 0.65 * W, 0.85 * W, W], recess: [0, 0.51 * rc, 0.91 * rc, 0.91 * rc, 0.51 * rc, 0])
            case .garden: garden(opening)
            case .arch: fixed(Self.archBase(W, H), isRect: false)
            case .halfRound: fixed(Self.halfRoundBase(W, H), isRect: false)
            case .circle: fixed(Self.circleBase(W, H), isRect: false)
            case .specialty: fixed(Self.octagonBase(W, H), isRect: false)
            }
            applyGrid()
            shapes.append(contentsOf: hardware)
        }

        mutating func hung(_ opening: [Vec2]) {
            frame(base: opening, isRect: true)
            let mid = H * 0.5, bottom = s * 1.15
            ring(G.rect(0, 0, W, mid), G.rect(s, s, W - s, mid - m / 2), "sash-upper")
            ring(G.rect(0, mid, W, H), G.rect(s, mid + m / 2, W - s, H - bottom), "sash-lower")
            glass(G.rect(s, s, W - s, mid - m / 2), zone: .upper)
            glass(G.rect(s, mid + m / 2, W - s, H - bottom), zone: .lower)
            seam(Vec2(0, mid), Vec2(W, mid), "meeting-rail")
            hw("lock", W / 2 - 1.7, mid - 0.5, W / 2 + 1.7, mid + 0.5)
            if type == .doubleHung {
                for x in [3.4, W - 3.4] { hw("latch", x - 0.8, mid - 0.4, x + 0.8, mid + 0.4) }
            }
            hw("lift", W / 2 - 2.2, H - bottom + 0.35, W / 2 + 2.2, H - bottom + 0.9)
        }

        mutating func slider2(_ opening: [Vec2]) {
            frame(base: opening, isRect: true)
            let bottom = s * 1.15
            ring(G.rect(0, 0, W / 2, H), G.rect(s, s, W / 2 - m / 2, H - bottom), "sash-left")
            ring(G.rect(W / 2, 0, W, H), G.rect(W / 2 + m / 2, s, W - s, H - bottom), "sash-right")
            glass(G.rect(s, s, W / 2 - m / 2, H - bottom))
            glass(G.rect(W / 2 + m / 2, s, W - s, H - bottom))
            seam(Vec2(W / 2, 0), Vec2(W / 2, H), "meeting-stile")
            hw("lock", W / 2 - 0.45, H * 0.5 - 1.6, W / 2 + 0.45, H * 0.5 + 1.6)
            hw("pull", W / 2 + 0.15, H * 0.5 + 3, W / 2 + 0.6, H * 0.5 + 8)
        }

        mutating func slider3(_ opening: [Vec2]) {
            frame(base: opening, isRect: true)
            let q1 = W / 4, q2 = W * 3 / 4, bottom = s * 1.15
            ring(G.rect(0, 0, q1, H), G.rect(s, s, q1 - m / 2, H - bottom), "sash-left")
            ring(G.rect(q1, 0, q2, H), G.rect(q1 + m / 2, s, q2 - m / 2, H - bottom), "sash-middle")
            ring(G.rect(q2, 0, W, H), G.rect(q2 + m / 2, s, W - s, H - bottom), "sash-right")
            glass(G.rect(s, s, q1 - m / 2, H - bottom))
            glass(G.rect(q1 + m / 2, s, q2 - m / 2, H - bottom))
            glass(G.rect(q2 + m / 2, s, W - s, H - bottom))
            seam(Vec2(q1, 0), Vec2(q1, H), "meeting-stile")
            seam(Vec2(q2, 0), Vec2(q2, H), "meeting-stile")
            for x in [q1, q2] { hw("lock", x - 0.45, H * 0.5 - 1.6, x + 0.45, H * 0.5 + 1.6) }
        }

        mutating func casement(_ opening: [Vec2], pair: Bool) {
            frame(base: opening, isRect: true)
            if !pair {
                ring(G.rect(0, 0, W, H), G.rect(sc, sc, W - sc, H - sc), "sash")
                glass(G.rect(sc, sc, W - sc, H - sc))
                hw("handle", W - 1.2, H / 2 - 2.2, W - 0.3, H / 2 + 2.2)
                crank(x: min(5, W * 0.2), armTo: 1)
            } else {
                let c = 0.8
                ring(G.rect(0, 0, W / 2, H), G.rect(sc, sc, W / 2 - c, H - sc), "sash-left")
                ring(G.rect(W / 2, 0, W, H), G.rect(W / 2 + c, sc, W - sc, H - sc), "sash-right")
                glass(G.rect(sc, sc, W / 2 - c, H - sc))
                glass(G.rect(W / 2 + c, sc, W - sc, H - sc))
                seam(Vec2(W / 2, 0), Vec2(W / 2, H), "meeting-stile")
                hw("handle", W / 2 + 0.1, H / 2 - 2.2, W / 2 + 0.7, H / 2 + 2.2)
                crank(x: min(5, W * 0.12), armTo: 1)
                crank(x: W - min(5, W * 0.12), armTo: -1)
            }
        }

        mutating func awningOrHopper(_ opening: [Vec2], awning: Bool) {
            frame(base: opening, isRect: true)
            ring(G.rect(0, 0, W, H), G.rect(sc, sc, W - sc, H - sc), "sash")
            glass(G.rect(sc, sc, W - sc, H - sc))
            if awning {
                hw("lock", W / 2 - 2, H - sc + 0.35, W / 2 + 2, H - sc + 1.0)
                crank(x: W * 0.22, armTo: 1)
            } else {
                hw("lock", W / 2 - 2, 0.35, W / 2 + 2, 1.0)
            }
        }

        mutating func fixed(_ base: [Vec2], isRect: Bool) {
            frame(base: base, isRect: isRect)
            let inner = G.offset(base, by: -bead)
            ring(base, inner, "bead")
            glass(inner)
        }

        mutating func pictureCasements(_ opening: [Vec2]) {
            frame(base: opening, isRect: true)
            let q1 = W / 4, q2 = W * 3 / 4, mw = 0.8
            ring(G.rect(0, 0, q1 - mw, H), G.rect(sc, sc, q1 - mw - sc, H - sc), "sash-left")
            ring(G.rect(q2 + mw, 0, W, H), G.rect(q2 + mw + sc, sc, W - sc, H - sc), "sash-right")
            let mid = G.rect(q1 + mw, 0, q2 - mw, H)
            ring(mid, G.offset(mid, by: -bead), "bead")
            shapes.append(WindowShape(.sash, "mullion", G.rect(q1 - mw, 0, q1 + mw, H)))
            shapes.append(WindowShape(.sash, "mullion", G.rect(q2 - mw, 0, q2 + mw, H)))
            glass(G.rect(sc, sc, q1 - mw - sc, H - sc))
            glass(G.offset(mid, by: -bead))
            glass(G.rect(q2 + mw + sc, sc, W - sc, H - sc))
            hw("handle", q1 - mw - 1.2, H / 2 - 2.2, q1 - mw - 0.3, H / 2 + 2.2)
            hw("handle", q2 + mw + 0.3, H / 2 - 2.2, q2 + mw + 1.2, H / 2 + 2.2)
            crank(x: min(5, q1 * 0.5), armTo: 1)
            crank(x: W - min(5, q1 * 0.5), armTo: -1)
        }

        /// A bay or a bow seen from inside: panels that step back from the wall edges (`recess`, inches, at each edge) with the head
        /// and the seat in perspective above and below, all flat-projected into the opening.
        mutating func panels(_ opening: [Vec2], edges: [Double], recess: [Double]) {
            frame(base: opening, isRect: true)
            var head = [Vec2(0, 0), Vec2(W, 0)], seat = [Vec2(0, H), Vec2(W, H)]
            for k in stride(from: edges.count - 2, through: 1, by: -1) {
                head.append(Vec2(edges[k], recess[k]))
                seat.append(Vec2(edges[k], H - recess[k]))
            }
            shapes.append(WindowShape(.board, "head", head))
            shapes.append(WindowShape(.board, "seat", seat))
            let sp = 1.5
            for i in 0..<(edges.count - 1) {
                let outline = [Vec2(edges[i], recess[i]), Vec2(edges[i + 1], recess[i + 1]), Vec2(edges[i + 1], H - recess[i + 1]), Vec2(edges[i], H - recess[i])]
                let inner = G.offset(outline, by: -sp)
                ring(outline, inner, "panel-\(i)")
                glass(inner)
            }
        }

        mutating func garden(_ opening: [Vec2]) {
            frame(base: opening, isRect: true)
            let dg = min(max(0.1 * W, 3), 9), hT = min(max(0.14 * H, 4), 12), hS = min(max(0.12 * H, 4), 10)
            let top = [Vec2(0, 0), Vec2(W, 0), Vec2(W - dg, hT), Vec2(dg, hT)]
            let left = [Vec2(0, 0), Vec2(dg, hT), Vec2(dg, H - hS), Vec2(0, H)]
            let right = [Vec2(W, 0), Vec2(W - dg, hT), Vec2(W - dg, H - hS), Vec2(W, H)]
            let front = G.rect(dg, hT, W - dg, H - hS)
            shapes.append(WindowShape(.board, "shelf", [Vec2(0, H), Vec2(dg, H - hS), Vec2(W - dg, H - hS), Vec2(W, H)]))
            for (poly, tag) in [(top, "roof"), (left, "side-left"), (right, "side-right")] {
                let inner = G.offset(poly, by: -1.2)
                ring(poly, inner, tag)
                glass(inner, gridded: false, tag: "glass-\(tag)")
            }
            ring(front, G.offset(front, by: -bead * 1.2), "front")
            glass(G.offset(front, by: -bead * 1.2))
        }

        // MARK: Bases for the shapes that do not fill the opening

        static func archBase(_ W: Double, _ H: Double) -> [Vec2] {
            let a = min(W / 2, H * 0.55)
            var pts = [Vec2(0, H)] + WindowGeometry.arc(cx: W / 2, cy: a, rx: W / 2, ry: a, from: .pi, to: 0, steps: 40)
            pts.append(Vec2(W, H))
            return pts
        }

        static func halfRoundBase(_ W: Double, _ H: Double) -> [Vec2] {
            let r = min(W / 2, H)
            return WindowGeometry.arc(cx: W / 2, cy: H, rx: r, ry: r, from: .pi, to: 0, steps: 40)
        }

        static func circleBase(_ W: Double, _ H: Double) -> [Vec2] {
            let r = min(W, H) / 2
            return Array(WindowGeometry.arc(cx: W / 2, cy: H / 2, rx: r, ry: r, from: 0, to: 2 * .pi, steps: 64).dropLast())
        }

        static func octagonBase(_ W: Double, _ H: Double) -> [Vec2] {
            let side = min(W, H), c = 0.2929 * side, ox = (W - side) / 2, oy = (H - side) / 2
            let pts = [(c, 0), (side - c, 0), (side, c), (side, side - c), (side - c, side), (c, side), (0, side - c), (0, c)]
            return pts.map { Vec2(ox + $0.0, oy + $0.1) }
        }

        // MARK: Grids

        mutating func applyGrid() {
            guard grid != .none else { return }
            for pane in panes where pane.gridded {
                for (a, b) in segments(for: pane) {
                    guard let (p, q) = G.clip(a, b, to: pane.poly), hypot(q.x - p.x, q.y - p.y) > 0.5 else { continue }
                    shapes.append(WindowShape(.muntin, grid.rawValue, G.bar(p, q, width: bar)))
                }
            }
        }

        /// The bars of one pane as segments (inches), before they are cut to the pane's shape.
        func segments(for pane: Pane) -> [(Vec2, Vec2)] {
            let box = G.box(pane.poly)
            let x0 = box.minX, x1 = box.maxX, y0 = box.minY, y1 = box.maxY
            let w = x1 - x0, h = y1 - y0
            var out: [(Vec2, Vec2)] = []
            func vertical(_ x: Double, _ ya: Double, _ yb: Double) { out.append((Vec2(x, ya), Vec2(x, yb))) }
            func horizontal(_ y: Double, _ xa: Double, _ xb: Double) { out.append((Vec2(xa, y), Vec2(xb, y))) }
            func colonial(top: Double, bottom: Double) {
                let (cols, rows) = WindowLayoutBuilder.colonialCounts(width: w, height: bottom - top)
                for c in 1..<max(cols, 1) { vertical(x0 + w * Double(c) / Double(cols), top, bottom) }
                for r in 1..<max(rows, 1) { horizontal(top + (bottom - top) * Double(r) / Double(rows), x0, x1) }
            }
            switch grid {
            case .none: break
            case .colonial: colonial(top: y0, bottom: y1)
            case .prairie:
                let i = min(max(0.2 * min(w, h), 3), 6.5)
                if w > 2 * i + 4 { vertical(x0 + i, y0, y1); vertical(x1 - i, y0, y1) }
                if h > 2 * i + 4 { horizontal(y0 + i, x0, x1); horizontal(y1 - i, x0, x1) }
            case .diamond:
                let cols = min(max(Int((w / 6.5).rounded()), 2), 8), rows = min(max(Int((h / 9).rounded()), 2), 10)
                let dx = w / Double(cols)
                for k in (-rows + 1)..<cols { out.append((Vec2(x0 + Double(k) * dx, y0), Vec2(x0 + Double(k + rows) * dx, y1))) }
                for k in 1..<(cols + rows) { out.append((Vec2(x0 + Double(k) * dx, y0), Vec2(x0 + Double(k - rows) * dx, y1))) }
            case .queenAnne:
                guard pane.zone != .lower else { break }
                let sh = min(max(0.24 * h, 4.5), 9)
                horizontal(y0 + sh, x0, x1)
                let n = min(max(Int((w / 5.5).rounded()), 2), 8)
                for c in 1..<n { vertical(x0 + w * Double(c) / Double(n), y0, y0 + sh) }
            case .topOnly:
                switch pane.zone {
                case .upper: colonial(top: y0, bottom: y1)
                case .lower: break
                case .single:
                    let sh = 0.36 * h
                    horizontal(y0 + sh, x0, x1)
                    let cols = WindowLayoutBuilder.colonialCounts(width: w, height: h).cols
                    for c in 1..<max(cols, 1) { vertical(x0 + w * Double(c) / Double(cols), y0, y0 + sh) }
                }
            }
            return out
        }

        func layout() -> WindowLayout {
            WindowLayout(type: type, grid: grid, widthIn: W, heightIn: H, frameFaceIn: F, shapes: shapes, silhouette: silhouette)
        }
    }
}
