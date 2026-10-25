import Foundation
import RooflineCore

// Checks for the guided scan's decisions (ScanGuide.swift): which frames are kept, the coaching for each thing that can go wrong, the order of
// the close-ups. A synthetic phone is walked past a window at 60 frames a second.

private struct Rig {
    var guide = ScanGuide()
    var t = 0.0
    var scene = ScanScene()
    var keeps: [(time: Double, keep: ScanKeep, eye: Vec3)] = []
    var last: ScanStep?
    var windowKnown = true

    /// One camera frame at `eye`, looking at `target` (the window's middle by default).
    @discardableResult
    mutating func frame(_ eye: Vec3, look target: Vec3? = nil, tracking: ScanObservation.Tracking = .normal, luma: Double? = 120, sharp: Double? = 100, dt: Double = 1.0 / 60) -> ScanStep {
        t += dt
        let o = ScanObservation(time: t, cameraTransform: scanLookAt(eye, target ?? scene.centre), intrinsics: scanLens, tracking: tracking, meanLuma: luma, sharpness: sharp,
                                windowCornersM: windowKnown ? scene.corners : nil)
        let s = guide.update(o)
        if let k = s.keep { keeps.append((t, k, eye)) }
        last = s
        return s
    }

    /// Walk along x at `speed` m/s from `x0` for `seconds`, 2 m from the wall.
    mutating func walk(from x0: Double = -0.5, speed: Double = 0.12, seconds: Double, distance: Double = 2.0, stopWhen: ((ScanStep) -> Bool)? = nil) {
        let start = t
        while t - start < seconds {
            let x = x0 + speed * (t - start)
            let s = frame(Vec3(x, 1.4, scene.wallZ + distance))
            if stopWhen?(s) == true { return }
        }
    }

    /// Stand at `eye` for `seconds`.
    mutating func stand(_ eye: Vec3, look: Vec3? = nil, seconds: Double, luma: Double? = 120, sharp: Double? = 100) {
        let start = t
        while t - start < seconds { frame(eye, look: look, luma: luma, sharp: sharp) }
    }

    /// A rig that has finished its sweep and is asking for close-ups.
    static func inCloseups() -> Rig {
        var r = Rig()
        r.walk(seconds: 10) { $0.phase == .closeups }
        return r
    }

    func closeupEye(_ corner: Int, away: Double = 0.6) -> (eye: Vec3, look: Vec3) {
        let p = scene.corners[corner]
        return (Vec3(p.x, p.y, scene.wallZ + away), p)
    }
}

let scanGuideChecks: [Check] = [
    Check("ScanGuide sweep: walking past the window keeps 6 steady photos at least 15 cm apart, then asks for the close-ups") { ctx in
        var r = Rig()
        r.walk(seconds: 10) { $0.phase == .closeups }
        ctx.equal(r.guide.phase, .closeups)
        let regular = r.keeps.filter { $0.keep.kind == .regular }
        ctx.equal(regular.count, 6)
        ctx.expect(regular.allSatisfy { !$0.keep.manual })
        for i in 0..<regular.count {
            for j in (i + 1)..<max(regular.count, i + 1) { ctx.expect(regular[i].eye.distance(to: regular[j].eye) >= 0.15 - 1e-9, "photos \(i) and \(j) are \(regular[i].eye.distance(to: regular[j].eye)) m apart") }
        }
        ctx.expect(r.t < 9, "the sweep took \(r.t) s")
        ctx.equal(r.last?.coach, ScanCoach(.sweepDone))
        ctx.equal(r.last?.target?.corner, 0)
    },
    Check("ScanGuide coaching: too fast, too dark, too bright, lost tracking and too little detail each stop the photos and say why") { ctx in
        var r = Rig()
        r.walk(from: -0.5, speed: 0.8, seconds: 1.0)
        ctx.equal(r.keeps.count, 0, "nothing kept while walking at 0.8 m/s")
        ctx.equal(r.last?.coach, ScanCoach(.tooFast))
        var d = Rig()
        d.stand(Vec3(0, 1.4, 0), seconds: 0.5, luma: 12)
        ctx.equal(d.last?.coach, ScanCoach(.tooDark))
        ctx.equal(d.keeps.count, 0)
        var b = Rig()
        b.stand(Vec3(0, 1.4, 0), seconds: 0.5, luma: 252)
        ctx.equal(b.last?.coach, ScanCoach(.tooBright))
        var m = Rig()
        m.frame(Vec3(0, 1.4, 0), tracking: .excessiveMotion)
        ctx.equal(m.last?.coach, ScanCoach(.tooFast))
        m.frame(Vec3(0, 1.4, 0), tracking: .insufficientFeatures)
        ctx.equal(m.last?.coach, ScanCoach(.lowDetail))
        m.frame(Vec3(0, 1.4, 0), tracking: .insufficientFeatures, luma: 8)
        ctx.equal(m.last?.coach, ScanCoach(.tooDark))
        m.frame(Vec3(0, 1.4, 0), tracking: .limited)
        ctx.equal(m.last?.coach, ScanCoach(.trackingLimited))
        ctx.equal(m.keeps.count, 0)
        for c in [ScanCoach(.tooFast), ScanCoach(.tooDark), ScanCoach(.windowNotInView)] { ctx.expect(c.isProblem) }
        ctx.expect(!ScanCoach(.sweep).isProblem)
        ctx.expect(ScanCopy.text(ScanCoach(.sweep)) == "Step slowly left and right")
    },
    Check("ScanGuide coaching: the whole window must be in view once it is known; before that photos are not refused for it") { ctx in
        var r = Rig()
        r.stand(Vec3(0, 1.4, r.scene.wallZ + 0.9), seconds: 0.5)
        ctx.equal(r.last?.coach, ScanCoach(.windowNotInView))
        ctx.equal(r.keeps.count, 0)
        var k = Rig()
        k.windowKnown = false
        k.stand(Vec3(0, 1.4, k.scene.wallZ + 0.9), seconds: 0.5)
        ctx.equal(k.keeps.count, 1, "no window known yet: the first photo is kept")
        // stepping back until it fits keeps a photo
        var s = Rig()
        s.stand(Vec3(0, 1.4, s.scene.wallZ + 0.9), seconds: 0.3)
        s.stand(Vec3(0, 1.4, s.scene.wallZ + 2.0), seconds: 0.5)
        ctx.equal(s.keeps.count, 1)
    },
    Check("ScanGuide coaching: a blurred frame is not kept, a sharp one is") { ctx in
        var r = Rig()
        // the sharp reference is learned first
        for _ in 0..<12 { r.frame(Vec3(-0.5, 1.4, 0), sharp: 100) }
        let before = r.keeps.count
        r.stand(Vec3(0, 1.4, 0), seconds: 0.4, sharp: 20)
        ctx.equal(r.keeps.count, before, "20 against a reference of 100")
        ctx.equal(r.last?.coach, ScanCoach(.tooFast))
        r.stand(Vec3(0.2, 1.4, 0), seconds: 0.4, sharp: 90)
        ctx.equal(r.keeps.count, before + 1)
    },
    Check("ScanGuide: standing still says to step further; stopping with two photos says you stopped too early, with three it moves on") { ctx in
        var r = Rig()
        r.stand(Vec3(0, 1.4, 0), seconds: 4)
        ctx.equal(r.keeps.count, 1, "standing still keeps one photo, not many")
        ctx.equal(r.last?.coach, ScanCoach(.stepFurther))
        r.stand(Vec3(0.2, 1.4, 0), seconds: 0.5)
        ctx.equal(r.keeps.count, 2)
        ctx.expect(!(r.last?.canFinishSweep ?? true))
        ctx.expect(!r.guide.finishSweep())
        r.frame(Vec3(0.2, 1.4, 0))
        ctx.equal(r.last?.coach, ScanCoach(.stoppedTooEarly))
        ctx.equal(r.guide.phase, .sweep)
        r.stand(Vec3(0.4, 1.4, 0), seconds: 0.5)
        ctx.equal(r.keeps.count, 3)
        ctx.expect(r.last?.canFinishSweep == true)
        ctx.expect(r.guide.finishSweep())
        ctx.equal(r.guide.phase, .closeups)
    },
    Check("ScanGuide: the manual shutter keeps a photo the rules would not, but not two on the same spot") { ctx in
        var r = Rig()
        r.frame(Vec3(0, 1.4, 0), luma: 8)
        var o = ScanObservation(time: r.t, cameraTransform: scanLookAt(Vec3(0, 1.4, 0), r.scene.centre), intrinsics: scanLens, meanLuma: 8, windowCornersM: r.scene.corners)
        ctx.equal(r.guide.manualKeep(o), ScanKeep(kind: .regular, manual: true))
        ctx.equal(r.guide.manualKeep(o), nil, "same spot")
        o.cameraTransform = scanLookAt(Vec3(0.3, 1.4, 0), r.scene.centre)
        ctx.equal(r.guide.manualKeep(o)?.manual, true)
        ctx.equal(r.guide.regularKept, 2)
    },
    Check("ScanGuide close-ups: too far, too near and off-centre are each coached, with the arrow's direction, and nothing is kept") { ctx in
        var r = Rig.inCloseups()
        let tl = r.closeupEye(0, away: 1.6)
        r.stand(tl.eye, look: tl.look, seconds: 1)
        ctx.equal(r.last?.coach, ScanCoach(.closeupFar, corner: 0))
        ctx.equal(r.keeps.filter { $0.keep.kind == .closeup }.count, 0)
        let near = r.closeupEye(0, away: 0.25)
        r.stand(near.eye, look: near.look, seconds: 1)
        ctx.equal(r.last?.coach, ScanCoach(.closeupNear, corner: 0))
        // 0.6 m away but looking at the window's middle: the corner is off to the side
        r.stand(r.closeupEye(0).eye, look: r.scene.centre, seconds: 1)
        ctx.equal(r.last?.coach, ScanCoach(.closeupCentre, corner: 0))
        guard let t = r.last?.target?.offsetPortrait else { return ctx.expect(false, "no target offset") }
        // the top-left corner lies up and to the left of a picture aimed at the middle: portrait offset points left (and up)
        ctx.expect(abs(t.x) + abs(t.y) > 100, "offset \(t)")
        ctx.expect(r.last?.target?.centred == false)
        ctx.expect(r.last?.target?.rightDistance == true)
        ctx.equal(ScanCopy.text(ScanCoach(.closeupFar, corner: 0)), "Move closer to the top-left corner")
        ctx.equal(ScanCopy.text(ScanCoach(.closeupCentre, corner: 2)), "Centre the bottom-right corner")
    },
    Check("ScanGuide close-ups: each corner is taken by itself once centred, near, steady and sharp, in the order TL, TR, BR, BL, then the scan is finished") { ctx in
        var r = Rig.inCloseups()
        var order: [Int] = []
        for c in 0..<4 {
            let p = r.closeupEye(c)
            // arrives, then holds still
            r.stand(p.eye, look: p.look, seconds: 0.7)
            let hold = r.last?.holdProgress ?? 0
            ctx.expect(hold > 0 && hold < 1.0 || r.keeps.last?.keep.corner == c, "the ring fills while holding (\(hold))")
            r.stand(p.eye, look: p.look, seconds: 0.8)
            if let k = r.keeps.last, k.keep.kind == .closeup { order.append(k.keep.corner ?? -1) }
            if c < 3 { ctx.equal(r.last?.target?.corner, c + 1, "next target after corner \(c)") }
        }
        ctx.equal(order, [0, 1, 2, 3])
        ctx.equal(r.guide.phase, .finished)
        ctx.equal(r.last?.closeupsKept, [true, true, true, true])
        ctx.equal(r.last?.coach, ScanCoach(.allDone))
        ctx.equal(r.keeps.filter { $0.keep.kind == .closeup }.count, 4)
    },
    Check("ScanGuide close-ups: a shaky hand does not take the close-up; the Skip offer comes after 12 s and the corner is skipped by itself after 25 s") { ctx in
        var r = Rig.inCloseups()
        let p = r.closeupEye(0)
        // jittering 4 cm each frame: far too fast
        for i in 0..<60 { r.frame(p.eye + Vec3(i % 2 == 0 ? 0.02 : -0.02, 0, 0), look: p.look) }
        ctx.equal(r.keeps.filter { $0.keep.kind == .closeup }.count, 0)
        ctx.equal(r.last?.coach, ScanCoach(.tooFast))
        ctx.expect(r.last?.offerSkip == false)
        for i in 0..<(60 * 12) { r.frame(p.eye + Vec3(i % 2 == 0 ? 0.02 : -0.02, 0, 0), look: p.look) }
        ctx.expect(r.last?.offerSkip == true)
        ctx.equal(r.guide.current, 0)
        for i in 0..<(60 * 14) { r.frame(p.eye + Vec3(i % 2 == 0 ? 0.02 : -0.02, 0, 0), look: p.look) }
        ctx.equal(r.guide.current, 1, "skipped by itself")
        ctx.equal(r.last?.closeupsKept, [false, false, false, false])
        // Skip by hand
        r.guide.skipCorner()
        ctx.equal(r.guide.current, 2)
        ctx.equal(r.guide.closeupsDone, 2)
    },
    Check("ScanGuide close-ups: without a window the phone says it is finding it, and asks for help after five seconds") { ctx in
        var r = Rig()
        r.windowKnown = false
        r.walk(seconds: 12) { $0.phase == .closeups }
        ctx.equal(r.guide.phase, .closeups)
        r.stand(Vec3(0, 1.4, 0), seconds: 1)
        ctx.equal(r.last?.coach, ScanCoach(.findingWindow, corner: 0))
        ctx.expect(r.last?.needsWindowHelp == false)
        r.stand(Vec3(0, 1.4, 0), seconds: 5)
        ctx.expect(r.last?.needsWindowHelp == true)
        // then the corners come
        r.windowKnown = true
        let p = r.closeupEye(0)
        r.stand(p.eye, look: p.look, seconds: 1)
        ctx.equal(r.keeps.last?.keep.corner, 0)
    },
]
