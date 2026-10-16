import Foundation

/// A pinhole camera as ARKit describes it for ARFrame.capturedImage: focal lengths and principal point in pixels of
/// the NATIVE (landscape, sensor-orientation) image of `width` x `height`.
public struct CameraIntrinsics: Equatable, Sendable {
    public var fx: Double
    public var fy: Double
    public var cx: Double
    public var cy: Double
    public var width: Double
    public var height: Double

    public init(fx: Double, fy: Double, cx: Double, cy: Double, width: Double, height: Double) {
        self.fx = fx
        self.fy = fy
        self.cx = cx
        self.cy = cy
        self.width = width
        self.height = height
    }

    /// The same camera for an image scaled to `width` x `height` (e.g. the 256 x 192 LiDAR depth map).
    public func scaled(toWidth w: Double, height h: Double) -> CameraIntrinsics {
        let sx = w / width, sy = h / height
        return CameraIntrinsics(fx: fx * sx, fy: fy * sy, cx: cx * sx, cy: cy * sy, width: w, height: h)
    }
}

/// Between AR world space and image pixels.
/// ARKit's camera space: +x right, +y up, the camera looks along -z, in the native landscape image's orientation;
/// image pixels: x right, y down.
public enum ImageMapping {
    /// A world point into native image pixels; nil when it is at or behind the camera.
    public static func project(_ p: Vec3, cameraTransform: Mat4, intrinsics k: CameraIntrinsics) -> Vec2? {
        let c = cameraTransform.inverseRigid.transform(p)
        guard c.z < -1e-4 else { return nil }
        let depth = -c.z
        return Vec2(k.cx + k.fx * c.x / depth, k.cy - k.fy * c.y / depth)
    }

    /// A native-image pixel with its depth (metres along the camera's view direction) back into the world.
    public static func unproject(_ px: Vec2, depth: Double, cameraTransform: Mat4, intrinsics k: CameraIntrinsics) -> Vec3 {
        let x = (px.x - k.cx) / k.fx * depth
        let y = -(px.y - k.cy) / k.fy * depth
        return cameraTransform.transform(Vec3(x, y, -depth))
    }

    /// A native (landscape) image pixel into the upright portrait image: the native image turned 90° clockwise
    /// (CGImagePropertyOrientation.right, the back camera with the phone held upright).
    public static func nativeToPortrait(_ p: Vec2, nativeWidth: Double, nativeHeight: Double) -> Vec2 {
        Vec2(nativeHeight - p.y, p.x)
    }

    public static func isInside(_ p: Vec2, width: Double, height: Double) -> Bool {
        p.x >= 0 && p.y >= 0 && p.x <= width && p.y <= height
    }

    /// Kept inside the image (the server wants corners on the photo), to a tenth of a pixel.
    public static func clamp(_ p: Vec2, width: Double, height: Double) -> Vec2 {
        Vec2((min(width, max(0, p.x)) * 10).rounded() / 10, (min(height, max(0, p.y)) * 10).rounded() / 10)
    }

    /// The photo inset 15% on every side (TL, TR, BR, BL): where corners go when the window cannot be drawn into it.
    public static func insetCorners(width: Double, height: Double) -> [Vec2] {
        let x0 = (width * 0.15).rounded(), x1 = (width * 0.85).rounded()
        let y0 = (height * 0.15).rounded(), y1 = (height * 0.85).rounded()
        return [Vec2(x0, y0), Vec2(x1, y0), Vec2(x1, y1), Vec2(x0, y1)]
    }

    /// Corners from one image size to another (the server may report the upload at a different size).
    public static func rescale(_ ps: [Vec2], from: (Double, Double), to: (Double, Double)) -> [Vec2] {
        guard from.0 > 0, from.1 > 0 else { return ps }
        let sx = to.0 / from.0, sy = to.1 / from.1
        return ps.map { Vec2(($0.x * sx * 10).rounded() / 10, ($0.y * sy * 10).rounded() / 10) }
    }
}

/// RoomPlan's windows and doors: a surface's transform (local x along its width, y up its height, z its normal) and
/// its dimensions give its four corners.
public enum RoomPlanMath {
    /// TL, TR, BR, BL in world space (gravity-ordered as seen from `viewer` when given, else in the surface's frame).
    public static func corners(transform: Mat4, widthM: Double, heightM: Double, viewer: Vec3? = nil) -> [Vec3] {
        let hw = widthM / 2, hh = heightM / 2
        let local = [Vec3(-hw, hh, 0), Vec3(hw, hh, 0), Vec3(hw, -hh, 0), Vec3(-hw, -hh, 0)]
        let world = local.map { transform.transform($0) }
        return gravityOrderedCorners(world, viewer: viewer) ?? world
    }

    /// How front-on and complete a view of the surface is, 0...1, for keeping the best photo of each window:
    /// 0 when a corner is off the image or behind the camera.
    public static func viewScore(corners: [Vec3], cameraTransform: Mat4, intrinsics k: CameraIntrinsics) -> Double {
        let px = corners.compactMap { ImageMapping.project($0, cameraTransform: cameraTransform, intrinsics: k) }
        guard px.count == 4, px.allSatisfy({ ImageMapping.isInside($0, width: k.width, height: k.height) }) else { return 0 }
        // Area share of the image (shoelace), favouring a window that fills the frame but not edge to edge
        var a = 0.0
        for i in 0..<4 {
            let p = px[i], q = px[(i + 1) % 4]
            a += p.x * q.y - q.x * p.y
        }
        let share = abs(a) / 2 / (k.width * k.height)
        // Front-on: the camera's view direction against the surface normal
        guard let n = (corners[1] - corners[0]).cross(corners[3] - corners[0]).normalized else { return 0 }
        let forward = -cameraTransform.column(2)
        let frontal = abs(n.dot(forward.normalized ?? forward))
        return min(1, share * 3) * frontal
    }
}
