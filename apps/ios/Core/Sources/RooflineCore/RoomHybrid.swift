import Foundation

// The room-scan hybrid, as logic: "I pan the room, then take close-ups, then tap Measure and check."
//
//   1. PAN. Apple's room scan (RoomPlan) runs as it always did. While it runs, the phone also keeps REGULAR photos for the window scan
//      (docs/windows/scan-contract.md), judged by the same rules the guided scan uses (`ScanGuide`): sharp, steady, well lit, at least 15 cm
//      from the others, the whole window in view. One `ScanGuide` per window RoomPlan is showing (`PanFrameKeeper`).
//   2. CLOSE-UPS. When the scan is done each window has Apple's size and Apple's place in the room. That place, made into the same level
//      rectangle the scan pipeline uses (`HybridEstimate`), is the scan's FIRST ESTIMATE: no AI call is needed to start, and the close-ups are asked
//      for in the same session and world (`ScanGuide(startAtCloseups:)`).
//   3. MEASURE AND CHECK. Per window: the pan photos that saw it (`PanFrameSelector`) + its close-ups, the estimate projected into each and snapped,
//      triangulated, the seven gates. Measured, or "WinChoice will check this one" (never a block); windows without close-ups keep Apple's size.
//
// This file is the decisions only (no RoomPlan, no ARKit, no images), so it is checked on a Mac.

// MARK: - Apple's window as the scan's first estimate

/// A window RoomPlan found, as the hybrid holds it: Apple's size, the level rectangle it makes in the AR world (TL, TR, BR, BL), and the wall plane
/// it lies in. The rectangle is what the scan projects into every photo to start.
public struct HybridEstimate: Equatable, Sendable {
    /// TL, TR, BR, BL in the session's world: top and bottom level with gravity, seen from the room.
    public var cornersM: [Vec3]
    /// The wall at the window (through its corners), turned toward the room.
    public var wall: Plane
    public var widthM: Double
    public var heightM: Double
    public var confidence: RoomPlanConfidence
    /// Where the size came from: RoomPlan's dimensions, or its outline (`polygonCorners`) when that was a sensible rectangle.
    public var basis: ScanWindowShape.Basis

    public var widthIn: Double { widthM * inchesPerMetre }
    public var heightIn: Double { heightM * inchesPerMetre }

    /// Apple's size as the window's 'roomplan' scale (what a window nobody measured further keeps).
    public var appleScale: RoomPlanScale { RoomPlanScale(widthM: widthM, heightM: heightM, confidence: confidence) }

    public init(cornersM: [Vec3], wall: Plane, widthM: Double, heightM: Double, confidence: RoomPlanConfidence, basis: ScanWindowShape.Basis) {
        self.cornersM = cornersM
        self.wall = wall
        self.widthM = widthM
        self.heightM = heightM
        self.confidence = confidence
        self.basis = basis
    }

    /// From a window already resolved to a level rectangle (`RoomWindowShape.resolve`). Nil when its four corners do not span a plane.
    public init?(shape: ScanWindowShape, viewer: Vec3? = nil) {
        self.init(cornersM: shape.corners, widthM: shape.widthM, heightM: shape.heightM, confidence: shape.confidence, basis: shape.basis, viewer: viewer)
    }

    /// From the four corners alone (TL, TR, BR, BL); the wall is the plane through them, turned toward `viewer`.
    public init?(cornersM: [Vec3], widthM: Double, heightM: Double, confidence: RoomPlanConfidence, basis: ScanWindowShape.Basis, viewer: Vec3? = nil) {
        guard cornersM.count == 4, cornersM.allSatisfy({ $0.isFinite }), var plane = Plane.fit(cornersM) else { return nil }
        if let v = viewer { plane = plane.facing(v) }
        self.init(cornersM: cornersM, wall: plane, widthM: widthM, heightM: heightM, confidence: confidence, basis: basis)
    }

    /// RoomPlan's window (its transform and dimensions, or its outline when that agrees) as the scan's first estimate. `viewer`: where the
    /// room is seen from (the pan's middle), which decides left from right and which way the wall faces.
    public static func from(_ surface: ScanSurface, viewer: Vec3?) -> HybridEstimate? {
        RoomWindowShape.resolve(surface, viewer: viewer).flatMap { HybridEstimate(shape: $0, viewer: viewer) }
    }

    /// How far the corners are, in metres, from another rectangle's (the largest of the four), for telling two estimates of one window apart.
    public func maxCornerDistance(to other: [Vec3]) -> Double? {
        guard other.count == 4 else { return nil }
        return zip(cornersM, other).map { $0.distance(to: $1) }.max()
    }
}

// MARK: - Pan photos: which to keep while RoomPlan runs

/// What the phone knows about one photo kept during the pan (no pixels).
public struct PanFrameMeta: Equatable, Sendable, Identifiable {
    public var id: Int
    public var time: Double
    public var cameraTransform: Mat4
    /// For the NATIVE (landscape) image.
    public var intrinsics: CameraIntrinsics
    /// Variance of the Laplacian over the picture's middle (larger is sharper; only compared between photos of one scan). 0: not measured.
    public var sharpness: Double

    public init(id: Int, time: Double, cameraTransform: Mat4, intrinsics: CameraIntrinsics, sharpness: Double = 0) {
        self.id = id
        self.time = time
        self.cameraTransform = cameraTransform
        self.intrinsics = intrinsics
        self.sharpness = sharpness
    }
}

/// The photos of the pan that go with one window, picked once the window's final place is known.
public enum PanFrameSelector {
    /// The most photos one window takes from the pan (the guide's own maximum).
    public static let maxFrames = ScanGuideConfig().maxRegular
    /// Below this many photos the baseline rule is relaxed a little (a person panning on the spot barely moves).
    public static let wantFrames = ScanGuideConfig().minRegular
    /// The relaxed rule: a photo this far from every kept one (metres), or turned this much from it (degrees), still adds a view.
    public static let relaxedBaselineM = 0.04
    public static let relaxedTurnDeg = 6.0

    /// The whole window is in this photo: all four corners in front of the camera and inside every edge by `marginShare` of the picture.
    public static func sees(_ f: PanFrameMeta, corners: [Vec3], marginShare: Double = ScanGuideConfig().viewMarginShare) -> Bool {
        guard corners.count == 4 else { return false }
        let k = f.intrinsics
        let mx = k.width * marginShare, my = k.height * marginShare
        for p in corners {
            guard f.cameraTransform.inverseRigid.transform(p).z < -1e-4,
                  let px = ImageMapping.project(p, cameraTransform: f.cameraTransform, intrinsics: k) else { return false }
            if px.x < mx || px.x > k.width - mx || px.y < my || px.y > k.height - my { return false }
        }
        return true
    }

    /// How front-on the photo is to the window (1: straight on, 0: along the wall).
    public static func frontness(_ f: PanFrameMeta, corners: [Vec3]) -> Double {
        guard corners.count == 4, let c = Vec3.mean(corners),
              let n = (corners[1] - corners[0]).cross(corners[3] - corners[0]).normalized,
              let look = (c - f.cameraTransform.translation).normalized else { return 0 }
        return abs(n.dot(look))
    }

    /// The ids of the photos for a window with these corners, best first (the first is the key photo: the scan's single-photo estimate and the
    /// window's picture come from it). Only photos that see the whole window; the sharpest and most front-on first; each at least
    /// `config.minBaselineM` from every one already picked; at most `limit`. With fewer than `wantFrames`, photos only a little apart are added.
    public static func select(_ frames: [PanFrameMeta], corners: [Vec3], config: ScanGuideConfig = ScanGuideConfig(), limit: Int = maxFrames) -> [Int] {
        let seen = frames.filter { sees($0, corners: corners, marginShare: config.viewMarginShare) }
        guard !seen.isEmpty, limit > 0 else { return [] }
        let sharpest = seen.map { $0.sharpness }.max() ?? 0
        func score(_ f: PanFrameMeta) -> Double {
            let sharp = sharpest > 1e-9 ? f.sharpness / sharpest : 1
            return (0.2 + 0.8 * sharp) * (0.3 + 0.7 * frontness(f, corners: corners))
        }
        let ranked = seen.sorted { a, b in
            let sa = score(a), sb = score(b)
            return sa != sb ? sa > sb : a.time < b.time
        }
        var picked: [PanFrameMeta] = []
        for f in ranked where picked.count < limit {
            if picked.allSatisfy({ $0.cameraTransform.translation.distance(to: f.cameraTransform.translation) >= config.minBaselineM }) { picked.append(f) }
        }
        if picked.count < min(wantFrames, limit) {
            for f in ranked where picked.count < min(wantFrames, limit) && !picked.contains(where: { $0.id == f.id }) {
                let pos = f.cameraTransform.translation
                let look = -f.cameraTransform.column(2)
                let adds = picked.allSatisfy { p in
                    let turn = acos(max(-1, min(1, look.dot(-p.cameraTransform.column(2))))) * 180 / .pi
                    return p.cameraTransform.translation.distance(to: pos) >= relaxedBaselineM || turn >= relaxedTurnDeg
                }
                if adds { picked.append(f) }
            }
        }
        return picked.map { $0.id }
    }
}

/// One `ScanGuide` per window RoomPlan is showing, fed every camera frame of the pan: a window's guide says when a frame is worth keeping for it
/// (steady, sharp, lit, at least 15 cm from that window's other photos, the whole window in view). A frame is kept once if any window wants it.
/// The guides use the same numbers as the guided scan, with the phone allowed to move a little faster (the person is panning, not stepping).
public struct PanFrameKeeper: Sendable {
    public struct Window: Equatable, Sendable {
        public var id: String
        public var cornersM: [Vec3]

        public init(id: String, cornersM: [Vec3]) {
            self.id = id
            self.cornersM = cornersM
        }
    }

    /// The guided scan's rules, with a panning hand: a little faster than stepping, as RoomPlan itself asks for a slow pan.
    public static var panConfig: ScanGuideConfig {
        var c = ScanGuideConfig()
        c.maxSpeedMps = 0.25
        c.maxTurnDps = 30
        // Panning on the spot turns more than it moves: a photo from the same place but 8 degrees round still adds a view (the close-ups give the baseline)
        c.minTurnDeg = 8
        return c
    }

    public let config: ScanGuideConfig
    private var guides: [String: ScanGuide] = [:]

    public init(config: ScanGuideConfig = PanFrameKeeper.panConfig) {
        self.config = config
    }

    /// One camera frame in; the ids of the windows that want it kept. A window whose guide has all the photos it wants is not asked again.
    public mutating func update(_ o: ScanObservation, windows: [Window]) -> [String] {
        var wanted: [String] = []
        for w in windows where w.cornersM.count == 4 {
            var guide = guides[w.id] ?? ScanGuide(config: config)
            // (a guide that has moved on to the close-ups has taken all it wants from the pan)
            guard guide.phase == .sweep else { continue }
            var obs = o
            obs.windowCornersM = w.cornersM
            let step = guide.update(obs)
            if step.keep?.kind == .regular { wanted.append(w.id) }
            guides[w.id] = guide
        }
        return wanted
    }

    /// Photos kept for a window so far.
    public func kept(_ id: String) -> Int { guides[id]?.regularKept ?? 0 }
}

// MARK: - Has the world moved?

/// Watches the camera's pose from poll to poll for a jump that no hand makes (the AR session restarted, or tracking never came back): from then
/// on photos are in another world and cannot be combined with the earlier ones. Pure: the app feeds it the pose and tracking state.
public struct WorldWatch: Equatable, Sendable {
    /// Goes up each time the world moved.
    public private(set) var epoch = 0
    private struct Pose: Equatable, Sendable {
        var time: Double
        var position: Vec3
        var forward: Vec3
    }

    private var last: Pose?
    private var unavailableSince: Double?

    /// A hand moves a phone at most this fast between two looks (metres per second, and degrees per second), with a floor for a single tick.
    public static let maxSpeedMps = 4.0
    public static let maxTurnDps = 600.0
    public static let floorJumpM = 0.35
    public static let floorTurnDeg = 50.0
    /// Looks further apart than this (the app slept) say nothing about a jump.
    public static let maxGapS = 0.6
    /// Tracking gone for this long is a world lost.
    public static let unavailableLimitS = 8.0

    public init() {}

    /// A new pose. True when the world moved with this one.
    @discardableResult
    public mutating func update(time: Double, cameraTransform: Mat4, tracking: ScanObservation.Tracking) -> Bool {
        let position = cameraTransform.translation
        let forward = (-cameraTransform.column(2)).normalized ?? Vec3(0, 0, -1)
        var moved = false
        if let l = last {
            let dt = time - l.time
            if dt > 0, dt <= Self.maxGapS {
                let jump = position.distance(to: l.position)
                let turn = acos(max(-1, min(1, forward.dot(l.forward)))) * 180 / .pi
                if jump > max(Self.floorJumpM, Self.maxSpeedMps * dt) || turn > max(Self.floorTurnDeg, Self.maxTurnDps * dt) { moved = true }
            }
        }
        last = Pose(time: time, position: position, forward: forward)
        if tracking == .unavailable {
            if unavailableSince == nil { unavailableSince = time }
            if let since = unavailableSince, time - since >= Self.unavailableLimitS {
                moved = true
                unavailableSince = time
            }
        } else {
            unavailableSince = nil
        }
        if moved { epoch += 1 }
        return moved
    }
}

// MARK: - The flow

/// How a window ended up after Measure and check.
public enum HybridOutcome: String, Equatable, Sendable {
    /// The scan passed every gate.
    case measured
    /// The scan has an answer, but a gate failed: "WinChoice will check this one" (never a block).
    case check
    /// Nothing was measured further: Apple's size stands (quote-grade).
    case appleSize
}

/// One window in the list.
public struct HybridItem: Equatable, Sendable, Identifiable {
    public var id: String
    public var letter: String
    public var widthM: Double
    public var heightM: Double
    public var confidence: RoomPlanConfidence
    /// Left in the list (a wrong window can be left out).
    public var included = true
    /// The person skipped this window's close-ups: it keeps Apple's size.
    public var skipped = false
    /// Pan photos that saw this window well.
    public var panFrames: Int
    /// Which corners have a close-up (TL, TR, BR, BL).
    public var closeups = [false, false, false, false]
    public var outcome: HybridOutcome?

    public init(id: String, letter: String, widthM: Double, heightM: Double, confidence: RoomPlanConfidence, panFrames: Int) {
        self.id = id
        self.letter = letter
        self.widthM = widthM
        self.heightM = heightM
        self.confidence = confidence
        self.panFrames = panFrames
    }

    public var widthIn: Double { widthM * inchesPerMetre }
    public var heightIn: Double { heightM * inchesPerMetre }
    public var closeupCount: Int { closeups.filter { $0 }.count }
    /// The window's close-ups are done: enough of them for the scan's gates (`ScanLimits.minCloseups`).
    public var isFinished: Bool { closeupCount >= ScanLimits.minCloseups }
    /// Photos the scan would have for it: the pan's and the close-ups'.
    public var frameCount: Int { panFrames + closeupCount }
    /// The pan saw this window well enough for close-ups to be of use (`HybridRules.minPanFrames`).
    public var measurable: Bool { panFrames >= HybridRules.minPanFrames }
}

public enum HybridRules {
    /// The pan photos a window needs before its close-ups are worth taking: with one, a corner would have two marks (a close-up and the pan's) and the
    /// scan's gate asks for three (`ScanLimits.minMarksPerCorner`).
    public static let minPanFrames = ScanLimits.minMarksPerCorner - 1
    /// A scan the gates did not pass and that disagrees with Apple's size by more than this share (on either side) is not used: Apple's stands.
    public static let maxDisagreementShare = 0.12
    /// Apple's window is a coarser first estimate than the single-photo finders (a few centimetres a side), so the FIRST search for each corner in the
    /// photos is this much wider than the guided scan's (`ScanMarkMaker.run`'s `radiusScale`); the narrow rings are still tried first.
    public static let firstSearchScale = 1.6

    /// Whether Measure and check runs a scan for this window: it is in the list, was not skipped, the pan saw it well enough (`minPanFrames`) and
    /// the person took at least one close-up of it. (A window without close-ups keeps Apple's size, as the list says.)
    public static func qualifies(_ i: HybridItem) -> Bool {
        i.included && !i.skipped && i.measurable && i.closeupCount >= 1 && i.frameCount >= ScanLimits.minFrames
    }

    /// Whether the scan's own rectangle is the window's size: always when the gates passed; otherwise only when it is near Apple's.
    public static func useScanSize(appleW: Double, appleH: Double, scanW: Double, scanH: Double, measured: Bool) -> Bool {
        if measured { return true }
        guard appleW > 0, appleH > 0 else { return true }
        return abs(scanW - appleW) / appleW <= maxDisagreementShare && abs(scanH - appleH) / appleH <= maxDisagreementShare
    }
}

public enum HybridStage: Equatable, Sendable {
    /// Apple's scan is running (and the phone is keeping photos).
    case panning
    /// Apple is building the room.
    case building
    /// The list of windows Apple found.
    case windows
    /// The close-ups of one window.
    case closeups(String)
    /// Measure and check is running.
    case measuring
    case results
    /// The scan worked but found no window.
    case empty
}

/// The steps of the hybrid as a state machine: pan, list, close-ups, measure and check, results. Plain values; the screen and the camera drive it.
public struct HybridFlow: Equatable, Sendable {
    public private(set) var stage: HybridStage = .panning
    public private(set) var items: [HybridItem] = []
    /// The ids Measure and check ran (or is running) for.
    public private(set) var measuring: [String] = []

    public init() {}

    public func item(_ id: String) -> HybridItem? { items.first { $0.id == id } }

    private func index(_ id: String) -> Int? { items.firstIndex { $0.id == id } }

    // MARK: Pan and build

    /// "Done" on the pan: Apple builds the room.
    public mutating func stopPanning() {
        guard stage == .panning else { return }
        stage = .building
    }

    /// Apple's room is built: the windows it found (none: the scan found no window).
    public mutating func built(_ windows: [HybridItem]) {
        guard stage == .building || stage == .panning else { return }
        items = windows
        stage = windows.isEmpty ? .empty : .windows
    }

    // MARK: The list

    /// Leave a window out of the list, or take it back.
    public mutating func setIncluded(_ id: String, _ on: Bool) {
        guard stage == .windows, let i = index(id) else { return }
        items[i].included = on
    }

    /// "Skip": this window keeps Apple's size. Its close-ups are cleared; taking any close-up later un-skips it.
    public mutating func setSkipped(_ id: String, _ on: Bool) {
        guard stage == .windows, let i = index(id) else { return }
        items[i].skipped = on
        if on { items[i].closeups = [false, false, false, false] }
    }

    /// Open the close-ups of a window (any order). False for a window that is not in the list or was left out.
    @discardableResult
    public mutating func openCloseups(_ id: String) -> Bool {
        guard stage == .windows, let i = index(id), items[i].included, items[i].measurable else { return false }
        stage = .closeups(id)
        return true
    }

    /// The close-ups of the open window are over, with the corners that got one. Back to the list.
    public mutating func closeupsDone(corners: [Bool]) {
        guard case .closeups(let id) = stage, let i = index(id) else { return }
        if corners.count == 4 {
            items[i].closeups = corners
            if corners.contains(true) { items[i].skipped = false }
        }
        stage = .windows
    }

    /// Back to the list without changing the open window.
    public mutating func closeCloseups() {
        if case .closeups = stage { stage = .windows }
    }

    // MARK: Measure and check

    /// The windows Measure and check would run for.
    public var qualifying: [HybridItem] { items.filter(HybridRules.qualifies) }

    /// The big button is enabled: at least one window has close-ups (or enough pan photos).
    public var canMeasure: Bool { stage == .windows && !qualifying.isEmpty }

    /// Press "Measure and check". Returns the ids to run, in list order.
    @discardableResult
    public mutating func startMeasuring() -> [String] {
        guard canMeasure else { return [] }
        measuring = qualifying.map { $0.id }
        for i in items.indices { items[i].outcome = nil }
        stage = .measuring
        return measuring
    }

    /// One window's scan finished.
    public mutating func record(_ id: String, _ outcome: HybridOutcome) {
        guard stage == .measuring, let i = index(id) else { return }
        items[i].outcome = outcome
    }

    /// Every scan is done: the results. Windows no scan ran for keep Apple's size.
    public mutating func finishMeasuring() {
        guard stage == .measuring else { return }
        for i in items.indices where items[i].included && items[i].outcome == nil { items[i].outcome = .appleSize }
        stage = .results
    }

    /// A window's result changed after the person moved a mark on one of its photos.
    public mutating func revise(_ id: String, _ outcome: HybridOutcome) {
        guard stage == .results, let i = index(id), let was = items[i].outcome, was != .appleSize, outcome != .appleSize else { return }
        items[i].outcome = outcome
    }

    /// From the results back to the list (to add close-ups to a window that needs them).
    public mutating func reopenList() {
        guard stage == .results else { return }
        for i in items.indices { items[i].outcome = nil }
        measuring = []
        stage = .windows
    }

    /// The windows that will be saved, once the results are shown.
    public var toSave: [HybridItem] { stage == .results ? items.filter { $0.included } : [] }

    public var measuredCount: Int { items.filter { $0.included && $0.outcome == .measured }.count }
    public var checkCount: Int { items.filter { $0.included && $0.outcome == .check }.count }
}

// MARK: - Words

public enum HybridWording {
    /// "Living room" is the screen title; this is the line under a window's size in the list.
    public static func rowStatus(_ i: HybridItem) -> String {
        if i.skipped { return "Skipped. Keeps Apple's size" }
        if !i.measurable { return "Not seen well enough to measure. Keeps Apple's size" }
        switch i.closeupCount {
        case 0: return "No close-ups yet"
        case 4: return "4 close-ups"
        case let n: return "\(n) of 4 close-ups"
        }
    }

    /// The result of Measure and check, in the words of the guided scan's result screen.
    public static func outcomeTitle(_ o: HybridOutcome) -> String {
        switch o {
        case .measured: return "Measured"
        case .check: return "WinChoice will check this one"
        case .appleSize: return "Apple's size"
        }
    }

    public static func outcomeDetail(_ o: HybridOutcome) -> String {
        switch o {
        case .measured: return "Measured from your photos and close-ups"
        case .check: return "You can still use this size. Someone will check it against your photos."
        case .appleSize: return "Good for your quote. We confirm the exact size at your visit."
        }
    }

    /// The footer under the list.
    public static func listFooter(canMeasure: Bool, windows: Int) -> String {
        if windows == 0 { return "" }
        return canMeasure ? "Windows without close-ups keep Apple's size." : "Take close-ups of at least one window, then Measure and check."
    }

    /// What the pan has collected for the close-ups, on the camera screen.
    public static func panPhotos(_ n: Int) -> String { n == 1 ? "1 photo kept" : "\(n) photos kept" }

    /// On the list, once the camera lost its place in the room.
    public static let lostWorld = "The camera lost its place in the room, so new close-ups can't be lined up with your scan. Windows that already have close-ups can still be measured."

    /// "Measuring window 2 of 3".
    public static func measuringLine(done: Int, of total: Int) -> String {
        "Measuring window \(min(done + 1, total)) of \(total)"
    }

    /// The button that saves the results: "Add 3 windows to Living room".
    public static func addTitle(count: Int, room: String) -> String {
        count == 0 ? "Add windows to \(room)" : "Add \(count) window\(count == 1 ? "" : "s") to \(room)"
    }
}
