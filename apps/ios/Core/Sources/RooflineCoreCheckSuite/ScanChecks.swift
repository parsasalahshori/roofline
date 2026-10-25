import Foundation
import RooflineCore

// Checks for the multi-frame scan (docs/windows/scan-contract.md): triangulation, the level rectangle, each quality gate's failure case, the
// marks pipeline (project, snap, prune, second pass), and the JSON the server reads. The scenes are made-up windows on a wall 2 m away
// photographed from known places, so every number has a known right answer.

let scanLens = CameraIntrinsics(fx: 1430, fy: 1430, cx: 960, cy: 720, width: 1920, height: 1440)

/// A camera at `eye` looking at `target` (world up is +Y): ARKit's camera looks along -z, +x right, +y up.
func scanLookAt(_ eye: Vec3, _ target: Vec3) -> Mat4 {
    let f = (target - eye).normalized!
    let r = f.cross(Vec3.up).normalized!
    let u = r.cross(f)
    return Mat4.rigid(right: r, up: u, back: -f, origin: eye)
}

/// A deterministic noise source (uniform -1 ... 1).
struct ScanNoise {
    var seed: UInt64
    mutating func next() -> Double {
        seed = seed &* 6364136223846793005 &+ 1442695040888963407
        return Double(seed >> 33) / Double(1 << 30) - 1
    }
}

/// A 36 x 60 in window on a wall at z = -2: TL, TR, BR, BL.
struct ScanScene {
    var widthIn = 36.0
    var heightIn = 60.0
    var wallZ = -2.0
    var left = -0.45
    var top = 1.95

    var widthM: Double { widthIn / inchesPerMetre }
    var heightM: Double { heightIn / inchesPerMetre }
    var corners: [Vec3] {
        [Vec3(left, top, wallZ), Vec3(left + widthM, top, wallZ), Vec3(left + widthM, top - heightM, wallZ), Vec3(left, top - heightM, wallZ)]
    }
    var wall: Plane { Plane(point: Vec3(0, 0, wallZ), normal: Vec3(0, 0, 1))! }
    var centre: Vec3 { Vec3(left + widthM / 2, top - heightM / 2, wallZ) }

    /// `n` regular frames along a sweep from x = -0.6 to 0.6, 2 m from the wall, aimed at the window's middle.
    func regularFrames(_ n: Int = 7, spread: Double = 1.2, distance: Double = 2.0) -> [ScanFrame] {
        (0..<n).map { i in
            let x = n == 1 ? 0 : -spread / 2 + spread * Double(i) / Double(n - 1)
            let eye = Vec3(x, 1.4, wallZ + distance)
            return ScanFrame(frameId: "r\(i + 1)", kind: .regular, imageWidth: 1920, imageHeight: 1440, cameraTransform: scanLookAt(eye, centre), intrinsics: scanLens)
        }
    }

    /// A close-up of each corner from 0.6 m, the corner in the middle of the picture.
    func closeupFrames() -> [ScanFrame] {
        corners.enumerated().map { c, p in
            let eye = Vec3(p.x, p.y, wallZ + 0.6)
            return ScanFrame(frameId: "c\(c + 1)", kind: .closeup, corner: c, imageWidth: 1920, imageHeight: 1440,
                             cameraTransform: scanLookAt(eye + Vec3(0.05, 0.03, 0), p), intrinsics: scanLens)
        }
    }

    /// The marks a perfect snapper would make, plus noise of `sigmaPx` (uniform), for the given corner positions.
    func marks(_ frames: [ScanFrame], corners truth: [Vec3]? = nil, sigmaPx: Double = 0, seed: UInt64 = 7, source: MarkSource = .snap) -> [ScanMark] {
        var noise = ScanNoise(seed: seed)
        var out: [ScanMark] = []
        for f in frames {
            for c in 0..<4 {
                if f.kind == .closeup, f.corner != c { continue }
                guard let p = WindowScanSolver.project((truth ?? corners)[c], in: f) else { continue }
                out.append(ScanMark(frameId: f.frameId, corner: c, x: p.x + noise.next() * sigmaPx, y: p.y + noise.next() * sigmaPx, source: source))
            }
        }
        return out
    }
}

/// A snapper that sees the true corners (plus noise) when the search reaches them.
func scanSnapper(_ scene: ScanScene, sigmaPx: Double = 0, seed: UInt64 = 11, unclear: Set<String> = []) -> ScanMarkMaker.Snapper {
    var noise = ScanNoise(seed: seed)
    let truth = scene.corners
    return { frame, corner, approx, radius in
        if unclear.contains("\(frame.frameId)#\(corner)") { return nil }
        guard let p = WindowScanSolver.project(truth[corner], in: frame), hypot(p.x - approx.x, p.y - approx.y) <= radius else { return nil }
        return Vec2(p.x + noise.next() * sigmaPx, p.y + noise.next() * sigmaPx)
    }
}

private func solve(_ scene: ScanScene, frames: [ScanFrame], marks: [ScanMark]) -> ScanSolution {
    WindowScanSolver.solve(frames: frames, marks: marks, wall: scene.wall)
}

private let sixteenth = 1.0 / 16

let scanChecks: [Check] = [
    Check("Scan: noise-free marks triangulate every corner exactly and the rectangle is the window's size") { ctx in
        let s = ScanScene()
        let frames = s.regularFrames() + s.closeupFrames()
        let sol = solve(s, frames: frames, marks: s.marks(frames))
        for c in 0..<4 { ctx.near(sol.triangulatedM[c]?.distance(to: s.corners[c]), 0, 1e-7, "corner \(c)") }
        ctx.near(sol.widthIn, 36, 1e-6)
        ctx.near(sol.heightIn, 60, 1e-6)
        ctx.equal(sol.status, .measured)
        ctx.equal(sol.quality.failed, [])
        ctx.equal(sol.quality.framesPerCorner, [8, 8, 8, 8])
        ctx.equal(sol.quality.closeups, 4)
        ctx.expect(sol.quality.reprojMaxPx < 1e-6)
        ctx.expect(sol.quality.minBaselineDeg > 20, "baseline \(sol.quality.minBaselineDeg)")
    },
    Check("Scan: marks 1 px off give width and height within 1/16 in, for ten different noise draws, and the scan is measured") { ctx in
        let s = ScanScene()
        let frames = s.regularFrames() + s.closeupFrames()
        for seed in 1...10 {
            let sol = solve(s, frames: frames, marks: s.marks(frames, sigmaPx: 1, seed: UInt64(seed) * 97))
            ctx.near(sol.widthIn, 36, sixteenth, "width, draw \(seed)")
            ctx.near(sol.heightIn, 60, sixteenth, "height, draw \(seed)")
            ctx.equal(sol.status, .measured, "draw \(seed): \(sol.quality)")
            ctx.expect(sol.quality.reprojRmsPx < 1.5, "rms \(sol.quality.reprojRmsPx)")
        }
    },
    Check("Scan: regular frames alone (no close-ups) also reach 1/16 in at 2 m, and the scan says no_closeups without failing") { ctx in
        let s = ScanScene()
        let frames = s.regularFrames(7)
        let sol = solve(s, frames: frames, marks: s.marks(frames, sigmaPx: 0.8, seed: 5))
        ctx.near(sol.widthIn, 36, sixteenth)
        ctx.near(sol.heightIn, 60, sixteenth)
        ctx.equal(sol.quality.failed, ["no_closeups"])
        ctx.equal(sol.quality.hardFailures, [])
        ctx.equal(sol.status, .measured, "a warning does not fail a scan")
        ctx.equal(sol.quality.closeups, 0)
    },
    Check("Scan gate too_few_frames: a corner with only two marks fails, and so does a corner nobody marked") { ctx in
        let s = ScanScene()
        let frames = s.regularFrames(3)
        var marks = s.marks(frames)
        // corner 2 in only two frames
        marks.removeAll { $0.corner == 2 && $0.frameId == "r3" }
        var sol = solve(s, frames: frames, marks: marks)
        ctx.expect(sol.quality.failed.contains("too_few_frames"), "\(sol.quality.failed)")
        ctx.equal(sol.quality.framesPerCorner, [3, 3, 2, 3])
        ctx.equal(sol.status, .needsReview)
        // no marks for corner 0 at all: no rectangle, nothing to size
        marks = s.marks(frames).filter { $0.corner != 0 }
        sol = solve(s, frames: frames, marks: marks)
        ctx.expect(sol.fit == nil)
        ctx.expect(sol.widthIn == nil && sol.cornersM == nil)
        ctx.expect(sol.quality.failed.contains("too_few_frames"))
        ctx.equal(sol.status, .needsReview)
        // and three marks per corner are enough
        sol = solve(s, frames: frames, marks: s.marks(frames))
        ctx.expect(!sol.quality.failed.contains("too_few_frames"))
    },
    Check("Scan gate reprojection: one mark 12 px off fails the worst-mark limit, noisy marks fail the RMS limit, and 2 px is fine") { ctx in
        let s = ScanScene()
        let frames = s.regularFrames() + s.closeupFrames()
        var marks = s.marks(frames)
        let k = marks.firstIndex { $0.frameId == "r2" && $0.corner == 1 }!
        marks[k].x += 12
        var sol = solve(s, frames: frames, marks: marks)
        ctx.expect(sol.quality.failed.contains("reprojection"), "\(sol.quality)")
        ctx.expect(sol.quality.reprojMaxPx > ScanLimits.reprojMaxPx, "max \(sol.quality.reprojMaxPx)")
        // many marks 4.5 px off: RMS over 3
        sol = solve(s, frames: frames, marks: s.marks(frames, sigmaPx: 7, seed: 3))
        ctx.expect(sol.quality.reprojRmsPx > ScanLimits.reprojRmsPx || sol.quality.reprojMaxPx > ScanLimits.reprojMaxPx, "\(sol.quality)")
        ctx.expect(sol.quality.failed.contains("reprojection"))
        sol = solve(s, frames: frames, marks: s.marks(frames, sigmaPx: 2, seed: 3))
        ctx.expect(!sol.quality.failed.contains("reprojection"), "\(sol.quality)")
    },
    Check("Scan gate baseline: photos taken 3 cm apart (under 4 degrees between rays) fail, and a corner seen from two places 15 cm apart does not") { ctx in
        let s = ScanScene()
        let near = s.regularFrames(4, spread: 0.06)
        var sol = solve(s, frames: near, marks: s.marks(near))
        ctx.expect(sol.quality.failed.contains("baseline"), "\(sol.quality)")
        ctx.expect(sol.quality.minBaselineDeg < ScanLimits.minBaselineDeg, "\(sol.quality.minBaselineDeg)")
        ctx.equal(sol.status, .needsReview)
        let apart = s.regularFrames(4, spread: 0.45)
        sol = solve(s, frames: apart, marks: s.marks(apart))
        ctx.expect(!sol.quality.failed.contains("baseline"), "\(sol.quality.minBaselineDeg)")
        // exactly parallel rays cannot be triangulated at all
        let one = ScanFrame(frameId: "p1", kind: .regular, imageWidth: 1920, imageHeight: 1440, cameraTransform: scanLookAt(Vec3(0, 1.4, 0), Vec3(0, 1.4, -2)), intrinsics: scanLens)
        let two = ScanFrame(frameId: "p2", kind: .regular, imageWidth: 1920, imageHeight: 1440, cameraTransform: scanLookAt(Vec3(0.3, 1.4, 0), Vec3(0.3, 1.4, -2)), intrinsics: scanLens)
        let r1 = WindowScanSolver.ray(frame: one, x: 960, y: 720)!, r2 = WindowScanSolver.ray(frame: two, x: 960, y: 720)!
        ctx.expect(WindowScanSolver.triangulate([r1, r2]) == nil, "parallel rays")
        ctx.expect(WindowScanSolver.triangulate([r1]) == nil, "one ray")
    },
    Check("Scan gate sym_ratio: a corner marked 40 px out in every photo makes opposite sides differ and fails") { ctx in
        let s = ScanScene()
        let frames = s.regularFrames() + s.closeupFrames()
        var moved = s.corners
        moved[2] = moved[2] + Vec3(0.04, -0.09, 0)
        var sol = solve(s, frames: frames, marks: s.marks(frames, corners: moved))
        ctx.expect(sol.quality.failed.contains("sym_ratio"), "\(sol.quality)")
        ctx.expect(sol.quality.symRatioDiff > ScanLimits.symDiffShare, "\(sol.quality.symRatioDiff)")
        ctx.equal(sol.status, .needsReview)
        // a small difference (0.4 in on a 60 in side) is allowed
        moved = s.corners
        moved[2] = moved[2] + Vec3(0, -0.4 / inchesPerMetre, 0)
        sol = solve(s, frames: frames, marks: s.marks(frames, corners: moved))
        ctx.expect(!sol.quality.failed.contains("sym_ratio"), "\(sol.quality)")
    },
    Check("Scan gate plane: a corner 5 cm off the plane of the others fails (the plane is fitted to all four, so it is 1.25 cm from it); 2 cm does not") { ctx in
        let s = ScanScene()
        let frames = s.regularFrames() + s.closeupFrames()
        var moved = s.corners
        moved[1] = moved[1] + Vec3(0, 0, 0.05)
        var sol = solve(s, frames: frames, marks: s.marks(frames, corners: moved))
        ctx.expect(sol.quality.failed.contains("plane"), "\(sol.quality)")
        ctx.expect(sol.quality.planeMaxCm > 1.0, "\(sol.quality.planeMaxCm)")
        moved = s.corners
        moved[1] = moved[1] + Vec3(0, 0, 0.02)
        sol = solve(s, frames: frames, marks: s.marks(frames, corners: moved))
        ctx.expect(!sol.quality.failed.contains("plane"), "\(sol.quality)")
        ctx.expect(sol.quality.planeMaxCm < 1.0)
    },
    Check("Scan gate scale: a window 8 cm in front of the wall plane is 4% bigger on the plane than in space and fails; on the plane it passes") { ctx in
        let s = ScanScene()
        let frames = s.regularFrames() + s.closeupFrames()
        // all four corners moved toward the cameras: the same size in space, but the wall plane puts it 4.2% larger
        let proud = s.corners.map { $0 + Vec3(0, 0, 0.08) }
        var sol = solve(s, frames: frames, marks: s.marks(frames, corners: proud))
        ctx.near(sol.widthIn, 36, 1e-4, "the triangulated size is the real one")
        ctx.expect(sol.quality.failed.contains("scale"), "\(sol.quality)")
        ctx.expect(sol.quality.scaleDiff > ScanLimits.scaleShare, "\(sol.quality.scaleDiff)")
        ctx.equal(sol.status, .needsReview)
        // 1.5 cm proud: 0.75%, fine
        let little = s.corners.map { $0 + Vec3(0, 0, 0.015) }
        sol = solve(s, frames: frames, marks: s.marks(frames, corners: little))
        ctx.expect(!sol.quality.failed.contains("scale"), "\(sol.quality)")
        // no wall to check against: the scale cannot pass
        sol = WindowScanSolver.solve(frames: frames, marks: s.marks(frames), wall: nil)
        ctx.expect(sol.quality.failed.contains("scale"))
    },
    Check("Scan: the single-frame estimate uses the first regular frame that has all four marks, so the key frame goes first") { ctx in
        let s = ScanScene()
        let frames = s.regularFrames(4)
        let marks = s.marks(frames).filter { !($0.frameId == "r1" && $0.corner == 3) }
        let est = WindowScanSolver.singleFrameEstimate(frames: frames, marks: marks, wall: s.wall)
        ctx.near(est?.width, 36, 1e-6)
        ctx.near(est?.height, 60, 1e-6)
        // reordered so r2 leads: still the same window
        let est2 = WindowScanSolver.singleFrameEstimate(frames: Array(frames.reversed()), marks: marks, wall: s.wall)
        ctx.near(est2?.width, 36, 1e-6)
        // the wall is a different distance: the plane estimate scales
        let far = Plane(point: Vec3(0, 0, -2.2), normal: Vec3(0, 0, 1))!
        let est3 = WindowScanSolver.singleFrameEstimate(frames: frames, marks: marks, wall: far)
        ctx.near(est3?.width, 36 * 2.2 / 2.0, 1e-4)
    },
    Check("Scan: the level rectangle is level and plumb even when the camera and the window are turned (rectangle fit as RectangleFit)") { ctx in
        var s = ScanScene()
        s.left = 0.8
        s.top = 2.3
        let frames = s.regularFrames(6, spread: 1.6) + s.closeupFrames()
        let sol = solve(s, frames: frames, marks: s.marks(frames, sigmaPx: 0.5, seed: 21))
        guard let p = sol.cornersM else { return ctx.expect(false, "no rectangle") }
        ctx.near(p[0].y, p[1].y, 1e-9, "level top")
        ctx.near(p[3].y, p[2].y, 1e-9, "level bottom")
        ctx.near(p[0].x, p[3].x, 1e-5, "plumb left")
        ctx.near(sol.widthIn, 36, sixteenth)
        ctx.near(sol.heightIn, 60, sixteenth)
        // TL is the top-left as the person faces the window: left of TR, above BL
        ctx.expect(p[0].x < p[1].x && p[0].y > p[3].y)
    },
    Check("Scan: a mark appearing twice for one photo and corner counts once (the last wins); marks on unknown photos are ignored") { ctx in
        let s = ScanScene()
        let frames = s.regularFrames(3)
        var marks = s.marks(frames)
        marks.append(ScanMark(frameId: "r1", corner: 0, x: 1, y: 1, source: .user))
        marks.append(ScanMark(frameId: "ghost", corner: 0, x: 5, y: 5, source: .snap))
        marks.append(ScanMark(frameId: "r1", corner: 7, x: 5, y: 5, source: .snap))
        let fixed = marks.last { $0.frameId == "r1" && $0.corner == 0 }!
        ctx.equal(fixed.source, .user)
        let sol = solve(s, frames: frames, marks: marks)
        ctx.equal(sol.quality.framesPerCorner, [3, 3, 3, 3])
        // the last wins: corner 0 in r1 is now at (1, 1), far from truth
        ctx.expect(sol.quality.reprojMaxPx > 100)
    },
    Check("Scan marks: projecting a first estimate with a 1.4 cm error into every photo and snapping gives 1/16 in, and the second pass is kept") { ctx in
        let s = ScanScene()
        let frames = s.regularFrames(6) + s.closeupFrames()
        // the estimate: each side 1.4 cm out (an AI/LiDAR proposal is rarely better)
        let off = 0.014
        let estimate = [s.corners[0] + Vec3(-off, off, 0), s.corners[1] + Vec3(off, off, 0), s.corners[2] + Vec3(off, -off, 0), s.corners[3] + Vec3(-off, -off, 0)]
        let run = ScanMarkMaker.run(frames: frames, estimate: estimate, keyFrameId: "r1", keySource: .ai, wall: s.wall, snapper: scanSnapper(s, sigmaPx: 0.8))
        let sol = run.solution
        ctx.near(sol.widthIn, 36, sixteenth)
        ctx.near(sol.heightIn, 60, sixteenth)
        ctx.equal(sol.status, .measured, "\(sol.quality)")
        ctx.equal(sol.quality.closeups, 4)
        ctx.expect(run.used.allSatisfy { $0.source == .snap })
        ctx.expect(run.refined || sol.quality.reprojRmsPx < 2, "second pass kept or already tight")
        // close-ups carry only their own corner
        for m in run.all where m.frameId.hasPrefix("c") { ctx.equal(m.corner, Int(m.frameId.dropFirst())! - 1) }
    },
    Check("Scan marks: a corner the picture is not clear about stays a hollow projection that the maths ignores; a user's mark is used and kept") { ctx in
        let s = ScanScene()
        let frames = s.regularFrames(5)
        let snapper = scanSnapper(s, unclear: ["r4#2", "r5#2", "r3#2"])
        let run = ScanMarkMaker.run(frames: frames, estimate: s.corners, keyFrameId: "r1", keySource: .ai, wall: s.wall, snapper: snapper, secondPass: false)
        ctx.equal(run.all.filter { $0.source == .projected }.count, 3)
        ctx.equal(run.used.count, 17)
        ctx.equal(run.solution.quality.framesPerCorner, [5, 5, 2, 5])
        ctx.expect(run.solution.quality.failed.contains("too_few_frames"))
        // the person drags the hollow mark in r4 onto the corner: it is a user mark and corner 2 has three
        let draft = ScanDraft(scanId: "s1", windowId: "w1", frames: frames, allMarks: run.all, wall: s.wall)
        let p = WindowScanSolver.project(s.corners[2], in: frames[3])!
        let edited = draft.placing(frameId: "r4", corner: 2, at: p).placing(frameId: "r3", corner: 2, at: WindowScanSolver.project(s.corners[2], in: frames[2])!)
        ctx.equal(edited.usedMarks.filter { $0.source == .user }.count, 2)
        ctx.equal(edited.solution.quality.framesPerCorner, [5, 5, 4, 5])
        ctx.equal(edited.solution.status, .measured)
        ctx.equal(edited.allMarks.filter { $0.frameId == "r4" && $0.corner == 2 }.count, 1)
    },
    Check("Scan marks: an outlier mark (30 px off) is pruned while the corner keeps its other marks; a user mark is never pruned") { ctx in
        let s = ScanScene()
        let frames = s.regularFrames(6)
        var marks = s.marks(frames, sigmaPx: 0.5)
        let k = marks.firstIndex { $0.frameId == "r3" && $0.corner == 0 }!
        marks[k].x += 30
        let pruned = ScanMarkMaker.pruned(frames: frames, marks: marks, wall: s.wall)
        ctx.equal(pruned.count, marks.count - 1)
        ctx.expect(!pruned.contains { $0.frameId == "r3" && $0.corner == 0 })
        ctx.equal(WindowScanSolver.solve(frames: frames, marks: pruned, wall: s.wall).quality.failed.contains("reprojection"), false)
        // the same mark placed by the person stays
        marks[k].source = .user
        let kept = ScanMarkMaker.pruned(frames: frames, marks: marks, wall: s.wall)
        ctx.equal(kept.count, marks.count)
        // a corner with only three marks keeps all three
        let three = s.regularFrames(3)
        var m3 = s.marks(three)
        let j = m3.firstIndex { $0.frameId == "r2" && $0.corner == 1 }!
        m3[j].y += 40
        ctx.equal(ScanMarkMaker.pruned(frames: three, marks: m3, wall: s.wall).count, m3.count)
    },
    Check("Scan marks: the search radius is the same size on the wall near and far, and a corner outside the photo is not marked") { ctx in
        // 3 cm at 2 m with fx 1430 is 21 px; at 0.5 m it is capped
        ctx.near(ScanMarkMaker.radiusPx(radiusM: 0.03, depthM: 2, fx: 1430), 21.45, 0.01)
        ctx.near(ScanMarkMaker.radiusPx(radiusM: 0.03, depthM: 0.2, fx: 1430), ScanMarkMaker.maxRadiusPx, 1e-9)
        ctx.near(ScanMarkMaker.radiusPx(radiusM: 0.001, depthM: 5, fx: 1430), ScanMarkMaker.minRadiusPx, 1e-9)
        let s = ScanScene()
        let f = s.closeupFrames()[0]
        ctx.expect(ScanMarkMaker.expected(s.corners[0], in: f) != nil)
        ctx.expect(ScanMarkMaker.expected(s.corners[2], in: f) == nil, "the far corner is not in a close-up of the first")
        ctx.expect(ScanMarkMaker.expected(Vec3(0, 1.4, 1), in: f) == nil, "behind the camera")
    },
    Check("Scan JSON: the body has exactly the contract's keys, nulls where it says null, 16 numbers per pose, and reads back") { ctx in
        let s = ScanScene()
        let frames = s.regularFrames(4) + s.closeupFrames()
        let draft = ScanDraft(scanId: "5b2c2f4e-0000-4000-8000-000000000001", windowId: "w-1", frames: frames, allMarks: s.marks(frames, sigmaPx: 0.4),
                              wall: s.wall, windowFrame: WindowFrameSize(widthIn: 34.5, heightIn: 58.5, estimated: true))
        var ids: [String: String] = [:]
        for f in frames { ids[f.frameId] = "up-\(f.frameId)" }
        guard let payload = draft.payload(uploadIds: ids, app: "0.1.0 (2610251200)", device: "iPhone17,2"), let data = try? payload.json(),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return ctx.expect(false, "no payload") }
        ctx.equal(Set(obj.keys), ["scanId", "windowId", "app", "device", "wall", "frames", "marks", "result"])
        ctx.equal(Set((obj["wall"] as? [String: Any] ?? [:]).keys), ["point", "normal"])
        let fr = obj["frames"] as? [[String: Any]] ?? []
        ctx.equal(fr.count, 8)
        for f in fr {
            ctx.equal(Set(f.keys), ["frameId", "kind", "corner", "uploadId", "imageWidth", "imageHeight", "cameraTransform", "intrinsics"])
            ctx.equal((f["cameraTransform"] as? [Double])?.count, 16)
            ctx.equal(Set((f["intrinsics"] as? [String: Any] ?? [:]).keys), ["fx", "fy", "cx", "cy", "width", "height"])
        }
        ctx.expect(fr[0]["corner"] is NSNull, "a regular frame's corner is an explicit null")
        ctx.equal(fr[4]["corner"] as? Int, 0)
        ctx.equal(fr[0]["kind"] as? String, "regular")
        ctx.equal(fr[4]["kind"] as? String, "closeup")
        let mk = obj["marks"] as? [[String: Any]] ?? []
        ctx.expect(!mk.isEmpty && mk.count <= 200)
        for m in mk { ctx.equal(Set(m.keys), ["frameId", "corner", "x", "y", "source"]) }
        let res = obj["result"] as? [String: Any] ?? [:]
        ctx.equal(Set(res.keys), ["cornersM", "widthIn", "heightIn", "windowFrame", "quality", "status"])
        ctx.equal((res["cornersM"] as? [[Double]])?.count, 4)
        ctx.equal(Set((res["windowFrame"] as? [String: Any] ?? [:]).keys), ["widthIn", "heightIn", "estimated"])
        ctx.equal(res["status"] as? String, "measured")
        let q = res["quality"] as? [String: Any] ?? [:]
        ctx.equal(Set(q.keys), ["framesPerCorner", "reprojRmsPx", "reprojMaxPx", "minBaselineDeg", "symRatioDiff", "planeMaxCm", "scaleDiff", "closeups", "failed"])
        ctx.expect(data.count < 1_000_000, "body is \(data.count) bytes")
        ctx.equal(payload.problem, nil)
        // reads back identical
        let back = try JSONDecoder().decode(WindowScanPayload.self, from: data)
        ctx.equal(back, payload)
        // nothing to fit: nulls, not missing keys
        let empty = ScanDraft(scanId: "s", windowId: "w", frames: frames, allMarks: [], wall: s.wall)
        let nullBody = try empty.payload(uploadIds: ids, app: "a", device: "d")!.json()
        let nullRes = (try JSONSerialization.jsonObject(with: nullBody) as? [String: Any])?["result"] as? [String: Any] ?? [:]
        ctx.expect(nullRes["cornersM"] is NSNull && nullRes["widthIn"] is NSNull && nullRes["heightIn"] is NSNull)
        ctx.equal(nullRes["status"] as? String, "needs_review")
        // a photo without an upload id: no body yet
        ctx.expect(draft.payload(uploadIds: [:], app: "a", device: "d") == nil)
    },
    Check("Scan JSON: the contract's limits (3 to 24 photos, 200 marks, known photos) are checked before sending") { ctx in
        let s = ScanScene()
        func payload(_ n: Int, marks: [ScanMark]? = nil) -> WindowScanPayload {
            let frames = s.regularFrames(n)
            let ids = Dictionary(uniqueKeysWithValues: frames.map { ($0.frameId, "u-\($0.frameId)") })
            return ScanDraft(scanId: "s", windowId: "w", frames: frames, allMarks: marks ?? s.marks(frames), wall: s.wall).payload(uploadIds: ids, app: "a", device: "d")!
        }
        ctx.expect(payload(2).problem != nil)
        ctx.equal(payload(3).problem, nil)
        ctx.equal(payload(24).problem, nil)
        ctx.expect(payload(25).problem != nil)
        let many = (0..<201).map { ScanMark(frameId: "r1", corner: $0 % 4, x: 1, y: 1, source: .snap) }
        ctx.expect(payload(3, marks: many).problem != nil)
        ctx.expect(payload(3, marks: [ScanMark(frameId: "nope", corner: 0, x: 1, y: 1, source: .snap)]).problem != nil)
    },
    Check("Scan JSON: the server's answer reads whether or not its result does") { ctx in
        let ok = Data(#"{"scanId":"s1","status":"needs_review","result":{"cornersM":null,"widthIn":null,"heightIn":null,"windowFrame":null,"quality":{"framesPerCorner":[3,3,3,3],"reprojRmsPx":1.0,"reprojMaxPx":2.0,"minBaselineDeg":5.0,"symRatioDiff":0.01,"planeMaxCm":0.2,"scaleDiff":0.01,"closeups":0,"failed":["no_closeups"]},"status":"measured"}}"#.utf8)
        let a = try JSONDecoder().decode(WindowScanAnswer.self, from: ok)
        ctx.equal(a.scanId, "s1")
        ctx.equal(a.status, "needs_review")
        ctx.equal(a.result?.quality.failed, ["no_closeups"])
        let odd = Data(#"{"scanId":"s2","status":"processing","result":{"something":"else"}}"#.utf8)
        let b = try JSONDecoder().decode(WindowScanAnswer.self, from: odd)
        ctx.equal(b.status, "processing")
        ctx.expect(b.result == nil)
        let none = Data(#"{"scanId":"s3","status":"processing"}"#.utf8)
        ctx.expect(try JSONDecoder().decode(WindowScanAnswer.self, from: none).result == nil)
    },
]
