import ARKit
import RooflineCore

/// What the guided scan's camera screen shows, as plain values (the recorder fills it in on the engine's queue; the main actor reads it).
struct ScanUiState: Equatable {
    var running = false
    var step: ScanStep?
    /// Photos kept so far (goes up with each; the screen taps the haptic on it).
    var shotCount = 0
    /// Tracking was lost or the session restarted during the scan: the photos are not in one world any more.
    var interrupted = false
    /// The wall is locked: the scan can start.
    var haveWall = false
}

/// The hand-over from the engine's queue to the main actor: the newest state, and every photo kept since the last look (none is dropped).
final class ScanBox: @unchecked Sendable {
    private let lock = NSLock()
    private var state = ScanUiState()
    private var shots: [ScanShot] = []
    private var scheduled = false

    /// True when the caller must wake the main queue (nothing was pending).
    func post(_ s: ScanUiState, newShots: [ScanShot]) -> Bool {
        lock.lock(); defer { lock.unlock() }
        state = s
        shots.append(contentsOf: newShots)
        if scheduled { return false }
        scheduled = true
        return true
    }

    func take() -> (ScanUiState, [ScanShot]) {
        lock.lock(); defer { lock.unlock() }
        scheduled = false
        let out = (state, shots)
        shots = []
        return out
    }
}

/// The guided scan's recorder. The frame engine hands it every ARFrame while a scan runs (on the engine's queue, like everything else there);
/// it asks `ScanGuide` what to do with the frame, keeps the frames that count (native JPEG for upload, upright JPEG for the screens and the
/// corner finders, the camera's pose and lens, the wall and, for a regular photo, the LiDAR depth), and posts what the screen shows.
/// Nothing here holds an ARFrame past its callback. All state is touched only on the engine's queue.
final class ScanRecorder: @unchecked Sendable {
    let box = ScanBox()
    /// Called on the engine's queue after something was posted (the controller wakes the main queue).
    var wake: (() -> Void)?

    private(set) var isRunning = false
    private var guide = ScanGuide()
    private var windowCorners: [Vec3]?
    private var counter = 0
    private var epochAtStart = 0
    private var interrupted = false
    private var frameIndex = 0
    private var stats: (luma: Double, sharp: Double)?
    private var manualRequested = false
    private var finishRequested = false
    private var skipRequested = false
    private var state = ScanUiState()

    // MARK: Actions (call on the engine's queue)

    func start(epoch: Int) {
        guide = ScanGuide()
        windowCorners = nil
        counter = 0
        epochAtStart = epoch
        interrupted = false
        frameIndex = 0
        stats = nil
        manualRequested = false
        finishRequested = false
        skipRequested = false
        state = ScanUiState(running: true, step: nil, shotCount: 0, interrupted: false, haveWall: true)
        isRunning = true
        post(newShots: [])
    }

    func stop() {
        isRunning = false
        state.running = false
        post(newShots: [])
    }

    func setWindow(_ corners: [Vec3]?) { windowCorners = corners?.count == 4 ? corners : nil }
    func requestManual() { manualRequested = true }
    func requestFinishSweep() { finishRequested = true }
    func requestSkip() { skipRequested = true }

    // MARK: Per frame

    func process(frame: ARFrame, wall: Plane?, epoch: Int, lidar: Bool) {
        guard isRunning else { return }
        if epoch != epochAtStart { interrupted = true }
        frameIndex += 1
        if frameIndex % 2 == 0 || stats == nil { stats = ScanImageStats.measure(frame.capturedImage) }
        let cam = frame.camera
        var tracking: ScanObservation.Tracking
        switch cam.trackingState {
        case .normal: tracking = .normal
        case .notAvailable: tracking = .unavailable
        case .limited(let reason):
            switch reason {
            case .excessiveMotion: tracking = .excessiveMotion
            case .insufficientFeatures: tracking = .insufficientFeatures
            default: tracking = .limited
            }
        }
        // (A scan cannot start before the wall is locked, but it is not lost if ARKit drops the plane: the world has not moved.)
        let o = ScanObservation(time: frame.timestamp, cameraTransform: Mat4(cam.transform), intrinsics: CameraIntrinsics(cam), tracking: tracking,
                                meanLuma: stats?.luma, sharpness: stats?.sharp, windowCornersM: windowCorners)
        if interrupted {
            state.interrupted = true
            post(newShots: [])
            return
        }
        if finishRequested {
            finishRequested = false
            _ = guide.finishSweep(at: frame.timestamp)
        }
        if skipRequested {
            skipRequested = false
            guide.skipCorner(at: frame.timestamp)
        }
        var step = guide.update(o)
        if manualRequested {
            manualRequested = false
            if step.keep == nil, let k = guide.manualKeep(o) {
                step.keep = k
                step.regularKept = guide.regularKept
                step.closeupsKept = guide.closeupTaken
                step.closeupsDone = guide.closeupsDone
            }
        }
        var shots: [ScanShot] = []
        if let keep = step.keep, let wall = wall, let shot = capture(frame, keep: keep, wall: wall, lidar: lidar) {
            shots.append(shot)
            state.shotCount += 1
        }
        state.step = step
        post(newShots: shots)
    }

    private func capture(_ frame: ARFrame, keep: ScanKeep, wall: Plane, lidar: Bool) -> ScanShot? {
        guard let up = FrameCapture.uprightJPEG(frame.capturedImage, quality: 0.85), let native = FrameCapture.nativeJPEG(frame.capturedImage, quality: 0.85) else { return nil }
        counter += 1
        let depth = (lidar && keep.kind == .regular) ? FrozenDepth(frame: frame) : nil
        let view = FrozenView(cameraTransform: Mat4(frame.camera.transform), intrinsics: CameraIntrinsics(frame.camera), wall: wall, depth: depth,
                              photoWidthPx: Double(up.1), photoHeightPx: Double(up.2))
        return ScanShot(id: "f\(counter)", kind: keep.kind, corner: keep.corner, nativeJPEG: native.0, uprightJPEG: up.0, nativeWidth: native.1, nativeHeight: native.2, view: view)
    }

    private func post(newShots: [ScanShot]) {
        if box.post(state, newShots: newShots) { wake?() }
    }
}

/// How bright and how sharp the middle of the camera's picture is, from its grey (luma) plane. Cheap enough for every other frame.
enum ScanImageStats {
    /// `luma`: the mean grey, 0 ... 255. `sharp`: the variance of the Laplacian over the picture's middle (the larger, the sharper;
    /// only compared between frames of one scan).
    static func measure(_ pixelBuffer: CVPixelBuffer) -> (luma: Double, sharp: Double)? {
        guard CVPixelBufferGetPlaneCount(pixelBuffer) >= 1 else { return nil }
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0) else { return nil }
        let w = CVPixelBufferGetWidthOfPlane(pixelBuffer, 0), h = CVPixelBufferGetHeightOfPlane(pixelBuffer, 0)
        let rowBytes = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)
        guard w > 32, h > 32 else { return nil }
        let p = base.assumingMemoryBound(to: UInt8.self)
        var sum = 0, n = 0
        for y in Swift.stride(from: 0, to: h, by: 16) {
            for x in Swift.stride(from: 0, to: w, by: 16) {
                sum += Int(p[y * rowBytes + x])
                n += 1
            }
        }
        let cw = min(384, w - 4), ch = min(288, h - 4)
        let x0 = (w - cw) / 2, y0 = (h - ch) / 2
        var s = 0.0, s2 = 0.0, m = 0.0
        for y in (y0 + 1)..<(y0 + ch - 1) {
            let row = y * rowBytes
            for x in (x0 + 1)..<(x0 + cw - 1) {
                let c = Int(p[row + x])
                let l = 4 * c - Int(p[row + x - 1]) - Int(p[row + x + 1]) - Int(p[row - rowBytes + x]) - Int(p[row + rowBytes + x])
                s += Double(l)
                s2 += Double(l * l)
                m += 1
            }
        }
        let mean = s / m
        return (Double(sum) / Double(max(n, 1)), max(0, s2 / m - mean * mean))
    }
}
