import Foundation

// A window is a rectangle. Four corners placed on a wall are never quite one: a corner a little off the frame makes the top longer than
// the bottom and one side longer than the other, and the "size" is then an average of unequal sides. After the fourth corner the phone
// fits the best RECTANGLE to them, level with gravity, in the wall's plane: that rectangle is drawn, labelled (one width, one height),
// sized and sent. The corners as placed are kept, and when they disagree with the rectangle the phone says which one looks off, so
// that one corner can be placed again without starting over.
//
// Nothing here changes how the server sizes a window: the rectangle's four corners go through the same `sizeFromArPoints`, and being a
// true rectangle they give back exactly the width and height shown on the phone.

public enum FitLimits {
    /// A window really is tilted in its plane (a roof window, a window on a slope) only when all four of its sides agree on a turn of at
    /// least this many degrees; otherwise the rectangle is level.
    public static let tiltMinDeg = 3.0
    /// How closely the four sides must agree on that turn, degrees.
    public static let tiltAgreeDeg = 1.5
    /// The placed corners disagree with the rectangle when opposite sides differ by more than this, inches...
    public static let sideDiffIn = 0.75
    /// ...or by more than this share of their mean (2%), or a corner is further than `sideDiffIn` from where the rectangle puts it.
    public static let sideDiffShare = 0.02
    /// Two corners whose removal explains the rest equally well (within this, inches) are told apart by their spread.
    public static let tieIn = 0.1
    /// A corner this uncertain (metres, 1 cm) is not an order-grade measure: the preview marks the window 'check'.
    public static let checkSpreadM = 0.01
}

public struct RectangleFit: Equatable, Sendable {
    /// The fitted rectangle, TL, TR, BR, BL, on the wall's plane (world metres).
    public var pointsM: [Vec3]
    /// The corners as placed (projected onto the plane), in the same order.
    public var rawPointsM: [Vec3]
    public var widthIn: Double
    public var heightIn: Double
    /// How far each placed corner is from its rectangle corner, inches.
    public var residualIn: [Double]
    /// The turn of the rectangle in its plane, degrees (0: level with gravity).
    public var tiltDeg: Double
    /// The placed top, bottom, left and right sides, inches.
    public var topIn: Double
    public var bottomIn: Double
    public var leftIn: Double
    public var rightIn: Double
    /// The placed corners disagree with the rectangle (see `FitLimits`).
    public var disagrees: Bool
    /// The corner whose placement explains the disagreement best (0 TL, 1 TR, 2 BR, 3 BL), whether or not they disagree.
    public var worstCorner: Int

    /// The corner to ask the person to place again: only when the corners disagree.
    public var flaggedCorner: Int? { disagrees ? worstCorner : nil }

    /// The spread of each corner for the server: at least the corner's own, and at least how far it is from the rectangle; the flagged
    /// corner never under `FitLimits.checkSpreadM`. The server's uncertainty takes the larger of this and its own noise per corner, so
    /// a window whose corners did not line up says so in its "about X in".
    public func spreadM(corner own: [Double]) -> [Double] {
        var out = (0..<4).map { i in max(i < own.count ? own[i] : 0, residualIn[i] / inchesPerMetre) }
        if let w = flaggedCorner { out[w] = max(out[w], FitLimits.checkSpreadM) }
        return out
    }

    /// The best rectangle for four corners (TL, TR, BR, BL as `gravityOrderedCorners` puts them, already on `plane`), as seen from
    /// `viewer`. Gravity-aligned unless the window is truly turned in its plane; the left side is the mean of the two left corners'
    /// positions, the right side of the two right ones', the top and bottom likewise, which is the least-squares fit. Nil for a plane
    /// with no "up" in it (a floor, a skylight) or corners that make no rectangle.
    public static func fit(ordered raw: [Vec3], plane: Plane, viewer: Vec3, spreadM: [Double] = []) -> RectangleFit? {
        guard raw.count == 4, raw.allSatisfy({ $0.isFinite }), let c = Vec3.mean(raw) else { return nil }
        var n = plane.normal
        if (viewer - c).dot(n) < 0 { n = -n }
        let upIn = Vec3.up - n * Vec3.up.dot(n)
        guard let up = upIn.normalized, upIn.length > 0.25 else { return nil }
        let right = up.cross(n)
        let st = raw.map { p -> (s: Double, t: Double) in
            let d = p - c
            return (d.dot(right), d.dot(up))
        }

        // The turn: each side's angle against its own axis; a real tilt is one all four sides share
        func degrees(_ a: (s: Double, t: Double), _ b: (s: Double, t: Double)) -> Double { atan2(b.t - a.t, b.s - a.s) * 180 / .pi }
        func wrap(_ angle: Double) -> Double {
            var x = angle.truncatingRemainder(dividingBy: 360)
            if x > 180 { x -= 360 } else if x <= -180 { x += 360 }
            return x
        }
        let tilts = [wrap(degrees(st[0], st[1])), wrap(degrees(st[3], st[2])), wrap(degrees(st[3], st[0]) - 90), wrap(degrees(st[2], st[1]) - 90)]
        let mean = tilts.reduce(0, +) / 4
        let turned = abs(mean) >= FitLimits.tiltMinDeg && tilts.allSatisfy { abs($0 - mean) <= FitLimits.tiltAgreeDeg }
        let theta = turned ? mean : 0
        let (ct, stt) = (cos(theta * .pi / 180), sin(theta * .pi / 180))
        // Into the rectangle's own axes (turned back by theta), and out again
        func into(_ p: (s: Double, t: Double)) -> (s: Double, t: Double) { (p.s * ct + p.t * stt, -p.s * stt + p.t * ct) }
        func out(_ p: (s: Double, t: Double)) -> (s: Double, t: Double) { (p.s * ct - p.t * stt, p.s * stt + p.t * ct) }
        let a = st.map(into)
        let left = (a[0].s + a[3].s) / 2, rightS = (a[1].s + a[2].s) / 2
        let top = (a[0].t + a[1].t) / 2, bottom = (a[3].t + a[2].t) / 2
        guard rightS - left > 1e-4, top - bottom > 1e-4 else { return nil }
        let fitted = [(left, top), (rightS, top), (rightS, bottom), (left, bottom)].map { corner -> Vec3 in
            let p = out((s: corner.0, t: corner.1))
            return c + right * p.s + up * p.t
        }

        let residual = (0..<4).map { raw[$0].distance(to: fitted[$0]) * inchesPerMetre }
        let topIn = raw[0].distance(to: raw[1]) * inchesPerMetre, bottomIn = raw[3].distance(to: raw[2]) * inchesPerMetre
        let leftIn = raw[0].distance(to: raw[3]) * inchesPerMetre, rightIn = raw[1].distance(to: raw[2]) * inchesPerMetre
        let widthIn = (rightS - left) * inchesPerMetre, heightIn = (top - bottom) * inchesPerMetre
        func differs(_ x: Double, _ y: Double) -> Bool {
            let d = abs(x - y)
            return d > FitLimits.sideDiffIn || d / max((x + y) / 2, 1e-9) > FitLimits.sideDiffShare
        }
        let disagrees = differs(topIn, bottomIn) || differs(leftIn, rightIn) || (residual.max() ?? 0) > FitLimits.sideDiffIn

        // Which corner? The one whose removal leaves the other three agreeing best: the two edges that do not touch a corner are
        // the evidence about the rest (the horizontal one must be level, the vertical one upright, in the rectangle's own axes)
        func level(_ i: Int, _ j: Int) -> Double { abs(a[i].t - a[j].t) }
        func upright(_ i: Int, _ j: Int) -> Double { abs(a[i].s - a[j].s) }
        let edges: [(corners: Set<Int>, off: Double)] = [([0, 1], level(0, 1)), ([3, 2], level(3, 2)), ([0, 3], upright(0, 3)), ([1, 2], upright(1, 2))]
        let explained = (0..<4).map { i -> Double in
            let rest = edges.filter { !$0.corners.contains(i) }
            return (rest.reduce(0) { $0 + $1.off * $1.off } / 2).squareRoot() * inchesPerMetre
        }
        let best = explained.min() ?? 0
        let ties = (0..<4).filter { explained[$0] <= best + FitLimits.tieIn }
        // Among corners explaining it equally well: the less certain one, then the one further from its rectangle corner, then the lower
        let worst = ties.max { x, y in
            let sx = x < spreadM.count ? spreadM[x] : 0, sy = y < spreadM.count ? spreadM[y] : 0
            if abs(sx - sy) > 1e-9 { return sx < sy }
            if abs(residual[x] - residual[y]) > 1e-9 { return residual[x] < residual[y] }
            return x < y
        } ?? 0

        return RectangleFit(pointsM: fitted, rawPointsM: raw, widthIn: widthIn, heightIn: heightIn, residualIn: residual, tiltDeg: theta,
                            topIn: topIn, bottomIn: bottomIn, leftIn: leftIn, rightIn: rightIn, disagrees: disagrees, worstCorner: worst)
    }
}
