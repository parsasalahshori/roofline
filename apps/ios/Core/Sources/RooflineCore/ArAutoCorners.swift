import Foundation

// The AR side of proposing the corners: a window outline found in the live camera image (a quad in image pixels, from
// `AutoCorners`) is turned into four points in the world by sending a ray from the camera through each corner onto the wall's
// plane, then judged (is this a believable window?) and steadied over a few looks before the phone offers it. The points that come
// out are exactly what four taps would give `CornerCapture`: the app places them through `CornerCapture.place`, so the wall check,
// the ordering, the size and the server's data do not change. No ARKit, no Vision: it is all checked on a Mac.

extension ImageMapping {
    /// A native-image (landscape) pixel from a pixel of the upright portrait image: the inverse of `nativeToPortrait`.
    public static func portraitToNative(_ p: Vec2, nativeWidth: Double, nativeHeight: Double) -> Vec2 {
        Vec2(p.y, nativeHeight - p.x)
    }

    /// The ray from the camera through a native-image pixel: where it starts (the camera) and which way it goes (a unit vector, in
    /// the world). The inverse of `project`.
    public static func ray(throughNativePixel px: Vec2, cameraTransform: Mat4, intrinsics k: CameraIntrinsics) -> (origin: Vec3, direction: Vec3)? {
        let origin = cameraTransform.translation
        let far = unproject(px, depth: 1, cameraTransform: cameraTransform, intrinsics: k)
        guard let d = (far - origin).normalized else { return nil }
        return (origin, d)
    }
}

public enum ArAutoCorners {
    /// A window's sides, metres: a smaller or bigger outline is not a window (a stained-glass panel; a whole wall).
    public static let sideRangeM: ClosedRange<Double> = 0.2...4.0
    /// Opposite sides of the window on the wall differ by this ratio at most (a real rectangle: they are equal; the rest is noise
    /// in the outline and in the plane).
    public static let oppositeSideRatio = 1.15
    /// The two diagonals of a rectangle are equal: they may differ by this share of their mean.
    public static let diagonalDifference = 0.1

    /// The four world points where the rays through the outline's corners meet the planes `planes[i]` (the wall plane, or the frame's
    /// own plane near that corner when depth says the frame stands proud of the wall). `nativePx` is TL, TR, BR, BL in the native
    /// image's pixels. Nil when a ray does not reach its plane (parallel, or behind the camera).
    public static func worldQuad(nativePx: [Vec2], cameraTransform: Mat4, intrinsics: CameraIntrinsics, planes: [Plane]) -> [Vec3]? {
        guard nativePx.count == 4, planes.count == 4 else { return nil }
        var out: [Vec3] = []
        for i in 0..<4 {
            guard let r = ImageMapping.ray(throughNativePixel: nativePx[i], cameraTransform: cameraTransform, intrinsics: intrinsics),
                  let hit = planes[i].intersect(rayOrigin: r.origin, direction: r.direction) else { return nil }
            out.append(hit)
        }
        return out
    }

    /// Could these four points (TL, TR, BR, BL) be a window on a wall? Sides of a window's size, opposite sides equal and the two
    /// diagonals equal (a rectangle), within the noise of an outline found in a camera image.
    public static func isPlausibleWindow(_ p: [Vec3]) -> Bool {
        guard p.count == 4, p.allSatisfy({ $0.isFinite }) else { return false }
        let top = p[0].distance(to: p[1]), bottom = p[3].distance(to: p[2])
        let left = p[0].distance(to: p[3]), right = p[1].distance(to: p[2])
        guard [top, bottom, left, right].allSatisfy({ sideRangeM.contains($0) }) else { return false }
        guard max(top, bottom) / min(top, bottom) <= oppositeSideRatio, max(left, right) / min(left, right) <= oppositeSideRatio else { return false }
        let d1 = p[0].distance(to: p[2]), d2 = p[1].distance(to: p[3])
        return abs(d1 - d2) / ((d1 + d2) / 2) <= diagonalDifference
    }

    /// The width and height of a plausible window, inches (the mean of the opposite sides).
    public static func sizeInches(_ p: [Vec3]) -> (widthIn: Double, heightIn: Double)? {
        guard p.count == 4 else { return nil }
        let w = (p[0].distance(to: p[1]) + p[3].distance(to: p[2])) / 2
        let h = (p[0].distance(to: p[3]) + p[1].distance(to: p[2])) / 2
        return (w * inchesPerMetre, h * inchesPerMetre)
    }
}

/// Keeps a window outline steady across camera looks: an outline is offered only after it has been found in about the same place
/// twice in a row, it is the mean of its last few looks (so it does not shiver on screen), it goes when it stops being found, and
/// each corner's spread (how much it moved between looks) is the noise reported with it.
public struct QuadTracker: Sendable {
    /// Two looks are "the same outline" when their corners are this close, on average (metres).
    public static let matchM = 0.03
    /// Looks in a row, in about the same place, before the outline is offered.
    public static let looksToOffer = 2
    /// The outline is the mean of this many of the latest looks.
    public static let memory = 5
    /// Looks in a row that found nothing (or nothing believable) before the outline is dropped.
    public static let missesToDrop = 2
    /// The least spread a corner is reported with (metres): a detected outline is never better than a few millimetres.
    public static let minSpreadM = 0.004

    private var recent: [[Vec3]] = []
    private var misses = 0
    public private(set) var streak = 0

    public init() {}

    /// The steadied outline (TL, TR, BR, BL), or nil before one is offered.
    public var offered: [Vec3]? { streak >= Self.looksToOffer ? smoothed : nil }

    public var smoothed: [Vec3]? {
        guard let first = recent.first else { return nil }
        return (0..<first.count).compactMap { i in Vec3.mean(recent.map { $0[i] }) }
    }

    /// Each corner's spread over the recent looks, metres (at least `minSpreadM`).
    public var spreadM: [Double] {
        guard let mean = smoothed else { return [] }
        return (0..<mean.count).map { i in
            guard recent.count >= 2 else { return Self.minSpreadM }
            let v = recent.reduce(0.0) { $0 + ($1[i] - mean[i]).dot($1[i] - mean[i]) } / Double(recent.count - 1)
            return max(Self.minSpreadM, v.squareRoot())
        }
    }

    /// A look that found an outline (four world points).
    public mutating func add(_ corners: [Vec3]) {
        misses = 0
        guard corners.count == 4, corners.allSatisfy({ $0.isFinite }) else {
            miss()
            return
        }
        if let mean = smoothed, meanDistance(mean, corners) <= Self.matchM {
            recent.append(corners)
            if recent.count > Self.memory { recent.removeFirst(recent.count - Self.memory) }
            streak += 1
        } else {
            // Somewhere else, or the first: start again from this one
            recent = [corners]
            streak = 1
        }
    }

    /// A look that found nothing believable.
    public mutating func miss() {
        misses += 1
        if misses >= Self.missesToDrop { reset() }
    }

    public mutating func reset() {
        recent = []
        misses = 0
        streak = 0
    }

    private func meanDistance(_ a: [Vec3], _ b: [Vec3]) -> Double {
        zip(a, b).reduce(0.0) { $0 + $1.0.distance(to: $1.1) } / 4
    }
}
