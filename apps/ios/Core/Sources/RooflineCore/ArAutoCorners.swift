import Foundation

// The AR side of proposing the corners: a window outline found in a photo (a quad in image pixels, from `AutoCorners`) is turned into four
// points in the world by sending a ray from the camera through each corner onto the wall's plane, then judged (is this a believable
// window?) before the phone offers it. The frozen-photo measuring (`FrozenView`) does the same for the corners a person drags. No ARKit, no
// Vision: it is all checked on a Mac.

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
