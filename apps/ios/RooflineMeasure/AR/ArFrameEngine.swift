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
    /// The photo taken when the 4th corner was placed (the corners are projected into it), and a counter that goes up with each.
    var shot: FrameCapture.Shot?
    var shotSeq = 0
    var cornersInPhoto = false
    var cornerDots: [CGPoint] = []
    /// The window outline the phone found, TL, TR, BR, BL on screen (empty unless one is offered: found twice in a row, no corner placed).
    var proposalDots: [CGPoint] = []
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
    /// The homeowner app has the phone look for the window and offer its outline; the rep app does not.
    private let autoCorners: Bool
    private let deliver: (ArSnapshot, [UINotificationFeedbackGenerator.FeedbackType]) -> Void

    // Everything below is touched only on `queue`.
    private var snap = ArSnapshot()
    private var sampler = CornerSampler()
    private var samplingDepth: [Vec3] = []
    private var sampling = false
    private var samplingDeadline = Date.distantPast
    private var stillness = StillnessDetector()
    /// The plane anchor the wall plane follows (refined by ARKit): the one under the reticle until the first corner is tapped,
    /// that one afterwards.
    private var wallAnchorId: UUID?
    /// When tracking turned limited (nil while normal): a short limited spell keeps the corners, a long one restarts the window.
    private var limitedSince: Date?
    private var sessionReruns = 0
    private var normalFrames = 0
    private var frameCount = 0
    private var viewport = CGSize.zero
    private var lastViewer = Vec3.zero
    private var haptics: [UINotificationFeedbackGenerator.FeedbackType] = []

    // The proposed window (only with `autoCorners`), also touched only on `queue`.
    private let detector = ArWindowDetector()
    private var tracker = QuadTracker()
    /// Is a look at the camera image running now (one at a time)?
    private var looking = false
    private var lastLookAt = -1.0
    /// Goes up whenever the world may have changed (a restart, tracking lost): a look that started before it is thrown away.
    private var lookGeneration = 0
    /// The depth points around each corner of the latest outline, for the wall check when it is placed.
    private var proposalDepth: [[Vec3]] = [[], [], [], []]
    /// "Use these corners" was tapped: the next frame places them (the photo needs a frame).
    private var useRequested = false
    /// The four corners came from the outline: Undo takes all four back, not one.
    private var placedAsGroup = false

    /// Seconds between looks at the camera image for a window outline.
    static let lookInterval: TimeInterval = 0.3
    /// Seconds a corner may take to sample before it is placed from what it has (or refused with < minSamples samples).
    static let samplingTimeout: TimeInterval = 4
    /// Seconds of limited tracking (without an interruption) the corners survive.
    static let limitedGrace: TimeInterval = 8
    static let pausedMessage = "The camera was paused. Aim at the first corner again."
    /// Re-runs the session with a reset (set by the controller, which owns the configuration).
    var rerun: ((ARSession) -> Void)?

    init(lidar: Bool, device: ArDevice, autoCorners: Bool = false, deliver: @escaping (ArSnapshot, [UINotificationFeedbackGenerator.FeedbackType]) -> Void) {
        self.lidar = lidar
        self.device = device
        self.autoCorners = autoCorners
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
            self.tracker.reset()
            self.publish()
        }
    }

    /// "Use these corners": the outline on screen becomes the four corners, in the next frame.
    func useProposal() {
        queue.async {
            guard self.autoCorners, self.tracker.offered != nil else { return }
            self.useRequested = true
        }
    }

    func undo() {
        queue.async {
            self.cancelSampling()
            if self.placedAsGroup {
                // Four corners that came as one outline go back as one: the outline can be used again, or the corners tapped by hand
                self.snap.capture.startOver()
                self.placedAsGroup = false
            } else {
                self.snap.capture.undo()
            }
            if self.snap.capture.corners.isEmpty { self.wallAnchorId = nil }
            self.clearFinished()
            self.setMessage(nil)
            self.publish()
        }
    }

    func startOver() {
        queue.async {
            self.cancelSampling()
            self.snap.capture.startOver()
            self.placedAsGroup = false
            self.wallAnchorId = nil
            self.clearFinished()
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

    func session(_ session: ARSession, didRemove anchors: [ARAnchor]) {
        // The wall's anchor went (ARKit merged or dropped the plane). Before any corner, the next frame picks the plane under the
        // reticle again. With corners placed the plane stays as it was (the world has not moved) and is just no longer refined.
        guard let id = wallAnchorId, anchors.contains(where: { $0.identifier == id }) else { return }
        wallAnchorId = nil
        if snap.capture.corners.isEmpty && !sampling { snap.capture.setWallPlane(nil, viewer: lastViewer) }
    }

    func sessionWasInterrupted(_ session: ARSession) {
        trackingLost(reason: "The camera was interrupted.")
        publish()
    }

    func sessionInterruptionEnded(_ session: ARSession) {
        // The world is not the same after an interruption: start tracking afresh, with no corners and no wall
        restartSession(session)
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        let code = (error as? ARError)?.code
        // A refused camera, or a phone that cannot do this, will not get better by trying again
        if code == .cameraUnauthorized || code == .unsupportedConfiguration || sessionReruns >= 3 {
            setMessage("AR stopped: \(error.localizedDescription)")
            snap.phase = .lost
            publish()
            return
        }
        sessionReruns += 1
        restartSession(session)
    }

    private func restartSession(_ session: ARSession) {
        cancelSampling()
        snap.capture.resetForNewSession()
        placedAsGroup = false
        resetProposal()
        wallAnchorId = nil
        limitedSince = nil
        normalFrames = 0
        clearFinished()
        snap.aim = nil
        snap.canPlace = false
        snap.phase = .searching
        snap.overlay = ArOverlayState()
        setMessage(Self.pausedMessage)
        haptics.append(.warning)
        rerun?(session)
        publish()
    }

    private func clearFinished() {
        snap.finished = nil
        snap.preview = nil
        snap.shot = nil
        snap.shotSeq += 1
        snap.cornersInPhoto = false
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
                // Before tracking was ever normal it is the camera warming up; after, a brief spell the corners survive
                if snap.capture.hadTracking { limitedReason = "Move the phone slowly side to side." } else { warmingUp = true }
            case .excessiveMotion: limitedReason = "Move the phone more slowly."
            case .insufficientFeatures: limitedReason = "It's too dark or too plain here. Turn on a light."
            @unknown default: limitedReason = "Move the phone slowly side to side."
            }
            if !warmingUp {
                if limitedSince == nil { limitedSince = Date() }
                // A long limited spell (the world may have shifted): the corners cannot be trusted
                if let since = limitedSince, Date().timeIntervalSince(since) > Self.limitedGrace, !snap.capture.corners.isEmpty { lost = true }
            }
        }
        if case .normal = cam.trackingState {
            limitedSince = nil
            normalFrames += 1
            if normalFrames > 90 { sessionReruns = 0 }
        } else {
            normalFrames = 0
        }
        if lost {
            trackingLost(reason: nil)
            publish()
            return
        }
        if warmingUp {
            resetProposal()
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

        // The wall: the vertical plane under the reticle, used as an infinite plane. It follows the reticle until the FIRST corner
        // is tapped (sampling starts then) and is frozen from that tap on; undo to zero or start over lets it go again.
        if snap.capture.corners.isEmpty && !sampling {
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
            if sampler.isFull || Date() >= samplingDeadline { finishSampling(viewer: viewer, frame: frame) }
        }

        // The outline the phone found: placed now when "Use these corners" was tapped
        if autoCorners, useRequested {
            useRequested = false
            applyProposal(viewer: viewer, frame: frame)
        }

        // Phase. No corner can be placed before the wall plane is locked: until then the phase stays "searching".
        let wallLocked = snap.capture.wallPlane != nil
        let next: ArMeasureController.Phase
        if snap.capture.isComplete {
            next = .complete
        } else if sampling {
            next = still && limitedReason == nil ? .sampling : .holdStill
        } else if let r = limitedReason {
            next = .limited(r)
        } else {
            next = (aimNow == nil || !wallLocked) ? .searching : .aiming
        }
        snap.phase = next
        snap.canPlace = canPlaceNow

        if autoCorners { lookForWindow(frame: frame, imageCenter: imageCenter) }
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
        resetProposal()
        if snap.capture.tracking, snap.capture.setTracking(normal: false) {
            cancelSampling()
            placedAsGroup = false
            wallAnchorId = nil
            clearFinished()
            setMessage((reason ?? "Tracking was lost.") + " Start this window again from its first corner.")
            haptics.append(.warning)
        }
        snap.aim = nil
        snap.canPlace = false
        snap.phase = .lost
        updateOverlay()
    }

    private func finishSampling(viewer: Vec3, frame: ARFrame) {
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
            if snap.capture.isComplete { finish(viewer: viewer, frame: frame) }
        case .offWall(let d):
            _ = d
            setMessage("That spot isn't on the window frame. Aim at the frame's corner.")
            haptics.append(.error)
        case .tooCloseToCorner:
            setMessage("That corner is already placed. Aim at the next one.")
            haptics.append(.warning)
        case .alreadyFour:
            break
        }
    }

    /// The 4th corner is down: the size, and the photo of this very frame with the four corners in it (not at Done: the photo
    /// must be the one the corners were placed in, and Done may come after the phone has moved).
    private func finish(viewer: Vec3, frame: ARFrame) {
        snap.finished = snap.capture.finished(viewer: viewer)
        if let f = snap.finished {
            snap.preview = previewArSize(f.pointsM, device: device, cornerSpreadM: f.cornerSpreadM)
            let shot = FrameCapture.shot(frame: frame, points: f.pointsM)
            snap.shot = shot
            snap.shotSeq += 1
            snap.cornersInPhoto = shot?.allInView ?? false
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
        // The outline offered, where it is on this frame (it is fixed on the wall, so it follows the wall as the phone moves)
        if autoCorners, snap.capture.corners.isEmpty, !sampling, let outline = tracker.offered {
            let onScreen = outline.compactMap(screen)
            snap.proposalDots = onScreen.count == 4 ? onScreen : []
        } else {
            snap.proposalDots = []
        }
    }

    // MARK: The proposed window

    /// Forgets the outline and any look in flight (the world may not be where it was).
    private func resetProposal() {
        tracker.reset()
        snap.proposalDots = []
        useRequested = false
        looking = false
        lookGeneration += 1
    }

    /// While the phone is aimed at a wall with no corner placed, about three times a second Vision looks at the camera image (on the
    /// detector's own queue) for the window being aimed at.
    private func lookForWindow(frame: ARFrame, imageCenter: CGPoint) {
        let open = snap.capture.corners.isEmpty && !sampling && snap.phase == .aiming && snap.capture.wallPlane != nil
        guard open else {
            tracker.reset()
            return
        }
        guard !looking, frame.timestamp - lastLookAt >= Self.lookInterval else { return }
        looking = true
        lastLookAt = frame.timestamp
        let depth = frame.smoothedSceneDepth ?? frame.sceneDepth
        let input = ArWindowDetector.Input(pixelBuffer: frame.capturedImage, depthMap: depth?.depthMap, confidenceMap: depth?.confidenceMap,
                                           cameraTransform: Mat4(frame.camera.transform), intrinsics: CameraIntrinsics(frame.camera), reticle: imageCenter)
        let generation = lookGeneration
        detector.look(input) { [weak self] output in
            self?.queue.async {
                guard let self = self, self.lookGeneration == generation else { return }
                self.receiveLook(output)
            }
        }
    }

    /// A look came back (on `queue`): the outline's corners are sent as rays onto the wall (each onto the frame's own plane where the
    /// depth sensor shows the frame stands off the wall), checked for being a window, and kept with the looks before it.
    private func receiveLook(_ output: ArWindowDetector.Output?) {
        looking = false
        guard snap.capture.corners.isEmpty, !sampling, let wall = snap.capture.wallPlane, let output = output else {
            tracker.miss()
            return
        }
        let planes = (0..<4).map { localFramePlane(wall: wall, depthPoints: output.depthPoints[$0], maxOffsetM: CornerCapture.maxOffPlaneM) }
        guard let world = ArAutoCorners.worldQuad(nativePx: output.nativeQuad, cameraTransform: output.cameraTransform, intrinsics: output.intrinsics, planes: planes),
              ArAutoCorners.isPlausibleWindow(world) else {
            tracker.miss()
            return
        }
        tracker.add(world)
        proposalDepth = output.depthPoints
    }

    /// The outline becomes the four corners, through the same `CornerCapture.place` a tap goes through: the wall check, then the
    /// photo of this frame with the corners in it. A refused corner puts them all back: the person taps them.
    private func applyProposal(viewer: Vec3, frame: ARFrame) {
        guard let outline = tracker.offered, snap.capture.corners.isEmpty, !sampling, let wall = snap.capture.wallPlane,
              snap.capture.canPlaceNext(aimed: snap.aim != nil, sampling: false),
              outline.allSatisfy({ wall.distance($0) <= CornerCapture.maxOffPlaneM + 0.02 }) else {
            tracker.reset()
            setMessage("That outline moved. Tap the corners yourself, or aim at the window again.")
            haptics.append(.warning)
            return
        }
        let spreads = tracker.spreadM
        for i in 0..<4 {
            let estimate = CornerEstimate(point: outline[i], spreadM: spreads[i], used: tracker.streak, rejected: 0)
            guard case .placed = snap.capture.place(estimate, depthPoints: proposalDepth[i]) else {
                snap.capture.startOver()
                wallAnchorId = nil
                tracker.reset()
                setMessage("We couldn't line that up on the window. Tap the corners yourself.")
                haptics.append(.error)
                return
            }
        }
        placedAsGroup = true
        tracker.reset()
        haptics.append(.success)
        finish(viewer: viewer, frame: frame)
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
