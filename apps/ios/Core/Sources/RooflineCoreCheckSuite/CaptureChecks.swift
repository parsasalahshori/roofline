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
    Check("CornerSampler: fills to 15, estimate needs 5") { ctx in
        var s = CornerSampler()
        for _ in 0..<4 { s.add(Vec3(0, 1, -1)) }
        ctx.expect(s.estimate() == nil, "4 is too few")
        for _ in 0..<20 { s.add(Vec3(0, 1, -1)) }
        ctx.equal(s.count, 15)
        ctx.expect(s.isFull, "full")
        ctx.near(s.estimate()?.spreadM, 0, 1e-12)
        s.add(Vec3(.nan, 0, 0))
        ctx.equal(s.count, 15)
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
        let glass = (0..<8).map { Vec3(Double($0) * 0.01, 1, -2.25) }
        if case .offWall(let d) = c.place(CornerEstimate(point: Vec3(0, 1, -2), spreadM: 0, used: 15, rejected: 0), depthPoints: glass) {
            ctx.near(d, 0.25, 1e-9)
        } else {
            ctx.expect(false, "should be refused")
        }
        let frame = (0..<8).map { Vec3(Double($0) * 0.01, 1, -1.99) }
        ctx.equal(c.place(CornerEstimate(point: Vec3(0, 1, -1.99), spreadM: 0, used: 15, rejected: 0), depthPoints: frame), .placed(index: 0))
        c.setWallPlane(Plane(point: .zero, normal: .up), viewer: .zero)
        ctx.expect(c.wallPlane?.isVertical == true, "a floor is not taken as the wall")
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
