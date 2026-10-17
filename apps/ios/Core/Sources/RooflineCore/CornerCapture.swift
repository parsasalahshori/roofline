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

    public mutating func undo() {
        if !corners.isEmpty { corners.removeLast() }
    }

    public mutating func startOver() {
        corners = []
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
        let raw = points
        let plane = wallPlane.map { wall -> Plane in
            // The frame's own plane: parallel to the wall, through the corners (they were sampled on local planes)
            let offs = raw.map { wall.signedDistance($0) }
            return wall.offset(by: median(offs) ?? 0)
        } ?? Plane.fit(raw)
        guard let pl = plane else { return nil }
        let maxOff = raw.map { pl.distance($0) }.max() ?? 0
        let projected = raw.map { pl.project($0) }
        guard let ordered = gravityOrderedCorners(projected, viewer: viewer) else { return nil }
        // Spreads follow their corners into the gravity order
        let spreads: [Double] = ordered.map { q in
            let i = projected.enumerated().min { $0.element.distance(to: q) < $1.element.distance(to: q) }!.offset
            return corners[i].spreadM
        }
        return FinishedCorners(pointsM: ordered, cornerSpreadM: spreads, maxOffPlaneM: maxOff, usedWallPlane: wallPlane != nil)
    }
}

public struct FinishedCorners: Equatable, Sendable {
    /// TL, TR, BR, BL, metres.
    public var pointsM: [Vec3]
    public var cornerSpreadM: [Double]
    /// How far the raw corners were off the plane they were projected onto (metres).
    public var maxOffPlaneM: Double
    public var usedWallPlane: Bool
}
