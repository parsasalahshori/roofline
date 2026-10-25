import ARKit
import Observation
import RooflineCore
import SceneKit
import UIKit

/// One AR corner measure (mirrors the Android WebXR flow in apps/web/src/features/measure/windows/ar/arSession.ts,
/// with the LiDAR rules of the iOS brief):
/// - a centre reticle; once ARKit finds the vertical wall plane, the reticle's ray is intersected with that INFINITE
///   plane (moved onto the frame's face by the LiDAR points around the reticle), since a frame's edges are exactly where
///   plane polygons stop; no corner can be placed before that wall plane is locked;
/// - a tap starts sampling: ~45 positions (about a second) while the phone is held still, outliers dropped, averaged
///   (each corner's block-mean spread is kept and sent as cornerSpreadM);
/// - a tap whose high-confidence depth points within 2 cm are mostly more than 5 cm off the wall is refused (hit through
///   the glass);
/// - tracking lost between corners restarts the window; corners are ordered by gravity, never by tap order;
/// - on save: the current frame's upright JPEG with the corners projected into it, into the outbox.
///
/// Threading: the ARSession delegate runs on a serial background queue (ArFrameEngine), which does all the per-frame
/// work and hands this class plain-value snapshots; this class only holds the published UI state and the SceneKit nodes.
/// No ARFrame is kept past its callback (the loupe is a crop of the camera image, not a snapshot of the view).
@MainActor
@Observable
final class ArMeasureController {
    enum Phase: Equatable {
        case starting
        /// Looking for a surface at the reticle (and for the wall, before any corner can be placed).
        case searching
        case aiming
        /// Collecting samples for a corner (progress 0...1).
        case sampling
        /// Sampling, but the phone is moving.
        case holdStill
        /// Tracking works but is poor (the reason, in words).
        case limited(String)
        case lost
        case complete
    }

    private(set) var phase: Phase = .starting
    /// A one-off message (a refused tap, a restart).
    var message: String?
    private(set) var capture = CornerCapture()
    private(set) var sampleProgress: Double = 0
    private(set) var aim: Vec3?
    private(set) var finished: FinishedCorners?
    private(set) var preview: ArSize?
    /// Every corner is inside the photo that Save would keep.
    private(set) var cornersInPhoto = false
    /// The photo taken when the 4th corner was placed.
    private(set) var shot: FrameCapture.Shot?
    @ObservationIgnored private var lastShotSeq = 0
    private(set) var loupe: UIImage?
    /// The newest frozen frame (Capture), the Capture button was tapped and the phone is waiting for a still hand, and the tracking session
    /// the frame came from (photos of one window combine only within one).
    private(set) var frozen: FrozenCapture?
    private(set) var capturing = false
    private(set) var epoch = 0
    @ObservationIgnored private var lastFrozenSeq = 0
    /// Has ARKit locked the wall plane the window is on?
    private(set) var wallLocked = false
    /// The guided scan (homeowner app): what the camera screen shows, and every photo kept so far.
    private(set) var scanUi = ScanUiState()
    private(set) var scanShots: [ScanShot] = []
    /// The corners placed so far, as screen points of the AR view (for the homeowner app's dots and size plates).
    private(set) var cornerDots: [CGPoint] = []
    /// A length plate for each side drawn so far, at its midpoint on screen.
    private(set) var edgeLabels: [EdgeLabel] = []
    /// A corner may be placed now: tracking normal, wall locked, a surface under the reticle, not already sampling.
    private(set) var canPlace = false

    struct EdgeLabel: Equatable, Identifiable {
        var id: Int
        var point: CGPoint
        /// The side in eighths, e.g. "35 5/8".
        var text: String
        /// The side, inches.
        var inches: Double = 0
        /// The side still running to the crosshair.
        var live: Bool
    }

    let lidar: Bool
    var device: ArDevice { lidar ? .arkitLidar : .arkit }
    let startedAt = Date()

    @ObservationIgnored let sceneView: ArMeasureSceneView
    @ObservationIgnored private let overlay: ArOverlay
    @ObservationIgnored private var engine: ArFrameEngine!
    @ObservationIgnored private let mailbox = ArMailbox()
    @ObservationIgnored private var lastOverlayKey = ""
    @ObservationIgnored private var lastMessageSeq = 0
    @ObservationIgnored private let haptics = UINotificationFeedbackGenerator()

    /// `tapeStyle`: the homeowner app draws corners and sides in tape yellow (Chalk Line's measuring colour).
    init(tapeStyle: Bool = false) {
        lidar = DeviceCaps.hasLiDAR
        overlay = ArOverlay(tapeStyle: tapeStyle)
        sceneView = ArMeasureSceneView(frame: .zero)
        sceneView.automaticallyUpdatesLighting = true
        sceneView.rendersCameraGrain = false
        sceneView.scene.rootNode.addChildNode(overlay.root)
        let mailbox = self.mailbox
        engine = ArFrameEngine(lidar: lidar, device: lidar ? .arkitLidar : .arkit) { [weak self] snapshot, haptics in
            // Called on the engine's queue: keep only the newest snapshot, and wake the main queue once
            guard mailbox.post(snapshot, haptics) else { return }
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.drain() } }
        }
        // The session keeps a weak reference to its delegate: the controller holds the engine. Its callbacks run on the
        // engine's serial background queue, never on main.
        let hasLidar = lidar
        engine.rerun = { session in
            session.run(ArMeasureController.makeConfiguration(lidar: hasLidar), options: [.resetTracking, .removeExistingAnchors])
        }
        engine.scan.wake = { [weak self] in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.drainScan() } }
        }
        sceneView.session.delegateQueue = engine.queue
        sceneView.session.delegate = engine
        sceneView.onLayout = { [weak engine] size in engine?.setViewport(size) }
        engine.setViewport(sceneView.bounds.size)
    }

    // MARK: Session

    nonisolated static func makeConfiguration(lidar: Bool) -> ARWorldTrackingConfiguration {
        let config = ARWorldTrackingConfiguration()
        config.worldAlignment = .gravity // world +Y is up: corners are ordered by it
        config.planeDetection = [.vertical]
        if lidar {
            // Scene depth only: the corners and the off-wall check read depth points, nothing reads a mesh
            config.frameSemantics.insert(.sceneDepth)
            if ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth) { config.frameSemantics.insert(.smoothedSceneDepth) }
        }
        return config
    }

    func start() {
        engine.setViewport(sceneView.bounds.size)
        sceneView.session.run(Self.makeConfiguration(lidar: lidar), options: [.resetTracking, .removeExistingAnchors])
        phase = .searching
    }

    func pause() {
        sceneView.session.pause()
    }

    /// Take the engine's newest snapshot (main actor). Observed properties are only written when they change: SwiftUI
    /// redraws on every write.
    private func drain() {
        guard let (s, feedback) = mailbox.take() else { return }
        for f in feedback { haptics.notificationOccurred(f) }
        if s.messageSeq != lastMessageSeq {
            lastMessageSeq = s.messageSeq
            message = s.message
        }
        if phase != s.phase { phase = s.phase }
        let wall = s.capture.wallPlane != nil
        if wall != wallLocked { wallLocked = wall }
        if capture.corners.count != s.capture.corners.count || capture.trackingLostCount != s.capture.trackingLostCount
            || capture.restartsForTracking != s.capture.restartsForTracking || capture.tracking != s.capture.tracking
            || capture.hadTracking != s.capture.hadTracking || (capture.wallPlane == nil) != (s.capture.wallPlane == nil)
            || capture.corners.last?.point != s.capture.corners.last?.point {
            capture = s.capture
        }
        if canPlace != s.canPlace { canPlace = s.canPlace }
        if sampleProgress != s.sampleProgress { sampleProgress = s.sampleProgress }
        // The shown aim follows to the nearest 2 mm (the samples use the exact value)
        if (s.aim == nil) != (aim == nil) || (s.aim.map { a in aim.map { a.distance(to: $0) > 0.002 } ?? true } ?? false) { aim = s.aim }
        if finished != s.finished { finished = s.finished }
        if preview != s.preview { preview = s.preview }
        if cornersInPhoto != s.cornersInPhoto { cornersInPhoto = s.cornersInPhoto }
        if s.shotSeq != lastShotSeq {
            lastShotSeq = s.shotSeq
            shot = s.shot
        }
        if let l = s.loupe, l !== loupe { loupe = l }
        if capturing != s.capturing { capturing = s.capturing }
        if epoch != s.epoch { epoch = s.epoch }
        if s.frozenSeq != lastFrozenSeq {
            lastFrozenSeq = s.frozenSeq
            frozen = s.frozen
        }
        func moved(_ a: [CGPoint], _ b: [CGPoint]) -> Bool {
            a.count != b.count || zip(a, b).contains { abs($0.x - $1.x) > 0.5 || abs($0.y - $1.y) > 0.5 }
        }
        if moved(s.cornerDots, cornerDots) { cornerDots = s.cornerDots }
        if s.edgeLabels.count != edgeLabels.count
            || zip(s.edgeLabels, edgeLabels).contains(where: { moved([$0.point], [$1.point]) || $0.text != $1.text || $0.live != $1.live }) {
            edgeLabels = s.edgeLabels
        }
        if s.overlay.key != lastOverlayKey {
            lastOverlayKey = s.overlay.key
            overlay.update(corners: s.overlay.corners, aim: s.overlay.aim, wallNormal: s.overlay.wallNormal, closed: s.overlay.closed)
        }
    }

    // MARK: The guided scan

    /// Apple's coaching overlay for finding the wall (before Start); it is taken off for the scan itself, which has its own coaching.
    @ObservationIgnored private var coaching: ARCoachingOverlayView?

    func installCoaching() {
        guard coaching == nil else { return }
        let c = ARCoachingOverlayView(frame: sceneView.bounds)
        c.session = sceneView.session
        c.goal = .verticalPlane
        c.activatesAutomatically = true
        c.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        sceneView.addSubview(c)
        coaching = c
    }

    func removeCoaching() {
        coaching?.activatesAutomatically = false
        coaching?.setActive(false, animated: false)
        coaching?.removeFromSuperview()
        coaching = nil
    }

    private func drainScan() {
        let (state, shots) = engine.scan.box.take()
        if scanUi != state { scanUi = state }
        if !shots.isEmpty { scanShots.append(contentsOf: shots) }
    }

    /// Begin the guided scan: needs the wall locked.
    func startScan() {
        guard wallLocked else { return }
        scanShots = []
        scanUi = ScanUiState(running: true, step: nil, shotCount: 0, interrupted: false, haveWall: true)
        engine.startScan()
    }

    func stopScan() {
        engine.stopScan()
        scanUi.running = false
    }

    /// The window as far as the phone knows it (TL, TR, BR, BL in the world): the scan asks for close-ups of these corners and checks the whole window is in view.
    func scanSetWindow(_ corners: [Vec3]?) {
        let e = engine!
        e.queue.async { e.scan.setWindow(corners) }
    }

    func scanManualShutter() { let e = engine!; e.queue.async { e.scan.requestManual() } }
    func scanFinishSweep() { let e = engine!; e.queue.async { e.scan.requestFinishSweep() } }
    func scanSkipCorner() { let e = engine!; e.queue.async { e.scan.requestSkip() } }

    // MARK: Actions

    /// Start sampling the corner under the reticle.
    func placeCorner() {
        guard canPlace else { return }
        message = nil
        haptics.prepare()
        engine.place()
    }

    /// Freeze the camera frame for the homeowner's measuring: the photo, and what turns its pixels into points on the wall.
    func captureFrozen() {
        guard canPlace, !capturing else { return }
        message = nil
        haptics.prepare()
        engine.captureFrozen()
    }

    func undo() {
        message = nil
        engine.undo()
    }

    func startOver() {
        message = nil
        engine.startOver()
    }

    /// The window to save: the current frame's photo, the corners drawn into it. Nil (with a message) when it cannot.
    func makeWindow(context: MeasureContext, label: String) -> (window: PhotoWindowInput, shot: FrameCapture.Shot, pass: TestPass)? {
        guard let f = finished else {
            message = "Place all four corners first."
            return nil
        }
        guard let shot = shot else {
            message = "The photo could not be made. Start this window again."
            return nil
        }
        let window = PhotoWindowInput(
            id: WindowIds.new(),
            uploadId: nil, // filled in by the outbox once the photo is up
            label: label,
            windowKey: context.windowKey,
            corners: shot.corners,
            scale: .ar(ArScale(pointsM: f.pointsM, trackingLostCount: capture.trackingLostCount, device: device, cornerSpreadM: f.cornerSpreadM))
        )
        let p = preview
        let pass = TestPass(
            measurementId: context.measurementId, windowId: window.id, windowKey: context.windowKey, label: label,
            method: "ar", device: device.rawValue, lidar: lidar, pointsM: f.pointsM, cornerSpreadM: f.cornerSpreadM,
            trackingLostCount: capture.trackingLostCount, restartsForTracking: capture.restartsForTracking,
            wallPlaneLocked: f.usedWallPlane, maxOffPlaneMm: f.maxOffPlaneM * 1000,
            widthIn: p?.widthIn ?? 0, heightIn: p?.heightIn ?? 0,
            uncertaintyWidthIn: p?.uncertaintyWidthIn, uncertaintyHeightIn: p?.uncertaintyHeightIn,
            quality: p?.quality.rawValue ?? "check", reasons: p?.reasons ?? [], durationS: Date().timeIntervalSince(startedAt)
        )
        return (window, shot, pass)
    }

    /// What a finished measure gives any app: its corners and their spreads, the sizing preview, and the photo of the
    /// current frame with the corners projected into it. Nil (with a message) when it cannot be made.
    struct Capture {
        var finished: FinishedCorners
        var shot: FrameCapture.Shot
        var preview: ArSize?
        var trackingLostCount: Int
        var restartsForTracking: Int
        var durationS: Double
    }

    func makeCapture() -> Capture? {
        guard let f = finished else {
            message = "Place all four corners first."
            return nil
        }
        guard let shot = shot else {
            message = "The photo could not be made. Start this window again."
            return nil
        }
        return Capture(finished: f, shot: shot, preview: preview, trackingLostCount: capture.trackingLostCount,
                       restartsForTracking: capture.restartsForTracking, durationS: Date().timeIntervalSince(startedAt))
    }

    /// Width and height as the live readout shows them (the corners placed so far and the crosshair).
    var liveReadout: LiveReadout {
        LiveReadout.from(corners: capture.points, aim: capture.isComplete ? nil : aim, device: device)
    }

    /// The live sides, in eighths (the last one runs to the reticle while aiming).
    var liveSides: [(text: String, toAim: Bool)] {
        capture.liveEdgesIn(aim: capture.isComplete ? nil : aim).map { (Eighths.format($0.inches) + " in", $0.toAim) }
    }
}

/// An ARSCNView that reports its size to the frame engine (the reticle is the centre of the view).
final class ArMeasureSceneView: ARSCNView {
    var onLayout: ((CGSize) -> Void)?
    override func layoutSubviews() {
        super.layoutSubviews()
        onLayout?(bounds.size)
    }
}

/// The newest snapshot from the engine's queue, waiting for the main actor. Haptics queue up (none is dropped).
final class ArMailbox: @unchecked Sendable {
    private let lock = NSLock()
    private var snapshot: ArSnapshot?
    private var feedback: [UINotificationFeedbackGenerator.FeedbackType] = []
    private var scheduled = false

    /// Stores the snapshot; true when the caller must wake the main queue (none is pending yet).
    func post(_ s: ArSnapshot, _ f: [UINotificationFeedbackGenerator.FeedbackType]) -> Bool {
        lock.lock(); defer { lock.unlock() }
        snapshot = s
        feedback.append(contentsOf: f)
        if scheduled { return false }
        scheduled = true
        return true
    }

    func take() -> (ArSnapshot, [UINotificationFeedbackGenerator.FeedbackType])? {
        lock.lock(); defer { lock.unlock() }
        scheduled = false
        guard let s = snapshot else { return nil }
        snapshot = nil
        let f = feedback
        feedback = []
        return (s, f)
    }
}

/// SceneKit nodes for the corners, the sides and the reticle on the wall.
final class ArOverlay {
    let root = SCNNode()
    /// The homeowner app's look: every corner and side in tape yellow (#FFC21F).
    let tapeStyle: Bool
    static let tape = UIColor(red: 1, green: 0.76, blue: 0.12, alpha: 1)

    init(tapeStyle: Bool = false) {
        self.tapeStyle = tapeStyle
    }

    func update(corners: [Vec3], aim: Vec3?, wallNormal: Vec3?, closed: Bool) {
        root.childNodes.forEach { $0.removeFromParentNode() }
        for (i, c) in corners.enumerated() {
            let s = SCNSphere(radius: 0.006)
            s.firstMaterial?.diffuse.contents = tapeStyle ? Self.tape : (i == 0 ? UIColor.systemYellow : UIColor.systemGreen)
            s.firstMaterial?.lightingModel = .constant
            let n = SCNNode(geometry: s)
            n.simdPosition = c.simd
            root.addChildNode(n)
        }
        var path = corners
        if closed, let first = corners.first { path.append(first) }
        if !closed, let a = aim, !corners.isEmpty { path.append(a) }
        if path.count >= 2 {
            for i in 1..<path.count {
                let live = !closed && i == path.count - 1 && aim != nil
                root.addChildNode(Self.segment(from: path[i - 1], to: path[i], color: live ? .white : (tapeStyle ? Self.tape : .systemGreen)))
            }
        }
        if let a = aim {
            let ring = SCNTorus(ringRadius: 0.012, pipeRadius: 0.0015)
            ring.firstMaterial?.diffuse.contents = UIColor.white
            ring.firstMaterial?.lightingModel = .constant
            let n = SCNNode(geometry: ring)
            n.simdPosition = a.simd
            // The torus lies in its local x-z plane: turn its y axis onto the wall's normal
            if let normal = wallNormal {
                n.simdOrientation = simd_quatf(from: simd_float3(0, 1, 0), to: simd_normalize(normal.simd))
            }
            root.addChildNode(n)
        }
    }

    /// A thin cylinder from a to b (SCNCylinder runs along its local y axis).
    static func segment(from a: Vec3, to b: Vec3, color: UIColor) -> SCNNode {
        let d = b - a
        let len = d.length
        let cyl = SCNCylinder(radius: 0.0015, height: CGFloat(max(len, 0.0001)))
        cyl.firstMaterial?.diffuse.contents = color
        cyl.firstMaterial?.lightingModel = .constant
        let n = SCNNode(geometry: cyl)
        n.simdPosition = ((a + b) / 2).simd
        if let dir = d.normalized {
            n.simdOrientation = simd_quatf(from: simd_float3(0, 1, 0), to: dir.simd)
        }
        return n
    }
}
