import Foundation

// From a first estimate of the window to the marks of a scan. The window's four corners are found ONCE (in one good regular frame, by the
// AI finder and the depth sensor, as the single-photo flow does) and become a 3D rectangle. That rectangle is PROJECTED into every other photo,
// and each projected corner is then looked for in that photo's own pixels (the corner snapper: the crossing of the strongest upright and level
// edges near it). What the photo confirms is a mark; a corner the photo is not clear about stays a hollow, unconfirmed projection that is
// never used in the maths until the person drags it. After a first triangulation the better-known corners are projected again, with a
// smaller search, and the scan is solved a second time. Everything here is plain values and a snapper closure, so it is checked on a Mac.

public enum ScanMarkMaker {
    /// Finds a corner in one photo: given the frame, the corner and where it is expected (native pixels), the corner's native pixel, or nil
    /// when the picture is not clear about one within `radiusPx`.
    public typealias Snapper = (_ frame: ScanFrame, _ corner: Int, _ approx: Vec2, _ radiusPx: Double) -> Vec2?

    /// How far (metres on the wall) from the estimate a corner is looked for: the first pass in a regular photo, in a close-up (the estimate
    /// is less exact seen so near, and the picture shows more clutter), and the second pass in each.
    public static let firstRadiusM = 0.03
    public static let firstCloseupRadiusM = 0.045
    public static let secondRadiusM = 0.015
    public static let secondCloseupRadiusM = 0.025
    /// A corner is looked for in rings: first close to where it should be (half the radius), then the radius, then half as far again. The
    /// nearest ring where the picture is clear about a corner wins: a wide search sees look-alike edges (casing, sill, the window's own frame)
    /// that make a clear corner look unclear, so it is only widened when the narrow one finds nothing.
    public static let radiusLadder = [0.5, 1.0, 1.5]
    /// The search radius in native pixels is kept between these.
    public static let minRadiusPx = 5.0
    public static let maxRadiusPx = 130.0
    /// A corner counts as in the photo when it is this share of the photo's size inside every edge.
    public static let edgeMarginShare = 0.02

    /// A corner's expected pixel in a frame and how far away it is (metres along the view), nil when behind the camera or outside the photo.
    public static func expected(_ p: Vec3, in f: ScanFrame) -> (px: Vec2, depthM: Double)? {
        let c = f.cameraTransform.inverseRigid.transform(p)
        guard c.z < -1e-4, let px = WindowScanSolver.project(p, in: f) else { return nil }
        let w = f.intrinsics.width, h = f.intrinsics.height
        let mx = w * edgeMarginShare, my = h * edgeMarginShare
        guard px.x >= mx, px.x <= w - mx, px.y >= my, px.y <= h - my else { return nil }
        return (px, -c.z)
    }

    /// The search radius in native pixels for `radiusM` on the wall at `depthM` from the camera.
    public static func radiusPx(radiusM: Double, depthM: Double, fx: Double) -> Double {
        min(maxRadiusPx, max(minRadiusPx, radiusM * fx / max(depthM, 0.05)))
    }

    /// The marks for a rectangle's corners (TL, TR, BR, BL in the world) in every frame. A regular frame is marked at every corner it shows; a
    /// close-up only at its own corner. A corner the photo confirms is `.snap` (the key frame's, which the estimate itself came from, is
    /// `keySource` when the snapper is not clear); one it does not is `.projected`.
    public static func marks(corners: [Vec3], frames: [ScanFrame], keyFrameId: String?, keySource: MarkSource, radiusM: Double, closeupRadiusM: Double,
                             snapper: Snapper) -> [ScanMark] {
        guard corners.count == 4 else { return [] }
        var out: [ScanMark] = []
        for f in frames {
            for c in 0..<4 {
                if f.kind == .closeup, f.corner != c { continue }
                guard let e = expected(corners[c], in: f) else { continue }
                let base = f.kind == .closeup ? closeupRadiusM : radiusM
                var found: Vec2?
                for k in radiusLadder {
                    if let s = snapper(f, c, e.px, radiusPx(radiusM: base * k, depthM: e.depthM, fx: f.intrinsics.fx)) {
                        found = s
                        break
                    }
                }
                if let s = found {
                    out.append(ScanMark(frameId: f.frameId, corner: c, x: s.x, y: s.y, source: .snap))
                } else {
                    out.append(ScanMark(frameId: f.frameId, corner: c, x: e.px.x, y: e.px.y, source: f.frameId == keyFrameId ? keySource : .projected))
                }
            }
        }
        return out
    }

    /// The marks the maths may use: everything but a projection nothing in the photo confirmed.
    public static func evidence(_ marks: [ScanMark]) -> [ScanMark] { marks.filter { $0.source != .projected } }

    /// The marks with the outliers taken out. While a corner has more than `minMarksPerCorner` marks and one of them is further than the gate's
    /// `reprojMaxPx` from where the corner is triangulated, the mark whose removal leaves the others agreeing best goes (leave-one-out: the
    /// mark with the biggest error is not always the wrong one, a far camera can show the pull of a bad mark most). A mark the person placed
    /// is never removed. At most `maxDrops` marks in all.
    public static func pruned(frames: [ScanFrame], marks: [ScanMark], wall: Plane?, maxDrops: Int = 8) -> [ScanMark] {
        var current = marks
        for _ in 0..<maxDrops {
            var dropped = false
            for c in 0..<4 {
                let mine = current.filter { $0.corner == c }
                guard mine.count > ScanLimits.minMarksPerCorner, let res = WindowScanSolver.residuals(of: mine, frames: frames),
                      (res.max() ?? 0) > ScanLimits.reprojMaxPx else { continue }
                // Which removal leaves the rest in best agreement (lowest RMS of the others)?
                var best: (index: Int, rms: Double)?
                for (i, _) in mine.enumerated() {
                    var rest = mine
                    rest.remove(at: i)
                    guard let r = WindowScanSolver.residuals(of: rest, frames: frames) else { continue }
                    let rms = (r.reduce(0) { $0 + $1 * $1 } / Double(r.count)).squareRoot()
                    if best == nil || rms < best!.rms { best = (i, rms) }
                }
                // (a mark the person placed may be the culprit: it stays, and so do the others)
                guard let b = best, mine[b.index].source != .user else { continue }
                let gone = mine[b.index]
                if let k = current.firstIndex(where: { $0.frameId == gone.frameId && $0.corner == gone.corner }) { current.remove(at: k) }
                dropped = true
            }
            if !dropped { break }
        }
        return current
    }

    public struct Run: Equatable, Sendable {
        /// Every mark found, including the hollow projections (for drawing).
        public var all: [ScanMark]
        /// The marks the solution used, and the scan sends.
        public var used: [ScanMark]
        public var solution: ScanSolution
        /// Whether the second pass (re-projecting the triangulated corners) was kept.
        public var refined: Bool
    }

    /// The whole of it: marks from `estimate` (a rectangle's four corners), the outliers pruned, solved; then once more from the solved rectangle
    /// with a smaller search, kept when it is better (fewer gates failing, then a lower reprojection error).
    public static func run(frames: [ScanFrame], estimate: [Vec3], keyFrameId: String?, keySource: MarkSource, wall: Plane?, snapper: Snapper, secondPass: Bool = true) -> Run {
        let first = marks(corners: estimate, frames: frames, keyFrameId: keyFrameId, keySource: keySource, radiusM: firstRadiusM, closeupRadiusM: firstCloseupRadiusM, snapper: snapper)
        let used1 = pruned(frames: frames, marks: evidence(first), wall: wall)
        let sol1 = WindowScanSolver.solve(frames: frames, marks: used1, wall: wall)
        var best = Run(all: first, used: used1, solution: sol1, refined: false)
        guard secondPass, let rect = sol1.cornersM else { return best }
        let second = marks(corners: rect, frames: frames, keyFrameId: keyFrameId, keySource: keySource, radiusM: secondRadiusM, closeupRadiusM: secondCloseupRadiusM, snapper: snapper)
        let used2 = pruned(frames: frames, marks: evidence(second), wall: wall)
        let sol2 = WindowScanSolver.solve(frames: frames, marks: used2, wall: wall)
        let better = (sol2.fit != nil && sol1.fit == nil)
            || (sol2.fit != nil && (sol2.quality.hardFailures.count < sol1.quality.hardFailures.count
                || (sol2.quality.hardFailures.count == sol1.quality.hardFailures.count && sol2.quality.reprojRmsPx <= sol1.quality.reprojRmsPx)))
        if better { best = Run(all: second, used: used2, solution: sol2, refined: true) }
        return best
    }
}

/// One finished scan on the phone: its photos and marks, the wall, and the maths. What the result screen edits and the outbox sends.
public struct ScanDraft: Codable, Equatable, Sendable {
    public var scanId: String
    /// The window this scan belongs to (the window row the phone sends with it).
    public var windowId: String
    /// The photos; the one the first estimate was made on comes first (the scale gate's single-frame estimate uses it).
    public var frames: [ScanFrame]
    /// Every mark including hollow projections (what the screen draws).
    public var allMarks: [ScanMark]
    public var wall: Plane
    /// The window's own frame inside the opening (the single-photo finder's, or an estimate).
    public var windowFrame: WindowFrameSize?

    public init(scanId: String, windowId: String, frames: [ScanFrame], allMarks: [ScanMark], wall: Plane, windowFrame: WindowFrameSize? = nil) {
        self.scanId = scanId
        self.windowId = windowId
        self.frames = frames
        self.allMarks = allMarks
        self.wall = wall
        self.windowFrame = windowFrame
    }

    /// The marks in use: the confirmed ones.
    public var usedMarks: [ScanMark] { ScanMarkMaker.evidence(allMarks) }

    public var solution: ScanSolution { WindowScanSolver.solve(frames: frames, marks: usedMarks, wall: wall) }

    /// The draft with one mark placed by the person (a new mark, or the old one moved). It is then in use, and never moved or dropped by the phone.
    public func placing(frameId: String, corner: Int, at p: Vec2) -> ScanDraft {
        var d = self
        d.allMarks.removeAll { $0.frameId == frameId && $0.corner == corner }
        // (the server refuses a mark outside its photo: a mark dragged off the picture stays on its edge)
        let k = frames.first { $0.frameId == frameId }?.intrinsics
        let x = min(max(p.x, 0), k?.width ?? p.x), y = min(max(p.y, 0), k?.height ?? p.y)
        d.allMarks.append(ScanMark(frameId: frameId, corner: corner, x: x, y: y, source: .user))
        return d
    }

    /// The body for the server once every photo has an upload id (`uploadIds` by frame id). Nil while one is missing.
    public func payload(uploadIds: [String: String], app: String, device: String) -> WindowScanPayload? {
        var framePayloads: [ScanFramePayload] = []
        for f in frames {
            guard let up = uploadIds[f.frameId] else { return nil }
            framePayloads.append(ScanFramePayload(frame: f, uploadId: up))
        }
        let s = solution
        return WindowScanPayload(scanId: scanId, windowId: windowId, app: app, device: device, wall: ScanWall(wall), frames: framePayloads,
                                 marks: usedMarks, result: ScanResultPayload(solution: s, windowFrame: windowFrame))
    }
}
