import ARKit
import Observation
import RooflineCore
import UIKit

// The camera side of the room-scan hybrid (pan, then close-ups, then Measure and check).
//
// ONE ARSession from the pan to the last close-up. It is made here and handed to RoomPlan's capture view (`RoomCaptureView(frame:arSession:)`).
// Apple's Done calls `stop(pauseARSession: false)`, so the session goes on tracking in the SAME world: the pan photos, Apple's window positions
// and every close-up taken afterwards share one coordinate system, with no registration step. RoomPlan owns the session's delegate, so this
// class reads `ARSession.currentFrame` on a timer instead (20 times a second, on its own queue) and feeds:
//   * during the pan: `PanRecorder`, which keeps the regular photos any window wants (rules: `PanFrameKeeper`, one `ScanGuide` per window);
//   * during a window's close-ups: `ScanRecorder` started at the close-ups, exactly the guided scan's close-up step;
//   * always: `WorldWatch`, which notices when the world moved (the session restarted), so photos of two worlds are never combined.

/// A regular photo kept during the pan because a window wanted it. Plain values (no ARFrame); only the native JPEG is kept (the upright copy is
/// made for the few photos a window uses).
struct PanFrame: Identifiable {
    let id: Int
    var time: Double
    var nativeJPEG: Data
    var nativeWidth: Int
    var nativeHeight: Int
    var cameraTransform: Mat4
    var intrinsics: CameraIntrinsics
    /// The LiDAR depth, when the session gave it (RoomPlan's configuration decides).
    var depth: FrozenDepth?
    var sharpness: Double

    var meta: PanFrameMeta { PanFrameMeta(id: id, time: time, cameraTransform: cameraTransform, intrinsics: intrinsics, sharpness: sharpness) }
}

/// Reads the newest `ARFrame` of a session on a timer. The handler runs on `queue`, once per new frame, and keeps nothing past its call.
final class ArFramePoller: @unchecked Sendable {
    let queue = DispatchQueue(label: "com.winchoice.hybrid.frames", qos: .userInitiated)
    private var timer: DispatchSourceTimer?
    private var lastTimestamp = -1.0
    /// Set before `start`; runs on `queue`.
    var handler: ((ARFrame) -> Void)?

    func start(session: ARSession, hz: Double = 20) {
        stop()
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now(), repeating: 1.0 / hz, leeway: .milliseconds(5))
        t.setEventHandler { [weak self, weak session] in
            guard let self = self, let frame = session?.currentFrame, frame.timestamp != self.lastTimestamp else { return }
            self.lastTimestamp = frame.timestamp
            self.handler?(frame)
        }
        timer = t
        t.resume()
    }

    func stop() {
        timer?.cancel()
        timer = nil
    }
}

/// Keeps the regular photos of the pan. All the per-frame work is on the poller's queue; `setWindows`, `count` and `take` are safe from any thread.
final class PanRecorder: @unchecked Sendable {
    /// All photos of all windows: more than this are not kept (memory).
    static let maxFrames = 120

    private let lock = NSLock()
    private var windows: [PanFrameKeeper.Window] = []
    private var frames: [PanFrame] = []
    private var nextId = 0
    // (touched only on the poller's queue)
    private var keeper = PanFrameKeeper()
    private var frameIndex = 0
    private var stats: (luma: Double, sharp: Double)?

    /// The windows RoomPlan is showing now, with their corners in the session's world.
    func setWindows(_ w: [PanFrameKeeper.Window]) {
        lock.lock(); windows = w; lock.unlock()
    }

    var count: Int {
        lock.lock(); defer { lock.unlock() }
        return frames.count
    }

    /// Everything kept so far.
    func take() -> [PanFrame] {
        lock.lock(); defer { lock.unlock() }
        return frames
    }

    func reset() {
        lock.lock()
        frames = []
        windows = []
        nextId = 0
        lock.unlock()
        keeper = PanFrameKeeper()
        frameIndex = 0
        stats = nil
    }

    /// One frame, on the poller's queue.
    func process(_ frame: ARFrame) {
        frameIndex += 1
        if frameIndex % 2 == 0 || stats == nil { stats = ScanImageStats.measure(frame.capturedImage) }
        let cam = frame.camera
        let o = ScanObservation(time: frame.timestamp, cameraTransform: Mat4(cam.transform), intrinsics: CameraIntrinsics(cam), tracking: ScanRecorder.tracking(of: cam.trackingState),
                                meanLuma: stats?.luma, sharpness: stats?.sharp)
        lock.lock()
        let current = windows
        let full = frames.count >= Self.maxFrames
        lock.unlock()
        let wanted = keeper.update(o, windows: current)
        guard !wanted.isEmpty, !full, let native = FrameCapture.nativeJPEG(frame.capturedImage, quality: 0.85) else { return }
        let depth = FrozenDepth(frame: frame)
        lock.lock()
        frames.append(PanFrame(id: nextId, time: frame.timestamp, nativeJPEG: native.0, nativeWidth: native.1, nativeHeight: native.2, cameraTransform: o.cameraTransform,
                               intrinsics: o.intrinsics, depth: depth, sharpness: stats?.sharp ?? 0))
        nextId += 1
        lock.unlock()
    }
}

/// Routes each polled frame (on the poller's queue): to the pan's recorder, to a window's close-up recorder, and always to the world watch.
/// What the main actor sets (the mode, the wall) and reads (the epoch) is behind a lock; everything else is touched only on the poller's queue.
private final class HybridRouter: @unchecked Sendable {
    enum Mode { case idle, pan, closeups }

    let pan = PanRecorder()
    let closeups = ScanRecorder()
    /// Called on the poller's queue when the world moved.
    var onWorldMoved: (() -> Void)?

    private let lock = NSLock()
    private var mode = Mode.idle
    private var wall: Plane?
    private var bumps = 0
    private var watchEpoch = 0
    // (queue only)
    private var watch = WorldWatch()

    func set(_ m: Mode, wall w: Plane? = nil) {
        lock.lock(); mode = m; wall = w; lock.unlock()
    }

    /// The app left the screen: counts like a jump of the world.
    func bump() {
        lock.lock(); bumps += 1; lock.unlock()
    }

    /// How many times the world is known to have moved since `reset`.
    var epoch: Int {
        lock.lock(); defer { lock.unlock() }
        return bumps + watchEpoch
    }

    /// A new flow: the watch starts again (call before the poller starts).
    func reset() {
        lock.lock(); mode = .idle; wall = nil; bumps = 0; watchEpoch = 0; lock.unlock()
        watch = WorldWatch()
        pan.reset()
    }

    func handle(_ frame: ARFrame) {
        let cam = frame.camera
        let moved = watch.update(time: frame.timestamp, cameraTransform: Mat4(cam.transform), tracking: ScanRecorder.tracking(of: cam.trackingState))
        lock.lock()
        watchEpoch = watch.epoch
        let (m, w, e) = (mode, wall, bumps + watchEpoch)
        lock.unlock()
        if moved { onWorldMoved?() }
        switch m {
        case .idle: break
        case .pan: pan.process(frame)
        case .closeups: closeups.process(frame: frame, wall: w, epoch: e, lidar: true)
        }
    }
}

/// The hybrid's camera: the shared AR session, the pan's photos, a window's close-ups, and whether the world moved.
@MainActor
@Observable
final class RoomHybridCamera {
    let arSession = ARSession()
    /// Pan photos kept so far (for the pan screen's count).
    private(set) var panCount = 0
    /// The world moved since the pan began (the AR session restarted or tracking was lost for good): further close-ups cannot be lined up with the pan.
    private(set) var worldMoved = false
    /// The open window's close-up step: what the camera screen shows, and each photo kept.
    private(set) var closeupUi = ScanUiState()
    private(set) var closeupShots: [ScanShot] = []

    @ObservationIgnored private let poller = ArFramePoller()
    @ObservationIgnored private let router = HybridRouter()
    @ObservationIgnored private var observers: [NSObjectProtocol] = []
    @ObservationIgnored private var _sceneView: ArMeasureSceneView?
    @ObservationIgnored private var running = false

    var pan: PanRecorder { router.pan }

    init() {
        let router = self.router
        router.closeups.wake = { [weak self] in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.drainCloseups() } }
        }
        router.onWorldMoved = { [weak self] in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.refreshWorld() } }
        }
        poller.handler = { frame in router.handle(frame) }
    }

    // MARK: Pan

    /// RoomPlan's scan has started on `arSession`: watch the world and keep the pan's photos.
    func beginPan() {
        guard !running else { return }
        running = true
        router.reset()
        panCount = 0
        worldMoved = false
        router.set(.pan)
        poller.start(session: arSession)
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            // The camera is interrupted in the background and ARKit does not bring the old world back by itself: no more close-ups are lined up with the pan
            MainActor.assumeIsolated { self?.noteBackgrounded() }
        })
    }

    /// The windows RoomPlan is showing, for the photos worth keeping. Called on every live update.
    func setLiveWindows(_ list: [(id: UUID, corners: [Vec3])]) {
        pan.setWindows(list.map { PanFrameKeeper.Window(id: $0.id.uuidString, cornersM: $0.corners) })
        let n = pan.count
        if n != panCount { panCount = n }
    }

    /// Apple's Done: the pan's photos stop; the session goes on (watched).
    func endPan() {
        router.set(.idle)
        panCount = pan.count
    }

    private func noteBackgrounded() {
        guard running else { return }
        router.bump()
        refreshWorld()
    }

    // MARK: The session

    /// Makes sure the session is still delivering frames (RoomPlan or the system may have paused it); resumes it WITHOUT a reset, so the world is kept
    /// when ARKit can find its way back. Cheap when it is running.
    func ensureRunning() {
        if let f = arSession.currentFrame, abs(ProcessInfo.processInfo.systemUptime - f.timestamp) < 1.5 { return }
        if let c = arSession.configuration {
            arSession.run(c, options: [])
        } else {
            let c = ARWorldTrackingConfiguration()
            c.worldAlignment = .gravity
            arSession.run(c, options: [])
        }
    }

    /// The flow is over (saved, left, or failed): the camera stops.
    func shutDown() {
        poller.stop()
        router.set(.idle)
        let r = router.closeups
        poller.queue.async { r.stop() }
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers = []
        arSession.pause()
        running = false
    }

    // MARK: Close-ups of one window

    /// The ARSCNView that shows the shared session while a window's close-ups are taken.
    func sceneView() -> ARSCNView {
        if let v = _sceneView { return v }
        let v = ArMeasureSceneView(frame: .zero)
        v.session = arSession
        v.automaticallyUpdatesLighting = false
        v.rendersCameraGrain = false
        _sceneView = v
        return v
    }

    /// Start (or restart) the close-ups of a window: the guide asks for its four corners in turn, from the first frame.
    func beginCloseups(corners: [Vec3], wall: Plane) {
        ensureRunning()
        closeupShots = []
        closeupUi = ScanUiState(running: true, step: nil, shotCount: 0, interrupted: false, haveWall: true)
        let r = router.closeups
        let epoch = router.epoch
        router.set(.closeups, wall: wall)
        poller.queue.async {
            r.start(epoch: epoch, closeupsOnly: true)
            r.setWindow(corners)
        }
    }

    /// Done with the open window's close-ups.
    func endCloseups() {
        router.set(.idle)
        let r = router.closeups
        poller.queue.async { r.stop() }
        closeupUi.running = false
    }

    func manualShutter() { let r = router.closeups; poller.queue.async { r.requestManual() } }
    func skipCorner() { let r = router.closeups; poller.queue.async { r.requestSkip() } }

    private func drainCloseups() {
        let (state, shots) = router.closeups.box.take()
        if closeupUi != state { closeupUi = state }
        if !shots.isEmpty { closeupShots.append(contentsOf: shots) }
    }

    private func refreshWorld() {
        let moved = router.epoch != 0
        if worldMoved != moved { worldMoved = moved }
    }
}
