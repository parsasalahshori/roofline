import Foundation

/// A plane projective map (a 3 x 3 homography, row-major, acting on column vectors [x y 1]). The window visualizer draws a window on a
/// flat canonical rectangle (inches) and this carries it onto the four corners of the window in the photo; the inverse says where
/// a photo pixel falls on the window. Pure arithmetic, so it is checked on a Mac.
public struct Homography: Equatable, Sendable {
    /// Nine numbers, row by row.
    public var m: [Double]

    public static let identity = Homography([1, 0, 0, 0, 1, 0, 0, 0, 1])

    public init(_ m: [Double]) {
        precondition(m.count == 9, "a homography has nine numbers")
        self.m = m
    }

    /// Where `p` goes. Nil when the point is sent to infinity (it lies on the line that maps to the horizon).
    public func map(_ p: Vec2) -> Vec2? {
        let w = m[6] * p.x + m[7] * p.y + m[8]
        guard abs(w) > 1e-12 else { return nil }
        return Vec2((m[0] * p.x + m[1] * p.y + m[2]) / w, (m[3] * p.x + m[4] * p.y + m[5]) / w)
    }

    /// The same, for a point known to be on the near side (falls back to the origin of the target when it is not).
    public func apply(_ p: Vec2) -> Vec2 { map(p) ?? Vec2(0, 0) }

    public func inverse() -> Homography? {
        let a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8]
        let det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
        guard abs(det) > 1e-18 else { return nil }
        let s = 1 / det
        return Homography([
            (e * i - f * h) * s, (c * h - b * i) * s, (b * f - c * e) * s,
            (f * g - d * i) * s, (a * i - c * g) * s, (c * d - a * f) * s,
            (d * h - e * g) * s, (b * g - a * h) * s, (a * e - b * d) * s,
        ])
    }

    /// `self` after `other`: first `other`, then `self`.
    public func after(_ other: Homography) -> Homography {
        var r = [Double](repeating: 0, count: 9)
        for row in 0..<3 {
            for col in 0..<3 {
                for k in 0..<3 { r[row * 3 + col] += m[row * 3 + k] * other.m[k * 3 + col] }
            }
        }
        return Homography(r)
    }

    /// The map that sends the four `src` points to the four `dst` points, in order (no three of either on a line). Nil when the
    /// points are degenerate.
    public static func fourPoints(from src: [Vec2], to dst: [Vec2]) -> Homography? {
        guard src.count == 4, dst.count == 4 else { return nil }
        // Eight equations in the eight unknowns h0...h7 (h8 = 1):
        //   x' = (h0 x + h1 y + h2) / (h6 x + h7 y + 1),  y' = (h3 x + h4 y + h5) / (h6 x + h7 y + 1)
        var a = [[Double]](repeating: [Double](repeating: 0, count: 9), count: 8)
        for k in 0..<4 {
            let x = src[k].x, y = src[k].y, u = dst[k].x, v = dst[k].y
            a[2 * k] = [x, y, 1, 0, 0, 0, -u * x, -u * y, u]
            a[2 * k + 1] = [0, 0, 0, x, y, 1, -v * x, -v * y, v]
        }
        guard let h = solve(&a) else { return nil }
        return Homography(h + [1])
    }

    /// The unit-less rectangle `(0,0) (w,0) (w,h) (0,h)` onto the quad `TL, TR, BR, BL`.
    public static func rect(width: Double, height: Double, to quad: [Vec2]) -> Homography? {
        fourPoints(from: [Vec2(0, 0), Vec2(width, 0), Vec2(width, height), Vec2(0, height)], to: quad)
    }

    /// Gaussian elimination with partial pivoting on an augmented n x (n+1) system.
    private static func solve(_ a: inout [[Double]]) -> [Double]? {
        let n = a.count
        for col in 0..<n {
            var pivot = col
            for r in col..<n where abs(a[r][col]) > abs(a[pivot][col]) { pivot = r }
            guard abs(a[pivot][col]) > 1e-12 else { return nil }
            a.swapAt(col, pivot)
            for r in 0..<n where r != col {
                let f = a[r][col] / a[col][col]
                if f == 0 { continue }
                for c in col...n { a[r][c] -= f * a[col][c] }
            }
        }
        return (0..<n).map { a[$0][n] / a[$0][$0] }
    }
}

/// What the visualizer needs to know about the window's four corners in the photo.
public enum WindowQuad {
    /// A quad that can carry a window: four distinct corners making a convex shape, in order (so no bow-tie), with a size.
    public static func isUsable(_ quad: [Vec2], imageWidth: Double, imageHeight: Double) -> Bool {
        guard quad.count == 4, imageWidth > 0, imageHeight > 0 else { return false }
        // Inside the picture (a little outside is fine: a window cut by the edge of the photo)
        for p in quad {
            guard p.x.isFinite, p.y.isFinite, p.x > -imageWidth * 0.1, p.x < imageWidth * 1.1, p.y > -imageHeight * 0.1, p.y < imageHeight * 1.1 else { return false }
        }
        // Convex and consistently turning: every corner turns the same way
        var sign = 0.0
        for k in 0..<4 {
            let a = quad[k], b = quad[(k + 1) % 4], c = quad[(k + 2) % 4]
            let cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
            if abs(cross) < 1e-9 { return false }
            if sign == 0 { sign = cross > 0 ? 1 : -1 } else if (cross > 0) != (sign > 0) { return false }
        }
        // Not a sliver: each side at least 1.5 % of the picture's longer side
        let minSide = max(imageWidth, imageHeight) * 0.015
        for k in 0..<4 where hypot(quad[k].x - quad[(k + 1) % 4].x, quad[k].y - quad[(k + 1) % 4].y) < minSide { return false }
        return true
    }

    /// Width over height of the window as drawn on the photo: the mean top and bottom edge over the mean left and right edge.
    /// The picture's perspective makes this only roughly the window's own proportions; it is used when the real size is not known.
    public static func aspect(_ quad: [Vec2]) -> Double {
        guard quad.count == 4 else { return 1 }
        func d(_ a: Vec2, _ b: Vec2) -> Double { hypot(a.x - b.x, a.y - b.y) }
        let w = (d(quad[0], quad[1]) + d(quad[3], quad[2])) / 2
        let h = (d(quad[0], quad[3]) + d(quad[1], quad[2])) / 2
        return h > 0 ? w / h : 1
    }

    /// The smallest box round the quad: (minX, minY, maxX, maxY).
    public static func bounds(_ quad: [Vec2]) -> (minX: Double, minY: Double, maxX: Double, maxY: Double) {
        let xs = quad.map(\.x), ys = quad.map(\.y)
        return (xs.min() ?? 0, ys.min() ?? 0, xs.max() ?? 0, ys.max() ?? 0)
    }

    /// The part of the photo the visualizer shows: a box round the window (about 58 % of its height, no more than 62 % of its
    /// width) in the shape of the screen's picture area (`aspect` = width / height), kept inside the photo. Where the photo is
    /// too small to give the window that much room, the viewport is as much of the photo as fits that shape.
    public static func viewport(quad: [Vec2], imageWidth: Double, imageHeight: Double, aspect: Double) -> (x: Double, y: Double, width: Double, height: Double) {
        let b = bounds(quad)
        let bw = max(b.maxX - b.minX, 1), bh = max(b.maxY - b.minY, 1)
        let a = max(aspect, 0.2)
        var vh = max(bh / 0.58, bw / 0.62 / a)
        var vw = vh * a
        if vw > imageWidth { vw = imageWidth; vh = vw / a }
        if vh > imageHeight { vh = imageHeight; vw = vh * a }
        let cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2
        let x = min(max(cx - vw / 2, 0), max(imageWidth - vw, 0))
        let y = min(max(cy - vh / 2, 0), max(imageHeight - vh, 0))
        return (x, y, vw, vh)
    }
}
