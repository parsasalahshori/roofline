import Foundation

// The guided scan, as logic. The person aims at the window and taps Start; for about 6 to 10 seconds the phone then
//   (a) "Step slowly left and right": keeps 5 to 8 REGULAR photos, chosen for spread (at least 15 cm between the places they were taken from),
//       steady, sharp, well lit and with the whole window in view once the window is known; then
//   (b) "Move closer to each corner": for the top-left, top-right, bottom-right and bottom-left corner in turn, takes a CLOSE-UP by itself when
//       that corner is in the middle of the picture, about 0.4 to 0.8 m away, and the hand is still and the picture sharp.
// Live coaching says what to change (too fast, too dark, too close, too far, keep the whole window in view, you stopped too early). This file
// is the decisions only: the phone feeds it one `ScanObservation` per camera frame and acts on the `ScanStep` it answers. No ARKit, no images.

/// How to judge a frame. All of these are plain numbers the owner can tune after the first real-iPhone tests.
public struct ScanGuideConfig: Equatable, Sendable {
    /// Regular photos: how many to keep, and the least distance between the places two were taken from (metres).
    public var minRegular = 3
    public var targetRegular = 6
    public var maxRegular = 8
    public var minBaselineM = 0.15
    /// Steady enough to be sharp: the camera's speed (m/s) and turning rate (degrees/s) for a regular photo, and for a close-up.
    public var maxSpeedMps = 0.15
    public var maxTurnDps = 25.0
    public var closeupMaxSpeedMps = 0.07
    public var closeupMaxTurnDps = 14.0
    /// Mean brightness of the picture (0 ... 255) outside which it is too dark or too bright.
    public var minLuma = 35.0
    public var maxLuma = 242.0
    /// A picture is sharp when its sharpness is at least this share of the sharpest seen lately.
    public var sharpShare = 0.5
    /// The least gap between two kept photos (seconds).
    public var minKeepGapS = 0.25
    /// The window is in view when its four corners are this share of the picture inside every edge.
    public var viewMarginShare = 0.04
    /// A close-up is of a corner this far from the camera (metres), within this share of the picture's size from its middle, held this long.
    public var nearM = 0.4
    public var farM = 0.8
    public var centreShare = 0.12
    public var dwellS = 0.35
    /// The sweep ends by itself: with `targetRegular` photos kept, or with five after this long, or with three after the longer time.
    public var sweepGoodAfterS = 7.0
    public var sweepEnoughAfterS = 14.0
    /// No photo kept for this long while nothing is wrong: "keep stepping to the side".
    public var stallHintS = 3.0
    /// A corner nobody can take a close-up of is offered "Skip" after this long, and skipped by itself after the longer time.
    public var skipOfferS = 12.0
    public var skipAutoS = 25.0
    /// Not looking for the window at all this long into the close-ups: the phone asks for help.
    public var noWindowHelpS = 5.0

    public init() {}
}

/// What the phone knows about one camera frame.
public struct ScanObservation: Sendable {
    public enum Tracking: Sendable {
        case normal
        case excessiveMotion
        case insufficientFeatures
        /// Limited for another reason (initialising, relocalising).
        case limited
        case unavailable
    }

    /// ARFrame.timestamp, seconds.
    public var time: Double
    public var cameraTransform: Mat4
    public var intrinsics: CameraIntrinsics
    public var tracking: Tracking
    /// Mean grey of the picture, 0 ... 255 (nil: not measured).
    public var meanLuma: Double?
    /// Sharpness of the picture's middle (variance of the Laplacian; nil: not measured).
    public var sharpness: Double?
    /// The window's corners (TL, TR, BR, BL) in the world as far as the phone knows (nil: not found yet).
    public var windowCornersM: [Vec3]?

    public init(time: Double, cameraTransform: Mat4, intrinsics: CameraIntrinsics, tracking: Tracking = .normal, meanLuma: Double? = nil, sharpness: Double? = nil,
                windowCornersM: [Vec3]? = nil) {
        self.time = time
        self.cameraTransform = cameraTransform
        self.intrinsics = intrinsics
        self.tracking = tracking
        self.meanLuma = meanLuma
        self.sharpness = sharpness
        self.windowCornersM = windowCornersM
    }
}

/// Keep this frame as a photo of the scan.
public struct ScanKeep: Equatable, Sendable {
    public var kind: ScanFrameKind
    public var corner: Int?
    /// The person pressed the shutter.
    public var manual: Bool

    public init(kind: ScanFrameKind, corner: Int? = nil, manual: Bool = false) {
        self.kind = kind
        self.corner = corner
        self.manual = manual
    }
}

/// Where the corner being asked for is on the picture.
public struct ScanTarget: Equatable, Sendable {
    public var corner: Int
    /// From the middle of the upright photo to the corner, portrait pixels (right and down); nil when the corner is behind the camera.
    public var offsetPortrait: Vec2?
    /// The corner's distance from the camera, metres.
    public var distanceM: Double?
    public var centred: Bool
    /// Near enough and far enough for a close-up.
    public var rightDistance: Bool

    public init(corner: Int, offsetPortrait: Vec2?, distanceM: Double?, centred: Bool, rightDistance: Bool) {
        self.corner = corner
        self.offsetPortrait = offsetPortrait
        self.distanceM = distanceM
        self.centred = centred
        self.rightDistance = rightDistance
    }
}

public struct ScanCoach: Equatable, Sendable {
    public enum Code: String, Sendable {
        case sweep, stepFurther, tooFast, tooDark, tooBright, lowDetail, trackingLimited, windowNotInView, findingWindow, stoppedTooEarly
        case closeupFar, closeupNear, closeupCentre, closeupHold, cornerBehind, cornerDone, sweepDone, allDone, needWindow
    }

    public var code: Code
    public var corner: Int?

    public init(_ code: Code, corner: Int? = nil) {
        self.code = code
        self.corner = corner
    }

    /// Something the person should change (not the plain instruction).
    public var isProblem: Bool {
        switch code {
        case .tooFast, .tooDark, .tooBright, .lowDetail, .trackingLimited, .windowNotInView, .stoppedTooEarly, .closeupFar, .closeupNear, .cornerBehind: return true
        default: return false
        }
    }
}

public enum ScanCopy {
    public static func text(_ c: ScanCoach) -> String {
        let name = c.corner.map { ScanCorner.names[$0] } ?? "corner"
        switch c.code {
        case .sweep: return "Step slowly left and right"
        case .stepFurther: return "Keep stepping to the side"
        case .tooFast: return "Moving too fast. Slow down"
        case .tooDark: return "Too dark. Turn on a light"
        case .tooBright: return "Too bright. Avoid pointing at a lamp or the sun"
        case .lowDetail: return "Not enough detail to track. Add light or step back"
        case .trackingLimited: return "Move the phone slowly from side to side"
        case .windowNotInView: return "Keep the whole window in view"
        case .findingWindow: return "Finding your window"
        case .stoppedTooEarly: return "You stopped too early. Keep stepping left and right"
        case .closeupFar: return "Move closer to the \(name) corner"
        case .closeupNear: return "A little further back from the \(name) corner"
        case .closeupCentre: return "Centre the \(name) corner"
        case .closeupHold: return "Hold still"
        case .cornerBehind: return "Turn to the \(name) corner"
        case .cornerDone: return "Got it. Now the \(name) corner"
        case .sweepDone: return "Good. Now move closer to each corner"
        case .allDone: return "All done"
        case .needWindow: return "We couldn't find the window. Outline it on the photo"
        }
    }

    /// What a failed gate means to the person, in a few plain words.
    public static func reason(_ gate: ScanGate) -> String {
        switch gate {
        case .tooFewFrames: return "A corner was seen in too few photos"
        case .reprojection: return "The corners don't line up between photos"
        case .baseline: return "The photos were taken too close together"
        case .symRatio: return "Opposite sides came out different lengths"
        case .plane: return "The corners don't sit flat on one wall"
        case .scale: return "The size doesn't match the depth sensor"
        case .noCloseups: return "No close-ups of the corners"
        }
    }

    /// The progress line: "Photo 3 of 6" while sweeping, "Corner 2 of 4" while taking close-ups.
    public static func progress(_ s: ScanStep, targetRegular: Int) -> String {
        switch s.phase {
        case .sweep: return "Photo \(min(s.regularKept + 1, targetRegular)) of \(targetRegular)"
        case .closeups: return "Corner \(min(s.closeupsDone + 1, 4)) of 4"
        case .finished: return "Done"
        }
    }
}

public struct ScanStep: Equatable, Sendable {
    public enum Phase: String, Sendable {
        case sweep, closeups, finished
    }

    public var phase: Phase
    public var coach: ScanCoach
    /// Keep THIS frame as a photo.
    public var keep: ScanKeep?
    public var regularKept: Int
    /// Which corners have a close-up (taken or skipped) so far, in the order TL, TR, BR, BL.
    public var closeupsKept: [Bool]
    public var closeupsDone: Int
    public var target: ScanTarget?
    /// How far through the hold-still second of the close-up (0 ... 1): the ring the screen fills.
    public var holdProgress: Double
    /// The sweep may be ended by the person now (enough photos).
    public var canFinishSweep: Bool
    /// The target corner has been tried a while: a Skip button is worth showing.
    public var offerSkip: Bool
    /// Seconds in this phase.
    public var phaseSeconds: Double
    /// The close-ups have been asked for and the window is still unknown for this long: the phone should ask the person to outline it.
    public var needsWindowHelp: Bool

    public init(phase: Phase, coach: ScanCoach, keep: ScanKeep? = nil, regularKept: Int, closeupsKept: [Bool], closeupsDone: Int, target: ScanTarget? = nil, holdProgress: Double = 0,
                canFinishSweep: Bool = false, offerSkip: Bool = false, phaseSeconds: Double = 0, needsWindowHelp: Bool = false) {
        self.phase = phase
        self.coach = coach
        self.keep = keep
        self.regularKept = regularKept
        self.closeupsKept = closeupsKept
        self.closeupsDone = closeupsDone
        self.target = target
        self.holdProgress = holdProgress
        self.canFinishSweep = canFinishSweep
        self.offerSkip = offerSkip
        self.phaseSeconds = phaseSeconds
        self.needsWindowHelp = needsWindowHelp
    }
}

public struct ScanGuide: Sendable {
    public private(set) var config: ScanGuideConfig
    public private(set) var phase: ScanStep.Phase = .sweep
    /// Where the regular photos were taken from, and the id order they were kept in.
    public private(set) var keptPositions: [Vec3] = []
    public private(set) var closeupDone = [false, false, false, false]
    public private(set) var closeupTaken = [false, false, false, false]
    public private(set) var current = 0

    private var startedAt: Double?
    private var phaseStartedAt: Double?
    private var lastKeepAt = -1e9
    private var cornerSince: Double?
    private var dwell = 0.0
    private var lastTime: Double?
    private var previous: (position: Vec3, forward: Vec3, time: Double)?
    private var speed = 0.0
    private var turn = 0.0
    /// Frames the camera's speed has been measured over: it means nothing before a few.
    private var motionSamples = 0
    private var sharpReference = 0.0
    private var sharpSamples = 0
    private var tooEarly = false
    private var lastCoach = ScanCoach(.sweep)

    public static let corners = [0, 1, 2, 3]

    public init(config: ScanGuideConfig = ScanGuideConfig()) {
        self.config = config
    }

    public var regularKept: Int { keptPositions.count }
    public var closeupsDone: Int { closeupDone.filter { $0 }.count }
    public var isFinished: Bool { phase == .finished }

    // MARK: Per frame

    /// One camera frame in, the decision out.
    public mutating func update(_ o: ScanObservation) -> ScanStep {
        let dt = lastTime.map { max(o.time - $0, 1e-3) } ?? 0
        measureMotion(o, dt: dt)
        trackSharpness(o.sharpness)
        lastTime = o.time
        if startedAt == nil { startedAt = o.time }
        if phaseStartedAt == nil { phaseStartedAt = o.time }
        switch phase {
        case .sweep: return sweepStep(o)
        case .closeups: return closeupStep(o, dt: dt)
        case .finished: return step(o, coach: ScanCoach(.allDone), keep: nil, target: nil)
        }
    }

    /// The person pressed the shutter: keep this frame as the next regular photo, or as the close-up of the corner being asked for.
    public mutating func manualKeep(_ o: ScanObservation) -> ScanKeep? {
        switch phase {
        case .sweep:
            guard regularKept < config.maxRegular, keptPositions.allSatisfy({ $0.distance(to: o.cameraTransform.translation) >= config.minBaselineM / 3 }) else { return nil }
            return keepRegular(o, manual: true)
        case .closeups:
            guard current < 4 else { return nil }
            let k = keepCloseup(o, corner: current, manual: true)
            advanceCorner(at: o.time)
            return k
        case .finished:
            return nil
        }
    }

    /// The person says the sweep is done. False (and "you stopped too early" until the next frame) with fewer than the least number of photos.
    @discardableResult
    public mutating func finishSweep(at time: Double? = nil) -> Bool {
        guard phase == .sweep else { return true }
        guard regularKept >= config.minRegular else {
            tooEarly = true
            return false
        }
        enterCloseups(at: time ?? lastTime ?? 0)
        return true
    }

    /// Give up on the corner being asked for (the person tapped Skip, or it took too long): on to the next.
    public mutating func skipCorner(at time: Double? = nil) {
        guard phase == .closeups, current < 4 else { return }
        closeupDone[current] = true
        advanceCorner(at: time ?? lastTime ?? 0)
    }

    // MARK: Motion and sharpness

    private mutating func measureMotion(_ o: ScanObservation, dt: Double) {
        let p = o.cameraTransform.translation
        let f = -o.cameraTransform.column(2)
        if let prev = previous, dt > 0 {
            let v = p.distance(to: prev.position) / dt
            let c = max(-1, min(1, (f.normalized ?? f).dot(prev.forward)))
            let w = acos(c) * 180 / .pi / dt
            // smoothed over a few frames: one jittery frame is not "too fast"
            speed = speed * 0.5 + v * 0.5
            turn = turn * 0.5 + w * 0.5
            motionSamples += 1
        }
        previous = (p, f.normalized ?? f, o.time)
    }

    private mutating func trackSharpness(_ s: Double?) {
        guard let s = s, s.isFinite, s >= 0 else { return }
        sharpReference = max(s, sharpReference * 0.998)
        sharpSamples += 1
    }

    private func isSharp(_ o: ScanObservation) -> Bool {
        guard let s = o.sharpness, sharpSamples >= 6, sharpReference > 1e-6 else { return true }
        return s >= config.sharpShare * sharpReference
    }

    private func isSteady(closeup: Bool) -> Bool {
        speed <= (closeup ? config.closeupMaxSpeedMps : config.maxSpeedMps) && turn <= (closeup ? config.closeupMaxTurnDps : config.maxTurnDps)
    }

    /// A reason the frame cannot be used, as the coaching for it; nil when the camera and the picture are fine.
    private func problem(_ o: ScanObservation, closeup: Bool) -> ScanCoach? {
        switch o.tracking {
        case .normal: break
        case .excessiveMotion: return ScanCoach(.tooFast)
        case .insufficientFeatures: return ScanCoach(o.meanLuma.map { $0 < config.minLuma } == true ? .tooDark : .lowDetail)
        case .limited, .unavailable: return ScanCoach(.trackingLimited)
        }
        if let l = o.meanLuma {
            if l < config.minLuma { return ScanCoach(.tooDark) }
            if l > config.maxLuma { return ScanCoach(.tooBright) }
        }
        if motionSamples >= 3, !isSteady(closeup: closeup) { return ScanCoach(.tooFast) }
        return nil
    }

    // MARK: The sweep

    private mutating func sweepStep(_ o: ScanObservation) -> ScanStep {
        let t = o.time
        let position = o.cameraTransform.translation
        let elapsed = t - (phaseStartedAt ?? t)
        let base = ScanCoach(tooEarly ? .stoppedTooEarly : .sweep)
        var coach = base
        var keep: ScanKeep?

        if let p = problem(o, closeup: false) {
            coach = p
        } else if motionSamples < 3 {
            // the speed is not known yet: the first moments of a scan keep nothing
        } else if let corners = o.windowCornersM, !windowInView(corners, o) {
            coach = ScanCoach(.windowNotInView)
        } else if !isSharp(o) {
            coach = ScanCoach(.tooFast)
        } else if regularKept >= config.maxRegular {
            coach = ScanCoach(.sweepDone)
        } else if t - lastKeepAt < config.minKeepGapS {
            coach = lastCoach
        } else if keptPositions.allSatisfy({ $0.distance(to: position) >= config.minBaselineM }) {
            keep = keepRegular(o, manual: false)
            tooEarly = false
        } else {
            let stalled = t - max(lastKeepAt, phaseStartedAt ?? t) > config.stallHintS
            coach = stalled ? ScanCoach(.stepFurther) : base
        }

        // The sweep ends by itself
        let enough = regularKept >= config.targetRegular
            || (regularKept >= 5 && elapsed >= config.sweepGoodAfterS)
            || (regularKept >= config.minRegular && elapsed >= config.sweepEnoughAfterS)
        if enough {
            enterCloseups(at: t)
            return closeupFirst(o, keepFromSweep: keep)
        }
        lastCoach = coach
        return step(o, coach: coach, keep: keep, target: nil)
    }

    private func windowInView(_ corners: [Vec3], _ o: ScanObservation) -> Bool {
        guard corners.count == 4 else { return true }
        let k = o.intrinsics
        let mx = k.width * config.viewMarginShare, my = k.height * config.viewMarginShare
        for p in corners {
            guard let px = ImageMapping.project(p, cameraTransform: o.cameraTransform, intrinsics: k) else { return false }
            if px.x < mx || px.x > k.width - mx || px.y < my || px.y > k.height - my { return false }
        }
        return true
    }

    private mutating func keepRegular(_ o: ScanObservation, manual: Bool) -> ScanKeep {
        keptPositions.append(o.cameraTransform.translation)
        lastKeepAt = o.time
        return ScanKeep(kind: .regular, manual: manual)
    }

    private mutating func enterCloseups(at t: Double) {
        phase = .closeups
        phaseStartedAt = t
        current = 0
        cornerSince = t
        dwell = 0
        lastKeepAt = t
    }

    /// The step of the frame that ended the sweep: it may itself have been kept as the last regular photo, and says what comes next.
    private func closeupFirst(_ o: ScanObservation, keepFromSweep: ScanKeep?) -> ScanStep {
        step(o, coach: ScanCoach(.sweepDone), keep: keepFromSweep, target: targetFor(o, corner: 0))
    }

    // MARK: The close-ups

    private mutating func closeupStep(_ o: ScanObservation, dt: Double) -> ScanStep {
        let t = o.time
        guard current < 4 else {
            phase = .finished
            return step(o, coach: ScanCoach(.allDone), keep: nil, target: nil)
        }
        guard o.windowCornersM != nil else {
            dwell = 0
            return step(o, coach: ScanCoach(.findingWindow, corner: current), keep: nil, target: nil)
        }
        let target = targetFor(o, corner: current)
        var coach = ScanCoach(.closeupHold, corner: current)
        var keep: ScanKeep?
        var progressing = false

        // Auto-skip a corner that never works
        if let since = cornerSince, t - since >= config.skipAutoS {
            closeupDone[current] = true
            advanceCorner(at: t)
            return step(o, coach: ScanCoach(.cornerDone, corner: current < 4 ? current : nil), keep: nil, target: current < 4 ? targetFor(o, corner: current) : nil)
        }
        if t - lastKeepAt < 0.6 {
            // Just took one: time to move on to the next corner
            coach = lastCoach
        } else if let tg = target, tg.offsetPortrait == nil {
            coach = ScanCoach(.cornerBehind, corner: current)
        } else if let tg = target, let d = tg.distanceM, d > config.farM {
            coach = ScanCoach(.closeupFar, corner: current)
        } else if let tg = target, let d = tg.distanceM, d < config.nearM {
            coach = ScanCoach(.closeupNear, corner: current)
        } else if let tg = target, !tg.centred {
            coach = ScanCoach(.closeupCentre, corner: current)
        } else if let p = problem(o, closeup: true) {
            coach = p
        } else if !isSharp(o) {
            coach = ScanCoach(.tooFast)
        } else {
            progressing = true
            dwell += dt
            if dwell >= config.dwellS { keep = keepCloseup(o, corner: current, manual: false) }
        }
        if !progressing { dwell = 0 }
        if let k = keep {
            advanceCorner(at: t)
            let next: ScanCoach = current < 4 ? ScanCoach(.cornerDone, corner: current) : ScanCoach(.allDone)
            lastCoach = next
            return step(o, coach: next, keep: k, target: current < 4 ? targetFor(o, corner: current) : nil)
        }
        lastCoach = coach
        return step(o, coach: coach, keep: nil, target: target)
    }

    private mutating func keepCloseup(_ o: ScanObservation, corner: Int, manual: Bool) -> ScanKeep {
        closeupDone[corner] = true
        closeupTaken[corner] = true
        lastKeepAt = o.time
        return ScanKeep(kind: .closeup, corner: corner, manual: manual)
    }

    private mutating func advanceCorner(at t: Double) {
        dwell = 0
        while current < 4, closeupDone[current] { current += 1 }
        cornerSince = t
        lastKeepAt = t
        if current >= 4 { phase = .finished }
    }

    private func targetFor(_ o: ScanObservation, corner: Int) -> ScanTarget? {
        guard let corners = o.windowCornersM, corners.count == 4, corner < 4 else { return nil }
        let p = corners[corner]
        let cam = o.cameraTransform.translation
        let distance = p.distance(to: cam)
        let k = o.intrinsics
        guard let px = ImageMapping.project(p, cameraTransform: o.cameraTransform, intrinsics: k) else {
            return ScanTarget(corner: corner, offsetPortrait: nil, distanceM: distance, centred: false, rightDistance: false)
        }
        let dx = px.x - k.width / 2, dy = px.y - k.height / 2
        let centred = abs(dx) <= config.centreShare * k.width && abs(dy) <= config.centreShare * k.height
        // native (right, down) -> upright portrait (right, down): the native image turned a quarter clockwise
        return ScanTarget(corner: corner, offsetPortrait: Vec2(-dy, dx), distanceM: distance, centred: centred,
                          rightDistance: distance >= config.nearM && distance <= config.farM)
    }

    // MARK: The answer

    private func step(_ o: ScanObservation, coach: ScanCoach, keep: ScanKeep?, target: ScanTarget?) -> ScanStep {
        let inPhase = o.time - (phaseStartedAt ?? o.time)
        let cornerFor = cornerSince.map { o.time - $0 } ?? 0
        return ScanStep(phase: phase, coach: coach, keep: keep, regularKept: regularKept, closeupsKept: closeupTaken, closeupsDone: closeupsDone, target: target,
                        holdProgress: phase == .closeups ? min(1, dwell / config.dwellS) : 0,
                        canFinishSweep: phase == .sweep && regularKept >= config.minRegular,
                        offerSkip: phase == .closeups && cornerFor >= config.skipOfferS,
                        phaseSeconds: inPhase,
                        needsWindowHelp: phase == .closeups && o.windowCornersM == nil && inPhase >= config.noWindowHelpS)
    }
}
