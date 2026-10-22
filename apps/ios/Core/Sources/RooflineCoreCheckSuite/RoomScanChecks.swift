import Foundation
import RooflineCore

/// A window surface 0.9 m x 1.2 m on a wall facing +z, its centre at (0, 1.5, -3), optionally rolled about the wall's normal.
private func surface(w: Double = 0.9, h: Double = 1.2, rollDeg: Double = 0, polygon: [Vec3] = [], confidence: RoomPlanConfidence = .high) -> ScanSurface {
    let r = rollDeg * .pi / 180
    let t = Mat4.rigid(right: Vec3(cos(r), sin(r), 0), up: Vec3(-sin(r), cos(r), 0), back: Vec3(0, 0, 1), origin: Vec3(0, 1.5, -3))
    return ScanSurface(widthM: w, heightM: h, transform: t, polygon: polygon, confidence: confidence)
}

/// A rectangle's corners in the surface's own frame (x along the width, y up, z 0), in any start order.
private func localRect(w: Double, h: Double, dx: Double = 0, dy: Double = 0) -> [Vec3] {
    [Vec3(-w / 2 + dx, h / 2 + dy, 0), Vec3(w / 2 + dx, h / 2 + dy, 0), Vec3(w / 2 + dx, -h / 2 + dy, 0), Vec3(-w / 2 + dx, -h / 2 + dy, 0)]
}

let roomScanChecks: [Check] = [
    Check("RoomWindowShape: no outline gives the dimensions as a level rectangle") { ctx in
        // A surface whose frame is rolled 4 degrees: RoomPlan's axes are a hair off, the window is still level
        let shape = RoomWindowShape.resolve(surface(rollDeg: 4), viewer: Vec3(0, 1.5, 0))
        ctx.equal(shape?.basis, .dimensions)
        ctx.equal(shape?.outlineDisagreed, false)
        ctx.near(shape?.widthM, 0.9, 1e-9)
        ctx.near(shape?.heightM, 1.2, 1e-9)
        guard let c = shape?.corners, c.count == 4 else { return ctx.expect(false, "four corners") }
        ctx.near(c[0].y, c[1].y, 1e-9, "top is level")
        ctx.near(c[2].y, c[3].y, 1e-9, "bottom is level")
        ctx.near(c[0].distance(to: c[1]), 0.9, 1e-9, "width")
        ctx.near(c[0].distance(to: c[3]), 1.2, 1e-9, "height")
        ctx.near(c[0].y - c[3].y, 1.2, 1e-9, "the left side is straight up")
        // Seen from the room (z > -3) the window's left is -x; from behind the wall it is mirrored
        ctx.expect(c[0].x < c[1].x, "TL left of TR as seen from the room")
        let behind = RoomWindowShape.resolve(surface(), viewer: Vec3(0, 1.5, -6))?.corners
        ctx.expect((behind?[0].x ?? -1) > (behind?[1].x ?? 1), "mirrored from behind")
        near3(ctx, shape?.centre, Vec3(0, 1.5, -3), 1e-9, "centre")
    },
    Check("RoomWindowShape: sizes are read to the eighth like the rest of the app") { ctx in
        // 0.9 m is 35.433 in: 35 3/8; 1.2 m is 47.244 in: 47 1/4
        let shape = RoomWindowShape.resolve(surface())
        ctx.equal(SizeWording.text(shape?.widthIn ?? 0), "35 3/8")
        ctx.equal(SizeWording.text(shape?.heightIn ?? 0), "47 1/4")
        ctx.equal(Eighths.format(shape?.widthIn ?? 0), "35 3/8")
    },
    Check("RoomWindowShape: a rectangular outline that agrees gives the size") { ctx in
        // dimensions 0.90 x 1.20, outline 0.92 x 1.19 and a little to the left
        let s = surface(polygon: localRect(w: 0.92, h: 1.19, dx: -0.01, dy: 0.005))
        let shape = RoomWindowShape.resolve(s)
        ctx.equal(shape?.basis, .outline)
        ctx.near(shape?.widthM, 0.92, 1e-9)
        ctx.near(shape?.heightM, 1.19, 1e-9)
        ctx.equal(shape?.confidence, .high)
        ctx.equal(shape?.outlineDisagreed, false)
        near3(ctx, shape?.centre, Vec3(-0.01, 1.505, -3), 1e-9, "centre moves with the outline")
        // Corners given in any order, closed with the first one repeated
        let shuffled = [localRect(w: 0.92, h: 1.19)[2], localRect(w: 0.92, h: 1.19)[0], localRect(w: 0.92, h: 1.19)[3], localRect(w: 0.92, h: 1.19)[1]]
        ctx.equal(RoomWindowShape.resolve(surface(polygon: shuffled))?.basis, .outline)
        ctx.equal(RoomWindowShape.resolve(surface(polygon: localRect(w: 0.92, h: 1.19) + [localRect(w: 0.92, h: 1.19)[0]]))?.basis, .outline)
    },
    Check("RoomWindowShape: the outline may be given in the scan's world, not the surface's own frame") { ctx in
        let s0 = surface(polygon: [])
        let world = localRect(w: 0.92, h: 1.19).map { s0.transform.transform($0) }
        let shape = RoomWindowShape.resolve(surface(polygon: world))
        ctx.equal(shape?.basis, .outline)
        ctx.near(shape?.widthM, 0.92, 1e-9)
        ctx.near(shape?.heightM, 1.19, 1e-9)
        // Far from both frames: ignored, the dimensions stand
        let far = localRect(w: 0.92, h: 1.19).map { $0 + Vec3(40, 0, 0) }
        ctx.equal(RoomWindowShape.resolve(surface(polygon: far))?.basis, .dimensions)
    },
    Check("RoomWindowShape: an outline that is not a rectangle is ignored") { ctx in
        let trapezoid = [Vec3(-0.3, 0.6, 0), Vec3(0.3, 0.6, 0), Vec3(0.45, -0.6, 0), Vec3(-0.45, -0.6, 0)]
        let triangle = [Vec3(-0.45, -0.6, 0), Vec3(0.45, -0.6, 0), Vec3(0, 0.6, 0)]
        let five = localRect(w: 0.9, h: 1.2) + [Vec3(0, 0.62, 0)]
        let sliver = localRect(w: 0.9, h: 0.04)
        // Far too big for the window it belongs to: not this window's outline
        let huge = localRect(w: 0.9, h: 1.7)
        for (name, poly) in [("trapezoid", trapezoid), ("triangle", triangle), ("five corners", five), ("sliver", sliver), ("outline far bigger than the window", huge), ("none", [])] {
            let shape = RoomWindowShape.resolve(surface(polygon: poly))
            ctx.equal(shape?.basis, .dimensions, name)
            ctx.equal(shape?.outlineDisagreed, false, name)
            ctx.equal(shape?.confidence, .high, "\(name) leaves the confidence")
            ctx.near(shape?.widthM, 0.9, 1e-9, name)
        }
    },
    Check("RoomWindowShape: an outline that disagrees with the dimensions is set aside and the confidence drops a step") { ctx in
        // 0.9 x 1.2 against an outline 0.9 x 1.45: two answers for one window
        let shape = RoomWindowShape.resolve(surface(polygon: localRect(w: 0.9, h: 1.45)))
        ctx.equal(shape?.basis, .dimensions)
        ctx.equal(shape?.outlineDisagreed, true)
        ctx.equal(shape?.confidence, .medium)
        ctx.near(shape?.heightM, 1.2, 1e-9)
        ctx.equal(RoomWindowShape.resolve(surface(polygon: localRect(w: 0.9, h: 1.45), confidence: .medium))?.confidence, .low)
        ctx.equal(RoomWindowShape.resolve(surface(polygon: localRect(w: 0.9, h: 1.45), confidence: .low))?.confidence, .low)
    },
    Check("RoomWindowShape: sizes that cannot be a window give nothing") { ctx in
        ctx.expect(RoomWindowShape.resolve(surface(w: 0.05, h: 1.2)) == nil, "5 cm wide")
        ctx.expect(RoomWindowShape.resolve(surface(w: 0.9, h: 0.09)) == nil, "9 cm tall")
        ctx.expect(RoomWindowShape.resolve(surface(w: .nan, h: 1.2)) == nil, "not a number")
        ctx.expect(RoomWindowShape.resolve(surface(w: 0.1, h: 0.1)) != nil, "10 cm is the least")
    },
    Check("ScanFinish: what a stopped scan is worth") { ctx in
        // The finished room has windows
        ctx.equal(ScanFinish.decide(mode: .oneWall, finalWindowCount: 2, liveWindowCount: 0), .review(fromLive: false))
        ctx.equal(ScanFinish.decide(mode: .wholeRoom, finalWindowCount: 1, liveWindowCount: 3), .review(fromLive: false))
        // Finished with none, but some were shown while scanning: use those
        ctx.equal(ScanFinish.decide(mode: .oneWall, finalWindowCount: 0, liveWindowCount: 2), .review(fromLive: true))
        // The room could not be built (a quick pan): the live windows stand
        ctx.equal(ScanFinish.decide(mode: .oneWall, finalWindowCount: nil, liveWindowCount: 1, tooLittle: true), .review(fromLive: true))
        // No window anywhere: kindly, not as a failure
        ctx.equal(ScanFinish.decide(mode: .oneWall, finalWindowCount: 0, liveWindowCount: 0), .noWindows)
        ctx.equal(ScanFinish.decide(mode: .wholeRoom, finalWindowCount: 0, liveWindowCount: 0), .noWindows)
        ctx.equal(ScanFinish.decide(mode: .oneWall, finalWindowCount: nil, liveWindowCount: 0, tooLittle: true), .noWindows)
        // A real break is still a break
        ctx.equal(ScanFinish.decide(mode: .oneWall, finalWindowCount: nil, liveWindowCount: 0), .failed)
        ctx.equal(ScanFinish.decide(mode: .wholeRoom, finalWindowCount: nil, liveWindowCount: 0, tooLittle: true), .failed)
    },
    Check("ScanProgress: the quick scan waits a few seconds, the whole-room scan never does") { ctx in
        var quick = ScanProgress(mode: .oneWall)
        ctx.equal(quick.canFinish, false)
        ctx.equal(quick.doneTitle, "Keep panning…")
        ctx.equal(quick.hint, "Point at the wall with the window. Pan slowly.")
        quick.seconds = 2.9
        ctx.equal(quick.canFinish, false)
        quick.seconds = 3
        ctx.equal(quick.canFinish, true)
        ctx.equal(quick.doneTitle, "Done scanning")
        ctx.equal(quick.hint, "Keep panning slowly until the window shows up.")
        quick.windowsFound = 2
        ctx.equal(quick.hint, "Got it. Tap Done, or pan on to catch more.")
        ctx.equal(quick.found, "2 windows found")
        let room = ScanProgress(mode: .wholeRoom)
        ctx.equal(room.canFinish, true)
        ctx.equal(room.hint, "Walk slowly around the room. Keep every window in view.")
        ctx.equal(room.found, "No windows yet")
    },
    Check("ScanWording: counts, confidence and letters in plain words") { ctx in
        ctx.equal(ScanWording.found(0), "No windows yet")
        ctx.equal(ScanWording.found(1), "1 window found")
        ctx.equal(ScanWording.found(2), "2 windows found")
        ctx.equal(ScanWording.foundTitle(0), "We didn't find a window")
        ctx.equal(ScanWording.foundTitle(1), "We found 1 window")
        ctx.equal(ScanWording.foundTitle(3), "We found 3 windows")
        ctx.equal(ScanWording.sourceLine(.high), "Apple's scan · fairly sure")
        ctx.equal(ScanWording.sourceLine(.medium), "Apple's scan · not fully sure")
        ctx.equal(ScanWording.sourceLine(.low), "Apple's scan · not sure")
        for c in RoomPlanConfidence.allCases {
            ctx.expect(!ScanWording.sourceLine(c).contains("±") && !ScanWording.sourceLine(c).contains("inch"), "no accuracy number in \(c)")
        }
        ctx.equal([0, 1, 25, 26, 27].map(ScanWording.letter), ["A", "B", "Z", "A", "B"])
    },
]
