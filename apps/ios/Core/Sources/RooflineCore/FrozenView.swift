import Foundation

// Measuring a window from a FROZEN frame. Holding a phone steady on a corner and tapping is the source of most wrong sizes (the hand
// moves, the outline flies about), so the phone takes ONE still of the camera frame and keeps, with it, everything ARKit knew at that
// instant: where the camera was, its lens numbers, the wall plane, and the LiDAR depth. After that nothing moves: the corners are
// dragged on the photo, and every position in the world is worked out from that one frame. No ARKit here: the app copies the numbers
// out of the ARFrame, and all the maths is checked on a Mac.

/// The LiDAR depth of one frame as plain numbers (ARFrame.sceneDepth: 256 x 192, in the camera's landscape orientation).
public struct FrozenDepth: Equatable, Sendable {
    public var width: Int
    public var height: Int
    /// Metres along the camera's view direction, row-major; 0 or not finite where there is no reading.
    public var depthM: [Float]
    /// ARConfidenceLevel per pixel (0 low, 1 medium, 2 high), row-major; empty when the frame had none (every reading is then trusted).
    public var confidence: [UInt8]

    public init(width: Int, height: Int, depthM: [Float], confidence: [UInt8] = []) {
        self.width = width
        self.height = height
        self.depthM = depthM
        self.confidence = confidence
    }

    public static let minDepthM = 0.1
    public static let maxDepthM = 10.0
    /// Only readings with this confidence (ARConfidenceLevel.high) count.
    public static let minConfidence: UInt8 = 2

    public var isValid: Bool { width > 0 && height > 0 && depthM.count == width * height && (confidence.isEmpty || confidence.count == width * height) }

    /// The reading at a depth pixel: nil when missing, out of range, or not high confidence.
    public func reading(_ x: Int, _ y: Int) -> Double? {
        guard x >= 0, y >= 0, x < width, y < height else { return nil }
        let i = y * width + x
        if !confidence.isEmpty, confidence[i] < Self.minConfidence { return nil }
        let d = Double(depthM[i])
        guard d.isFinite, d > Self.minDepthM, d < Self.maxDepthM else { return nil }
        return d
    }

    /// The world points of the trusted readings within `radiusM` (metres, across the surface) of a native-image pixel. `intrinsics`
    /// are the camera's, in the NATIVE image's pixels. Empty without readings there.
    public func points(aroundNative center: Vec2, radiusM: Double, cameraTransform: Mat4, intrinsics: CameraIntrinsics) -> [Vec3] {
        guard isValid else { return [] }
        let k = intrinsics.scaled(toWidth: Double(width), height: Double(height))
        let cx = Int((center.x / intrinsics.width * Double(width)).rounded(.down)), cy = Int((center.y / intrinsics.height * Double(height)).rounded(.down))
        guard cx >= 0, cy >= 0, cx < width, cy < height else { return [] }
        // How many depth pixels make radiusM at about this distance (a depth pixel is distance / focal length wide)
        let distance = reading(cx, cy) ?? nearestReading(cx, cy) ?? 1.5
        let pixelM = distance / max(k.fx, 1)
        let r = max(1, Int((radiusM / pixelM).rounded(.up)))
        var out: [Vec3] = []
        for dy in -r...r {
            for dx in -r...r {
                guard (Double(dx * dx + dy * dy)).squareRoot() * pixelM <= radiusM + pixelM / 2 else { continue }
                guard let d = reading(cx + dx, cy + dy) else { continue }
                // Pixel centres: +0.5
                out.append(ImageMapping.unproject(Vec2(Double(cx + dx) + 0.5, Double(cy + dy) + 0.5), depth: d, cameraTransform: cameraTransform, intrinsics: k))
            }
        }
        return out
    }

    private func nearestReading(_ cx: Int, _ cy: Int) -> Double? {
        for r in 1...4 {
            for dy in -r...r {
                for dx in -r...r where max(abs(dx), abs(dy)) == r {
                    if let d = reading(cx + dx, cy + dy) { return d }
                }
            }
        }
        return nil
    }
}

/// Everything about one frozen frame that turns a point on its photo into a point on the wall.
public struct FrozenView: Equatable, Sendable {
    /// Where the camera was (ARCamera.transform) and its lens, in the native landscape image's pixels.
    public var cameraTransform: Mat4
    public var intrinsics: CameraIntrinsics
    /// The wall the window is on, turned toward the camera.
    public var wall: Plane
    public var depth: FrozenDepth?
    /// The upright photo the person sees and drags corners on (the native image turned a quarter clockwise, perhaps at another size).
    public var photoWidthPx: Double
    public var photoHeightPx: Double

    public init(cameraTransform: Mat4, intrinsics: CameraIntrinsics, wall: Plane, depth: FrozenDepth?, photoWidthPx: Double, photoHeightPx: Double) {
        self.cameraTransform = cameraTransform
        self.intrinsics = intrinsics
        self.wall = wall.facing(cameraTransform.translation)
        self.depth = depth
        self.photoWidthPx = photoWidthPx
        self.photoHeightPx = photoHeightPx
    }

    public var viewer: Vec3 { cameraTransform.translation }
    public var device: ArDevice { depth == nil ? .arkit : .arkitLidar }

    /// How far a frame may stand from the wall's surface (metres): a sill, a casing, a frame set in a reveal. Depth readings further off
    /// than this are the glass behind the frame, or the room in front of it, not the frame.
    public static let frameOffsetLimitM = 0.05
    /// The depth around each corner that says where the frame's face is: readings within this radius (metres).
    public static let depthRadiusM = 0.04
    /// Fewest readings, over the four corners, that move the plane from the wall's surface to the frame's face.
    public static let minDepthPoints = 12
    /// A corner's own noise: this many pixels of the photo (1 px at 2 m is about 1.3 mm), at least `minSpreadM`.
    public static let pixelSpreadPx = 1.5
    public static let minSpreadM = 0.002

    // MARK: Photo <-> camera image

    /// A pixel of the upright photo as a pixel of the native (landscape) camera image.
    public func nativePixel(fromPhoto p: Vec2) -> Vec2 {
        let portraitW = intrinsics.height, portraitH = intrinsics.width
        let q = Vec2(p.x / max(photoWidthPx, 1) * portraitW, p.y / max(photoHeightPx, 1) * portraitH)
        return ImageMapping.portraitToNative(q, nativeWidth: intrinsics.width, nativeHeight: intrinsics.height)
    }

    /// A pixel of the native camera image as a pixel of the upright photo.
    public func photoPixel(fromNative n: Vec2) -> Vec2 {
        let q = ImageMapping.nativeToPortrait(n, nativeWidth: intrinsics.width, nativeHeight: intrinsics.height)
        return Vec2(q.x / intrinsics.height * photoWidthPx, q.y / intrinsics.width * photoHeightPx)
    }

    /// A point in the world as a pixel of the upright photo; nil when it is behind the camera.
    public func photoPixel(ofWorld p: Vec3) -> Vec2? {
        ImageMapping.project(p, cameraTransform: cameraTransform, intrinsics: intrinsics).map(photoPixel(fromNative:))
    }

    // MARK: Photo -> wall

    /// The plane the window's frame lies in: the wall's, moved to the frame's face by the depth readings around the four corners
    /// (`photoPx`: the corners on the photo, any order). The wall itself without depth, or with too few readings.
    public func framePlane(photoPx: [Vec2]) -> Plane {
        guard let depth = depth, photoPx.count == 4 else { return wall }
        var offsets: [Double] = []
        for p in photoPx {
            let pts = depth.points(aroundNative: nativePixel(fromPhoto: p), radiusM: Self.depthRadiusM, cameraTransform: cameraTransform, intrinsics: intrinsics)
            for q in pts {
                let d = wall.signedDistance(q)
                if abs(d) <= Self.frameOffsetLimitM { offsets.append(d) }
            }
        }
        guard offsets.count >= Self.minDepthPoints, let off = median(offsets) else { return wall }
        return wall.offset(by: off)
    }

    /// The four corners on the photo (TL, TR, BR, BL in any order) as points on the frame's plane, with that plane and each corner's
    /// own noise in metres. Nil when a ray misses the plane.
    public func worldCorners(photoPx: [Vec2]) -> (points: [Vec3], plane: Plane, spreadM: [Double])? {
        guard photoPx.count == 4, photoPx.allSatisfy({ $0.x.isFinite && $0.y.isFinite }) else { return nil }
        let plane = framePlane(photoPx: photoPx)
        var points: [Vec3] = []
        var spreads: [Double] = []
        for p in photoPx {
            let native = nativePixel(fromPhoto: p)
            guard let ray = ImageMapping.ray(throughNativePixel: native, cameraTransform: cameraTransform, intrinsics: intrinsics),
                  let hit = plane.intersect(rayOrigin: ray.origin, direction: ray.direction) else { return nil }
            points.append(hit)
            let distance = hit.distance(to: ray.origin)
            spreads.append(max(Self.minSpreadM, Self.pixelSpreadPx * distance / max(intrinsics.fx, 1) * intrinsics.width / max(photoHeightPx, 1)))
        }
        return (points, plane, spreads)
    }
}
