import Foundation
import RooflineCore

let samplingChecks: [Check] = [
    Check("robustMean: an outlier 10 cm off is dropped, the spread is the kept samples'") { ctx in
        let c = Vec3(0.4, 1.6, -1.5)
        var pts: [Vec3] = []
        for i in 0..<14 { pts.append(c + Vec3(Double(i % 3 - 1) * 0.001, Double(i % 5 - 2) * 0.0005, 0)) }
        pts.append(c + Vec3(0.1, 0, 0))
        let e = robustMean(pts, minCount: 5)!
        ctx.equal(e.rejected, 1)
        ctx.equal(e.used, 14)
        near3(ctx, e.point, c, 0.001, "mean")
        ctx.expect(e.spreadM < 0.002, "spread \(e.spreadM)")
        ctx.expect(robustMean(Array(pts.prefix(3)), minCount: 5) == nil, "too few")
    },
    Check("CornerSampler: fills to 45 (about a second), estimate needs 20") { ctx in
        var s = CornerSampler()
        for _ in 0..<19 { s.add(Vec3(0, 1, -1)) }
        ctx.expect(s.estimate() == nil, "19 is too few")
        for _ in 0..<60 { s.add(Vec3(0, 1, -1)) }
        ctx.equal(s.count, 45)
        ctx.expect(s.isFull, "full")
        ctx.near(s.estimate()?.spreadM, 0, 1e-12)
        s.add(Vec3(.nan, 0, 0))
        ctx.equal(s.count, 45)
    },
    Check("robustMean spread: block means, honest about correlated samples") { ctx in
        // Independent noise (sigma 2 mm per sample) averages down inside a block: the spread is well under a sample's
        var state: UInt64 = 12345
        func rnd() -> Double { // uniform -1...1, then scaled to sigma 2 mm
            state = state &* 6364136223846793005 &+ 1442695040888963407
            return (Double(state >> 11) / Double(1 << 53) * 2 - 1) * 0.002 * 3.0.squareRoot()
        }
        let c = Vec3(0.4, 1.6, -1.5)
        let noisy = (0..<45).map { _ in c + Vec3(rnd(), rnd(), rnd()) }
        let n = robustMean(noisy, minCount: 20)!
        let perSample = (noisy.reduce(0.0) { $0 + ($1 - Vec3.mean(noisy)!).dot($1 - Vec3.mean(noisy)!) } / 45).squareRoot()
        ctx.expect(n.spreadM < perSample * 0.7, "independent noise: block spread \(n.spreadM) vs per-sample \(perSample)")
        // A slow drift (4 mm over the second) is the same in every frame of a block: the spread keeps it
        let drift = (0..<45).map { c + Vec3(0.004 * Double($0) / 44, 0, 0) }
        let d = robustMean(drift, minCount: 20)!
        let driftRms = (drift.reduce(0.0) { $0 + ($1 - Vec3.mean(drift)!).dot($1 - Vec3.mean(drift)!) } / 45).squareRoot()
        ctx.expect(d.spreadM > driftRms * 0.8, "drift: block spread \(d.spreadM) vs per-sample \(driftRms)")
        ctx.expect(d.spreadM > n.spreadM, "a wandering corner reports more spread than a steady noisy one")
        // Too few for blocks: the RMS of the samples
        let few = robustMean([c, c + Vec3(0.002, 0, 0), c, c + Vec3(0.002, 0, 0)], minCount: 1)!
        ctx.near(few.spreadM, 0.001, 1e-9)
    },
    Check("StillnessDetector: still, then moving, then turning") { ctx in
        var d = StillnessDetector()
        var still = false
        for i in 0..<20 { still = d.update(time: Double(i) / 60, position: Vec3(0, 1.4, 0), forward: Vec3(0, 0, -1)) }
        ctx.expect(still, "held still")
        var m = StillnessDetector()
        for i in 0..<20 { still = m.update(time: Double(i) / 60, position: Vec3(Double(i) * 0.005, 1.4, 0), forward: Vec3(0, 0, -1)) }
        ctx.expect(!still, "walking 30 cm/s")
        var t = StillnessDetector()
        for i in 0..<20 {
            let a = Double(i) * 0.5 * .pi / 180 // 30 degrees a second
            still = t.update(time: Double(i) / 60, position: Vec3(0, 1.4, 0), forward: Vec3(sin(a), 0, -cos(a)))
        }
        ctx.expect(!still, "turning")
        var short = StillnessDetector()
        ctx.expect(!short.update(time: 0, position: .zero, forward: Vec3(0, 0, -1)), "one frame is not enough")
    },
    Check("localFramePlane: follows the frame's depth, ignores glass and the room behind") { ctx in
        let wall = Plane(point: Vec3(0, 0, -2), normal: Vec3(0, 0, 1))!
        var pts = (0..<10).map { Vec3(Double($0) * 0.01, 1, -1.98) } // frame 2 cm proud of the siding
        pts += (0..<6).map { Vec3(Double($0) * 0.01, 1.1, -2.3) } // through the glass
        let local = localFramePlane(wall: wall, depthPoints: pts)
        ctx.near(local.signedDistance(Vec3(0, 0, -1.98)), 0, 1e-9)
        ctx.equal(localFramePlane(wall: wall, depthPoints: []), wall)
        ctx.near(offPlaneShare(wall: wall, points: pts), 6.0 / 16.0, 1e-12)
    },
]

let captureChecks: [Check] = [
    Check("CornerCapture: place four, undo, start over, live sides") { ctx in
        var c = CornerCapture()
        let r = rect(w: 36 * inch, h: 48 * inch)
        c.setTracking(normal: true)
        ctx.equal(c.place(CornerEstimate(point: r[0], spreadM: 0.001, used: 15, rejected: 0)), .placed(index: 0))
        ctx.equal(c.place(CornerEstimate(point: r[0] + Vec3(0.005, 0, 0), spreadM: 0.001, used: 15, rejected: 0)), .tooCloseToCorner)
        let edges = c.liveEdgesIn(aim: r[1])
        ctx.equal(edges.count, 1)
        ctx.near(edges.first?.inches, 36, 1e-9)
        ctx.equal(edges.first?.toAim, true)
        _ = c.place(CornerEstimate(point: r[1], spreadM: 0.001, used: 15, rejected: 0))
        c.undo()
        ctx.equal(c.corners.count, 1)
        for i in 1..<4 { _ = c.place(CornerEstimate(point: r[i], spreadM: 0.001 * Double(i + 1), used: 15, rejected: 0)) }
        ctx.expect(c.isComplete, "complete")
        ctx.equal(c.place(CornerEstimate(point: Vec3(5, 5, 5), spreadM: 0, used: 15, rejected: 0)), .alreadyFour)
        ctx.equal(c.liveEdgesIn(aim: nil).count, 4)
        c.startOver()
        ctx.equal(c.corners.count, 0)
    },
    Check("CornerCapture: start over, undo to zero, a tracking restart and a new session all let go of the wall plane") { ctx in
        let wall = Plane(point: Vec3(0, 0, -2), normal: Vec3(0, 0, -1))
        let viewer = Vec3(0, 1.4, 0)
        func fresh() -> CornerCapture {
            var c = CornerCapture()
            c.setTracking(normal: true)
            c.setWallPlane(wall, viewer: viewer)
            _ = c.place(CornerEstimate(point: Vec3(0, 1, -2), spreadM: 0, used: 15, rejected: 0))
            return c
        }
        var a = fresh()
        ctx.expect(a.wallPlane != nil, "locked")
        a.startOver()
        ctx.expect(a.wallPlane == nil, "start over")
        var b = fresh()
        b.undo()
        ctx.expect(b.wallPlane == nil, "undo to zero")
        var c = fresh()
        _ = c.place(CornerEstimate(point: Vec3(1, 1, -2), spreadM: 0, used: 15, rejected: 0))
        c.undo()
        ctx.expect(c.wallPlane != nil, "one corner left: the wall stays")
        var d = fresh()
        d.setTracking(normal: false)
        ctx.expect(d.wallPlane == nil, "tracking restart")
        var e = fresh()
        e.resetForNewSession()
        ctx.expect(e.wallPlane == nil && e.corners.isEmpty && !e.hadTracking && !e.tracking, "new session")
    },
    Check("CornerCapture: a tracking loss between corners restarts the window and is counted") { ctx in
        var c = CornerCapture()
        ctx.equal(c.setTracking(normal: false), false, "not tracking yet: nothing to restart")
        ctx.equal(c.trackingLostCount, 0, "never tracked: not a loss")
        c.setTracking(normal: true)
        ctx.equal(c.setTracking(normal: false), false, "lost with no corners")
        ctx.equal(c.trackingLostCount, 1)
        c.setTracking(normal: false)
        ctx.equal(c.trackingLostCount, 1, "still lost is one loss")
        c.setTracking(normal: true)
        _ = c.place(CornerEstimate(point: Vec3(0, 1, -1), spreadM: 0, used: 15, rejected: 0))
        ctx.equal(c.setTracking(normal: false), true, "restart")
        ctx.equal(c.corners.count, 0)
        ctx.equal(c.trackingLostCount, 2)
        ctx.equal(c.restartsForTracking, 1)
    },
    Check("CornerCapture: a tap through the glass is refused once the wall is known") { ctx in
        var c = CornerCapture()
        c.setTracking(normal: true)
        c.setWallPlane(Plane(point: Vec3(0, 0, -2), normal: Vec3(0, 0, -1)), viewer: Vec3(0, 1.4, 0))
        ctx.near(c.wallPlane?.normal.z, 1, 1e-12, "turned toward the camera")
        // A 2 cm disc of depth points around the tap, all 25 cm behind the wall
        func disc(z: Double, cx: Double = 0) -> [Vec3] {
            var out: [Vec3] = []
            for i in -3...3 { for j in -3...3 { out.append(Vec3(cx + Double(i) * 0.005, 1 + Double(j) * 0.005, z)) } }
            return out.filter { ($0 - Vec3(0, 1, $0.z)).length <= 0.02 + 1e-9 }
        }
        let glass = disc(z: -2.25)
        ctx.expect(glass.count >= CornerCapture.minDepthPoints, "enough points: \(glass.count)")
        if case .offWall(let d) = c.place(CornerEstimate(point: Vec3(0, 1, -2), spreadM: 0, used: 45, rejected: 0), depthPoints: glass) {
            ctx.near(d, 0.25, 1e-9)
        } else {
            ctx.expect(false, "should be refused")
        }
        let frame = disc(z: -1.99)
        ctx.equal(c.place(CornerEstimate(point: Vec3(0, 1, -1.99), spreadM: 0, used: 45, rejected: 0), depthPoints: frame), .placed(index: 0))
        c.setWallPlane(Plane(point: .zero, normal: .up), viewer: .zero)
        ctx.expect(c.wallPlane?.isVertical == true, "a floor is not taken as the wall")
    },
    Check("CornerCapture: the off-wall check looks 2 cm around the tap, so a thin frame member is not refused") { ctx in
        var c = CornerCapture()
        c.setTracking(normal: true)
        c.setWallPlane(Plane(point: Vec3(0, 0, -2), normal: Vec3(0, 0, -1)), viewer: Vec3(0, 1.4, 0))
        // A 3 cm wide frame member (|x| <= 1.5 cm) on the wall, glass 8 cm back on both sides of it
        var pts: [Vec3] = []
        for i in -12...12 { for j in -12...12 {
            let x = Double(i) * 0.005
            pts.append(Vec3(x, 1 + Double(j) * 0.005, abs(x) <= 0.0151 ? -1.99 : -2.08))
        } }
        let wide = pts.filter { Vec3($0.x, $0.y - 1, 0).length <= 0.05 }
        ctx.expect(offPlaneShare(wall: c.wallPlane!, points: wide) > 0.5, "the old ~5 cm window is mostly glass here")
        ctx.equal(c.place(CornerEstimate(point: Vec3(0, 1, -1.99), spreadM: 0, used: 45, rejected: 0), depthPoints: pts), .placed(index: 0))
        // The same neighbourhood with the tap on the glass itself is still refused
        if case .offWall = c.place(CornerEstimate(point: Vec3(0.05, 1.05, -2.08), spreadM: 0, used: 45, rejected: 0), depthPoints: pts) {} else {
            ctx.expect(false, "a tap on the glass should be refused")
        }
    },
    Check("CornerCapture.canPlaceNext: not before the wall plane is locked") { ctx in
        var c = CornerCapture()
        ctx.expect(!c.canPlaceNext(aimed: true, sampling: false), "no tracking yet")
        c.setTracking(normal: true)
        ctx.expect(!c.canPlaceNext(aimed: true, sampling: false), "tracking but no wall plane")
        c.setWallPlane(Plane(point: Vec3(0, 0, -2), normal: Vec3(0, 0, -1)), viewer: Vec3(0, 1.4, 0))
        ctx.expect(c.canPlaceNext(aimed: true, sampling: false), "wall locked and aimed")
        ctx.expect(!c.canPlaceNext(aimed: false, sampling: false), "no surface under the reticle")
        ctx.expect(!c.canPlaceNext(aimed: true, sampling: true), "already sampling")
        let r = rect(w: 36 * inch, h: 48 * inch)
        for p in r { _ = c.place(CornerEstimate(point: p, spreadM: 0, used: 45, rejected: 0)) }
        ctx.expect(!c.canPlaceNext(aimed: true, sampling: false), "all four placed")
        c.setTracking(normal: false)
        ctx.expect(!c.canPlaceNext(aimed: true, sampling: false), "tracking lost")
    },
    Check("CornerCapture: too little depth near the tap judges nothing") { ctx in
        var c = CornerCapture()
        c.setTracking(normal: true)
        c.setWallPlane(Plane(point: Vec3(0, 0, -2), normal: Vec3(0, 0, -1)), viewer: Vec3(0, 1.4, 0))
        let few = (0..<3).map { Vec3(Double($0) * 0.005, 1, -2.3) }
        ctx.equal(c.place(CornerEstimate(point: Vec3(0, 1, -2), spreadM: 0, used: 45, rejected: 0), depthPoints: few), .placed(index: 0))
        // Far from the tap does not count either
        let farGlass = (0..<30).map { Vec3(0.1 + Double($0) * 0.005, 1, -2.3) }
        ctx.equal(c.place(CornerEstimate(point: Vec3(0, 1.2, -2), spreadM: 0, used: 45, rejected: 0), depthPoints: farGlass), .placed(index: 1))
    },
    Check("CornerCapture.finished: projected onto the plane, gravity-ordered, spreads follow their corners") { ctx in
        var c = CornerCapture()
        c.setTracking(normal: true)
        let r = rect(w: 36 * inch, h: 48 * inch)
        // Tapped BR, TL, BL, TR with a few mm of depth noise
        let taps = [(r[2], 0.004), (r[0] + Vec3(0, 0, 0.003), 0.001), (r[3] - Vec3(0, 0, 0.002), 0.003), (r[1], 0.002)]
        for (p, s) in taps { _ = c.place(CornerEstimate(point: p, spreadM: s, used: 15, rejected: 0)) }
        let f = c.finished(viewer: Vec3(0, 1.4, 0))!
        ctx.equal(f.cornerSpreadM, [0.001, 0.002, 0.004, 0.003])
        ctx.expect(f.maxOffPlaneM > 0.001 && f.maxOffPlaneM < 0.004, "off plane \(f.maxOffPlaneM)")
        let fit = Plane.fit(f.pointsM)!
        ctx.expect(fit.rmsDistance(f.pointsM) < 1e-9, "on one plane")
        let s = sizeFromArPoints(f.pointsM)!
        ctx.near(s.widthIn, 36, 0.01)
        ctx.near(s.heightIn, 48, 0.01)
        ctx.equal(f.usedWallPlane, false)
    },
]
