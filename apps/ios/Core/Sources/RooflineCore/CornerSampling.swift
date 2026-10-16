import Foundation

// One corner is not one raycast: while the phone is held still the app collects ~15 samples of where the reticle's
// ray meets the wall, drops the outliers and averages the rest. The spread of what is kept is the corner's measured
// noise (sent to the server as cornerSpreadM).

public struct CornerEstimate: Equatable, Sendable {
    /// The averaged corner, metres.
    public var point: Vec3
    /// RMS distance of the kept samples from their mean, metres.
    public var spreadM: Double
    public var used: Int
    public var rejected: Int

    public init(point: Vec3, spreadM: Double, used: Int, rejected: Int) {
        self.point = point
        self.spreadM = spreadM
        self.used = used
        self.rejected = rejected
    }
}

public struct CornerSampler: Sendable {
    /// Samples to collect for one corner.
    public static let targetSamples = 15
    /// Fewest samples a corner may be averaged from (when the phone would not hold still long enough).
    public static let minSamples = 5
    /// A sample further than this from the median is always kept if within it (metres): 5 mm.
    public static let minRejectRadiusM = 0.005

    public private(set) var samples: [Vec3] = []

    public init() {}

    public var count: Int { samples.count }
    public var isFull: Bool { samples.count >= Self.targetSamples }
    public var progress: Double { min(1, Double(samples.count) / Double(Self.targetSamples)) }

    public mutating func add(_ p: Vec3) {
        guard p.isFinite, !isFull else { return }
        samples.append(p)
    }

    public mutating func reset() { samples = [] }

    /// The corner from the samples so far; nil with fewer than `minSamples`.
    public func estimate() -> CornerEstimate? {
        robustMean(samples, minCount: Self.minSamples)
    }
}

/// Mean of the points after dropping outliers: distance from the component-wise median beyond
/// max(3 x 1.4826 x MAD, 5 mm). Nil with fewer than `minCount` points.
public func robustMean(_ points: [Vec3], minCount: Int = 1) -> CornerEstimate? {
    let finite = points.filter { $0.isFinite }
    guard finite.count >= max(1, minCount) else { return nil }
    let med = Vec3(median(finite.map { $0.x })!, median(finite.map { $0.y })!, median(finite.map { $0.z })!)
    let d = finite.map { $0.distance(to: med) }
    let mad = median(d.map { abs($0 - median(d)!) }) ?? 0
    let radius = max(3 * 1.4826 * mad, CornerSampler.minRejectRadiusM) + median(d)!
    let kept = finite.filter { $0.distance(to: med) <= radius }
    guard kept.count >= max(1, minCount), let mean = Vec3.mean(kept) else { return nil }
    let spread = (kept.reduce(0.0) { $0 + ($1 - mean).dot($1 - mean) } / Double(kept.count)).squareRoot()
    return CornerEstimate(point: mean, spreadM: spread, used: kept.count, rejected: finite.count - kept.count)
}

/// Is the phone being held still? Fed every frame with the camera's position and where it looks.
public struct StillnessDetector: Sendable {
    /// Over this many seconds...
    public var windowS: Double = 0.3
    /// ...the camera moved less than this (m/s)...
    public var maxSpeedMps: Double = 0.03
    /// ...and turned less than this (degrees per second).
    public var maxTurnDps: Double = 6

    private var history: [(t: Double, p: Vec3, f: Vec3)] = []

    public init() {}

    /// Adds a frame; true when the last `windowS` seconds were still.
    @discardableResult
    public mutating func update(time: Double, position: Vec3, forward: Vec3) -> Bool {
        guard let f = forward.normalized else { return false }
        history.append((time, position, f))
        history.removeAll { time - $0.t > windowS * 2 }
        return isStill(now: time)
    }

    public func isStill(now: Double) -> Bool {
        guard let first = history.first(where: { now - $0.t <= windowS }), let last = history.last else { return false }
        let dt = last.t - first.t
        // Need most of a window of history to judge
        guard dt >= windowS * 0.6 else { return false }
        let speed = last.p.distance(to: first.p) / dt
        let turn = acos(max(-1, min(1, last.f.dot(first.f)))) * 180 / .pi / dt
        return speed <= maxSpeedMps && turn <= maxTurnDps
    }

    public mutating func reset() { history = [] }
}

/// The plane to intersect the reticle's ray with near a corner: the wall plane moved to where the LiDAR depth points
/// around the reticle are (a window frame often stands a little proud of, or sits back from, the siding). Points more
/// than `maxOffsetM` off the wall are ignored (glass, the room behind it). Returns the wall plane unchanged when no
/// depth point is near it.
public func localFramePlane(wall: Plane, depthPoints: [Vec3], maxOffsetM: Double = 0.05) -> Plane {
    let near = depthPoints.filter { $0.isFinite }.map { wall.signedDistance($0) }.filter { abs($0) <= maxOffsetM }
    guard near.count >= 3, let off = median(near) else { return wall }
    return wall.offset(by: off)
}

/// The share of the depth points around the reticle that are more than `maxOffsetM` off the wall plane. A tap whose
/// samples are mostly off the wall is hitting through the glass (or past the house) and is refused.
public func offPlaneShare(wall: Plane, points: [Vec3], maxOffsetM: Double = 0.05) -> Double {
    let finite = points.filter { $0.isFinite }
    guard !finite.isEmpty else { return 0 }
    return Double(finite.filter { wall.distance($0) > maxOffsetM }.count) / Double(finite.count)
}
