import Foundation
import RooflineCore

// Checks for the room-scan hybrid (RoomHybrid.swift): Apple's window as the scan's first estimate, the pan photos each window keeps, the close-ups
// that start straight away, the world watch, and the flow from pan to results. The scenes are the scan checks' made-up window on a wall 2 m away.

/// A RoomPlan window surface for the scan check scene: its centre, its size, the wall facing +z (toward the room), with the size off by `grow` metres.
private func appleSurface(_ s: ScanScene, grow: Double = 0, shift: Vec3 = .zero, polygon: [Vec3] = [], confidence: RoomPlanConfidence = .high) -> ScanSurface {
    let t = Mat4.rigid(right: Vec3(1, 0, 0), up: Vec3(0, 1, 0), back: Vec3(0, 0, 1), origin: s.centre + shift)
    return ScanSurface(widthM: s.widthM + grow, heightM: s.heightM + grow, transform: t, polygon: polygon, confidence: confidence)
}

/// One pan photo at `eye` looking at `target`.
private func panMeta(_ id: Int, _ eye: Vec3, look target: Vec3, sharp: Double = 100, time: Double? = nil) -> PanFrameMeta {
    PanFrameMeta(id: id, time: time ?? Double(id) * 0.1, cameraTransform: scanLookAt(eye, target), intrinsics: scanLens, sharpness: sharp)
}

/// A synthetic hand walking past the window, feeding a `PanFrameKeeper` 20 times a second.
private struct PanRig {
    var keeper = PanFrameKeeper()
    var scene = ScanScene()
    var t = 0.0
    var kept: [(id: String, eye: Vec3)] = []

    mutating func frame(_ eye: Vec3, look target: Vec3? = nil, windows: [PanFrameKeeper.Window]? = nil, luma: Double = 120, sharp: Double = 100) {
        t += 0.05
        let o = ScanObservation(time: t, cameraTransform: scanLookAt(eye, target ?? scene.centre), intrinsics: scanLens, tracking: .normal, meanLuma: luma, sharpness: sharp)
        let w = windows ?? [PanFrameKeeper.Window(id: "A", cornersM: scene.corners)]
        for id in keeper.update(o, windows: w) { kept.append((id, eye)) }
    }

    mutating func walk(seconds: Double, speed: Double = 0.1, from x0: Double = -0.6, windows: [PanFrameKeeper.Window]? = nil) {
        let start = t
        while t - start < seconds {
            frame(Vec3(x0 + speed * (t - start), 1.4, scene.wallZ + 2), windows: windows)
        }
    }
}

let roomHybridChecks: [Check] = [
    Check("Hybrid estimate: RoomPlan's transform and dimensions become the level rectangle the scan starts from, in the world, facing the room") { ctx in
        let s = ScanScene()
        // RoomPlan's frame rolled 3 degrees about the wall's normal: the window is still level
        let r = 3.0 * .pi / 180
        let t = Mat4.rigid(right: Vec3(cos(r), sin(r), 0), up: Vec3(-sin(r), cos(r), 0), back: Vec3(0, 0, 1), origin: s.centre)
        let surface = ScanSurface(widthM: s.widthM, heightM: s.heightM, transform: t, confidence: .medium)
        guard let e = HybridEstimate.from(surface, viewer: Vec3(0, 1.4, 0)) else { return ctx.expect(false, "an estimate") }
        ctx.equal(e.cornersM.count, 4)
        for (i, c) in e.cornersM.enumerated() { ctx.near(c.distance(to: s.corners[i]), 0, 1e-9, "corner \(i) is where the window's is") }
        ctx.near(e.cornersM[0].y, e.cornersM[1].y, 1e-9, "top is level")
        ctx.near(e.cornersM[2].y, e.cornersM[3].y, 1e-9, "bottom is level")
        ctx.near(e.widthIn, 36, 1e-6)
        ctx.near(e.heightIn, 60, 1e-6)
        ctx.equal(e.basis, .dimensions)
        ctx.equal(e.confidence, .medium)
        // the wall: through the corners, facing the room (the viewer is at z = 0, the wall at z = -2)
        ctx.near(e.wall.normal.z, 1, 1e-9, "the wall faces the room")
        for c in e.cornersM { ctx.near(e.wall.distance(c), 0, 1e-9, "every corner is on the wall") }
        // the same estimate from the four corners alone (what the app holds after Apple's scan)
        let again = HybridEstimate(cornersM: e.cornersM, widthM: e.widthM, heightM: e.heightM, confidence: e.confidence, basis: e.basis, viewer: Vec3(0, 1.4, 0))
        ctx.equal(again, e)
        ctx.expect(HybridEstimate(cornersM: Array(e.cornersM.prefix(3)), widthM: 1, heightM: 1, confidence: .high, basis: .dimensions) == nil, "four corners or none")
        // Apple's size as the window's roomplan scale
        ctx.near(e.appleScale.widthM, s.widthM, 1e-12)
        ctx.equal(e.appleScale.confidence, .medium)
        // seen from behind the wall the plane faces that way and left and right swap
        let behind = HybridEstimate.from(surface, viewer: Vec3(0, 1.4, -6))
        ctx.near(behind?.wall.normal.z, -1, 1e-9)
        ctx.expect((behind?.cornersM[0].x ?? -1) > (behind?.cornersM[1].x ?? 1), "mirrored from behind")
    },
    Check("Hybrid estimate: a sensible outline replaces the dimensions; a window that is not believable gives no estimate") { ctx in
        let s = ScanScene()
        let w = s.widthM + 0.01, h = s.heightM - 0.012
        let local = [Vec3(-w / 2, h / 2, 0), Vec3(w / 2, h / 2, 0), Vec3(w / 2, -h / 2, 0), Vec3(-w / 2, -h / 2, 0)]
        let e = HybridEstimate.from(appleSurface(s, polygon: local), viewer: Vec3(0, 1.4, 0))
        ctx.equal(e?.basis, .outline)
        ctx.near(e?.widthM, w, 1e-9)
        ctx.near(e?.heightM, h, 1e-9)
        ctx.expect(HybridEstimate.from(ScanSurface(widthM: 0.05, heightM: 1, transform: .identity, confidence: .high), viewer: nil) == nil, "5 cm wide is not a window")
        ctx.expect(HybridEstimate.from(ScanSurface(widthM: .nan, heightM: 1, transform: .identity, confidence: .high), viewer: nil) == nil, "not a number")
    },
    Check("Hybrid estimate: Apple's window, 3 cm off on every side, starts a scan that comes out measured to 1/16 in with the widened first search") { ctx in
        let s = ScanScene()
        // Apple has the window 4 cm too big and 2.5 cm to one side: the kind of error a room scan makes
        let apple = appleSurface(s, grow: 0.04, shift: Vec3(0.025, 0, 0))
        guard let e = HybridEstimate.from(apple, viewer: Vec3(0, 1.4, 0)) else { return ctx.expect(false, "an estimate") }
        ctx.expect((e.maxCornerDistance(to: s.corners) ?? 0) > 0.03, "the estimate is really off")
        // the pan's photos (4 of them, from a few steps along the wall) and a close-up of each corner
        let frames = s.regularFrames(4, spread: 1.0) + s.closeupFrames()
        let wide = ScanMarkMaker.run(frames: frames, estimate: e.cornersM, keyFrameId: "r1", keySource: .projected, wall: e.wall, snapper: scanSnapper(s, sigmaPx: 0.8), radiusScale: HybridRules.firstSearchScale)
        ctx.near(wide.solution.widthIn, 36, 1.0 / 16)
        ctx.near(wide.solution.heightIn, 60, 1.0 / 16)
        ctx.equal(wide.solution.status, .measured, "\(wide.solution.quality)")
        ctx.equal(wide.solution.quality.closeups, 4)
        // the same estimate with the guided scan's own (narrower) search: 4 cm is beyond its 3 cm, so the first pass finds less. Not a wrong answer: it is
        // never better than the widened one
        let narrow = ScanMarkMaker.run(frames: frames, estimate: e.cornersM, keyFrameId: "r1", keySource: .projected, wall: e.wall, snapper: scanSnapper(s, sigmaPx: 0.8))
        ctx.expect(narrow.used.count <= wide.used.count, "the wider search finds at least as many marks (\(narrow.used.count) vs \(wide.used.count))")
        // a key-frame corner the picture does not confirm is NOT trusted just because the estimate put it there
        let unclear = ScanMarkMaker.run(frames: frames, estimate: s.corners, keyFrameId: "r1", keySource: .projected, wall: e.wall,
                                        snapper: scanSnapper(s, unclear: ["r1#0"]), secondPass: false)
        ctx.expect(!unclear.used.contains { $0.frameId == "r1" && $0.corner == 0 }, "Apple's guess is a hollow projection, not evidence")
    },
    Check("Hybrid estimate: when Apple has two corners 3.5 cm out and the picture only sees corners that are near, the two good opposite corners complete the level rectangle") { ctx in
        let s = ScanScene()
        let truth = s.corners
        // Apple's TL and BR are within 1 cm; its TR and BL are 3.5 cm out (a window a few centimetres too wide and a little off to one side)
        let estimate = [truth[0] + Vec3(-0.008, 0.006, 0), truth[1] + Vec3(0.035, 0.012, 0), truth[2] + Vec3(0.007, -0.007, 0), truth[3] + Vec3(-0.035, -0.012, 0)]
        let frames = s.regularFrames(4, spread: 1.0) + s.closeupFrames()
        // a corner finder that can only see a corner within 2 cm of where it is looked for (a look-alike edge wins further out)
        func limited(_ maxErrM: Double) -> ScanMarkMaker.Snapper {
            var noise = ScanNoise(seed: 5)
            return { frame, corner, approx, _ in
                guard let p = WindowScanSolver.project(truth[corner], in: frame) else { return nil }
                let depth = frame.cameraTransform.translation.distance(to: truth[corner])
                guard hypot(p.x - approx.x, p.y - approx.y) * depth / frame.intrinsics.fx <= maxErrM else { return nil }
                return Vec2(p.x + noise.next() * 0.6, p.y + noise.next() * 0.6)
            }
        }
        let plain = ScanMarkMaker.run(frames: frames, estimate: estimate, keyFrameId: "r1", keySource: .projected, wall: s.wall, snapper: limited(0.02), radiusScale: HybridRules.firstSearchScale)
        ctx.expect(plain.solution.status != .measured, "without the bootstrap the far corners are never found: \(plain.solution.quality)")
        let boot = ScanMarkMaker.run(frames: frames, estimate: estimate, keyFrameId: "r1", keySource: .projected, wall: s.wall, snapper: limited(0.02),
                                     radiusScale: HybridRules.firstSearchScale, bootstrap: true)
        ctx.near(boot.solution.widthIn, 36, 1.0 / 16)
        ctx.near(boot.solution.heightIn, 60, 1.0 / 16)
        ctx.equal(boot.solution.status, .measured, "\(boot.solution.quality)")
        // the improved estimate on its own: the opposite corners that were found, completed to a level rectangle within 1.5 cm of the truth
        let seen = ScanMarkMaker.marks(corners: estimate, frames: frames, keyFrameId: "r1", keySource: .projected, radiusM: ScanMarkMaker.firstRadiusM * HybridRules.firstSearchScale,
                                       closeupRadiusM: ScanMarkMaker.firstCloseupRadiusM * HybridRules.firstSearchScale, snapper: limited(0.02))
        guard let better = ScanMarkMaker.improvedEstimate(estimate: estimate, marks: ScanMarkMaker.evidence(seen), frames: frames, wall: s.wall) else { return ctx.expect(false, "an improved estimate") }
        for c in 0..<4 { ctx.expect(better[c].distance(to: truth[c]) < 0.015, "corner \(c) is \(better[c].distance(to: truth[c])) m out") }
        ctx.near(better[0].y, better[1].y, 1e-9, "level")
        ctx.near(better[0].x, better[3].x, 1e-9, "plumb")
        // nothing confirmed, nothing improved; a corner far from the estimate is not believed
        ctx.expect(ScanMarkMaker.improvedEstimate(estimate: estimate, marks: [], frames: frames, wall: s.wall) == nil)
        ctx.expect(ScanMarkMaker.improvedEstimate(estimate: truth.map { $0 + Vec3(0.3, 0, 0) }, marks: ScanMarkMaker.evidence(seen), frames: frames, wall: s.wall) == nil, "found corners 30 cm from the estimate are not the estimate's corners")
    },
    Check("Pan keeper: panning on the spot (no baseline) still keeps photos, about 8 degrees apart, because the close-ups give the baseline") { ctx in
        var r = PanRig()
        let eye = Vec3(0, 1.4, r.scene.wallZ + 2)
        // turning slowly from 12 degrees left of the window to 12 degrees right of it (2 degrees a second), the window whole in the picture
        let start = r.t
        while r.t - start < 12 {
            let deg = -12 + 2 * (r.t - start)
            let target = Vec3(r.scene.centre.x + 2.0 * tan(deg * .pi / 180), r.scene.centre.y, r.scene.wallZ)
            r.frame(eye, look: target)
        }
        let n = r.kept.count
        ctx.expect(n >= 2 && n <= 4, "\(n) photos from one spot")
        // a guide without the turn rule keeps one
        var strict = PanRig()
        var cfg = PanFrameKeeper.panConfig
        cfg.minTurnDeg = 0
        strict.keeper = PanFrameKeeper(config: cfg)
        let s0 = strict.t
        while strict.t - s0 < 12 {
            let deg = -12 + 2 * (strict.t - s0)
            strict.frame(eye, look: Vec3(strict.scene.centre.x + 2.0 * tan(deg * .pi / 180), strict.scene.centre.y, strict.scene.wallZ))
        }
        ctx.equal(strict.kept.count, 1, "without it, only the first photo is 15 cm from the others")
    },
    Check("Pan photos: a window keeps frames that see all of it, at least 15 cm apart, the sharpest first, at most eight") { ctx in
        let s = ScanScene()
        // 25 photos, 5 cm apart along the wall, 2 m back; photo 12 is the sharpest
        var frames: [PanFrameMeta] = []
        for i in 0..<25 { frames.append(panMeta(i, Vec3(-0.6 + 0.05 * Double(i), 1.4, s.wallZ + 2), look: s.centre, sharp: i == 12 ? 300 : 100)) }
        let ids = PanFrameSelector.select(frames, corners: s.corners)
        ctx.expect(ids.count >= 5 && ids.count <= PanFrameSelector.maxFrames, "\(ids.count) photos")
        ctx.equal(ids.first, 12, "the sharpest, most front-on photo is the key photo")
        let picked = ids.map { id in frames.first { $0.id == id }! }
        for i in 0..<picked.count {
            for j in (i + 1)..<max(picked.count, i + 1) {
                ctx.expect(picked[i].cameraTransform.translation.distance(to: picked[j].cameraTransform.translation) >= 0.15 - 1e-9, "photos \(ids[i]) and \(ids[j]) are too close")
            }
        }
        ctx.equal(PanFrameSelector.select(frames, corners: s.corners, limit: 3).count, 3)
        ctx.equal(PanFrameSelector.select(frames, corners: s.corners, limit: 0), [])
        ctx.equal(PanFrameSelector.select([], corners: s.corners), [])
    },
    Check("Pan photos: a photo that cuts the window off, looks away or sees only part of it is not kept for that window") { ctx in
        let s = ScanScene()
        let good = panMeta(1, Vec3(0, 1.4, s.wallZ + 2), look: s.centre)
        // aimed so far left that the window's right side is out of the picture
        let cutOff = panMeta(2, Vec3(0.4, 1.4, s.wallZ + 2), look: s.centre + Vec3(-1.6, 0, 0))
        // right up against the wall: the window is bigger than the picture
        let tooClose = panMeta(3, Vec3(0, 1.4, s.wallZ + 0.4), look: s.centre)
        // facing the other way
        let away = panMeta(4, Vec3(0, 1.4, s.wallZ + 2), look: Vec3(0, 1.4, s.wallZ + 6))
        ctx.expect(PanFrameSelector.sees(good, corners: s.corners))
        for (name, f) in [("cut off", cutOff), ("too close", tooClose), ("looking away", away)] {
            ctx.expect(!PanFrameSelector.sees(f, corners: s.corners), name)
        }
        ctx.equal(PanFrameSelector.select([good, cutOff, tooClose, away], corners: s.corners), [1])
        // two windows on one wall: each keeps the photos that see IT
        let other = (s.corners).map { $0 + Vec3(2.2, 0, 0) }
        let aimedAtOther = panMeta(5, Vec3(2.2, 1.4, s.wallZ + 2), look: s.centre + Vec3(2.2, 0, 0))
        ctx.equal(PanFrameSelector.select([good, aimedAtOther], corners: other), [5])
        ctx.equal(PanFrameSelector.select([good, aimedAtOther], corners: s.corners), [1])
    },
    Check("Pan photos: panning on the spot (no baseline) still gives each window a few photos, from different turns") { ctx in
        let s = ScanScene()
        // the phone stays within 1 cm and turns 2 degrees between photos
        var frames: [PanFrameMeta] = []
        for i in 0..<12 {
            let turn = (Double(i) - 6) * 2.0 * .pi / 180
            let target = Vec3(s.centre.x + 2.0 * tan(turn), s.centre.y, s.centre.z)
            frames.append(panMeta(i, Vec3(0.002 * Double(i), 1.4, s.wallZ + 2), look: target))
        }
        let ids = PanFrameSelector.select(frames, corners: s.corners)
        ctx.equal(ids.count, PanFrameSelector.wantFrames, "three photos from different turns")
        let looks = ids.map { id in -frames.first { $0.id == id }!.cameraTransform.column(2) }
        for i in 0..<looks.count {
            for j in (i + 1)..<max(looks.count, i + 1) {
                let deg = acos(max(-1, min(1, looks[i].dot(looks[j])))) * 180 / .pi
                ctx.expect(deg >= PanFrameSelector.relaxedTurnDeg - 1e-6, "photos turned only \(deg) degrees apart")
            }
        }
    },
    Check("Pan keeper: walking past the window keeps steady, sharp photos at least 15 cm apart for it, and none for a window that is never in view") { ctx in
        var r = PanRig()
        let elsewhere = PanFrameKeeper.Window(id: "B", cornersM: r.scene.corners.map { $0 + Vec3(40, 0, 0) })
        let both = [PanFrameKeeper.Window(id: "A", cornersM: r.scene.corners), elsewhere]
        r.walk(seconds: 12, windows: both)
        let a = r.kept.filter { $0.id == "A" }
        ctx.expect(a.count >= 3 && a.count <= ScanGuideConfig().maxRegular, "\(a.count) photos for A")
        ctx.equal(r.kept.filter { $0.id == "B" }.count, 0, "B is never in view")
        for i in 0..<a.count {
            for j in (i + 1)..<max(a.count, i + 1) { ctx.expect(a[i].eye.distance(to: a[j].eye) >= 0.15 - 1e-9, "photos \(i) and \(j) are too close") }
        }
        ctx.equal(r.keeper.kept("A"), a.count)
        // it stops asking once it has what it wants
        let before = r.kept.count
        r.walk(seconds: 6, from: -0.6, windows: both)
        ctx.expect(r.kept.count - before <= 2, "a window that has its photos takes (almost) no more")
    },
    Check("Pan keeper: a fast pan, a dark room or a blurred frame keeps nothing; a window half out of the picture keeps nothing") { ctx in
        var fast = PanRig()
        fast.walk(seconds: 3, speed: 0.9)
        ctx.equal(fast.kept.count, 0, "walking at 0.9 m/s")
        var dark = PanRig()
        let still = Vec3(0, 1.4, dark.scene.wallZ + 2)
        for _ in 0..<40 { dark.frame(still, luma: 10) }
        ctx.equal(dark.kept.count, 0, "too dark")
        var half = PanRig()
        for i in 0..<60 { half.frame(Vec3(0.002 * Double(i), 1.4, half.scene.wallZ + 2), look: half.scene.centre + Vec3(-1.5, 0, 0)) }
        ctx.equal(half.kept.count, 0, "the window is cut off")
        // a blurred frame among sharp ones: after the guide has seen sharp ones, a frame under half the sharpest is not kept
        var blur = PanRig()
        blur.walk(seconds: 1.5, speed: 0.1)
        let n = blur.kept.count
        blur.frame(Vec3(0.9, 1.4, blur.scene.wallZ + 2), sharp: 10)
        ctx.equal(blur.kept.count, n, "a blurred frame is not kept")
    },
    Check("World watch: a hand's pan is the same world; a jump no hand makes, or tracking gone for 8 s, starts a new one") { ctx in
        var w = WorldWatch()
        var t = 0.0
        var moved = false
        // walking at 1.5 m/s and turning at 90 degrees a second, 20 looks a second
        for i in 0..<100 {
            t += 0.05
            let eye = Vec3(0.075 * Double(i), 1.4, 0)
            let target = eye + Vec3(sin(Double(i) * 0.0785), 0, -cos(Double(i) * 0.0785))
            moved = moved || w.update(time: t, cameraTransform: scanLookAt(eye, target), tracking: .normal)
        }
        ctx.expect(!moved)
        ctx.equal(w.epoch, 0)
        // the session restarts: the phone is "back at the origin" a moment later
        t += 0.05
        ctx.expect(w.update(time: t, cameraTransform: scanLookAt(Vec3(0, 1.4, 0), Vec3(0, 1.4, -1)), tracking: .normal))
        ctx.equal(w.epoch, 1)
        // the world turned by 120 degrees between two looks
        t += 0.05
        ctx.expect(w.update(time: t, cameraTransform: scanLookAt(Vec3(0, 1.4, 0), Vec3(-0.87, 1.4, 0.5)), tracking: .normal))
        ctx.equal(w.epoch, 2)
        // the app slept for a minute: nothing can be said, so nothing is claimed
        t += 60
        ctx.expect(!w.update(time: t, cameraTransform: scanLookAt(Vec3(3, 1.4, 3), Vec3(3, 1.4, 4)), tracking: .normal))
        // tracking gone for 8 seconds
        var lost = WorldWatch()
        var any = false
        var u = 0.0
        for _ in 0..<(8 * 20 + 2) {
            u += 0.05
            any = any || lost.update(time: u, cameraTransform: scanLookAt(Vec3(0, 1.4, 0), Vec3(0, 1.4, -1)), tracking: .unavailable)
        }
        ctx.expect(any)
        ctx.equal(lost.epoch, 1)
        // limited tracking that comes back is not a lost world
        var limited = WorldWatch()
        for i in 0..<400 { limited.update(time: Double(i) * 0.05, cameraTransform: scanLookAt(Vec3(0, 1.4, 0), Vec3(0, 1.4, -1)), tracking: i % 50 < 30 ? .unavailable : .normal) }
        ctx.equal(limited.epoch, 0)
    },
    Check("Close-ups from the first frame: a guide that starts at the close-ups asks for the top-left corner at once and takes it when centred, near and steady") { ctx in
        let s = ScanScene()
        var g = ScanGuide(startAtCloseups: true)
        var t = 0.0
        var step: ScanStep?
        func look(_ eye: Vec3, _ target: Vec3, frames: Int) {
            for _ in 0..<frames {
                t += 1.0 / 30
                step = g.update(ScanObservation(time: t, cameraTransform: scanLookAt(eye, target), intrinsics: scanLens, meanLuma: 120, sharpness: 100, windowCornersM: s.corners))
            }
        }
        look(Vec3(0, 1.4, s.wallZ + 2), s.centre, frames: 1)
        ctx.equal(g.phase, .closeups)
        ctx.equal(step?.phase, .closeups)
        ctx.equal(step?.target?.corner, 0)
        ctx.equal(g.regularKept, 0, "no pan photos in the guide: they were taken another way")
        // go to the top-left corner, 0.6 m away, and hold still
        var kept: [ScanKeep] = []
        for corner in 0..<4 {
            let p = s.corners[corner]
            for _ in 0..<40 {
                t += 1.0 / 30
                let st = g.update(ScanObservation(time: t, cameraTransform: scanLookAt(Vec3(p.x, p.y, s.wallZ + 0.6), p), intrinsics: scanLens, meanLuma: 120, sharpness: 100, windowCornersM: s.corners))
                if let k = st.keep { kept.append(k) }
                step = st
            }
        }
        ctx.equal(kept.map { $0.corner }, [0, 1, 2, 3])
        ctx.expect(kept.allSatisfy { $0.kind == .closeup && !$0.manual })
        ctx.equal(g.phase, .finished)
        ctx.equal(step?.closeupsKept, [true, true, true, true])
        // the default guide still begins with the sweep
        var normal = ScanGuide()
        let first = normal.update(ScanObservation(time: 0, cameraTransform: scanLookAt(Vec3(0, 1.4, 0), s.centre), intrinsics: scanLens, windowCornersM: s.corners))
        ctx.equal(first.phase, .sweep)
    },
    Check("Hybrid flow: pan, list, close-ups in any order, skip, Measure and check, results") { ctx in
        var f = HybridFlow()
        ctx.equal(f.stage, .panning)
        f.stopPanning()
        ctx.equal(f.stage, .building)
        let a = HybridItem(id: "a", letter: "A", widthM: 0.9, heightM: 1.2, confidence: .high, panFrames: 3)
        let b = HybridItem(id: "b", letter: "B", widthM: 0.6, heightM: 1.0, confidence: .medium, panFrames: 2)
        let c = HybridItem(id: "c", letter: "C", widthM: 1.5, heightM: 1.2, confidence: .low, panFrames: 2)
        // the pan hardly saw D: close-ups of it would be no use
        let d = HybridItem(id: "d", letter: "D", widthM: 0.5, heightM: 0.5, confidence: .low, panFrames: 1)
        f.built([a, b, c, d])
        ctx.equal(f.stage, .windows)
        ctx.equal(f.items.count, 4)
        ctx.expect(!f.openCloseups("d"), "a window the pan hardly saw takes no close-ups")
        ctx.equal(HybridWording.rowStatus(f.item("d")!), "Not seen well enough to measure. Keeps Apple's size")
        ctx.expect(!f.canMeasure, "nothing yet: the button is off")
        ctx.equal(f.startMeasuring(), [], "pressing it does nothing")
        ctx.equal(f.stage, .windows)
        // C first, then A: any order
        ctx.expect(f.openCloseups("c"))
        ctx.equal(f.stage, .closeups("c"))
        ctx.expect(!f.openCloseups("a"), "one window at a time")
        f.closeupsDone(corners: [true, true, true, true])
        ctx.equal(f.stage, .windows)
        ctx.expect(f.item("c")?.isFinished == true)
        ctx.equal(HybridWording.rowStatus(f.item("c")!), "4 close-ups")
        ctx.expect(f.canMeasure, "one window with close-ups is enough")
        ctx.expect(f.openCloseups("a"))
        f.closeupsDone(corners: [true, false, true, false])
        ctx.equal(HybridWording.rowStatus(f.item("a")!), "2 of 4 close-ups")
        // B is skipped; a skipped window is never measured
        f.setSkipped("b", true)
        ctx.equal(HybridWording.rowStatus(f.item("b")!), "Skipped. Keeps Apple's size")
        ctx.equal(f.qualifying.map { $0.id }, ["a", "c"])
        // the pan alone can be enough (c had 1 photo; give another window 4 of them)
        ctx.equal(f.startMeasuring(), ["a", "c"])
        ctx.equal(f.stage, .measuring)
        f.record("a", .measured)
        f.record("c", .check)
        f.finishMeasuring()
        ctx.equal(f.stage, .results)
        ctx.equal(f.item("a")?.outcome, .measured)
        ctx.equal(f.item("c")?.outcome, .check)
        ctx.equal(f.item("b")?.outcome, .appleSize, "the skipped window keeps Apple's size")
        ctx.equal(f.item("d")?.outcome, .appleSize, "so does the one nobody could measure")
        ctx.equal(f.measuredCount, 1)
        ctx.equal(f.checkCount, 1)
        // a mark moved on the results screen can turn amber to green; only a scanned window's result can be revised
        f.revise("c", .measured)
        ctx.equal(f.measuredCount, 2)
        f.revise("c", .check)
        f.revise("b", .check)
        ctx.equal(f.item("b")?.outcome, .appleSize, "no scan, nothing to revise")
        ctx.equal(f.measuredCount, 1)
        ctx.equal(f.toSave.count, 4)
        // back to the list for more close-ups clears the results
        f.reopenList()
        ctx.equal(f.stage, .windows)
        ctx.expect(f.items.allSatisfy { $0.outcome == nil })
        ctx.expect(f.item("a")?.closeups == [true, false, true, false], "the close-ups are kept")
    },
    Check("Hybrid flow: who qualifies for Measure and check, and no windows is its own end") { ctx in
        func item(pan: Int, closeups: [Bool] = [false, false, false, false]) -> HybridItem {
            var i = HybridItem(id: "x", letter: "A", widthM: 1, heightM: 1, confidence: .high, panFrames: pan)
            i.closeups = closeups
            return i
        }
        // a close-up and the pan photos make a scan; 3 photos is the contract's least
        ctx.expect(HybridRules.qualifies(item(pan: 2, closeups: [true, false, false, false])))
        ctx.expect(!HybridRules.qualifies(item(pan: 1, closeups: [true, false, false, false])), "a corner would have 2 marks, the gate asks for 3")
        ctx.expect(!HybridRules.qualifies(item(pan: 6)), "pan photos and no close-up: the window keeps Apple's size")
        ctx.expect(HybridRules.qualifies(item(pan: 6, closeups: [true, true, true, true])))
        var skipped = item(pan: 5, closeups: [true, true, true, true])
        skipped.skipped = true
        ctx.expect(!HybridRules.qualifies(skipped))
        var out = item(pan: 5, closeups: [true, true, true, true])
        out.included = false
        ctx.expect(!HybridRules.qualifies(out))
        // taking a close-up un-skips; skipping clears the close-ups
        var f = HybridFlow()
        f.built([HybridItem(id: "a", letter: "A", widthM: 1, heightM: 1, confidence: .high, panFrames: 3)])
        f.setSkipped("a", true)
        f.openCloseups("a")
        f.closeupsDone(corners: [true, false, false, false])
        ctx.equal(f.item("a")?.skipped, false)
        f.setSkipped("a", true)
        ctx.equal(f.item("a")?.closeupCount, 0)
        // a window left out cannot be opened and is not saved
        f.setSkipped("a", false)
        f.setIncluded("a", false)
        ctx.expect(!f.openCloseups("a"))
        // no window found
        var none = HybridFlow()
        none.stopPanning()
        none.built([])
        ctx.equal(none.stage, .empty)
        ctx.expect(!none.canMeasure)
        // out-of-order calls change nothing
        var early = HybridFlow()
        early.record("a", .measured)
        early.finishMeasuring()
        ctx.equal(early.stage, .panning)
    },
    Check("Hybrid rules: an amber scan far from Apple's size is not used; a measured one always is") { ctx in
        ctx.expect(HybridRules.useScanSize(appleW: 0.9, appleH: 1.2, scanW: 0.5, scanH: 0.5, measured: true))
        ctx.expect(HybridRules.useScanSize(appleW: 0.9, appleH: 1.2, scanW: 0.93, scanH: 1.18, measured: false))
        ctx.expect(!HybridRules.useScanSize(appleW: 0.9, appleH: 1.2, scanW: 0.9, scanH: 1.45, measured: false), "21% taller")
        ctx.expect(!HybridRules.useScanSize(appleW: 0.9, appleH: 1.2, scanW: 0.7, scanH: 1.2, measured: false), "22% narrower")
        ctx.equal(HybridWording.addTitle(count: 3, room: "Kitchen"), "Add 3 windows to Kitchen")
        ctx.equal(HybridWording.addTitle(count: 1, room: "Kitchen"), "Add 1 window to Kitchen")
        ctx.equal(HybridWording.measuringLine(done: 1, of: 3), "Measuring window 2 of 3")
        ctx.equal(HybridWording.outcomeTitle(.check), "WinChoice will check this one")
        ctx.equal(ScanProgress(mode: .panForCloseups, seconds: 0).canFinish, true, "Done is open from the start, like the whole room")
        ctx.equal(ScanProgress(mode: .oneWall, seconds: 1).canFinish, false)
    },
]
