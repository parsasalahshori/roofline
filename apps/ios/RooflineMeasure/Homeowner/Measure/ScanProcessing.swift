import CoreGraphics
import Foundation
import RooflineCore

// From the photos of a guided scan to its marks and its answer. The window's first estimate is found in ONE regular photo with the same machinery
// the single-photo flow uses (the depth sensor's opening, the AI window finder, each side set onto the frame's edge in the photo); its four
// corners are projected into every other photo and found again there (`ScanMarkMaker`), and the maths in RooflineCore does the rest. Everything
// here blocks: call it off the main thread.

enum ScanProcessing {
    /// The corner finder for `ScanMarkMaker`: given where a corner should be in a photo (native pixels) and how far to look, cut a square of the
    /// upright photo round it and ask `CornerSnap` for the crossing of the strongest upright and level edges there.
    static func snapper(shots: [ScanShot], images: ScanImages) -> ScanMarkMaker.Snapper {
        let byId = Dictionary(shots.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return { frame, _, approx, radius in
            guard let shot = byId[frame.frameId], let image = images.image(shot) else { return nil }
            let photo = shot.view.photoPixel(fromNative: approx)
            guard let (patch, origin) = PhotoSnap.patch(around: CGPoint(x: photo.x, y: photo.y), half: CornerSnap.halfSize(forRadius: radius), in: image),
                  let s = CornerSnap.snap(corner: Vec2(photo.x - Double(origin.x), photo.y - Double(origin.y)), in: patch, radius: radius) else { return nil }
            return shot.view.nativePixel(fromPhoto: Vec2(s.point.x + Double(origin.x), s.point.y + Double(origin.y)))
        }
    }

    /// The depth sensor's opening in a regular photo, fast (no network). Nil without depth or when it shows no window.
    static func depthOpening(_ shot: ScanShot, images: ScanImages) -> OpeningFinder.Found? {
        guard let image = images.image(shot) else { return nil }
        return FreezeProposal.depth(in: image, view: shot.view)
    }

    /// The window to start from, in the order of trust (the AI's, the depth sensor's, Vision's): see `FreezeProposal.resolve`.
    static func proposal(_ shot: ScanShot, images: ScanImages, ai: WindowDetection?, depth: OpeningFinder.Found?) -> WindowProposal.Result? {
        guard let image = images.image(shot) else { return nil }
        return FreezeProposal.resolve(in: image, view: shot.view, ai: ai, depth: depth)
    }

    static func markSource(_ source: ProposalSource) -> MarkSource {
        switch source {
        case .ai, .aiQuad, .aiDepth: return .ai
        default: return .snap
        }
    }

    struct Built {
        var draft: ScanDraft
        var run: ScanMarkMaker.Run
    }

    /// The marks and the answer for a scan whose first estimate is `estimate` (TL, TR, BR, BL in the world, found in `shots[0]`).
    /// `radiusScale` widens the first search for a coarser first estimate (Apple's room scan), and `bootstrap` makes a better first rectangle from the
    /// corners the first search confirmed when the scan does not pass (`ScanMarkMaker.run`).
    static func build(shots: [ScanShot], estimate: [Vec3], keySource: MarkSource, scanId: String, windowId: String, images: ScanImages, radiusScale: Double = 1,
                      bootstrap: Bool = false) -> Built? {
        guard let key = shots.first, estimate.count == 4 else { return nil }
        let wall = Plane.fit(estimate)?.facing(key.view.viewer) ?? key.view.wall
        let frames = shots.map { $0.frame }
        let run = ScanMarkMaker.run(frames: frames, estimate: estimate, keyFrameId: key.id, keySource: keySource, wall: wall, snapper: snapper(shots: shots, images: images),
                                    radiusScale: radiusScale, bootstrap: bootstrap)
        var draft = ScanDraft(scanId: scanId, windowId: windowId, frames: frames, allMarks: run.all, wall: wall)
        // The marks that were not confirmed stay as hollow projections; the confirmed ones are what the maths used
        draft.allMarks = run.all.map { m in run.used.contains(where: { $0.frameId == m.frameId && $0.corner == m.corner && $0.x == m.x && $0.y == m.y }) ? m : hollow(m) }
        draft.windowFrame = windowFrame(of: draft, key: key, images: images)
        return Built(draft: draft, run: run)
    }

    /// A mark the pruning took out is shown as a projection nothing confirmed (the person may place it).
    private static func hollow(_ m: ScanMark) -> ScanMark {
        var h = m
        if h.source != .user { h.source = .projected }
        return h
    }

    /// The window's own frame inside the solved opening, found in the key photo as the single-photo flow does; its size estimated when blinds hide it.
    static func windowFrame(of draft: ScanDraft, key: ScanShot, images: ScanImages) -> WindowFrameSize? {
        let sol = draft.solution
        guard let corners = sol.cornersM, let w = sol.widthIn, let h = sol.heightIn else { return nil }
        if let image = images.image(key),
           let rect = FrozenRect.bounding(of: corners, plane: draft.wall, viewer: key.view.viewer),
           let opening = FrozenMeasure.measure(rect: rect, view: key.view),
           let found = WindowFrameFinder.find(opening: rect, view: key.view, photo: { x, y, w, h in PhotoSnap.gray(image, x: x, y: y, width: w, height: h) }),
           let size = found.size(inOpening: opening) {
            return size
        }
        return WindowFrameSize.estimate(openingWidthIn: w, openingHeightIn: h)
    }

    /// The photo with the scan's rectangle and a dot at each mark, as screen points of a `width` x `height` picture of the upright photo.
    static func outline(of corners: [Vec3], in shot: ScanShot) -> [CGPoint]? {
        let px = corners.compactMap { shot.view.photoPixel(ofWorld: $0) }
        return px.count == 4 ? px.map { CGPoint(x: $0.x, y: $0.y) } : nil
    }

    /// The mark's place in a shot's UPRIGHT photo (the marks themselves are native pixels).
    static func photoPoint(_ m: ScanMark, in shot: ScanShot) -> CGPoint {
        let p = shot.view.photoPixel(fromNative: Vec2(m.x, m.y))
        return CGPoint(x: p.x, y: p.y)
    }

    /// The native pixel for a point of the upright photo.
    static func nativePoint(_ p: CGPoint, in shot: ScanShot) -> Vec2 {
        shot.view.nativePixel(fromPhoto: Vec2(Double(p.x), Double(p.y)))
    }

    /// The best regular photo to show the result on: the most front-on one that has a mark on all four corners.
    static func bestShot(of shots: [ScanShot], draft: ScanDraft) -> ScanShot? {
        let regular = shots.filter { s in s.kind == .regular && (0..<4).allSatisfy { c in draft.usedMarks.contains { $0.frameId == s.id && $0.corner == c } } }
        guard let corners = draft.solution.cornersM, corners.count == 4 else { return regular.first ?? shots.first }
        let n = (corners[1] - corners[0]).cross(corners[3] - corners[0]).normalized
        return regular.max { a, b in front(a, n, corners) < front(b, n, corners) } ?? shots.first
    }

    private static func front(_ s: ScanShot, _ normal: Vec3?, _ corners: [Vec3]) -> Double {
        guard let n = normal, let c = Vec3.mean(corners) else { return 0 }
        let forward = (c - s.view.viewer).normalized ?? Vec3(0, 0, -1)
        return abs(n.dot(forward))
    }
}
