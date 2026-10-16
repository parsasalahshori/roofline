import Foundation

// A Swift port of packages/shared/src/window-photo-math.ts sizeFromArPoints: the server recomputes every size, this
// one is the live preview on the phone. Keep the two in step: RooflineMeasureTests (and the Core checks) load
// apps/ios/RooflineMeasureTests/Fixtures/ar-sizing.json, written by the server's vitest, and compare.

public let inchesPerMetre = 39.37007874

/// Which AR stack measured the points (the server's 'ar' scale `device`).
public enum ArDevice: String, Codable, CaseIterable, Sendable {
    case webxr
    case arkit
    case arkitLidar = "arkit-lidar"
}

/// Thresholds, as in window-photo-math.ts.
public enum ArLimits {
    /// The four points further than this off their best-fit plane (inches) are not one flat frame: 'check'.
    public static let maxOffPlaneIn = 0.5
    /// A corner further than this off square (degrees): 'check'.
    public static let maxCornerOffDeg = 4.0
    /// Opposite sides differing by more than this share of their mean: 'check'.
    public static let maxSideDiff = 0.03
    /// The server's single per-point sigma before per-device sigmas (AR_POINT_SIGMA_M).
    public static let legacyPointSigmaM = 0.003
}

/// How AR noise is modelled for the ±. Mirrors the server's per-device sigma + scale term.
/// SYNC: these numbers must match packages/shared/src/window-photo-math.ts once the server change lands; the fixture
/// check reports any difference in uncertainty.
public struct ArSigmaModel: Equatable, Sendable {
    public var pointSigmaM: [ArDevice: Double]
    /// Share of a side's length added as a scale error (AR's scale is not perfect).
    public var scaleFraction: Double

    public init(pointSigmaM: [ArDevice: Double], scaleFraction: Double) {
        self.pointSigmaM = pointSigmaM
        self.scaleFraction = scaleFraction
    }

    public static let `default` = ArSigmaModel(
        pointSigmaM: [.webxr: 0.003, .arkit: 0.004, .arkitLidar: 0.002],
        scaleFraction: 0.01
    )

    /// The legacy model: one sigma for every device and no scale term (what the server does before the change).
    public static let legacy = ArSigmaModel(pointSigmaM: [.webxr: 0.003, .arkit: 0.003, .arkitLidar: 0.003], scaleFraction: 0)

    /// Per-point sigma for a pass: the device's, or the measured corner spread (rms) when that is larger.
    public func sigma(device: ArDevice?, cornerSpreadM: [Double]?) -> Double {
        let base = device.flatMap { pointSigmaM[$0] } ?? ArLimits.legacyPointSigmaM
        guard let spread = cornerSpreadM, !spread.isEmpty, spread.allSatisfy({ $0.isFinite && $0 >= 0 }) else { return base }
        let rms = (spread.reduce(0) { $0 + $1 * $1 } / Double(spread.count)).squareRoot()
        return max(base, rms)
    }
}

public struct ArSize: Equatable, Sendable {
    public var widthIn: Double
    public var heightIn: Double
    /// About 1 sigma, inches.
    public var uncertaintyWidthIn: Double
    public var uncertaintyHeightIn: Double
    public var quality: Quality
    /// Why 'check', in plain words (empty when 'good').
    public var reasons: [String]
    /// The corners in the order they were sized (gravity-ordered TL, TR, BR, BL when asked).
    public var corners: [Vec3]

    public enum Quality: String, Codable, Sendable {
        case good
        case check
    }
}

/// TL, TR, BR, BL frame corners ordered by GRAVITY (world +Y up), never by tap order.
/// The top two are the two highest along the wall's in-plane "up"; left/right are as seen from `viewer` (the camera)
/// when given (without it the order can be mirrored, which changes no size). Nil unless four finite, non-collinear
/// points on a wall that is not lying flat.
public func gravityOrderedCorners(_ points: [Vec3], viewer: Vec3? = nil) -> [Vec3]? {
    guard points.count == 4, points.allSatisfy({ $0.isFinite }), let c = Vec3.mean(points) else { return nil }
    // The plane through the four points, by least squares: tap order is unknown, so "diagonals" may be two sides
    guard let n0 = Plane.fit(points)?.normal else { return nil }
    var normal = n0
    if let v = viewer, (v - c).dot(normal) < 0 { normal = -normal }
    // Gravity's up inside the wall plane
    let upIn = Vec3.up - normal * Vec3.up.dot(normal)
    guard let up = upIn.normalized, upIn.length > 0.25 else { return nil } // a skylight or a floor: no up
    let right = up.cross(normal)
    let coords = points.map { p -> (p: Vec3, s: Double, t: Double) in
        let d = p - c
        return (p, d.dot(right), d.dot(up))
    }
    let byHeight = coords.sorted { $0.t > $1.t }
    let top = byHeight[0..<2].sorted { $0.s < $1.s }
    let bottom = byHeight[2..<4].sorted { $0.s < $1.s }
    return [top[0].p, top[1].p, bottom[1].p, bottom[0].p]
}

/// The window's size from its four frame corners in AR space (metres). Width = mean of top and bottom, height = mean
/// of left and right; 'check' when the points are not one flat frame (> 0.5 in), a corner is > 4 degrees off square,
/// or opposite sides differ by > 3%. Uncertainty per dimension: the point sigma, half the difference between the
/// two opposite sides, the off-plane rms, and (scaleFraction x the dimension), added in quadrature.
/// Nil for degenerate input (not four finite points, or a side of zero length).
///
/// - Parameters:
///   - gravityOrder: order the corners by gravity first (the server's fix for tap-order corners).
public func sizeFromArPoints(
    _ pointsM: [Vec3],
    sigmaM: Double = ArLimits.legacyPointSigmaM,
    scaleFraction: Double = 0,
    gravityOrder: Bool = true,
    viewer: Vec3? = nil
) -> ArSize? {
    guard pointsM.count == 4, pointsM.allSatisfy({ $0.isFinite }) else { return nil }
    var ordered = pointsM
    if gravityOrder, let g = gravityOrderedCorners(pointsM, viewer: viewer) { ordered = g }
    let p = ordered.map { $0 * inchesPerMetre }
    let top = (p[1] - p[0]).length
    let right = (p[2] - p[1]).length
    let bottom = (p[2] - p[3]).length
    let left = (p[3] - p[0]).length
    guard [top, right, bottom, left].allSatisfy({ $0 > 1e-6 }) else { return nil }
    let widthIn = (top + bottom) / 2
    let heightIn = (left + right) / 2

    // Off-plane residuals: the plane through the centroid normal to both diagonals
    let n = (p[2] - p[0]).cross(p[3] - p[1])
    let nLen = n.length
    let c = Vec3.mean(p)!
    let off: [Double] = nLen > 1e-9 ? p.map { abs(($0 - c).dot(n)) / nLen } : [0, 0, 0, 0]
    let maxOff = off.max() ?? 0
    let rmsOff = (off.reduce(0) { $0 + $1 * $1 } / 4).squareRoot()

    // Corner angles (TL, TR, BR, BL)
    let cornerOff: [Double] = (0..<4).map { i in
        let a = p[(i + 3) % 4] - p[i]
        let b = p[(i + 1) % 4] - p[i]
        let cosv = a.dot(b) / (a.length * b.length)
        return abs(acos(max(-1, min(1, cosv))) * 180 / .pi - 90)
    }
    let worstCorner = cornerOff.max() ?? 0
    let widthDiff = abs(top - bottom) / widthIn
    let heightDiff = abs(left - right) / heightIn

    var reasons: [String] = []
    if nLen <= 1e-9 { reasons.append("the corners are in a line") }
    if maxOff > ArLimits.maxOffPlaneIn { reasons.append("the corners are not on one flat frame (\(fixed(maxOff, 2)) in off)") }
    if worstCorner > ArLimits.maxCornerOffDeg { reasons.append("a corner is \(fixed(worstCorner, 1))° off square") }
    if widthDiff > ArLimits.maxSideDiff { reasons.append("top and bottom differ by \(fixed(widthDiff * 100, 1))%") }
    if heightDiff > ArLimits.maxSideDiff { reasons.append("left and right differ by \(fixed(heightDiff * 100, 1))%") }

    let sigmaIn = sigmaM * inchesPerMetre
    func u(_ diff: Double, _ length: Double) -> Double {
        let scale = scaleFraction * length
        return (sigmaIn * sigmaIn + (diff / 2) * (diff / 2) + rmsOff * rmsOff + scale * scale).squareRoot()
    }
    return ArSize(
        widthIn: widthIn,
        heightIn: heightIn,
        uncertaintyWidthIn: u(abs(top - bottom), widthIn),
        uncertaintyHeightIn: u(abs(left - right), heightIn),
        quality: reasons.isEmpty ? .good : .check,
        reasons: reasons,
        corners: ordered
    )
}

/// The preview a pass shows: the sigma model for the device (and measured spread), gravity-ordered corners.
public func previewArSize(_ pointsM: [Vec3], device: ArDevice, cornerSpreadM: [Double]?, model: ArSigmaModel = .default, viewer: Vec3? = nil) -> ArSize? {
    sizeFromArPoints(pointsM, sigmaM: model.sigma(device: device, cornerSpreadM: cornerSpreadM), scaleFraction: model.scaleFraction, gravityOrder: true, viewer: viewer)
}

/// `toFixed` as JavaScript writes it (for the reasons' text).
func fixed(_ v: Double, _ digits: Int) -> String {
    String(format: "%.\(digits)f", v)
}
