import Foundation

// The multi-frame window SCAN (docs/windows/scan-contract.md, v1). Many photos of one window from different spots, close-ups of its corners,
// each corner a point where its rays from every photo meet (closed-form least squares), then the level rectangle through the four points
// and the quality gates. This file is the contract's maths and JSON, nothing else: no images, no ARKit. The server re-runs exactly this in
// TypeScript from the frames and marks the phone sends (and its answer wins), so every number here is spelled as the contract spells it.

/// The thresholds of the contract's quality gates.
public enum ScanLimits {
    public static let minFrames = 3
    public static let maxFrames = 24
    public static let maxMarks = 200
    /// `too_few_frames`: a corner needs this many marks used.
    public static let minMarksPerCorner = 3
    /// `reprojection`: the RMS over all marks, and the worst single mark, in native pixels.
    public static let reprojRmsPx = 3.0
    public static let reprojMaxPx = 8.0
    /// `baseline`: the largest angle between the rays of a corner (degrees).
    public static let minBaselineDeg = 4.0
    /// `sym_ratio`: opposite sides of the triangulated quad.
    public static let symDiffIn = 0.75
    public static let symDiffShare = 0.02
    /// `plane`: a corner this far (metres, 1 cm) from the four corners' plane.
    public static let planeMaxM = 0.01
    /// `scale`: against the single-frame estimate.
    public static let scaleShare = 0.03
    /// `no_closeups` (warning only).
    public static let minCloseups = 2
    /// The 3x3 normal matrix must have its smallest eigenvalue at least this times the number of rays.
    public static let conditionPerRay = 1e-6
    /// A mark that cannot be projected (the corner is behind its camera) counts as this many pixels.
    public static let unprojectablePx = 1e6
}

public enum ScanGate: String, Codable, CaseIterable, Sendable {
    case tooFewFrames = "too_few_frames"
    case reprojection
    case baseline
    case symRatio = "sym_ratio"
    case plane
    case scale
    case noCloseups = "no_closeups"

    /// A warning does not fail a scan on its own.
    public var isWarningOnly: Bool { self == .noCloseups }
}

public enum ScanFrameKind: String, Codable, Sendable {
    case regular
    case closeup
}

public enum MarkSource: String, Codable, Sendable {
    case ai
    case snap
    case projected
    case user
}

public enum ScanStatus: String, Codable, Sendable {
    case measured
    case needsReview = "needs_review"
}

/// Corner order everywhere: 0 TL, 1 TR, 2 BR, 3 BL, as the person faces the window.
public enum ScanCorner {
    public static let names = ["top-left", "top-right", "bottom-right", "bottom-left"]
    public static let short = ["TL", "TR", "BR", "BL"]
}

/// One photo of a scan: where the camera was and its lens, for the maths. (`ScanFramePayload` is the same photo as the server reads it.)
public struct ScanFrame: Codable, Equatable, Sendable {
    public var frameId: String
    public var kind: ScanFrameKind
    /// The corner a close-up is of (0...3); nil for a regular frame.
    public var corner: Int?
    /// The uploaded JPEG's size (the native landscape image).
    public var imageWidth: Int
    public var imageHeight: Int
    public var cameraTransform: Mat4
    public var intrinsics: CameraIntrinsics

    public init(frameId: String, kind: ScanFrameKind, corner: Int? = nil, imageWidth: Int, imageHeight: Int, cameraTransform: Mat4, intrinsics: CameraIntrinsics) {
        self.frameId = frameId
        self.kind = kind
        self.corner = corner
        self.imageWidth = imageWidth
        self.imageHeight = imageHeight
        self.cameraTransform = cameraTransform
        self.intrinsics = intrinsics
    }
}

/// One corner of the window as seen in one photo: native image pixels of that photo (x right, y down).
public struct ScanMark: Codable, Equatable, Sendable {
    public var frameId: String
    public var corner: Int
    public var x: Double
    public var y: Double
    public var source: MarkSource

    public init(frameId: String, corner: Int, x: Double, y: Double, source: MarkSource) {
        self.frameId = frameId
        self.corner = corner
        self.x = x
        self.y = y
        self.source = source
    }
}

// MARK: - The numbers

public struct ScanQuality: Codable, Equatable, Sendable {
    /// Marks used for triangulation at each corner.
    public var framesPerCorner: [Int]
    public var reprojRmsPx: Double
    public var reprojMaxPx: Double
    /// The smallest, over the corners, of the largest angle between that corner's rays (degrees).
    public var minBaselineDeg: Double
    /// The larger of the two relative differences between opposite sides of the triangulated quad.
    public var symRatioDiff: Double
    /// The farthest a corner is from the four corners' plane (centimetres).
    public var planeMaxCm: Double
    /// The larger relative difference of width and height against the single-frame estimate.
    public var scaleDiff: Double
    /// Close-up frames that contributed marks.
    public var closeups: Int
    /// Gate codes that failed. `no_closeups` (warning only) is listed here when it applies; it does not make the scan `needs_review`.
    public var failed: [String]

    public init(framesPerCorner: [Int], reprojRmsPx: Double, reprojMaxPx: Double, minBaselineDeg: Double, symRatioDiff: Double, planeMaxCm: Double,
                scaleDiff: Double, closeups: Int, failed: [String]) {
        self.framesPerCorner = framesPerCorner
        self.reprojRmsPx = reprojRmsPx
        self.reprojMaxPx = reprojMaxPx
        self.minBaselineDeg = minBaselineDeg
        self.symRatioDiff = symRatioDiff
        self.planeMaxCm = planeMaxCm
        self.scaleDiff = scaleDiff
        self.closeups = closeups
        self.failed = failed
    }

    /// The gates that failed, without the warning-only ones.
    public var hardFailures: [ScanGate] { failed.compactMap(ScanGate.init(rawValue:)).filter { !$0.isWarningOnly } }
    public var hasWarning: Bool { failed.contains(ScanGate.noCloseups.rawValue) }
}

/// What a solve gives: the triangulated corners, the level rectangle, the gates, and each mark's error.
public struct ScanSolution: Equatable, Sendable {
    public struct MarkError: Equatable, Sendable {
        public var frameId: String
        public var corner: Int
        public var px: Double
    }

    /// The four corners as triangulated (nil: that corner could not be).
    public var triangulatedM: [Vec3?]
    /// The level rectangle through them (nil unless all four were triangulated and make a rectangle).
    public var fit: RectangleFit?
    /// The single-frame (plane) estimate the scale gate compares with, inches.
    public var singleFrameIn: (width: Double, height: Double)?
    public var markErrors: [MarkError]
    public var quality: ScanQuality

    public var status: ScanStatus { quality.hardFailures.isEmpty && fit != nil ? .measured : .needsReview }
    public var widthIn: Double? { fit?.widthIn }
    public var heightIn: Double? { fit?.heightIn }
    /// The opening: the rectangle's corners TL, TR, BR, BL.
    public var cornersM: [Vec3]? { fit?.pointsM }

    public static func == (a: ScanSolution, b: ScanSolution) -> Bool {
        a.triangulatedM == b.triangulatedM && a.fit == b.fit && a.markErrors == b.markErrors && a.quality == b.quality
            && a.singleFrameIn?.width == b.singleFrameIn?.width && a.singleFrameIn?.height == b.singleFrameIn?.height
    }

    /// How far each mark is from where the solution says its corner is, for one frame (nil: no mark there).
    public func error(frameId: String, corner: Int) -> Double? {
        markErrors.first { $0.frameId == frameId && $0.corner == corner }?.px
    }
}

// MARK: - The solver

public enum WindowScanSolver {
    /// A mark's pixel in the intrinsics' own pixels: the contract scales image points by `imageWidth / intrinsics.width` (and the same for
    /// the height) when the JPEG is not the size the lens numbers are for. The phone always uploads at the lens' size, so this is 1.
    public static func intrinsicsPixel(_ x: Double, _ y: Double, in f: ScanFrame) -> Vec2 {
        let sx = f.imageWidth > 0 && f.intrinsics.width > 0 ? Double(f.imageWidth) / f.intrinsics.width : 1
        let sy = f.imageHeight > 0 && f.intrinsics.height > 0 ? Double(f.imageHeight) / f.intrinsics.height : 1
        return Vec2(x * sx, y * sy)
    }

    /// The ray through an image point: origin the camera, direction a unit vector in the world.
    /// camera-space direction = normalize(((x - cx) / fx, -(y - cy) / fy, -1)), rotated by the transform's 3x3.
    public static func ray(frame f: ScanFrame, x: Double, y: Double) -> (origin: Vec3, direction: Vec3)? {
        let p = intrinsicsPixel(x, y, in: f)
        let k = f.intrinsics
        guard k.fx != 0, k.fy != 0, p.x.isFinite, p.y.isFinite else { return nil }
        let dc = Vec3((p.x - k.cx) / k.fx, -(p.y - k.cy) / k.fy, -1)
        guard let d = f.cameraTransform.transformDirection(dc).normalized else { return nil }
        return (f.cameraTransform.translation, d)
    }

    /// The point P minimising the sum of |(I - d d^T)(P - o)|^2 over the rays: P = (sum A)^-1 sum A o with A = I - d d^T. Nil for fewer than two
    /// rays or a badly conditioned 3x3 (smallest eigenvalue below `conditionPerRay` times the number of rays).
    public static func triangulate(_ rays: [(origin: Vec3, direction: Vec3)]) -> Vec3? {
        guard rays.count >= 2 else { return nil }
        var a = [[Double]](repeating: [0, 0, 0], count: 3)
        var b = [0.0, 0.0, 0.0]
        for r in rays {
            let d = [r.direction.x, r.direction.y, r.direction.z]
            let o = [r.origin.x, r.origin.y, r.origin.z]
            let dDotO = d[0] * o[0] + d[1] * o[1] + d[2] * o[2]
            for i in 0..<3 {
                for j in 0..<3 { a[i][j] += (i == j ? 1 : 0) - d[i] * d[j] }
                b[i] += o[i] - d[i] * dDotO
            }
        }
        let (values, _) = symmetricEigen3(a)
        guard values[0] >= ScanLimits.conditionPerRay * Double(rays.count) else { return nil }
        guard let x = solve3(a, b) else { return nil }
        let p = Vec3(x[0], x[1], x[2])
        return p.isFinite ? p : nil
    }

    /// The 3x3 system by Cramer's rule.
    static func solve3(_ a: [[Double]], _ b: [Double]) -> [Double]? {
        func det(_ m: [[Double]]) -> Double {
            m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
        }
        let d = det(a)
        guard abs(d) > 1e-300, d.isFinite else { return nil }
        var out = [0.0, 0.0, 0.0]
        for c in 0..<3 {
            var m = a
            for r in 0..<3 { m[r][c] = b[r] }
            out[c] = det(m) / d
        }
        return out
    }

    /// The largest angle between any two of the rays, degrees.
    public static func maxAngleDeg(_ rays: [(origin: Vec3, direction: Vec3)]) -> Double {
        var best = 0.0
        for i in 0..<rays.count {
            for j in (i + 1)..<max(rays.count, i + 1) {
                let c = max(-1, min(1, rays[i].direction.dot(rays[j].direction)))
                best = max(best, acos(c) * 180 / .pi)
            }
        }
        return best
    }

    /// A world point in a frame's pixels (native, the lens' own); nil when it is at or behind the camera.
    public static func project(_ p: Vec3, in f: ScanFrame) -> Vec2? {
        ImageMapping.project(p, cameraTransform: f.cameraTransform, intrinsics: f.intrinsics)
    }

    /// The reprojection error (pixels) of each of one corner's marks after that corner is triangulated from just those marks, in the order given;
    /// nil when the corner cannot be triangulated from them (fewer than two, or the rays too alike).
    public static func residuals(of marks: [ScanMark], frames: [ScanFrame]) -> [Double]? {
        let byId = Dictionary(frames.map { ($0.frameId, $0) }, uniquingKeysWith: { first, _ in first })
        var rays: [(origin: Vec3, direction: Vec3)] = []
        var fs: [ScanFrame] = []
        for m in marks {
            guard let f = byId[m.frameId], let r = ray(frame: f, x: m.x, y: m.y) else { return nil }
            rays.append(r)
            fs.append(f)
        }
        guard let p = triangulate(rays) else { return nil }
        return zip(marks, fs).map { m, f in
            guard let q = project(p, in: f) else { return ScanLimits.unprojectablePx }
            let mp = intrinsicsPixel(m.x, m.y, in: f)
            return hypot(q.x - mp.x, q.y - mp.y)
        }
    }

    /// The whole scan: triangulate the four corners, fit the level rectangle, run the gates. `wall`: the plane the single-frame estimate is
    /// made on (the scale gate); without it the scale gate cannot pass.
    public static func solve(frames: [ScanFrame], marks: [ScanMark], wall: Plane?) -> ScanSolution {
        let byId = Dictionary(frames.map { ($0.frameId, $0) }, uniquingKeysWith: { first, _ in first })
        // The marks used: a known frame, a corner 0...3, finite numbers. A frame's second mark for a corner replaces the first (the last wins).
        var latest: [String: ScanMark] = [:]
        var order: [String] = []
        for m in marks where (0..<4).contains(m.corner) && byId[m.frameId] != nil && m.x.isFinite && m.y.isFinite {
            let key = "\(m.frameId)#\(m.corner)"
            if latest[key] == nil { order.append(key) }
            latest[key] = m
        }
        let used = order.compactMap { latest[$0] }

        var rays: [[(frame: ScanFrame, mark: ScanMark, origin: Vec3, direction: Vec3)]] = [[], [], [], []]
        for m in used {
            guard let f = byId[m.frameId], let r = ray(frame: f, x: m.x, y: m.y) else { continue }
            rays[m.corner].append((f, m, r.origin, r.direction))
        }
        let perCorner = rays.map { $0.map { (origin: $0.origin, direction: $0.direction) } }
        let counts = rays.map { $0.count }
        let triangulated = perCorner.map { WindowScanSolver.triangulate($0) }
        let baselines = perCorner.map { maxAngleDeg($0) }

        // Reprojection error of every mark of a triangulated corner
        var errors: [ScanSolution.MarkError] = []
        for c in 0..<4 {
            guard let p = triangulated[c] else { continue }
            for r in rays[c] {
                let px: Double
                if let q = project(p, in: r.frame) {
                    let m = intrinsicsPixel(r.mark.x, r.mark.y, in: r.frame)
                    px = hypot(q.x - m.x, q.y - m.y)
                } else {
                    px = ScanLimits.unprojectablePx
                }
                errors.append(ScanSolution.MarkError(frameId: r.mark.frameId, corner: c, px: px))
            }
        }
        let rms = errors.isEmpty ? 0 : (errors.reduce(0) { $0 + $1.px * $1.px } / Double(errors.count)).squareRoot()
        let worst = errors.map { $0.px }.max() ?? 0

        // The viewer: the mean position of the cameras (each counted once) that have at least one mark used
        let seenIds = Set(rays.flatMap { $0 }.map { $0.mark.frameId })
        let viewer = Vec3.mean(frames.filter { seenIds.contains($0.frameId) }.map { $0.cameraTransform.translation })

        // The rectangle through the four triangulated corners
        var fit: RectangleFit?
        var symDiff = 0.0, planeMaxM = 0.0
        var corners: [Vec3] = []
        if triangulated.allSatisfy({ $0 != nil }) {
            corners = triangulated.compactMap { $0 }
            if let plane = Plane.fit(corners), let v = viewer {
                fit = RectangleFit.fit(ordered: corners, plane: plane, viewer: v)
                planeMaxM = corners.map { plane.distance($0) }.max() ?? 0
            }
        }
        var symFails = false
        if let f = fit {
            func rel(_ x: Double, _ y: Double) -> Double { abs(x - y) / max((x + y) / 2, 1e-9) }
            symDiff = max(rel(f.topIn, f.bottomIn), rel(f.leftIn, f.rightIn))
            func differs(_ x: Double, _ y: Double) -> Bool { abs(x - y) > ScanLimits.symDiffIn || rel(x, y) > ScanLimits.symDiffShare }
            symFails = differs(f.topIn, f.bottomIn) || differs(f.leftIn, f.rightIn)
        }

        // The single-frame estimate: the first regular frame (in the order given) with all four marks, its rays met with the wall plane
        var single: (width: Double, height: Double)?
        if let wall = wall {
            single = singleFrameEstimate(frames: frames, marks: used, wall: wall)
        }
        var scaleDiff = 0.0
        if let f = fit {
            if let s = single, s.width > 0, s.height > 0 {
                scaleDiff = max(abs(f.widthIn - s.width) / s.width, abs(f.heightIn - s.height) / s.height)
            } else {
                // Nothing to check the scale against: it cannot pass
                scaleDiff = 1
            }
        }

        // The gates, in the contract's order
        var failed: [ScanGate] = []
        if counts.contains(where: { $0 < ScanLimits.minMarksPerCorner }) { failed.append(.tooFewFrames) }
        if rms > ScanLimits.reprojRmsPx || worst > ScanLimits.reprojMaxPx { failed.append(.reprojection) }
        if baselines.contains(where: { $0 < ScanLimits.minBaselineDeg }) { failed.append(.baseline) }
        if symFails { failed.append(.symRatio) }
        if planeMaxM > ScanLimits.planeMaxM { failed.append(.plane) }
        if fit != nil, scaleDiff > ScanLimits.scaleShare { failed.append(.scale) }
        // Corners that could not be triangulated at all leave no rectangle: the scan is a review case even if no gate above caught it
        let closeupIds = Set(used.compactMap { m in byId[m.frameId]?.kind == .closeup ? m.frameId : nil })
        if closeupIds.count < ScanLimits.minCloseups { failed.append(.noCloseups) }

        let quality = ScanQuality(framesPerCorner: counts, reprojRmsPx: rms, reprojMaxPx: worst, minBaselineDeg: baselines.min() ?? 0, symRatioDiff: symDiff,
                                  planeMaxCm: planeMaxM * 100, scaleDiff: scaleDiff, closeups: closeupIds.count, failed: failed.map { $0.rawValue })
        return ScanSolution(triangulatedM: triangulated, fit: fit, singleFrameIn: single, markErrors: errors, quality: quality)
    }

    /// The window's size from ONE regular frame: the first one (in `frames` order) with a mark on every corner, each mark's ray met with `wall`
    /// (turned to face that camera), then the level rectangle through the four points. The phone puts the frame its first estimate was made
    /// on first.
    public static func singleFrameEstimate(frames: [ScanFrame], marks: [ScanMark], wall: Plane) -> (width: Double, height: Double)? {
        for f in frames where f.kind == .regular {
            var pts: [Vec3] = []
            for c in 0..<4 {
                guard let m = marks.last(where: { $0.frameId == f.frameId && $0.corner == c }), let r = ray(frame: f, x: m.x, y: m.y),
                      let hit = wall.facing(r.origin).intersect(rayOrigin: r.origin, direction: r.direction) else { break }
                pts.append(hit)
            }
            guard pts.count == 4 else { continue }
            if let fit = RectangleFit.fit(ordered: pts, plane: wall, viewer: f.cameraTransform.translation) { return (fit.widthIn, fit.heightIn) }
        }
        return nil
    }
}

// MARK: - The JSON (strict keys, as the contract spells them)

private struct AnyKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init(_ s: String) { stringValue = s }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
}

public struct ScanFramePayload: Codable, Equatable, Sendable {
    public var frameId: String
    public var kind: ScanFrameKind
    public var corner: Int?
    public var uploadId: String
    public var imageWidth: Int
    public var imageHeight: Int
    public var cameraTransform: [Double]
    public var intrinsics: CameraIntrinsics

    public init(frame f: ScanFrame, uploadId: String) {
        frameId = f.frameId
        kind = f.kind
        corner = f.corner
        self.uploadId = uploadId
        imageWidth = f.imageWidth
        imageHeight = f.imageHeight
        cameraTransform = f.cameraTransform.m
        intrinsics = f.intrinsics
    }

    public init(frameId: String, kind: ScanFrameKind, corner: Int?, uploadId: String, imageWidth: Int, imageHeight: Int, cameraTransform: [Double], intrinsics: CameraIntrinsics) {
        self.frameId = frameId
        self.kind = kind
        self.corner = corner
        self.uploadId = uploadId
        self.imageWidth = imageWidth
        self.imageHeight = imageHeight
        self.cameraTransform = cameraTransform
        self.intrinsics = intrinsics
    }

    /// `corner` is written as an explicit null for a regular frame.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.encode(frameId, forKey: AnyKey("frameId"))
        try c.encode(kind, forKey: AnyKey("kind"))
        if let corner = corner { try c.encode(corner, forKey: AnyKey("corner")) } else { try c.encodeNil(forKey: AnyKey("corner")) }
        try c.encode(uploadId, forKey: AnyKey("uploadId"))
        try c.encode(imageWidth, forKey: AnyKey("imageWidth"))
        try c.encode(imageHeight, forKey: AnyKey("imageHeight"))
        try c.encode(cameraTransform, forKey: AnyKey("cameraTransform"))
        try c.encode(intrinsics, forKey: AnyKey("intrinsics"))
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        frameId = try c.decode(String.self, forKey: AnyKey("frameId"))
        kind = try c.decode(ScanFrameKind.self, forKey: AnyKey("kind"))
        corner = try c.decodeIfPresent(Int.self, forKey: AnyKey("corner"))
        uploadId = try c.decode(String.self, forKey: AnyKey("uploadId"))
        imageWidth = try c.decode(Int.self, forKey: AnyKey("imageWidth"))
        imageHeight = try c.decode(Int.self, forKey: AnyKey("imageHeight"))
        cameraTransform = try c.decode([Double].self, forKey: AnyKey("cameraTransform"))
        intrinsics = try c.decode(CameraIntrinsics.self, forKey: AnyKey("intrinsics"))
    }
}

public struct ScanResultPayload: Codable, Equatable, Sendable {
    public var cornersM: [Vec3]?
    public var widthIn: Double?
    public var heightIn: Double?
    public var windowFrame: WindowFrameSize?
    public var quality: ScanQuality
    public var status: ScanStatus

    public init(cornersM: [Vec3]?, widthIn: Double?, heightIn: Double?, windowFrame: WindowFrameSize?, quality: ScanQuality, status: ScanStatus) {
        self.cornersM = cornersM
        self.widthIn = widthIn
        self.heightIn = heightIn
        self.windowFrame = windowFrame
        self.quality = quality
        self.status = status
    }

    public init(solution s: ScanSolution, windowFrame: WindowFrameSize?) {
        self.init(cornersM: s.cornersM, widthIn: s.widthIn, heightIn: s.heightIn, windowFrame: windowFrame, quality: s.quality, status: s.status)
    }

    /// Nulls are written as nulls (the contract's `| null`).
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        if let v = cornersM { try c.encode(v, forKey: AnyKey("cornersM")) } else { try c.encodeNil(forKey: AnyKey("cornersM")) }
        if let v = widthIn { try c.encode(v, forKey: AnyKey("widthIn")) } else { try c.encodeNil(forKey: AnyKey("widthIn")) }
        if let v = heightIn { try c.encode(v, forKey: AnyKey("heightIn")) } else { try c.encodeNil(forKey: AnyKey("heightIn")) }
        if let v = windowFrame {
            // { widthIn, heightIn, estimated }: `estimated` always present
            try c.encode(ScanWindowFrame(v), forKey: AnyKey("windowFrame"))
        } else {
            try c.encodeNil(forKey: AnyKey("windowFrame"))
        }
        try c.encode(quality, forKey: AnyKey("quality"))
        try c.encode(status, forKey: AnyKey("status"))
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        cornersM = try c.decodeIfPresent([Vec3].self, forKey: AnyKey("cornersM"))
        widthIn = try c.decodeIfPresent(Double.self, forKey: AnyKey("widthIn"))
        heightIn = try c.decodeIfPresent(Double.self, forKey: AnyKey("heightIn"))
        windowFrame = try c.decodeIfPresent(ScanWindowFrame.self, forKey: AnyKey("windowFrame")).map { WindowFrameSize(widthIn: $0.widthIn, heightIn: $0.heightIn, estimated: $0.estimated) }
        quality = try c.decode(ScanQuality.self, forKey: AnyKey("quality"))
        status = try c.decode(ScanStatus.self, forKey: AnyKey("status"))
    }
}

/// The window's own frame as the contract spells it: `estimated` is always there.
public struct ScanWindowFrame: Codable, Equatable, Sendable {
    public var widthIn: Double
    public var heightIn: Double
    public var estimated: Bool

    public init(_ s: WindowFrameSize) {
        widthIn = s.widthIn
        heightIn = s.heightIn
        estimated = s.estimated ?? false
    }
}

public struct ScanWall: Codable, Equatable, Sendable {
    public var point: Vec3
    public var normal: Vec3

    public init(point: Vec3, normal: Vec3) {
        self.point = point
        self.normal = normal
    }

    public init(_ p: Plane) { self.init(point: p.point, normal: p.normal) }
    public var plane: Plane? { Plane(point: point, normal: normal) }
}

/// The body of POST .../requests/:id/scans.
public struct WindowScanPayload: Codable, Equatable, Sendable {
    public var scanId: String
    public var windowId: String
    public var app: String
    public var device: String
    public var wall: ScanWall
    public var frames: [ScanFramePayload]
    public var marks: [ScanMark]
    public var result: ScanResultPayload

    public init(scanId: String, windowId: String, app: String, device: String, wall: ScanWall, frames: [ScanFramePayload], marks: [ScanMark], result: ScanResultPayload) {
        self.scanId = scanId
        self.windowId = windowId
        self.app = app
        self.device = device
        self.wall = wall
        self.frames = frames
        self.marks = marks
        self.result = result
    }

    /// Why this body would be refused by the server's limits (3 to 24 frames, at most 200 marks, marks on known frames), nil when it fits.
    public var problem: String? {
        if frames.count < ScanLimits.minFrames { return "a scan needs at least \(ScanLimits.minFrames) photos" }
        if frames.count > ScanLimits.maxFrames { return "a scan has at most \(ScanLimits.maxFrames) photos" }
        if marks.count > ScanLimits.maxMarks { return "a scan has at most \(ScanLimits.maxMarks) marks" }
        let ids = Set(frames.map { $0.frameId })
        if ids.count != frames.count { return "photo ids repeat" }
        if marks.contains(where: { !ids.contains($0.frameId) || !(0..<4).contains($0.corner) }) { return "a mark is on an unknown photo or corner" }
        if frames.contains(where: { $0.cameraTransform.count != 16 }) { return "a camera pose is not 16 numbers" }
        return nil
    }

    public func json() throws -> Data {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys]
        return try e.encode(self)
    }
}

/// The server's answer to the scan: its own status and result (which wins over the phone's).
public struct WindowScanAnswer: Codable, Equatable, Sendable {
    public var scanId: String
    public var status: String
    public var result: ScanResultPayload?

    public init(scanId: String, status: String, result: ScanResultPayload? = nil) {
        self.scanId = scanId
        self.status = status
        self.result = result
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        scanId = try c.decode(String.self, forKey: AnyKey("scanId"))
        status = try c.decode(String.self, forKey: AnyKey("status"))
        // The result is kept when it reads; a server that words it differently does not fail the scan
        result = try? c.decodeIfPresent(ScanResultPayload.self, forKey: AnyKey("result"))
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.encode(scanId, forKey: AnyKey("scanId"))
        try c.encode(status, forKey: AnyKey("status"))
        try c.encodeIfPresent(result, forKey: AnyKey("result"))
    }
}
