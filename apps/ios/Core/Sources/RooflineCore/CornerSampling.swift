import Foundation

// One corner is not one raycast: while the phone is held still the app collects ~1 s of samples (about 45 frames at
// 45-60 fps) of where the reticle's ray meets the wall, drops the outliers and averages the rest. Consecutive frames are
// strongly correlated (the same pose, the same depth), so the spread is measured on BLOCK MEANS of consecutive samples,
// not on single samples: independent noise averages down inside a block, drift and slow wander do not. That spread is
// the corner's measured noise (sent to the server as cornerSpreadM).

public struct CornerEstimate: Equatable, Sendable {
    /// The averaged corner, metres.
    public var point: Vec3
    /// Correlation-aware spread, metres: the standard deviation (3-D) of the block means of the kept samples, in time
    /// order (see `robustMean`). With too few samples for blocks, the RMS distance of the samples from their mean.
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
    /// Samples to collect for one corner: about one second at 45-60 frames a second.
    public static let targetSamples = 45
    /// Fewest samples a corner may be averaged from (when the phone would not hold still long enough): ~1/3 s.
    public static let minSamples = 20
    /// The kept samples are cut into this many blocks of consecutive samples for the spread.
    public static let spreadBlocks = 5
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

/// Mean of the points (in time order) after dropping outliers: distance from the component-wise median beyond
/// max(3 x 1.4826 x MAD, 5 mm). The spread is the 3-D standard deviation of the means of `CornerSampler.spreadBlocks`
/// blocks of consecutive kept samples (n-1 divisor): honest when neighbouring samples are correlated, where the RMS of
/// single samples would only be the frame-to-frame jitter. Under 6 kept samples (blocks of under 3) it is the RMS of
/// the samples. Nil with fewer than `minCount` points.
public func robustMean(_ points: [Vec3], minCount: Int = 1) -> CornerEstimate? {
    let finite = points.filter { $0.isFinite }
    guard finite.count >= max(1, minCount) else { return nil }
    let med = Vec3(median(finite.map { $0.x })!, median(finite.map { $0.y })!, median(finite.map { $0.z })!)
    let d = finite.map { $0.distance(to: med) }
    let mad = median(d.map { abs($0 - median(d)!) }) ?? 0
    let radius = max(3 * 1.4826 * mad, CornerSampler.minRejectRadiusM) + median(d)!
    let kept = finite.filter { $0.distance(to: med) <= radius }
    guard kept.count >= max(1, minCount), let mean = Vec3.mean(kept) else { return nil }
    let spread = blockSpread(kept) ?? (kept.reduce(0.0) { $0 + ($1 - mean).dot($1 - mean) } / Double(kept.count)).squareRoot()
    return CornerEstimate(point: mean, spreadM: spread, used: kept.count, rejected: finite.count - kept.count)
}

/// The standard deviation of the block means of consecutive points (3-D), or nil when blocks of 3+ points are not possible.
func blockSpread(_ points: [Vec3], blocks wanted: Int = CornerSampler.spreadBlocks) -> Double? {
    let blocks = min(wanted, points.count / 3)
    guard blocks >= 2 else { return nil }
    let size = points.count / blocks
    let means = (0..<blocks).compactMap { b in Vec3.mean(Array(points[(b * size)..<((b + 1) * size)])) }
    guard means.count == blocks, let grand = Vec3.mean(means) else { return nil }
    return (means.reduce(0.0) { $0 + ($1 - grand).dot($1 - grand) } / Double(blocks - 1)).squareRoot()
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
/// depth point is near it. The caller passes only the high-confidence points within `CornerCapture.depthRadiusM` of
/// the reticle.
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
