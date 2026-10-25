import ARKit
import Observation
import RooflineCore
import SwiftUI

// The guided scan, start to finish: aim at the window and tap Start; step slowly left and right (the phone keeps regular photos), move
// closer to each corner (it takes a close-up of each by itself); the window's four corners are found once and carried into every photo;
// the result is shown with how sure it is, and the window goes on with the scan as evidence (`HomeownerStore+Windows.capture`).

@MainActor
@Observable
final class GuidedScanModel {
    enum Stage: Equatable {
        /// Aiming: the camera finds the wall and waits for Start.
        case aim
        case scanning
        /// Finding the corners in every photo.
        case working
        /// The phone could not find the window by itself: the person outlines it on the first photo.
        case needWindow
        case result
        /// Tracking was lost: the photos are not in one world any more.
        case interrupted
        /// Too few good photos to measure from.
        case tooFew
    }

    private(set) var stage: Stage = .aim
    private(set) var shots: [ScanShot] = []
    /// The window as far as the phone knows (TL, TR, BR, BL in the world) and where that came from.
    private(set) var windowCorners: [Vec3]?
    private(set) var keySource: MarkSource = .snap
    private(set) var finding = false
    private(set) var draft: ScanDraft?
    /// The estimate's own size, for a scan whose maths gave no rectangle (it is then sent as a window to check).
    private(set) var estimateSize: (widthIn: Double, heightIn: Double)?
    let windowId = WindowIds.new()
    let scanId = UUID().uuidString.lowercased()
    @ObservationIgnored let images = ScanImages()

    @ObservationIgnored private weak var controller: ArMeasureController?
    @ObservationIgnored private weak var store: HomeownerStore?
    @ObservationIgnored private var estimateTask: Task<Void, Never>?
    @ObservationIgnored private var buildTask: Task<Void, Never>?

    func attach(controller: ArMeasureController, store: HomeownerStore) {
        self.controller = controller
        self.store = store
    }

    // MARK: Steps

    func start() {
        guard stage == .aim, let controller = controller else { return }
        shots = []
        windowCorners = nil
        draft = nil
        controller.removeCoaching()
        controller.startScan()
        stage = .scanning
    }

    /// The person left the scan, or wants it again.
    func cancel() {
        estimateTask?.cancel()
        buildTask?.cancel()
        controller?.stopScan()
        controller?.scanSetWindow(nil)
    }

    func redo() {
        cancel()
        images.forget()
        shots = []
        windowCorners = nil
        draft = nil
        estimateSize = nil
        finding = false
        stage = .aim
        controller?.installCoaching()
    }

    /// Photos kept by the recorder.
    func ingest(_ all: [ScanShot]) {
        guard stage == .scanning, all.count > shots.count else { return }
        let fresh = Array(all[shots.count...])
        shots = all
        if windowCorners == nil, !finding, let first = shots.first, first.kind == .regular, fresh.contains(where: { $0.id == first.id }) {
            findWindow(in: first)
        }
    }

    func scanChanged(_ ui: ScanUiState) {
        guard stage == .scanning else { return }
        if ui.interrupted {
            cancel()
            stage = .interrupted
        } else if ui.step?.phase == .finished {
            finish()
        }
    }

    /// Stop here and measure with what was taken.
    func finish() {
        guard stage == .scanning else { return }
        controller?.stopScan()
        stage = .working
        buildTask = Task { await run() }
    }

    // MARK: The window

    /// The first estimate of the window, in the first regular photo: the depth sensor's opening at once (the live checks start from it), then the
    /// AI finder's answer when it comes (it replaces the depth's when it finds a window).
    private func findWindow(in shot: ScanShot) {
        finding = true
        let images = self.images
        estimateTask = Task { [weak self] in
            let depth = await Task.detached(priority: .userInitiated) { ScanProcessing.depthOpening(shot, images: images) }.value
            if let d = depth, !Task.isCancelled { self?.setWindow(d.rect.cornersM, source: .snap) }
            var attempt: AiAttempt?
            if let store = self?.store, let cg = images.image(shot) {
                let sent = await Task.detached(priority: .userInitiated) { DetectionPhoto.jpeg(from: cg) }.value
                if let sent = sent { attempt = await store.findWindow(jpeg: sent) }
            }
            let result = await Task.detached(priority: .userInitiated) { ScanProcessing.proposal(shot, images: images, ai: attempt?.detection, depth: depth) }.value
            if let r = result, !Task.isCancelled { self?.setWindow(r.rect.cornersM, source: ScanProcessing.markSource(r.source)) }
            self?.finding = false
        }
    }

    private func setWindow(_ corners: [Vec3], source: MarkSource) {
        windowCorners = corners
        keySource = source
        controller?.scanSetWindow(corners)
    }

    /// The person outlined the window on the first photo (the phone could not find it).
    func outlined(_ corners: [Vec3]) {
        setWindow(corners, source: .user)
        stage = .working
        buildTask = Task { await run() }
    }

    // MARK: The answer

    private func run() async {
        await estimateTask?.value
        guard !Task.isCancelled else { return }
        let regular = shots.filter { $0.kind == .regular }
        guard regular.count >= ScanLimits.minFrames else {
            stage = .tooFew
            return
        }
        guard let corners = windowCorners else {
            stage = .needWindow
            return
        }
        let shots = self.shots, source = keySource, scanId = self.scanId, windowId = self.windowId, images = self.images
        let built = await Task.detached(priority: .userInitiated) { ScanProcessing.build(shots: shots, estimate: corners, keySource: source, scanId: scanId, windowId: windowId, images: images) }.value
        guard !Task.isCancelled else { return }
        guard let b = built else {
            stage = .needWindow
            return
        }
        draft = b.draft
        if let key = shots.first, let r = FrozenMeasure.result(rawM: corners, spreadM: corners.map { key.view.spreadM(atWorld: $0) }, wall: b.draft.wall, viewer: key.view.viewer, device: key.view.device) {
            estimateSize = (r.widthIn, r.heightIn)
        }
        stage = .result
    }

    /// The person put a corner of one photo somewhere else: the answer is worked out again from the marks.
    func moveMark(shotId: String, corner: Int, toNative p: Vec2) {
        guard let d = draft else { return }
        draft = d.placing(frameId: shotId, corner: corner, at: p)
    }

    // MARK: What the result says

    var solution: ScanSolution? { draft?.solution }

    /// The size that goes on as the window: the scan's rectangle, else the first estimate's.
    var size: (widthIn: Double, heightIn: Double)? {
        if let s = solution, let w = s.widthIn, let h = s.heightIn { return (w, h) }
        return estimateSize
    }

    /// The four world points of the opening that go on (the rectangle, else the first estimate).
    var openingCornersM: [Vec3]? { solution?.cornersM ?? windowCorners }

    /// Measured by the gates; anything else is checked by WinChoice.
    var isMeasured: Bool { solution?.status == .measured }

    var bestShot: ScanShot? { draft.flatMap { ScanProcessing.bestShot(of: shots, draft: $0) } ?? shots.first }

    /// What goes on to the window and the outbox when the person uses the size.
    func finalWindow() -> (corners: [Vec2], pointsM: [Vec3], spreadM: [Double], shot: ScanShot, staged: HomeownerStore.StagedScan, windowFrame: WindowFrameSize?)? {
        guard let d = draft, let key = shots.first, let pts = openingCornersM, pts.count == 4 else { return nil }
        // The window's corners in the photo the window row keeps (the first photo, upright): the opening's four corners seen from it
        guard let px = ScanProcessing.outline(of: pts, in: key) else { return nil }
        let corners = px.map { ImageMapping.clamp(Vec2(Double($0.x), Double($0.y)), width: key.view.photoWidthPx, height: key.view.photoHeightPx) }
        // A corner's spread: the pixels its marks disagree by, as metres at its distance; a scan the gates did not pass is a window to check
        let s = d.solution
        let rms = max(s.quality.reprojRmsPx, 0.5)
        var spread = pts.map { max(FrozenView.minSpreadM, rms * $0.distance(to: key.view.viewer) / max(key.view.intrinsics.fx, 1)) }
        if !isMeasured { spread = spread.map { max($0, FitLimits.checkSpreadM) } }
        var jpegs: [String: Data] = [:]
        for shot in shots { jpegs[shot.id] = shot.nativeJPEG }
        return (corners, pts, spread, key, HomeownerStore.StagedScan(draft: d, jpegs: jpegs), d.windowFrame)
    }
}

#if DEBUG
extension GuidedScanModel {
    /// DEBUG: the result screen over drawn photos (the simulator has no camera): the real marks pipeline runs on them. `check`: one mark is far
    /// off, so the gates fail and the screen shows the amber state.
    func debugLoad(shots all: [ScanShot], estimate: [Vec3], check: Bool) {
        shots = all
        windowCorners = estimate
        keySource = .ai
        guard let b = ScanProcessing.build(shots: all, estimate: estimate, keySource: .ai, scanId: scanId, windowId: windowId, images: images) else { return }
        draft = b.draft
        if check, let m = b.draft.usedMarks.first(where: { $0.frameId == "f2" && $0.corner == 1 }) {
            draft = b.draft.placing(frameId: "f2", corner: 1, at: Vec2(m.x + 26, m.y - 18))
        }
        if let key = all.first, let r = FrozenMeasure.result(rawM: estimate, spreadM: estimate.map { key.view.spreadM(atWorld: $0) }, wall: b.draft.wall, viewer: key.view.viewer, device: key.view.device) {
            estimateSize = (r.widthIn, r.heightIn)
        }
        stage = .result
    }
}
#endif

/// The guided scan over the AR camera: whichever screen the scan is on.
struct GuidedScanFlow: View {
    @Environment(HomeownerStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let controller: ArMeasureController
    let title: String
    let onClose: () -> Void
    let onSinglePhoto: () -> Void
    let onUse: (GuidedScanModel) -> Void
    @State private var model = GuidedScanModel()

    var body: some View {
        ZStack {
            switch model.stage {
            case .aim:
                ScanAimOverlay(title: title, ready: controller.wallLocked && controller.canPlace, depth: controller.lidar, onClose: onClose, onStart: { model.start() },
                               onSinglePhoto: onSinglePhoto)
            case .scanning:
                ScanCaptureOverlay(ui: controller.scanUi, shots: model.shots, finding: model.finding, corners: model.windowCorners, title: title,
                                   onClose: { model.cancel(); onClose() }, onRedo: { model.redo() }, onShutter: { controller.scanManualShutter() },
                                   onNext: { controller.scanFinishSweep() }, onSkip: { controller.scanSkipCorner() }, onStop: { model.finish() })
            case .working:
                ScanWorkingOverlay(photos: model.shots.count)
            case .needWindow:
                if let key = model.shots.first {
                    FreezeFrameEditor(capture: key.capture, earlier: [], title: title, start: (FreezeProposal.inset(view: key.view), .notFound), allowAnother: false,
                                      onClose: { model.cancel(); onClose() }, onRetake: { model.redo() }, onAddAnother: { _ in },
                                      onUse: { model.outlined($0.windowPointsM) })
                }
            case .result:
                ScanResultView(model: model, title: title, onUse: { onUse(model) }, onAgain: { model.redo() }, onClose: { model.cancel(); onClose() })
                    .transition(reduceMotion ? .identity : .opacity)
            case .interrupted:
                ScanNoticeView(symbol: "exclamationmark.triangle", title: "We lost track of the room",
                               message: "Move slowly and keep the wall in view. Start the scan again.", action: "Scan again", onAction: { model.redo() }, onClose: onClose)
            case .tooFew:
                ScanNoticeView(symbol: "camera.metering.unknown", title: "That was a little quick",
                               message: "We need a few photos from different spots. Step slowly left and right, then try again.", action: "Scan again", onAction: { model.redo() }, onClose: onClose)
            }
        }
        .animation(reduceMotion ? nil : .default, value: model.stage)
        .task {
            model.attach(controller: controller, store: store)
            controller.installCoaching()
        }
        .onChange(of: controller.scanShots.count) { _, _ in model.ingest(controller.scanShots) }
        .onChange(of: controller.scanUi) { _, ui in model.scanChanged(ui) }
        .onDisappear { model.cancel(); controller.removeCoaching() }
    }
}
