import Foundation
import Observation
import RooflineCore
import SwiftUI

// The room-scan hybrid's model: "I pan the room, then take close-ups, and after that I tap Measure and check."
// Pan (Apple's room scan + regular photos kept for the window scan) -> the list of windows Apple found -> a window's close-ups, in any order
// -> Measure and check (the guided scan's own pipeline, per window, starting from Apple's window) -> results -> the windows are saved through
// the normal outbox and the scan outbox. The steps are `HybridFlow` (RooflineCore, checked on a Mac); this class holds the photos and the work.

/// What a window Apple found looks like when the pan is over: plain values, so the model can be driven without RoomPlan (tests, the simulator).
struct HybridFound {
    var appleId: UUID
    /// TL, TR, BR, BL in the session's world.
    var corners: [Vec3]
    var widthM: Double
    var heightM: Double
    var confidence: RoomPlanConfidence
    var basis: ScanWindowShape.Basis = .dimensions
    /// The pan photo that saw it best, small, with its outline (the list's picture).
    var photo: ScanPhoto?
    /// That photo in full, with the outline in its pixels: what a window nobody measured further is saved with.
    var appleShot: (jpeg: Data, widthPx: Int, heightPx: Int, corners: [Vec2])?
}

/// One window of the hybrid: Apple's find, the pan photos chosen for it, its close-ups, and (after Measure and check) its scan.
@MainActor
@Observable
final class HybridWindow: Identifiable {
    /// The window's id on the server, and the flow item's.
    let id: String
    let letter: String
    let estimate: HybridEstimate
    let photo: ScanPhoto?
    let appleShot: (jpeg: Data, widthPx: Int, heightPx: Int, corners: [Vec2])?
    /// The pan photos that saw it (`PanFrame.id`s), best first.
    let panIds: [Int]
    private(set) var closeups: [ScanShot] = []
    /// The scan after Measure and check: the same model the guided scan's result screen works on.
    private(set) var scan: GuidedScanModel?

    init(id: String, letter: String, estimate: HybridEstimate, photo: ScanPhoto?, appleShot: (jpeg: Data, widthPx: Int, heightPx: Int, corners: [Vec2])?, panIds: [Int]) {
        self.id = id
        self.letter = letter
        self.estimate = estimate
        self.photo = photo
        self.appleShot = appleShot
        self.panIds = panIds
    }

    /// The scan's best photo with the rectangle it found, small, for the results list.
    private(set) var resultPhoto: ScanPhoto?

    func setCloseups(_ shots: [ScanShot]) { closeups = shots }

    func setScan(_ model: GuidedScanModel?) {
        scan = model
        resultPhoto = model.flatMap(Self.photo(of:))
    }

    private static func photo(of m: GuidedScanModel) -> ScanPhoto? {
        guard let shot = m.bestShot, let img = UIImage(data: shot.uprightJPEG) else { return nil }
        let w = shot.view.photoWidthPx, h = shot.view.photoHeightPx
        guard w > 0, h > 0 else { return nil }
        let outline = m.outline(in: shot)
        guard outline.count == 4 else { return nil }
        let thumb = img.preparingThumbnail(of: CGSize(width: 420, height: 420 * h / w)) ?? img
        return ScanPhoto(image: thumb, outline: outline.map { CGPoint(x: $0.x / w, y: $0.y / h) })
    }

    /// Which corners have a close-up (TL, TR, BR, BL).
    var closeupCorners: [Bool] { (0..<4).map { c in closeups.contains { $0.corner == c } } }
}

/// What the outbox needs to save one window of the hybrid.
struct HybridSaveItem {
    var windowId: String
    var name: String
    var scale: WindowPhotoScale
    var jpeg: Data?
    var widthPx: Int
    var heightPx: Int
    var corners: [Vec2]?
    var windowFrame: WindowFrameSize?
    /// The window's scan (photos, marks, answer) to go up after the window; nil for a window nobody measured further.
    var staged: HomeownerStore.StagedScan?
    /// Whether the size is the scan's own (else Apple's stands).
    var usesScan: Bool
}

extension ScanShot {
    /// The same photo under another frame id (the scan's photos are numbered once they are all known).
    func renumbered(_ newId: String) -> ScanShot {
        ScanShot(id: newId, kind: kind, corner: corner, nativeJPEG: nativeJPEG, uprightJPEG: uprightJPEG, nativeWidth: nativeWidth, nativeHeight: nativeHeight, view: view)
    }
}

/// From Apple's window, the pan photos that saw it and its close-ups, to the window's scan: the guided scan's pipeline (marks, triangulation, the
/// seven gates) with Apple's window as the first estimate. Blocks (decodes JPEGs, snaps corners): call it off the main thread.
enum HybridScanBuilder {
    struct Built {
        var shots: [ScanShot]
        var draft: ScanDraft
        /// The first estimate the marks started from (Apple's corners, moved onto the frame's face when the depth sensor said where it is).
        var estimate: [Vec3]
    }

    /// The pan photos as the scan's regular photos (kind .regular, on Apple's wall plane).
    static func panShots(_ frames: [PanFrame], estimate: HybridEstimate) -> [ScanShot] {
        frames.compactMap { f in
            guard let up = FrameCapture.uprightJPEG(fromNative: f.nativeJPEG) else { return nil }
            let view = FrozenView(cameraTransform: f.cameraTransform, intrinsics: f.intrinsics, wall: estimate.wall, depth: f.depth,
                                  photoWidthPx: Double(up.1), photoHeightPx: Double(up.2), depthSensorPhone: true)
            return ScanShot(id: "p\(f.id)", kind: .regular, corner: nil, nativeJPEG: f.nativeJPEG, uprightJPEG: up.0, nativeWidth: f.nativeWidth, nativeHeight: f.nativeHeight, view: view)
        }
    }

    /// `pan`: the window's pan photos, best first (the first is the key photo). `closeups`: its close-ups. Nil when there are too few photos for a scan.
    static func build(estimate: HybridEstimate, windowId: String, scanId: String, pan: [PanFrame], closeups: [ScanShot], images: ScanImages = ScanImages()) -> Built? {
        var shots = panShots(pan, estimate: estimate) + closeups
        guard shots.count >= ScanLimits.minFrames, shots.count <= ScanLimits.maxFrames, shots.contains(where: { $0.kind == .regular }) else { return nil }
        // Regular photos first (the first of them is the key photo the single-photo estimate and the window's picture come from), then the close-ups
        shots = shots.filter { $0.kind == .regular } + shots.filter { $0.kind == .closeup }
        shots = shots.enumerated().map { $1.renumbered("f\($0 + 1)") }
        let start = refined(estimate, key: shots[0])
        guard let b = ScanProcessing.build(shots: shots, estimate: start, keySource: .projected, scanId: scanId, windowId: windowId, images: images,
                                           radiusScale: HybridRules.firstSearchScale, bootstrap: true) else { return nil }
        return Built(shots: shots, draft: b.draft, estimate: start)
    }

    /// Apple's corners, moved onto the frame's face when the key photo has depth: Apple puts a window in the wall's plane, the frame can sit a few
    /// centimetres behind it, and the depth round the corners says where (`FrozenView.framePlane`). The corners stay Apple's when there is no depth or it disagrees.
    static func refined(_ e: HybridEstimate, key: ScanShot) -> [Vec3] {
        guard key.view.depth != nil else { return e.cornersM }
        let px = e.cornersM.compactMap { key.view.photoPixel(ofWorld: $0) }
        guard px.count == 4, let on = key.view.worldCorners(photoPx: px), on.points.count == 4,
              zip(on.points, e.cornersM).allSatisfy({ $0.distance(to: $1) <= 0.08 }) else { return e.cornersM }
        return on.points
    }
}

@MainActor
@Observable
final class RoomHybridModel {
    private(set) var flow = HybridFlow()
    let room: String
    let camera = RoomHybridCamera()
    private(set) var scanner: RoomScanner?
    private(set) var windows: [HybridWindow] = []
    /// Windows Measure and check has finished (for "Measuring window 2 of 3").
    private(set) var measuredCount = 0
    /// Something to tell the person on the list (the world moved, nothing could be measured).
    private(set) var notice: String?
    @ObservationIgnored private(set) var panFrames: [PanFrame] = []

    init(room: String) {
        self.room = room
    }

    // MARK: Pan

    /// RoomPlan's scan on the shared AR session, with the pan's photos kept for every window it shows.
    func makeScanner() -> RoomScanner {
        let s = RoomScanner(mode: .panForCloseups, arSession: camera.arSession, keepSessionRunning: true)
        s.onLiveWindows = { [weak self] list in self?.camera.setLiveWindows(list) }
        scanner = s
        return s
    }

    func beginPan() {
        camera.beginPan()
        scanner?.start()
    }

    /// Apple's Done. The quick scan's rule (a few seconds before Done) does not apply: the hybrid lets the person stop whenever they like.
    func donePanning() {
        guard flow.stage == .panning, let s = scanner else { return }
        s.stop()
        guard s.phase == .processing else { return }
        camera.endPan()
        flow.stopPanning()
    }

    /// Apple has built the room: the windows it found become the list. (Called when the scanner reaches its review.)
    func panFinished() {
        guard let s = scanner, s.phase == .review, flow.stage == .building || flow.stage == .panning else { return }
        camera.endPan()
        let found: [HybridFound] = s.found.filter { !$0.isDoor }.map { f in
            HybridFound(appleId: f.id, corners: f.corners, widthM: f.widthM, heightM: f.heightM, confidence: f.confidence, basis: f.basis, photo: f.photo,
                        appleShot: s.keyframePhoto(for: f).map { (jpeg: $0.jpeg, widthPx: $0.widthPx, heightPx: $0.heightPx, corners: $0.corners) })
        }
        panBuilt(found, frames: camera.pan.take())
    }

    /// The windows Apple found, with the pan's photos: each window's photos are picked (`PanFrameSelector`) and the list is made.
    func panBuilt(_ found: [HybridFound], frames: [PanFrame]) {
        panFrames = frames
        // Seen from inside the room: the pan's middle
        let viewer = Vec3.mean(frames.map { $0.cameraTransform.translation })
        let metas = frames.map { $0.meta }
        var made: [HybridWindow] = []
        var items: [HybridItem] = []
        for f in found {
            guard let estimate = HybridEstimate(cornersM: f.corners, widthM: f.widthM, heightM: f.heightM, confidence: f.confidence, basis: f.basis, viewer: viewer) else { continue }
            let letter = ScanWording.letter(made.count)
            let ids = PanFrameSelector.select(metas, corners: estimate.cornersM)
            let id = WindowIds.new()
            made.append(HybridWindow(id: id, letter: letter, estimate: estimate, photo: f.photo, appleShot: f.appleShot, panIds: ids))
            items.append(HybridItem(id: id, letter: letter, widthM: estimate.widthM, heightM: estimate.heightM, confidence: estimate.confidence, panFrames: ids.count))
        }
        windows = made
        if flow.stage == .panning { flow.stopPanning() }
        flow.built(items)
        // The pan is over: RoomPlan's camera view goes; the shared session carries on for the close-ups
        camera.ensureRunning()
    }

    func window(_ id: String) -> HybridWindow? { windows.first { $0.id == id } }

    /// The pan photos' size as the camera shows them upright (the close-up arrows are placed by it).
    var panPhotoSize: CGSize {
        guard let f = panFrames.first else { return CGSize(width: 1440, height: 1920) }
        return CGSize(width: f.nativeHeight, height: f.nativeWidth)
    }

    /// What the close-up screen shows: the camera's state (a drawn one in the simulator's DEBUG samples).
    var closeupUi: ScanUiState {
        #if DEBUG
        if let d = debugCloseup { return d.ui }
        #endif
        return camera.closeupUi
    }

    var closeupShots: [ScanShot] {
        #if DEBUG
        if let d = debugCloseup { return d.shots }
        #endif
        return camera.closeupShots
    }

    #if DEBUG
    /// DEBUG: the close-up screen over a drawn photo instead of the camera (the simulator has none).
    struct DebugCloseup {
        var backdrop: AnyView
        var ui: ScanUiState
        var shots: [ScanShot]
    }

    @ObservationIgnored var debugCloseup: DebugCloseup?
    #endif

    // MARK: The list

    func setIncluded(_ id: String, _ on: Bool) { flow.setIncluded(id, on) }
    func setSkipped(_ id: String, _ on: Bool) {
        flow.setSkipped(id, on)
        if on { window(id)?.setCloseups([]) }
    }

    // MARK: Close-ups

    /// Open a window's close-ups (any order). Its earlier close-ups, if any, are taken again.
    func openCloseups(_ id: String) {
        guard !camera.worldMoved, let w = window(id), flow.openCloseups(id) else { return }
        camera.beginCloseups(corners: w.estimate.cornersM, wall: w.estimate.wall)
    }

    /// "Redo" on the camera: this window's close-ups start again.
    func redoCloseups() {
        guard case .closeups(let id) = flow.stage, let w = window(id) else { return }
        camera.beginCloseups(corners: w.estimate.cornersM, wall: w.estimate.wall)
    }

    /// Back to the list with the close-ups taken so far (a corner taken twice keeps the later photo).
    func finishCloseups() {
        guard case .closeups(let id) = flow.stage, let w = window(id) else { return }
        camera.endCloseups()
        var latest: [Int: ScanShot] = [:]
        for s in camera.closeupShots where s.kind == .closeup { if let c = s.corner { latest[c] = s } }
        let shots = latest.keys.sorted().compactMap { latest[$0] }
        // (a window with nothing new keeps the close-ups it had: nothing was taken)
        if !shots.isEmpty { w.setCloseups(shots) }
        flow.closeupsDone(corners: w.closeupCorners)
        if camera.worldMoved {
            notice = "We lost track of the room, so new close-ups can't be lined up with your scan. Windows that have close-ups can still be measured."
        }
    }

    // MARK: Measure and check

    /// The big button: per window, the scan of its pan photos and close-ups from Apple's window; then the results.
    func measureAndCheck() async {
        let ids = flow.startMeasuring()
        guard !ids.isEmpty else { return }
        measuredCount = 0
        notice = nil
        for id in ids {
            guard let w = window(id) else {
                flow.record(id, .appleSize)
                continue
            }
            let estimate = w.estimate, windowId = w.id, closeups = w.closeups
            let pan = w.panIds.compactMap { pid in panFrames.first { $0.id == pid } }
            let scanId = UUID().uuidString.lowercased()
            let built = await Task.detached(priority: .userInitiated) {
                HybridScanBuilder.build(estimate: estimate, windowId: windowId, scanId: scanId, pan: pan, closeups: closeups)
            }.value
            if let b = built {
                let model = GuidedScanModel()
                model.adopt(shots: b.shots, estimate: b.estimate, draft: b.draft, apple: (estimate.widthIn, estimate.heightIn))
                w.setScan(model)
                flow.record(id, model.isMeasured ? .measured : .check)
            } else {
                flow.record(id, .appleSize)
            }
            measuredCount += 1
        }
        flow.finishMeasuring()
    }

    /// A mark was moved on a window's photo: its result may have changed.
    func refreshOutcome(_ id: String) {
        guard let m = window(id)?.scan else { return }
        flow.revise(id, m.isMeasured ? .measured : .check)
    }

    func reopenList() {
        flow.reopenList()
        for w in windows { w.setScan(nil) }
    }

    // MARK: The size a window ends with

    /// The size shown and saved for a window: the scan's own when it has a rectangle that may be used, else Apple's.
    func size(of w: HybridWindow) -> (widthIn: Double, heightIn: Double, fromScan: Bool) {
        let apple = w.estimate
        if let m = w.scan, m.solution?.fit != nil, let s = m.size,
           HybridRules.useScanSize(appleW: apple.widthIn, appleH: apple.heightIn, scanW: s.widthIn, scanH: s.heightIn, measured: m.isMeasured) {
            return (s.widthIn, s.heightIn, true)
        }
        return (apple.widthIn, apple.heightIn, false)
    }

    // MARK: Saving

    /// The windows that go on, as the outbox takes them. The scan's own size and photos when it may be used; Apple's size (quote-grade) otherwise,
    /// with the scan still attached when there is one (the staff review it and the server refines it).
    func saveItems() -> [HybridSaveItem] {
        let list = flow.toSave
        let multiple = list.count > 1
        return list.compactMap { item in
            guard let w = window(item.id) else { return nil }
            let name = multiple ? "\(room), window \(w.letter)" : ""
            if let m = w.scan, let f = m.finalWindow() {
                let s = size(of: w)
                if s.fromScan {
                    let scale = WindowPhotoScale.ar(ArScale(pointsM: f.pointsM, trackingLostCount: 0, device: f.shot.view.device, cornerSpreadM: f.spreadM))
                    return HybridSaveItem(windowId: w.id, name: name, scale: scale, jpeg: f.shot.uprightJPEG, widthPx: Int(f.shot.view.photoWidthPx), heightPx: Int(f.shot.view.photoHeightPx),
                                          corners: f.corners, windowFrame: f.windowFrame, staged: f.staged, usesScan: true)
                }
                let outline = ScanProcessing.outline(of: w.estimate.cornersM, in: f.shot)?.map {
                    ImageMapping.clamp(Vec2(Double($0.x), Double($0.y)), width: f.shot.view.photoWidthPx, height: f.shot.view.photoHeightPx)
                }
                return HybridSaveItem(windowId: w.id, name: name, scale: .roomplan(w.estimate.appleScale), jpeg: f.shot.uprightJPEG, widthPx: Int(f.shot.view.photoWidthPx),
                                      heightPx: Int(f.shot.view.photoHeightPx), corners: outline, windowFrame: nil, staged: f.staged, usesScan: false)
            }
            return HybridSaveItem(windowId: w.id, name: name, scale: .roomplan(w.estimate.appleScale), jpeg: w.appleShot?.jpeg, widthPx: w.appleShot?.widthPx ?? 0,
                                  heightPx: w.appleShot?.heightPx ?? 0, corners: w.appleShot?.corners, windowFrame: nil, staged: nil, usesScan: false)
        }
    }

    // MARK: Leaving

    func shutDown() {
        scanner?.cancel()
        camera.shutDown()
    }
}

#if DEBUG
extension RoomHybridModel {
    /// DEBUG: a window's close-ups, as if the camera had just taken them.
    func debugCloseups(_ id: String, _ shots: [ScanShot]) {
        guard let w = window(id), flow.openCloseups(id) else { return }
        w.setCloseups(shots)
        flow.closeupsDone(corners: w.closeupCorners)
    }
}
#endif
