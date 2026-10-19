import ARKit
import RoomPlan
import RooflineCore
import SwiftUI

// Checked (iOS 26.5 SDK RoomPlan.swiftinterface): RoomCaptureSession is not actor-isolated (RoomCaptureView is
// @MainActor). @MainActor here is not required but harmless: every caller is a view.
@MainActor
enum RoomScanSupport {
    /// RoomPlan needs LiDAR.
    static var isSupported: Bool { RoomCaptureSession.isSupported }
}

/// Hosts RoomPlan's own capture view.
struct RoomCaptureContainer: UIViewRepresentable {
    let view: RoomCaptureView
    func makeUIView(context: Context) -> RoomCaptureView { view }
    func updateUIView(_ uiView: RoomCaptureView, context: Context) {}
}

/// Drives one RoomPlan scan and keeps photos to go with what it finds.
@MainActor
@Observable
final class RoomScanner {
    enum Phase: Equatable {
        case scanning, processing, review
        case failed(String)
    }

    struct Found: Identifiable {
        var id: UUID
        var isDoor: Bool
        var widthM: Double
        var heightM: Double
        var confidence: RoomPlanConfidence
        /// World corners TL, TR, BR, BL.
        var corners: [Vec3]
        var include: Bool
        var label: String
        var keyframe: Int?
        var thumbnail: UIImage?
    }

    /// A photo kept during the scan, with the camera that took it (to draw any window into it later).
    struct Keyframe {
        var jpeg: Data
        var widthPx: Int
        var heightPx: Int
        var cameraTransform: Mat4
        /// For the native (landscape) image.
        var intrinsics: CameraIntrinsics
    }

    private(set) var phase: Phase = .scanning
    var found: [Found] = []
    /// The room's walls and where its windows and doors are (for drawing it), once the scan is processed.
    private(set) var plan: ScanPlan?
    /// Seconds the scan took (shown as "Scanned in 41 seconds").
    private(set) var scanSeconds = 0

    @ObservationIgnored let captureView: RoomCaptureView
    @ObservationIgnored private let delegate = RoomCaptureDelegate()
    @ObservationIgnored private var store = KeyframeStore<Keyframe>(capacity: RoomScanner.maxKeyframes)
    private var keyframes: [Keyframe] { store.payloads }
    /// The phone's pose at the last timer tick, to tell how steadily it is held (the photo's score).
    @ObservationIgnored private var lastSample: (pose: Mat4, time: TimeInterval)?
    @ObservationIgnored private var watchdog: Timer?
    @ObservationIgnored private var untrackedSince: Date?
    @ObservationIgnored private var observers: [NSObjectProtocol] = []
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var lastKey: Mat4?
    @ObservationIgnored private let encodeQueue = DispatchQueue(label: "roomscan.keyframes", qos: .utility)
    @ObservationIgnored private var encoding = false
    @ObservationIgnored private var started = false
    let startedAt = Date()

    static let maxKeyframes = 60
    /// "Building your room…" for longer than this is a failed scan.
    static let processingLimit: TimeInterval = 30
    static let failedText = "The scan didn't finish. Try again, a little more slowly, with every window in view."

    init() {
        captureView = RoomCaptureView(frame: .zero)
        delegate.owner = self
        captureView.delegate = delegate
    }

    func start() {
        guard !started else { return }
        started = true
        captureView.captureSession.run(configuration: RoomCaptureSession.Configuration())
        // Keyframes: a photo whenever the phone has moved or turned enough since the last one
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.maybeKeyframe() }
        }
        // The phone going to the background mid-scan ends it: say so, and offer another go
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.fail("The scan was interrupted.") }
        })
    }

    /// The scan cannot go on (an error, an interruption, or processing that never ends): a failed state the screen can act on.
    func fail(_ why: String? = nil) {
        guard phase == .scanning || phase == .processing else { return }
        timer?.invalidate()
        timer = nil
        watchdog?.invalidate()
        watchdog = nil
        captureView.captureSession.stop()
        phase = .failed(why.map { $0 + " Try again, a little more slowly, with every window in view." } ?? Self.failedText)
    }

    private func clearObservers() {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers = []
        watchdog?.invalidate()
        watchdog = nil
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        // At least one photo to go with what was found (a very short scan may have kept none yet)
        if keyframes.isEmpty, let frame = captureView.captureSession.arSession.currentFrame,
           let e = FrameCapture.uprightJPEG(frame.capturedImage, quality: 0.85) {
            store.add(Keyframe(jpeg: e.0, widthPx: e.1, heightPx: e.2, cameraTransform: Mat4(frame.camera.transform), intrinsics: CameraIntrinsics(frame.camera)), score: 1)
        }
        phase = .processing
        captureView.captureSession.stop()
        watchdog?.invalidate()
        watchdog = Timer.scheduledTimer(withTimeInterval: Self.processingLimit, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.fail() }
        }
    }

    func cancel() {
        timer?.invalidate()
        timer = nil
        clearObservers()
        captureView.captureSession.stop()
    }

    private func maybeKeyframe() {
        // Checked (SDK): RoomCaptureSession has `public var arSession: ARSession`, the session the scan runs on.
        // ON DEVICE: that CapturedRoom surface transforms are in this session's world space (Apple's iOS 17 multi-room
        // API relies on it); a wrong frame would show as corners drawn off the window in the saved photo.
        guard phase == .scanning, let frame = captureView.captureSession.arSession.currentFrame else { return }
        // Tracking gone for ten seconds: the scan is not going to work
        if case .notAvailable = frame.camera.trackingState {
            if untrackedSince == nil { untrackedSince = Date() }
            if let since = untrackedSince, Date().timeIntervalSince(since) > 10 { fail("The camera lost track of the room.") }
        } else {
            untrackedSince = nil
        }
        let t = Mat4(frame.camera.transform)
        // How steadily the phone is held now (between ticks): a steady phone makes a sharper photo, which scores higher
        var score = 1.0
        if let prev = lastSample {
            let dt = max(0.05, frame.timestamp - prev.time)
            let turned = acos(max(-1, min(1, t.column(2).dot(prev.pose.column(2))))) * 180 / .pi
            score = KeyframeStore<Keyframe>.score(metresPerSecond: t.translation.distance(to: prev.pose.translation) / dt, degreesPerSecond: turned / dt)
        }
        lastSample = (t, frame.timestamp)
        guard !encoding, case .normal = frame.camera.trackingState else { return }
        if let last = lastKey {
            let moved = t.translation.distance(to: last.translation)
            let turned = acos(max(-1, min(1, t.column(2).dot(last.column(2))))) * 180 / .pi
            guard moved > 0.4 || turned > 20 else { return }
        }
        lastKey = t
        // Read-only hand-off to the encoder queue (CVPixelBuffer is not Sendable; ARKit does not reuse it while held)
        nonisolated(unsafe) let pixels = frame.capturedImage
        let k = CameraIntrinsics(frame.camera)
        encoding = true
        encodeQueue.async { [weak self] in
            let encoded = FrameCapture.uprightJPEG(pixels, quality: 0.85)
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self = self else { return }
                    self.encoding = false
                    if let e = encoded {
                        // Full: the new photo replaces the lowest-scoring one when it is steadier (else it is not kept)
                        self.store.add(Keyframe(jpeg: e.0, widthPx: e.1, heightPx: e.2, cameraTransform: t, intrinsics: k), score: score)
                    }
                }
            }
        }
    }

    fileprivate func presented(_ room: CapturedRoom?, error: Error?) {
        // Already given up on (the watchdog or an interruption): a late answer does not bring the review back
        guard phase == .processing else { return }
        watchdog?.invalidate()
        watchdog = nil
        guard let room = room, error == nil else {
            phase = .failed("The scan could not be finished: \(error?.localizedDescription ?? "no room was captured"). Try again, more slowly.")
            return
        }
        var list: [Found] = []
        let surfaces = room.windows.map { ($0, false) } + room.doors.map { ($0, true) }
        var n = 0
        for (s, isDoor) in surfaces {
            let w = Double(s.dimensions.x), h = Double(s.dimensions.y)
            guard w > 0.1, h > 0.1 else { continue }
            let t = Mat4(s.transform)
            // Seen from inside the room: the room's centre side (the camera path's middle is a fair viewer)
            let viewer = keyframes.isEmpty ? nil : Vec3.mean(keyframes.map { $0.cameraTransform.translation })
            let corners = RoomPlanMath.corners(transform: t, widthM: w, heightM: h, viewer: viewer)
            let conf = Self.confidence(s.confidence)
            let best = bestKeyframe(for: corners)
            if !isDoor { n += 1 }
            list.append(Found(
                id: s.identifier, isDoor: isDoor, widthM: w, heightM: h, confidence: conf,
                corners: corners, include: !isDoor, label: isDoor ? "Door" : "Scan window \(n)",
                keyframe: best, thumbnail: best.flatMap { thumbnail(keyframes[$0].jpeg) }
            ))
        }
        found = list
        plan = Self.plan(of: room)
        scanSeconds = Int(Date().timeIntervalSince(startedAt).rounded())
        clearObservers()
        phase = .review
    }

    /// The room from above: each wall as a segment on the floor, each window and door as a segment along its wall.
    private static func plan(of room: CapturedRoom) -> ScanPlan {
        func segment(_ s: CapturedRoom.Surface) -> ScanPlan.Segment {
            let t = Mat4(s.transform)
            let c = t.translation
            let dir = t.column(0)
            let half = Double(s.dimensions.x) / 2
            return ScanPlan.Segment(ax: c.x - dir.x * half, ay: c.z - dir.z * half, bx: c.x + dir.x * half, by: c.z + dir.z * half)
        }
        let floorY = room.walls.map { Mat4($0.transform).translation.y - Double($0.dimensions.y) / 2 }.min() ?? 0
        let height = room.walls.map { Double($0.dimensions.y) }.max() ?? 2.4
        let openings = (room.windows.map { ($0, false) } + room.doors.map { ($0, true) }).map { s, isDoor -> ScanPlan.Opening in
            let cy = Mat4(s.transform).translation.y
            return ScanPlan.Opening(id: s.identifier, isDoor: isDoor, segment: segment(s), sill: cy - Double(s.dimensions.y) / 2 - floorY, head: cy + Double(s.dimensions.y) / 2 - floorY)
        }
        return ScanPlan(walls: room.walls.map(segment), openings: openings, wallHeight: height)
    }

    private static func confidence(_ c: CapturedRoom.Confidence) -> RoomPlanConfidence {
        switch c {
        case .high: return .high
        case .medium: return .medium
        case .low: return .low
        @unknown default: return .low
        }
    }

    private func bestKeyframe(for corners: [Vec3]) -> Int? {
        var best: (Int, Double)?
        for (i, k) in keyframes.enumerated() {
            let score = RoomPlanMath.viewScore(corners: corners, cameraTransform: k.cameraTransform, intrinsics: k.intrinsics)
            if score > 0, score > (best?.1 ?? 0) { best = (i, score) }
        }
        return best?.0 ?? (keyframes.isEmpty ? nil : keyframes.count - 1)
    }

    private func thumbnail(_ jpeg: Data) -> UIImage? {
        guard let img = UIImage(data: jpeg) else { return nil }
        return img.preparingThumbnail(of: CGSize(width: 160, height: 160 * img.size.height / max(1, img.size.width)))
    }

    /// The photo from the scan that saw this window best, with its four corners drawn into it (TL, TR, BR, BL, in the
    /// photo's pixels); nil when no kept photo saw all four corners (corners are never made up).
    func keyframePhoto(for f: Found) -> (jpeg: Data, widthPx: Int, heightPx: Int, corners: [Vec2])? {
        guard let ki = f.keyframe, ki < keyframes.count else { return nil }
        let k = keyframes[ki]
        let w = Double(k.widthPx), h = Double(k.heightPx)
        let projected = f.corners.compactMap { ImageMapping.project($0, cameraTransform: k.cameraTransform, intrinsics: k.intrinsics) }
            .map { ImageMapping.nativeToPortrait($0, nativeWidth: k.intrinsics.width, nativeHeight: k.intrinsics.height) }
        guard projected.count == 4, projected.allSatisfy({ ImageMapping.isInside($0, width: w, height: h) }) else { return nil }
        return (k.jpeg, k.widthPx, k.heightPx, projected.map { ImageMapping.clamp($0, width: w, height: h) })
    }

    func makeWindow(_ f: Found, context: MeasureContext) -> (window: PhotoWindowInput, jpeg: Data?, widthPx: Int, heightPx: Int, pass: TestPass)? {
        var jpeg: Data?
        var corners: [Vec2]?
        var widthPx = 0, heightPx = 0
        if let shot = keyframePhoto(for: f) {
            corners = shot.corners
            jpeg = shot.jpeg
            widthPx = shot.widthPx
            heightPx = shot.heightPx
        }
        let label = f.label.trimmingCharacters(in: .whitespaces).isEmpty ? (f.isDoor ? "Door" : "Scan window") : f.label
        let window = PhotoWindowInput(
            id: WindowIds.new(), uploadId: nil, label: label, windowKey: WindowIds.new(), corners: corners,
            scale: .roomplan(RoomPlanScale(widthM: f.widthM, heightM: f.heightM, confidence: f.confidence))
        )
        let pass = TestPass(
            measurementId: context.measurementId, windowId: window.id, windowKey: window.windowKey, label: label,
            method: "roomplan", device: "roomplan", lidar: true, pointsM: f.corners, cornerSpreadM: nil,
            trackingLostCount: 0, restartsForTracking: 0, wallPlaneLocked: false, maxOffPlaneMm: nil,
            widthIn: f.widthM * inchesPerMetre, heightIn: f.heightM * inchesPerMetre,
            uncertaintyWidthIn: RoomPlanLimits.uncertaintyIn(f.confidence), uncertaintyHeightIn: RoomPlanLimits.uncertaintyIn(f.confidence),
            quality: "check", reasons: ["room scan (RoomPlan confidence \(f.confidence.rawValue))"], durationS: Date().timeIntervalSince(startedAt)
        )
        return (window, jpeg, widthPx, heightPx, pass)
    }
}

/// RoomCaptureView's delegate. The protocol inherits NSCoding, so it needs the coder members.
final class RoomCaptureDelegate: NSObject, RoomCaptureViewDelegate {
    weak var owner: RoomScanner?

    override init() { super.init() }

    required init?(coder: NSCoder) { super.init() }

    func encode(with coder: NSCoder) {}

    /// Let RoomPlan process what was scanned (it then shows its model and calls didPresent).
    func captureView(shouldPresent roomDataForProcessing: CapturedRoomData, error: Error?) -> Bool {
        if error != nil {
            DispatchQueue.main.async { [weak self] in MainActor.assumeIsolated { self?.owner?.fail("The scan stopped.") } }
            return false
        }
        return true
    }

    func captureView(didPresent processedResult: CapturedRoom, error: Error?) {
        // RoomCaptureViewDelegate is not annotated @MainActor in the SDK, so do not assume the main thread: hop if needed
        if Thread.isMainThread {
            MainActor.assumeIsolated { owner?.presented(processedResult, error: error) }
        } else {
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated { self?.owner?.presented(processedResult, error: error) }
            }
        }
    }
}
