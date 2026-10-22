import Foundation

// The DEBUG dump of one Capture, so a bad proposal on a real phone can be replayed on a Mac. After each Capture the Debug and TestFlight
// builds send the server (dev-only route, off unless the server has DEBUG_CAPTURES_DIR) everything the proposal was made from: the full-size
// photo, the depth map and its confidence, the lens, the camera's pose, the wall plane and the photo's size; and, when the person taps
// "Use this size", what the AI said, which source the proposal came from, the rectangle proposed and the rectangle used. This file is the
// format, so the phone, the tests and the Mac replay (RooflineReplay) cannot drift apart. One folder per capture id:
//
//   capture.json      Meta (below)
//   photo.jpg         the upright photo, full size
//   depth.f32         the depth map, metres, little-endian Float32, row-major, width x height from capture.json (0 = no reading)
//   confidence.u8     ARConfidenceLevel per depth pixel, UInt8 (absent when the frame had none)
//   result.json       Result (below), written when the person uses the size

public enum DebugCapture {
    public static let version = 1
    public static let metaFile = "capture.json"
    public static let photoFile = "photo.jpg"
    public static let depthFile = "depth.f32"
    public static let confidenceFile = "confidence.u8"
    public static let resultFile = "result.json"
    public static let allFiles = [metaFile, photoFile, depthFile, confidenceFile, resultFile]

    public struct Meta: Codable, Equatable, Sendable {
        public var version: Int
        public var captureId: String
        /// ISO 8601.
        public var createdAt: String
        public var app: String?
        public var device: String?
        public var photoWidthPx: Double
        public var photoHeightPx: Double
        public var jpegBytes: Int
        public var intrinsics: CameraIntrinsics
        public var cameraTransform: Mat4
        public var wall: Plane
        public var depthWidth: Int
        public var depthHeight: Int
        public var hasConfidence: Bool
        public var epoch: Int
        public var trackingLostCount: Int
        public var restartsForTracking: Int

        public init(captureId: String, createdAt: String, app: String? = nil, device: String? = nil, view: FrozenView, jpegBytes: Int, epoch: Int = 0,
                    trackingLostCount: Int = 0, restartsForTracking: Int = 0) {
            version = DebugCapture.version
            self.captureId = captureId
            self.createdAt = createdAt
            self.app = app
            self.device = device
            photoWidthPx = view.photoWidthPx
            photoHeightPx = view.photoHeightPx
            self.jpegBytes = jpegBytes
            intrinsics = view.intrinsics
            cameraTransform = view.cameraTransform
            wall = view.wall
            depthWidth = view.depth?.width ?? 0
            depthHeight = view.depth?.height ?? 0
            hasConfidence = !(view.depth?.confidence.isEmpty ?? true)
            self.epoch = epoch
            self.trackingLostCount = trackingLostCount
            self.restartsForTracking = restartsForTracking
        }
    }

    /// A rectangle on the frame's plane, as the phone held it, with what it comes to.
    public struct Rect: Codable, Equatable, Sendable {
        public var plane: Plane
        public var left: Double
        public var right: Double
        public var top: Double
        public var bottom: Double
        public var widthIn: Double
        public var heightIn: Double
        /// TL, TR, BR, BL in the photo's pixels.
        public var photoCorners: [[Double]]

        public init(_ r: FrozenRect, view: FrozenView) {
            plane = r.plane
            left = r.left
            right = r.right
            top = r.top
            bottom = r.bottom
            widthIn = r.widthM * inchesPerMetre
            heightIn = r.heightM * inchesPerMetre
            photoCorners = r.cornersM.compactMap { view.photoPixel(ofWorld: $0) }.map { [$0.x, $0.y] }
        }

        /// The rectangle again (the plane's axes come from gravity, so they are the same).
        public func frozenRect(viewer: Vec3) -> FrozenRect? {
            FrozenRect(plane: plane, viewer: viewer, left: left, right: right, top: top, bottom: bottom)
        }
    }

    /// What happened to the capture afterwards, written when the person uses the size (and earlier, with only `ai`).
    public struct Result: Codable, Equatable, Sendable {
        public var version: Int
        public var captureId: String
        /// ai-quad, ai, ai+depth, depth, vision, none (nothing found: the inset rectangle), manual (the person's own, from the start).
        public var source: String
        public var ai: AiAttempt?
        /// The rectangle the editor started from, and the one the person used.
        public var proposed: Rect?
        public var final: Rect?
        /// What the depth sensor alone made (`OpeningFinder`), when it found a window.
        public var depthFound: Rect?
        public var usedAt: String?
        /// False when the person had started dragging before the proposal came, so it was not put on the screen (`proposed` is what it would have been).
        public var applied: Bool?

        public init(captureId: String, source: String, ai: AiAttempt?, proposed: Rect?, final: Rect?, depthFound: Rect? = nil, usedAt: String? = nil, applied: Bool? = nil) {
            version = DebugCapture.version
            self.captureId = captureId
            self.source = source
            self.ai = ai
            self.proposed = proposed
            self.final = final
            self.depthFound = depthFound
            self.usedAt = usedAt
            self.applied = applied
        }
    }

    /// JSON the way the files are written: sorted keys, indented (a person reads them).
    public static func encode<T: Encodable>(_ value: T) throws -> Data {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try e.encode(value)
    }

    public struct DecodeError: Error, Equatable, CustomStringConvertible {
        public var description: String
    }

    // MARK: Depth as bytes

    /// The depth in metres as little-endian Float32.
    public static func encodeDepth(_ depth: FrozenDepth) -> Data {
        var data = Data(capacity: depth.depthM.count * 4)
        for v in depth.depthM {
            var bits = v.bitPattern.littleEndian
            withUnsafeBytes(of: &bits) { data.append(contentsOf: $0) }
        }
        return data
    }

    public static func decodeDepth(_ data: Data, width: Int, height: Int, confidence: Data?) throws -> FrozenDepth {
        guard width > 0, height > 0, data.count == width * height * 4 else { throw DecodeError(description: "depth.f32 is \(data.count) bytes, not \(width * height * 4)") }
        var values = [Float](repeating: 0, count: width * height)
        let bytes = [UInt8](data)
        for i in 0..<values.count {
            let bits = UInt32(bytes[i * 4]) | UInt32(bytes[i * 4 + 1]) << 8 | UInt32(bytes[i * 4 + 2]) << 16 | UInt32(bytes[i * 4 + 3]) << 24
            values[i] = Float(bitPattern: bits)
        }
        var conf: [UInt8] = []
        if let c = confidence {
            guard c.count == width * height else { throw DecodeError(description: "confidence.u8 is \(c.count) bytes, not \(width * height)") }
            conf = [UInt8](c)
        }
        return FrozenDepth(width: width, height: height, depthM: values, confidence: conf)
    }

    // MARK: A whole capture

    /// Everything about one Capture that the proposal was made from, as the phone sends it and the Mac reads it.
    public struct Bundle: Equatable, Sendable {
        public var meta: Meta
        public var jpeg: Data
        public var depth: FrozenDepth?
        public var result: Result?

        public init(meta: Meta, jpeg: Data, depth: FrozenDepth?, result: Result? = nil) {
            self.meta = meta
            self.jpeg = jpeg
            self.depth = depth
            self.result = result
        }

        /// The frozen view the proposal was made on.
        public var view: FrozenView {
            FrozenView(cameraTransform: meta.cameraTransform, intrinsics: meta.intrinsics, wall: meta.wall, depth: depth, photoWidthPx: meta.photoWidthPx, photoHeightPx: meta.photoHeightPx)
        }


        /// The files to send after the Capture, by name: capture.json, photo.jpg, depth.f32, confidence.u8 (the last two only with depth).
        public func captureFiles() throws -> [(name: String, data: Data)] {
            var out: [(String, Data)] = [(DebugCapture.metaFile, try DebugCapture.encode(meta)), (DebugCapture.photoFile, jpeg)]
            if let d = depth, d.isValid {
                out.append((DebugCapture.depthFile, DebugCapture.encodeDepth(d)))
                if !d.confidence.isEmpty { out.append((DebugCapture.confidenceFile, Data(d.confidence))) }
            }
            return out
        }

        /// The file to send when the person uses the size.
        public func resultFile() throws -> (name: String, data: Data)? {
            try result.map { (DebugCapture.resultFile, try DebugCapture.encode($0)) }
        }

        /// A capture from its files by name (what a folder holds).
        public init(files: [String: Data]) throws {
            guard let metaData = files[DebugCapture.metaFile], let jpeg = files[DebugCapture.photoFile] else { throw DecodeError(description: "a capture needs capture.json and photo.jpg") }
            let meta = try JSONDecoder().decode(Meta.self, from: metaData)
            guard meta.version == DebugCapture.version else { throw DecodeError(description: "capture.json is version \(meta.version), this reads \(DebugCapture.version)") }
            var depth: FrozenDepth?
            if meta.depthWidth > 0, let d = files[DebugCapture.depthFile] {
                depth = try DebugCapture.decodeDepth(d, width: meta.depthWidth, height: meta.depthHeight, confidence: meta.hasConfidence ? files[DebugCapture.confidenceFile] : nil)
            }
            self.meta = meta
            self.jpeg = jpeg
            self.depth = depth
            result = try files[DebugCapture.resultFile].map { try JSONDecoder().decode(Result.self, from: $0) }
        }

        /// Writes the capture into `folder` (made if needed).
        public func write(to folder: URL) throws {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            for (name, data) in try captureFiles() + (resultFile().map { [$0] } ?? []) { try data.write(to: folder.appendingPathComponent(name), options: .atomic) }
        }

        /// A capture from a folder the server wrote (or `write(to:)` did).
        public static func read(from folder: URL) throws -> Bundle {
            var files: [String: Data] = [:]
            for name in DebugCapture.allFiles {
                let url = folder.appendingPathComponent(name)
                if FileManager.default.fileExists(atPath: url.path) { files[name] = try Data(contentsOf: url) }
            }
            return try Bundle(files: files)
        }
    }
}
