import ARKit
import Observation
import RooflineCore
import SceneKit
import UIKit

/// One AR corner measure (mirrors the Android WebXR flow in apps/web/src/features/measure/windows/ar/arSession.ts,
/// with the LiDAR rules of the iOS brief):
/// - a centre reticle; once ARKit finds the vertical wall plane, the reticle's ray is intersected with that INFINITE
///   plane (moved onto the frame's face by the LiDAR points around the reticle), since a frame's edges are exactly where
///   plane polygons stop;
/// - a tap starts sampling: ~15 positions while the phone is held still, outliers dropped, averaged (each corner's
///   spread is kept and sent as cornerSpreadM);
/// - a tap whose depth points are mostly more than 5 cm off the wall is refused (hit through the glass);
/// - tracking lost between corners restarts the window; corners are ordered by gravity, never by tap order;
/// - on save: the current frame's upright JPEG with the corners projected into it, into the outbox.
@MainActor
@Observable
final class ArMeasureController {
    enum Phase: Equatable {
        case starting
        /// Looking for a surface at the reticle.
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
    private(set) var loupe: UIImage?
    var wallLocked: Bool { capture.wallPlane != nil }

    let lidar: Bool
    var device: ArDevice { lidar ? .arkitLidar : .arkit }
    let startedAt = Date()

    @ObservationIgnored let sceneView: ARSCNView
    @ObservationIgnored private let overlay = ArOverlay()
    @ObservationIgnored private var sampler = CornerSampler()
    @ObservationIgnored private var samplingDepth: [Vec3] = []
    @ObservationIgnored private var sampling = false
    @ObservationIgnored private var samplingDeadline = Date.distantPast
    @ObservationIgnored private var stillness = StillnessDetector()
    @ObservationIgnored private var wallAnchorId: UUID?
    @ObservationIgnored private var frameCount = 0
    @ObservationIgnored private var lastOverlayKey = ""
    @ObservationIgnored private let haptics = UINotificationFeedbackGenerator()
    @ObservationIgnored private let delegateProxy = ArSessionProxy()

    /// Seconds a corner may take to sample before it is placed from what it has (or refused with < 5 samples).
    static let samplingTimeout: TimeInterval = 4

    init() {
        lidar = DeviceCaps.hasLiDAR
        sceneView = ARSCNView(frame: .zero)
        sceneView.automaticallyUpdatesLighting = true
        sceneView.rendersCameraGrain = false
        sceneView.scene.rootNode.addChildNode(overlay.root)
        // The session keeps a weak reference to its delegate: the controller holds the proxy
        delegateProxy.owner = self
        sceneView.session.delegate = delegateProxy
    }

    // MARK: Session

    func start() {
        let config = ARWorldTrackingConfiguration()
        config.worldAlignment = .gravity // world +Y is up: corners are ordered by it
        config.planeDetection = [.vertical]
        if lidar {
            config.sceneReconstruction = .mesh
            config.frameSemantics.insert(.sceneDepth)
        }
        sceneView.session.run(config, options: [.resetTracking, .removeExistingAnchors])
        phase = .searching
    }

    func pause() {
        sceneView.session.pause()
    }

    fileprivate func anchorsUpdated(_ anchors: [ARAnchor]) {
        // ARKit refines the wall it found: follow it
        guard let id = wallAnchorId, let a = anchors.first(where: { $0.identifier == id }) as? ARPlaneAnchor,
              let plane = Plane(anchor: a), let cam = sceneView.session.currentFrame?.camera else { return }
        capture.setWallPlane(plane, viewer: Vec3(cam.transform.translation))
    }

    fileprivate func interrupted() {
        trackingLost(reason: "The camera was interrupted.")
    }

    fileprivate func failed(_ error: Error) {
        message = "AR stopped: \(error.localizedDescription)"
        phase = .lost
    }

    // MARK: Every frame

    fileprivate func handle(_ frame: ARFrame) {
        frameCount += 1
        let cam = frame.camera
        let viewer = Vec3(cam.transform.translation)

        // Tracking: a real loss restarts the window; poor tracking only blocks placing
        var limitedReason: String?
        var lost = false
        switch cam.trackingState {
        case .normal:
            break
        case .notAvailable:
            lost = true
        case .limited(let reason):
            switch reason {
            case .initializing, .relocalizing: lost = true
            case .excessiveMotion: limitedReason = "Move the phone more slowly."
            case .insufficientFeatures: limitedReason = "Aim at the frame's edge or something with more detail."
            @unknown default: limitedReason = "Tracking is limited."
            }
        }
        if lost {
            trackingLost(reason: nil)
            return
        }
        capture.setTracking(normal: true)

        let forward = -Vec3(simd_float3(cam.transform.columns.2.x, cam.transform.columns.2.y, cam.transform.columns.2.z))
        let still = stillness.update(time: frame.timestamp, position: viewer, forward: forward)

        // The reticle: the centre of the view, as a point of the native image (0...1)
        let bounds = sceneView.bounds
        guard bounds.width > 0, bounds.height > 0 else { return }
        let viewCenter = CGPoint(x: bounds.midX, y: bounds.midY)
        // VERIFY: displayTransform maps normalized image -> normalized view for .portrait; its inverse takes the view's
        // centre back into the native image.
        let imageCenter = CGPoint(x: 0.5, y: 0.5).applying(frame.displayTransform(for: .portrait, viewportSize: bounds.size).inverted())

        // The wall: lock the first vertical plane ARKit reports at the reticle, then use it as an infinite plane
        if capture.wallPlane == nil,
           let q = sceneView.raycastQuery(from: viewCenter, allowing: .existingPlaneInfinite, alignment: .vertical),
           let hit = sceneView.session.raycast(q).first,
           let anchor = hit.anchor as? ARPlaneAnchor, anchor.alignment == .vertical,
           let plane = Plane(anchor: anchor) {
            capture.setWallPlane(plane, viewer: viewer)
            if capture.wallPlane != nil { wallAnchorId = anchor.identifier }
        }

        let depth = lidar ? DepthSampler.points(frame: frame, center: imageCenter) : []
        let estimatedQuery = sceneView.raycastQuery(from: viewCenter, allowing: .estimatedPlane, alignment: .any)
        let rawHit: Vec3? = estimatedQuery.flatMap { sceneView.session.raycast($0).first }.map { Vec3($0.worldTransform.translation) }

        if let wall = capture.wallPlane, let q = estimatedQuery {
            let local = localFramePlane(wall: wall, depthPoints: depth, maxOffsetM: CornerCapture.maxOffPlaneM)
            aim = local.intersect(rayOrigin: Vec3(q.origin), direction: Vec3(q.direction))
        } else {
            aim = rawHit
        }

        if sampling {
            if limitedReason == nil, still, let a = aim {
                sampler.add(a)
                samplingDepth.append(contentsOf: depth.isEmpty ? (rawHit.map { [$0] } ?? []) : depth)
            }
            sampleProgress = sampler.progress
            if sampler.isFull || Date() >= samplingDeadline { finishSampling(viewer: viewer) }
        }

        // Phase
        if capture.isComplete {
            phase = .complete
            if frameCount % 3 == 0 { cornersInPhoto = FrameCapture.projectCorners(finished?.pointsM ?? capture.points, camera: cam).allInView }
        } else if sampling {
            phase = still && limitedReason == nil ? .sampling : .holdStill
        } else if let r = limitedReason {
            phase = .limited(r)
        } else {
            phase = aim == nil ? .searching : .aiming
        }

        updateOverlay(wallNormal: capture.wallPlane?.normal)
        if frameCount % 6 == 0, !capture.isComplete { loupe = makeLoupe() }
    }

    private func trackingLost(reason: String?) {
        if capture.setTracking(normal: false) {
            cancelSampling()
            finished = nil
            preview = nil
            message = (reason ?? "Tracking was lost.") + " Start this window again from its first corner."
            haptics.notificationOccurred(.warning)
        }
        aim = nil
        phase = .lost
        updateOverlay(wallNormal: nil)
    }

    // MARK: Actions

    var canPlace: Bool {
        guard !capture.isComplete, !sampling, aim != nil else { return false }
        switch phase {
        case .aiming: return true
        default: return false
        }
    }

    /// Start sampling the corner under the reticle.
    func placeCorner() {
        guard canPlace else { return }
        message = nil
        sampler.reset()
        samplingDepth = []
        sampleProgress = 0
        sampling = true
        samplingDeadline = Date().addingTimeInterval(Self.samplingTimeout)
        haptics.prepare()
    }

    private func finishSampling(viewer: Vec3) {
        sampling = false
        sampleProgress = 0
        guard let estimate = sampler.estimate() else {
            message = "Hold the phone still on the corner, then tap again."
            haptics.notificationOccurred(.warning)
            return
        }
        switch capture.place(estimate, depthPoints: samplingDepth) {
        case .placed:
            haptics.notificationOccurred(.success)
            if capture.isComplete { finish(viewer: viewer) }
        case .offWall(let d):
            message = "That point is \(Int((d * 100).rounded())) cm off the wall (through the glass?). Aim at the frame itself."
            haptics.notificationOccurred(.error)
        case .tooCloseToCorner:
            message = "That corner is already placed. Aim at the next one."
            haptics.notificationOccurred(.warning)
        case .alreadyFour:
            break
        }
        samplingDepth = []
    }

    private func cancelSampling() {
        sampling = false
        sampleProgress = 0
        sampler.reset()
        samplingDepth = []
    }

    private func finish(viewer: Vec3) {
        finished = capture.finished(viewer: viewer)
        if let f = finished {
            preview = previewArSize(f.pointsM, device: device, cornerSpreadM: f.cornerSpreadM, viewer: viewer)
        } else {
            message = "These four corners do not make a window (in a line, or on a floor). Start over."
        }
    }

    func undo() {
        cancelSampling()
        capture.undo()
        finished = nil
        preview = nil
        message = nil
    }

    func startOver() {
        cancelSampling()
        capture.startOver()
        finished = nil
        preview = nil
        message = nil
    }

    /// The window to save: the current frame's photo, the corners drawn into it. Nil (with a message) when it cannot.
    func makeWindow(context: MeasureContext, label: String) -> (window: PhotoWindowInput, shot: FrameCapture.Shot, pass: TestPass)? {
        guard let f = finished, let frame = sceneView.session.currentFrame else {
            message = "Place all four corners first."
            return nil
        }
        guard let shot = FrameCapture.shot(frame: frame, points: f.pointsM) else {
            message = "The photo could not be made. Try Save again."
            return nil
        }
        let window = PhotoWindowInput(
            id: WindowIds.new(),
            uploadId: "",
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

    /// The live sides, in eighths (the last one runs to the reticle while aiming).
    var liveSides: [(text: String, toAim: Bool)] {
        capture.liveEdgesIn(aim: capture.isComplete ? nil : aim).map { (Eighths.format($0.inches) + " in", $0.toAim) }
    }

    // MARK: Drawing

    private func updateOverlay(wallNormal: Vec3?) {
        let mm: (Vec3) -> String = { "\(Int($0.x * 500)),\(Int($0.y * 500)),\(Int($0.z * 500))" }
        let key = (capture.points.map(mm) + [aim.map(mm) ?? "-", sampling ? "s" : "", capture.isComplete ? "c" : ""]).joined(separator: "|")
        guard key != lastOverlayKey else { return }
        lastOverlayKey = key
        overlay.update(corners: finished?.pointsM ?? capture.points, aim: capture.isComplete ? nil : aim, wallNormal: wallNormal, closed: capture.isComplete)
    }

    /// The camera picture around the reticle, magnified (the corner under the crosshair).
    private func makeLoupe() -> UIImage? {
        // VERIFY: ARSCNView.snapshot() is fast enough at ~10 Hz on the target phones (else drop the loupe rate).
        let snap = sceneView.snapshot()
        guard let cg = snap.cgImage else { return nil }
        let side = CGFloat(min(cg.width, cg.height)) * 0.18
        let rect = CGRect(x: CGFloat(cg.width) / 2 - side / 2, y: CGFloat(cg.height) / 2 - side / 2, width: side, height: side)
        guard let crop = cg.cropping(to: rect) else { return nil }
        return UIImage(cgImage: crop, scale: snap.scale, orientation: snap.imageOrientation)
    }
}

/// ARSession's delegate (an NSObject, nonisolated): hands every callback to the controller on the main actor.
/// The session calls back on the main queue because no delegateQueue is set.
final class ArSessionProxy: NSObject, ARSessionDelegate {
    weak var owner: ArMeasureController?

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        MainActor.assumeIsolated { owner?.handle(frame) }
    }

    func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
        MainActor.assumeIsolated { owner?.anchorsUpdated(anchors) }
    }

    func sessionWasInterrupted(_ session: ARSession) {
        MainActor.assumeIsolated { owner?.interrupted() }
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        MainActor.assumeIsolated { owner?.failed(error) }
    }
}

/// SceneKit nodes for the corners, the sides and the reticle on the wall.
final class ArOverlay {
    let root = SCNNode()

    func update(corners: [Vec3], aim: Vec3?, wallNormal: Vec3?, closed: Bool) {
        root.childNodes.forEach { $0.removeFromParentNode() }
        for (i, c) in corners.enumerated() {
            let s = SCNSphere(radius: 0.006)
            s.firstMaterial?.diffuse.contents = i == 0 ? UIColor.systemYellow : UIColor.systemGreen
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
                root.addChildNode(Self.segment(from: path[i - 1], to: path[i], color: !closed && i == path.count - 1 && aim != nil ? .white : .systemGreen))
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
