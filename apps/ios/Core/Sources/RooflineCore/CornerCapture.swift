import Foundation

/// The four-corner AR measure of one window, without ARKit: corners placed, the wall plane, tracking losses, undo and
/// start over, the live sides. The app feeds it what ARKit reports; this decides what happens.
public struct CornerCapture: Sendable {
    /// A tap whose depth points are mostly further than this off the wall plane is refused (through the glass).
    public static let maxOffPlaneM = 0.05
    /// Only depth points this close (metres, along the wall) to the tapped corner count for the off-wall check, and the
    /// app only reads this far around the reticle: wide enough for a few good points, narrow enough that at an inside
    /// frame corner the glass behind it does not outvote the frame (it was ~4.7 cm, which refused correct taps).
    public static let depthRadiusM = 0.02
    /// Fewest depth points near the tap to judge by (fewer: the check is skipped, nothing is refused on thin evidence).
    public static let minDepthPoints = 6
    /// A corner closer than this to one already placed is a double tap.
    public static let minCornerGapM = 0.02

    public enum PlaceResult: Equatable, Sendable {
        case placed(index: Int)
        /// Most of the points around the reticle are off the wall (metres: their median distance).
        case offWall(distanceM: Double)
        case tooCloseToCorner
        case alreadyFour
    }

    /// Corners in tap order (the order a person happened to tap them).
    public private(set) var corners: [CornerEstimate] = []
    /// The wall the window is on, once ARKit found a vertical plane there (oriented toward the camera).
    public private(set) var wallPlane: Plane?
    /// Times tracking was lost during this window (kept across restarts: the server is told).
    public private(set) var trackingLostCount = 0
    /// Times the window was started over because tracking was lost between corners.
    public private(set) var restartsForTracking = 0
    /// Was tracking normal at the last update?
    public private(set) var tracking = false
    public private(set) var hadTracking = false

    public init() {}

    public var isComplete: Bool { corners.count == 4 }

    /// May the next corner be placed now? Only with tracking normal, the wall plane locked (a corner before the wall is
    /// known could not be checked or projected), the reticle on a surface, no sampling running and fewer than four corners.
    public func canPlaceNext(aimed: Bool, sampling: Bool) -> Bool {
        tracking && wallPlane != nil && aimed && !sampling && !isComplete
    }
    public var points: [Vec3] { corners.map { $0.point } }

    /// Lock (or refresh) the wall plane. Only a vertical plane counts; the normal is turned toward the viewer.
    public mutating func setWallPlane(_ plane: Plane?, viewer: Vec3) {
        guard let plane = plane else {
            wallPlane = nil
            return
        }
        guard plane.isVertical else { return }
        wallPlane = plane.facing(viewer)
    }

    /// Tracking changed. Returns true when the window was started over (a loss with corners in progress or before
    /// the save: the world can shift on relocalisation, so earlier corners cannot be trusted).
    @discardableResult
    public mutating func setTracking(normal: Bool) -> Bool {
        defer { tracking = normal }
        if normal {
            hadTracking = true
            return false
        }
        guard tracking else { return false } // already lost, or never tracked yet
        trackingLostCount += 1
        guard !corners.isEmpty else { return false }
        corners = []
        wallPlane = nil
        restartsForTracking += 1
        return true
    }

    /// Try to place the next corner from its averaged samples. `depthPoints`: high-confidence LiDAR points around the
    /// reticle (or raw surface hits) for the off-wall check; empty on phones without depth. Only the points within
    /// `depthRadiusM` of the corner (measured along the wall) are judged; with fewer than `minDepthPoints` of them the
    /// check is skipped. The tap is refused when more than half of them are further than `maxOffPlaneM` off the wall.
    public mutating func place(_ estimate: CornerEstimate, depthPoints: [Vec3] = []) -> PlaceResult {
        guard corners.count < 4 else { return .alreadyFour }
        if let wall = wallPlane {
            let near = depthPoints.filter { $0.isFinite && wall.project($0).distance(to: wall.project(estimate.point)) <= Self.depthRadiusM }
            if near.count >= Self.minDepthPoints, offPlaneShare(wall: wall, points: near, maxOffsetM: Self.maxOffPlaneM) > 0.5 {
                let d = median(near.map { wall.distance($0) }) ?? 0
                return .offWall(distanceM: d)
            }
        }
        if corners.contains(where: { $0.point.distance(to: estimate.point) < Self.minCornerGapM }) { return .tooCloseToCorner }
        corners.append(estimate)
        return .placed(index: corners.count - 1)
    }

    /// Takes one corner back (its index in tap order) so that corner can be placed again; the others and the wall stay. With none left
    /// the wall is let go, as in `undo`.
    @discardableResult
    public mutating func removeCorner(at index: Int) -> Bool {
        guard corners.indices.contains(index) else { return false }
        corners.remove(at: index)
        if corners.isEmpty { wallPlane = nil }
        return true
    }

    /// Takes the last corner back. With none left, the wall is let go too: the next first corner locks the plane under
    /// the reticle again (the homeowner may be about to measure a different window).
    public mutating func undo() {
        if !corners.isEmpty { corners.removeLast() }
        if corners.isEmpty { wallPlane = nil }
    }

    public mutating func startOver() {
        corners = []
        wallPlane = nil
    }

    /// The AR session was reset (an interruption ended, or it failed and was re-run): the world is new, so the corners, the
    /// wall and the tracking history all go. The losses already counted stay: the server is told.
    public mutating func resetForNewSession() {
        corners = []
        wallPlane = nil
        tracking = false
        hadTracking = false
    }

    /// The sides drawn so far, inches: between placed corners in order, and from the last one to the aim point.
    public func liveEdgesIn(aim: Vec3?) -> [(inches: Double, toAim: Bool)] {
        var out: [(inches: Double, toAim: Bool)] = []
        let p = points
        if p.count >= 2 { for i in 1..<p.count { out.append((p[i - 1].distance(to: p[i]) * inchesPerMetre, false)) } }
        if p.count == 4 {
            out.append((p[3].distance(to: p[0]) * inchesPerMetre, false))
        } else if let a = aim, let last = p.last {
            out.append((last.distance(to: a) * inchesPerMetre, true))
        }
        return out
    }

    /// The finished window: the four corners projected onto the plane (the wall's when locked, else the best fit
    /// through the four), then ordered TL, TR, BR, BL by gravity as seen from `viewer`. With the per-corner spreads in
    /// that same order and how far the raw corners were off the plane before projecting.
    public func finished(viewer: Vec3) -> FinishedCorners? {
        guard isComplete else { return nil }
        return Self.finish(raw: points, spreadM: corners.map { $0.spreadM }, wall: wallPlane, viewer: viewer)
    }

    /// Four corners in any order (world metres, `spreadM` in the same order) into the finished window: projected onto the plane (the
    /// wall's, moved to the frame's face, when given; else the best fit through the four), ordered TL, TR, BR, BL by gravity as seen
    /// from `viewer`, and fitted to a rectangle. Taps and a frozen photo both end here, so they size the same way.
    public static func finish(raw: [Vec3], spreadM: [Double], wall: Plane?, viewer: Vec3) -> FinishedCorners? {
        guard raw.count == 4, raw.allSatisfy({ $0.isFinite }) else { return nil }
        let plane = wall.map { wall -> Plane in
            // The frame's own plane: parallel to the wall, through the corners (they were sampled on local planes)
            let offs = raw.map { wall.signedDistance($0) }
            return wall.offset(by: median(offs) ?? 0)
        } ?? Plane.fit(raw)
        guard let pl = plane else { return nil }
        let maxOff = raw.map { pl.distance($0) }.max() ?? 0
        let projected = raw.map { pl.project($0) }
        guard let ordered = gravityOrderedCorners(projected, viewer: viewer) else { return nil }
        // Which corner as given each ordered corner was; the spreads follow their corners into the gravity order
        let tapIndex: [Int] = ordered.map { q in projected.enumerated().min { $0.element.distance(to: q) < $1.element.distance(to: q) }!.offset }
        let spreads: [Double] = tapIndex.map { $0 < spreadM.count ? spreadM[$0] : 0 }
        let fit = RectangleFit.fit(ordered: ordered, plane: pl, viewer: viewer)
        return FinishedCorners(pointsM: ordered, cornerSpreadM: spreads, maxOffPlaneM: maxOff, usedWallPlane: wall != nil, tapIndex: tapIndex, fit: fit)
    }
}

public struct FinishedCorners: Equatable, Sendable {
    /// TL, TR, BR, BL, metres.
    public var pointsM: [Vec3]
    public var cornerSpreadM: [Double]
    /// How far the raw corners were off the plane they were projected onto (metres).
    public var maxOffPlaneM: Double
    public var usedWallPlane: Bool
    /// For each ordered corner (TL, TR, BR, BL), which tap it was (an index into `CornerCapture.corners`).
    public var tapIndex: [Int] = []
    /// The best level rectangle through the four corners (see `RectangleFit`); nil when there is none (a floor, a skylight).
    public var fit: RectangleFit?

    /// The window to show, size and send: the fitted rectangle when there is one, else the four corners as placed.
    public var windowPointsM: [Vec3] { fit?.pointsM ?? pointsM }
    /// The spreads that go with `windowPointsM` (see `RectangleFit.spreadM(corner:)`).
    public var windowSpreadM: [Double] { fit?.spreadM(corner: cornerSpreadM) ?? cornerSpreadM }
    /// The corner (0 TL, 1 TR, 2 BR, 3 BL) that looks off the frame, when the corners disagree with the rectangle.
    public var flaggedCorner: Int? { fit?.flaggedCorner }
}
