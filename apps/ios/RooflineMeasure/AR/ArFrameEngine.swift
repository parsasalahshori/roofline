import ARKit
import CoreImage
import RooflineCore
import UIKit

/// What the frame engine hands the main actor after a frame (or an action): everything the screens draw. Plain values:
/// no ARFrame, no pixel buffer ever leaves the engine's queue.
struct ArSnapshot {
    var phase: ArMeasureController.Phase = .starting
    var capture = CornerCapture()
    var canPlace = false
    var sampleProgress: Double = 0
    var aim: Vec3?
    var finished: FinishedCorners?
    var preview: ArSize?
    var cornersInPhoto = false
    var cornerDots: [CGPoint] = []
    var edgeLabels: [ArMeasureController.EdgeLabel] = []
    var overlay = ArOverlayState()
    var loupe: UIImage?
    /// The one-off message and a counter that goes up each time the engine sets it (even to nil).
    var message: String?
    var messageSeq = 0
}

struct ArOverlayState {
    var corners: [Vec3] = []
    var aim: Vec3?
    var wallNormal: Vec3?
    var closed = false
    var key = ""
}

/// Turns the ARSession's frames into corners, off the main thread. The session's delegateQueue is `queue` (serial,
/// background), every callback and every action runs on it, and a frame is used only inside its own callback: nothing
/// here keeps an ARFrame (or its pixel buffers) after the callback returns, so ARKit's "delegate is retaining ARFrames"
/// warning cannot happen. The main actor gets plain-value snapshots through `deliver` (coalesced: at most one pending).
final class ArFrameEngine: NSObject, ARSessionDelegate {
    let queue = DispatchQueue(label: "com.winchoice.ar.frames", qos: .userInitiated)
    private let lidar: Bool
    private let device: ArDevice
    private let deliver: (ArSnapshot, [UINotificationFeedbackGenerator.FeedbackType]) -> Void

    // Everything below is touched only on `queue`.
    private var snap = ArSnapshot()
    private var sampler = CornerSampler()
    private var samplingDepth: [Vec3] = []
    private var sampling = false
    private var samplingDeadline = Date.distantPast
    private var stillness = StillnessDetector()
    private var wallAnchorId: UUID?
    private var frameCount = 0
    private var viewport = CGSize.zero
    private var lastViewer = Vec3.zero
    private var haptics: [UINotificationFeedbackGenerator.FeedbackType] = []

    /// Seconds a corner may take to sample before it is placed from what it has (or refused with < minSamples samples).
    static let samplingTimeout: TimeInterval = 4

    init(lidar: Bool, device: ArDevice, deliver: @escaping (ArSnapshot, [UINotificationFeedbackGenerator.FeedbackType]) -> Void) {
        self.lidar = lidar
        self.device = device
        self.deliver = deliver
        super.init()
    }

    // MARK: Actions (from the main actor)

    func setViewport(_ size: CGSize) {
        queue.async { self.viewport = size }
    }

    func place() {
        queue.async {
            guard self.canPlaceNow else { return }
            self.setMessage(nil)
            self.sampler.reset()
            self.samplingDepth = []
            self.snap.sampleProgress = 0
            self.sampling = true
            self.samplingDeadline = Date().addingTimeInterval(Self.samplingTimeout)
            self.snap.canPlace = false
            self.publish()
        }
    }

    func undo() {
        queue.async {
            self.cancelSampling()
            self.snap.capture.undo()
            self.snap.finished = nil
            self.snap.preview = nil
            self.setMessage(nil)
            self.publish()
        }
    }

    func startOver() {
        queue.async {
            self.cancelSampling()
            self.snap.capture.startOver()
            self.snap.finished = nil
            self.snap.preview = nil
            self.setMessage(nil)
            self.publish()
        }
    }

    // MARK: ARSessionDelegate (on `queue`)

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        handle(frame, session: session)
    }

    func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
        // ARKit refines the wall it found: follow it
        guard let id = wallAnchorId, let a = anchors.first(where: { $0.identifier == id }) as? ARPlaneAnchor,
              let plane = Plane(anchor: a) else { return }
        snap.capture.setWallPlane(plane, viewer: lastViewer)
    }

    func sessionWasInterrupted(_ session: ARSession) {
        trackingLost(reason: "The camera was interrupted.")
        publish()
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        setMessage("AR stopped: \(error.localizedDescription)")
        snap.phase = .lost
        publish()
    }

    // MARK: Every frame

    private func handle(_ frame: ARFrame, session: ARSession) {
        frameCount += 1
        let cam = frame.camera
        let viewer = Vec3(cam.transform.translation)
        lastViewer = viewer

        // Tracking: a real loss restarts the window; poor tracking only blocks placing. Before tracking has been normal
        // once, "initializing" is just the camera warming up: it says "searching", never "Tracking was lost".
        var limitedReason: String?
        var lost = false
        var warmingUp = false
        switch cam.trackingState {
        case .normal:
            break
        case .notAvailable:
            if snap.capture.hadTracking { lost = true } else { warmingUp = true }
        case .limited(let reason):
            switch reason {
            case .initializing, .relocalizing:
                if snap.capture.hadTracking { lost = true } else { warmingUp = true }
            case .excessiveMotion: limitedReason = "Move the phone more slowly."
            case .insufficientFeatures: limitedReason = "Aim at the frame's edge or something with more detail."
            @unknown default: limitedReason = "Tracking is limited."
            }
        }
        if lost {
            trackingLost(reason: nil)
            publish()
            return
        }
        if warmingUp {
            snap.aim = nil
            snap.canPlace = false
            snap.phase = .searching
            snap.overlay = ArOverlayState()
            publish()
            return
        }
        if !snap.capture.tracking { snap.capture.setTracking(normal: true) }

        let forward = -Vec3(simd_float3(cam.transform.columns.2.x, cam.transform.columns.2.y, cam.transform.columns.2.z))
        let still = stillness.update(time: frame.timestamp, position: viewer, forward: forward)

        guard viewport.width > 0, viewport.height > 0 else { return }
        // The reticle: the centre of the view, as a point of the native image (0...1).
        // Checked (ARFrame.h): displayTransform converts normalized captured-image points to normalized view points;
        // its inverse takes the view's centre back into the native image.
        let imageCenter = CGPoint(x: 0.5, y: 0.5).applying(frame.displayTransform(for: .portrait, viewportSize: viewport).inverted())

        // The wall: lock the first vertical plane ARKit reports at the reticle, then use it as an infinite plane
        if snap.capture.wallPlane == nil {
            let q = frame.raycastQuery(from: imageCenter, allowing: .existingPlaneInfinite, alignment: .vertical)
            if let hit = session.raycast(q).first, let anchor = hit.anchor as? ARPlaneAnchor, anchor.alignment == .vertical,
               let plane = Plane(anchor: anchor) {
                snap.capture.setWallPlane(plane, viewer: viewer)
                if snap.capture.wallPlane != nil { wallAnchorId = anchor.identifier }
            }
        }

        let depth = lidar ? DepthSampler.points(frame: frame, center: imageCenter) : []
        let estimatedQuery = frame.raycastQuery(from: imageCenter, allowing: .estimatedPlane, alignment: .any)
        let rawHit: Vec3? = session.raycast(estimatedQuery).first.map { Vec3($0.worldTransform.translation) }

        let aimNow: Vec3?
        if let wall = snap.capture.wallPlane {
            let local = localFramePlane(wall: wall, depthPoints: depth, maxOffsetM: CornerCapture.maxOffPlaneM)
            aimNow = local.intersect(rayOrigin: Vec3(estimatedQuery.origin), direction: Vec3(estimatedQuery.direction))
        } else {
            aimNow = rawHit
        }
        snap.aim = aimNow

        if sampling {
            if limitedReason == nil, still, let a = aimNow {
                sampler.add(a)
                samplingDepth.append(contentsOf: depth.isEmpty ? (rawHit.map { [$0] } ?? []) : depth)
            }
            snap.sampleProgress = sampler.progress
            if sampler.isFull || Date() >= samplingDeadline { finishSampling(viewer: viewer) }
        }

        // Phase. No corner can be placed before the wall plane is locked: until then the phase stays "searching".
        let wallLocked = snap.capture.wallPlane != nil
        let next: ArMeasureController.Phase
        if snap.capture.isComplete {
            next = .complete
            if frameCount % 3 == 0 {
                snap.cornersInPhoto = FrameCapture.projectCorners(snap.finished?.pointsM ?? snap.capture.points, camera: cam).allInView
            }
        } else if sampling {
            next = still && limitedReason == nil ? .sampling : .holdStill
        } else if let r = limitedReason {
            next = .limited(r)
        } else {
            next = (aimNow == nil || !wallLocked) ? .searching : .aiming
        }
        snap.phase = next
        snap.canPlace = canPlaceNow

        updateOverlay()
        updateScreenMarks(camera: cam)
        if frameCount % 6 == 0, !snap.capture.isComplete {
            snap.loupe = ArLoupe.image(pixelBuffer: frame.capturedImage, center: imageCenter)
        }
        publish()
    }

    private var canPlaceNow: Bool {
        snap.phase == .aiming && snap.capture.canPlaceNext(aimed: snap.aim != nil, sampling: sampling)
    }

    private func trackingLost(reason: String?) {
        // Once per loss (while lost, every frame lands here): count it, and restart a window in progress
        if snap.capture.tracking, snap.capture.setTracking(normal: false) {
            cancelSampling()
            snap.finished = nil
            snap.preview = nil
            setMessage((reason ?? "Tracking was lost.") + " Start this window again from its first corner.")
            haptics.append(.warning)
        }
        snap.aim = nil
        snap.canPlace = false
        snap.phase = .lost
        updateOverlay()
    }

    private func finishSampling(viewer: Vec3) {
        sampling = false
        snap.sampleProgress = 0
        defer { samplingDepth = [] }
        guard let estimate = sampler.estimate() else {
            setMessage("Hold the phone still on the corner, then tap again.")
            haptics.append(.warning)
            return
        }
        switch snap.capture.place(estimate, depthPoints: samplingDepth) {
        case .placed:
            haptics.append(.success)
            if snap.capture.isComplete { finish(viewer: viewer) }
        case .offWall(let d):
            setMessage("That point is \(Int((d * 100).rounded())) cm off the wall (through the glass?). Aim at the frame itself.")
            haptics.append(.error)
        case .tooCloseToCorner:
            setMessage("That corner is already placed. Aim at the next one.")
            haptics.append(.warning)
        case .alreadyFour:
            break
        }
    }

    private func finish(viewer: Vec3) {
        snap.finished = snap.capture.finished(viewer: viewer)
        if let f = snap.finished {
            snap.preview = previewArSize(f.pointsM, device: device, cornerSpreadM: f.cornerSpreadM)
        } else {
            setMessage("These four corners do not make a window (in a line, or on a floor). Start over.")
        }
    }

    private func cancelSampling() {
        sampling = false
        snap.sampleProgress = 0
        sampler.reset()
        samplingDepth = []
    }

    private func setMessage(_ m: String?) {
        snap.message = m
        snap.messageSeq += 1
    }

    // MARK: Screen marks and drawing state

    private func updateOverlay() {
        let normal = snap.capture.wallPlane?.normal
        let mm: (Vec3) -> String = { "\(Int($0.x * 500)),\(Int($0.y * 500)),\(Int($0.z * 500))" }
        let key = (snap.capture.points.map(mm) + [snap.aim.map(mm) ?? "-", sampling ? "s" : "", snap.capture.isComplete ? "c" : ""]).joined(separator: "|")
        guard key != snap.overlay.key else { return }
        snap.overlay = ArOverlayState(corners: snap.finished?.pointsM ?? snap.capture.points, aim: snap.capture.isComplete ? nil : snap.aim,
                                      wallNormal: normal, closed: snap.capture.isComplete, key: key)
    }

    /// Where the placed corners and the middle of each side are on screen (camera maths, no UIKit: runs off the main thread).
    private func updateScreenMarks(camera: ARCamera) {
        func screen(_ p: Vec3) -> CGPoint? {
            // In front of the camera: camera space looks down -z
            let local = camera.transform.inverse * simd_float4(Float(p.x), Float(p.y), Float(p.z), 1)
            guard local.z < -0.01 else { return nil }
            return camera.projectPoint(simd_float3(Float(p.x), Float(p.y), Float(p.z)), orientation: .portrait, viewportSize: viewport)
        }
        let points = snap.finished?.pointsM ?? snap.capture.points
        let dots = points.compactMap(screen)
        var labels: [ArMeasureController.EdgeLabel] = []
        var pairs: [(Vec3, Vec3, Bool)] = []
        if points.count >= 2 { for i in 1..<points.count { pairs.append((points[i - 1], points[i], false)) } }
        if points.count == 4 {
            pairs.append((points[3], points[0], false))
        } else if let a = snap.aim, let last = points.last {
            pairs.append((last, a, true))
        }
        for (i, pr) in pairs.enumerated() {
            guard let mid = screen((pr.0 + pr.1) / 2) else { continue }
            let inches = pr.0.distance(to: pr.1) * inchesPerMetre
            labels.append(ArMeasureController.EdgeLabel(id: i, point: mid, text: Eighths.format(inches), inches: inches, live: pr.2))
        }
        snap.cornerDots = dots
        snap.edgeLabels = labels
    }

    // MARK: Out to the main actor

    private func publish() {
        let h = haptics
        haptics = []
        deliver(snap, h)
    }
}

/// The magnified picture around the reticle: a native-resolution crop of the camera frame (not a screenshot of the view),
/// rendered with a shared CIContext on the engine's queue.
enum ArLoupe {
    /// `center`: the reticle in the native image, 0...1 from the top-left (as ARFrame.displayTransform reports it).
    static func image(pixelBuffer: CVPixelBuffer, center: CGPoint) -> UIImage? {
        let full = CIImage(cvPixelBuffer: pixelBuffer)
        let w = full.extent.width, h = full.extent.height
        let side = min(w, h) * 0.16
        // CIImage's origin is bottom-left; the normalized image point's is top-left
        let rect = CGRect(x: center.x * w - side / 2, y: (1 - center.y) * h - side / 2, width: side, height: side).intersection(full.extent)
        guard !rect.isEmpty else { return nil }
        // The phone is held upright: the sensor image is turned 90 degrees clockwise (as FrameCapture.uprightJPEG does)
        let crop = full.cropped(to: rect).oriented(.right)
        guard let cg = FrameCapture.context.createCGImage(crop, from: crop.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
