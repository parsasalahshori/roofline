import Foundation

// A fingertip cannot land on a one-pixel target, but the corner of a window frame is a very definite thing in a photo: two strong
// edges, one roughly upright and one roughly level, crossing. When a corner is let go within a few millimetres of one, it is moved
// onto the crossing. Only when the picture is clear about it: both edges strong, each far ahead of any look-alike beside it, and the
// crossing close by. Otherwise the corner stays exactly where the finger left it. Pure maths on a small square of grey pixels, so
// it is checked on a Mac; the app cuts the square out of the photo.

/// A small square of the photo in grey (0 black ... 255 white), row-major.
public struct GrayPatch: Equatable, Sendable {
    public var width: Int
    public var height: Int
    public var pixels: [UInt8]

    public init(width: Int, height: Int, pixels: [UInt8]) {
        self.width = width
        self.height = height
        self.pixels = pixels
    }

    public var isValid: Bool { width > 2 && height > 2 && pixels.count == width * height }

    public subscript(x: Int, y: Int) -> Double { Double(pixels[y * width + x]) }
}

public enum CornerSnap {
    /// The answer: where the corner is (patch pixels), how far it moved, and how clear the two edges were.
    public struct Snapped: Equatable, Sendable {
        public var point: Vec2
        public var movedPx: Double
        /// Each edge's strength over the next-best look-alike (1 = equal; the least of the two).
        public var clarity: Double
    }

    /// How far a corner may be pulled (pixels of a photo `referenceWidthPx` wide; scaled to the photo by `radius(forPhotoWidth:)`).
    public static let radiusAtReference = 25.0
    public static let referenceWidthPx = 1440.0
    /// Also looks this far past the snap radius for the edges' ends (pixels).
    public static let marginPx = 40.0
    /// An edge pixel counts for a line when its gradient points within this many degrees of the line's normal.
    public static let angleToleranceDeg = 20.0
    /// The lines searched may lean this far from upright and from level (as a slope: 0.25 is 14 degrees).
    public static let maxSlope = 0.25
    public static let slopeStep = 0.025
    /// Gradient (Sobel units, 8 per grey level per pixel) below which a pixel is not an edge, and the share of the strongest edge in the patch.
    public static let minGradient = 48.0
    public static let relativeGradient = 0.3
    /// An edge's total strength, in whole-edge-pixels' worth (a clear edge a few dozen pixels long).
    public static let minSupportPixels = 18.0
    /// The best line against the best other line (one at least `separationPx` away from it): at least this much stronger.
    public static let minClarity = 1.4
    public static let separationPx = 4.0
    /// The votes are smoothed over this many half-pixel bins each way (triangular), so a blurred edge peaks at its middle.
    static let smoothingHalfBins = 6

    /// The snap radius for a photo this wide.
    public static func radius(forPhotoWidth w: Double) -> Double { max(8, (radiusAtReference * w / referenceWidthPx).rounded()) }

    /// The patch half-size to cut around the corner for a snap radius (pixels).
    public static func halfSize(forRadius r: Double) -> Int { Int((r + marginPx).rounded(.up)) }

    private struct Line {
        /// Offset of the line at the corner's row (or column), pixels from the corner.
        var offset: Double
        var slope: Double
        var strength: Double
        var clarity: Double
    }

    /// The corner near `corner` (patch pixels) in a patch of grey pixels, or nil when the picture is not clear about one within `radius`.
    public static func snap(corner: Vec2, in patch: GrayPatch, radius: Double) -> Snapped? {
        guard patch.isValid, corner.x.isFinite, corner.y.isFinite, radius > 0 else { return nil }
        let w = patch.width, h = patch.height
        // The gradient (Sobel) and where the strong edges are
        var gx = [Double](repeating: 0, count: w * h), gy = gx, mag = gx
        var maxMag = 0.0
        for y in 1..<(h - 1) {
            for x in 1..<(w - 1) {
                let a = patch[x - 1, y - 1], b = patch[x, y - 1], c = patch[x + 1, y - 1]
                let d = patch[x - 1, y], f = patch[x + 1, y]
                let g = patch[x - 1, y + 1], hh = patch[x, y + 1], i = patch[x + 1, y + 1]
                let sx = (c + 2 * f + i) - (a + 2 * d + g)
                let sy = (g + 2 * hh + i) - (a + 2 * b + c)
                let k = y * w + x
                gx[k] = sx
                gy[k] = sy
                mag[k] = (sx * sx + sy * sy).squareRoot()
                maxMag = max(maxMag, mag[k])
            }
        }
        let threshold = max(minGradient, relativeGradient * maxMag)
        guard maxMag >= minGradient * 2 else { return nil }
        let tan = Foundation.tan(angleToleranceDeg * .pi / 180)

        // Lines: x = x0 + s (y - cy) for upright ones, y = y0 + s (x - cx) for level ones. Pixels vote with their gradient.
        let slopes = stride(from: -maxSlope, through: maxSlope + 1e-9, by: slopeStep).map { $0 }
        guard let vertical = bestLine(w: w, h: h, gx: gx, gy: gy, mag: mag, threshold: threshold, tan: tan, slopes: slopes,
                                      corner: corner, radius: radius, upright: true),
              let level = bestLine(w: w, h: h, gx: gx, gy: gy, mag: mag, threshold: threshold, tan: tan, slopes: slopes,
                                   corner: corner, radius: radius, upright: false) else { return nil }
        // Where they cross: dx = a + sv dy and dy = b + sh dx, from the corner
        let a = vertical.offset, b = level.offset
        let denom = 1 - vertical.slope * level.slope
        guard abs(denom) > 1e-6 else { return nil }
        let dx = (a + vertical.slope * b) / denom
        let dy = b + level.slope * dx
        let moved = (dx * dx + dy * dy).squareRoot()
        guard moved <= radius else { return nil }
        return Snapped(point: Vec2(corner.x + dx, corner.y + dy), movedPx: moved, clarity: min(vertical.clarity, level.clarity))
    }

    private struct EdgePixel {
        /// Along the line and across it, pixels from the corner.
        var u: Double
        var v: Double
        var weight: Double
    }

    /// The strongest roughly upright (or level) edge line passing within `radius` of the corner, when it is clearly ahead of the rest.
    private static func bestLine(w: Int, h: Int, gx: [Double], gy: [Double], mag: [Double], threshold: Double, tan: Double, slopes: [Double],
                                 corner: Vec2, radius: Double, upright: Bool) -> Line? {
        var pixels: [EdgePixel] = []
        for y in 1..<(h - 1) {
            for x in 1..<(w - 1) {
                let k = y * w + x
                guard mag[k] >= threshold else { continue }
                // The edge runs upright when the gradient points mostly across (x); level when mostly along y
                let across = upright ? abs(gx[k]) : abs(gy[k]), along = upright ? abs(gy[k]) : abs(gx[k])
                guard along <= tan * across else { continue }
                // (a pixel's centre is half a pixel in: the corner is in the photo's own coordinates, pixel (i, j) covering i...i+1)
                let px = Double(x) + 0.5 - corner.x, py = Double(y) + 0.5 - corner.y
                pixels.append(EdgePixel(u: upright ? py : px, v: upright ? px : py, weight: mag[k]))
            }
        }
        guard let best = strongest(pixels, slopes: slopes, radius: radius), best.strength >= minSupportPixels * threshold else { return nil }
        // The best look-alike: the strongest line among the pixels that are NOT on the best one (a parallel edge, trim, a casing)
        let rest = pixels.filter { abs($0.v - best.slope * $0.u - best.offset) > separationPx }
        let rival = strongest(rest, slopes: slopes, radius: radius)?.strength ?? 0
        let clarity = rival > 0 ? best.strength / rival : .infinity
        guard clarity >= minClarity else { return nil }
        return Line(offset: best.offset, slope: best.slope, strength: best.strength, clarity: clarity)
    }

    /// The line (offset at the corner's row or column, slope) that most edge pixels agree on, with its strength, among lines passing within
    /// `radius` of the corner.
    private static func strongest(_ pixels: [EdgePixel], slopes: [Double], radius: Double) -> (strength: Double, offset: Double, slope: Double)? {
        guard !pixels.isEmpty else { return nil }
        // Offsets are binned at half a pixel across -(radius+4) ... radius+4
        let span = radius + 4
        let bins = Int((2 * span * 2).rounded(.up)) + 1
        var acc = [[Double]](repeating: [Double](repeating: 0, count: bins), count: slopes.count)
        for p in pixels {
            for (si, s) in slopes.enumerated() {
                let off = p.v - s * p.u
                guard abs(off) <= span else { continue }
                let bin = Int(((off + span) * 2).rounded())
                if bin >= 0, bin < bins { acc[si][bin] += p.weight }
            }
        }
        // Smooth across the offset (a blurred edge is several pixels wide, and its votes are a plateau: the middle of it is the edge)
        let half = smoothingHalfBins
        var best: (strength: Double, offset: Double, slope: Double)?
        for si in 0..<slopes.count {
            let row = acc[si]
            for b in 0..<bins {
                let off = Double(b) / 2 - span
                guard abs(off) <= radius else { continue }
                var sum = 0.0
                for k in -half...half where b + k >= 0 && b + k < bins { sum += row[b + k] * Double(half + 1 - abs(k)) }
                let value = sum / Double((half + 1) * (half + 1))
                if value > (best?.strength ?? 0) { best = (value, off, slopes[si]) }
            }
        }
        return best
    }
}
