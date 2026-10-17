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

/// Thresholds and noise, as in window-photo-math.ts (AR_* constants). SYNC with the server: the fixture check
/// (Fixtures/ar-sizing.json carries the server's constants too) fails when they drift.
public enum ArLimits {
    /// The four points further than this off their best-fit plane (inches) are not one flat frame: 'check'.
    public static let maxOffPlaneIn = 0.5
    /// A corner further than this off square (degrees): 'check'.
    public static let maxCornerOffDeg = 4.0
    /// Opposite sides differing by more than this share of their mean: 'check'.
    public static let maxSideDiff = 0.03
    /// Per-point AR noise, metres, 1 sigma, by device (AR_POINT_SIGMA_M). UNCALIBRATED until the field test.
    public static let pointSigmaM: [ArDevice: Double] = [.webxr: 0.006, .arkit: 0.004, .arkitLidar: 0.0025]
    /// AR's world scale error as a share of a length, 1 sigma (AR_SCALE_SIGMA): the default, for phones without depth.
    public static let scaleSigma = 0.01
    /// The same by device (AR_SCALE_SIGMA_BY_DEVICE): with LiDAR depth the scale is anchored to measured distances, so a
    /// typical 36 in window comes out about 1/4 in (hypot(2.5 mm, 0.6% of 36 in) = 0.24 in).
    public static let scaleSigmaByDevice: [ArDevice: Double] = [.webxr: 0.01, .arkit: 0.01, .arkitLidar: 0.006]
    public static func scale(_ device: ArDevice?) -> Double { scaleSigmaByDevice[device ?? .webxr] ?? scaleSigma }

    /// The device's point sigma; absent means 'webxr' (the Android web app does not say).
    public static func sigma(_ device: ArDevice?) -> Double { pointSigmaM[device ?? .webxr] ?? 0.006 }
}

/// RoomPlan's ± by its confidence, inches (ROOMPLAN_UNCERTAINTY_IN, never under 1 in). UNCALIBRATED.
public enum RoomPlanLimits {
    public static let minUncertaintyIn = 1.0
    public static func uncertaintyIn(_ c: RoomPlanConfidence) -> Double {
        switch c {
        case .high: return 1
        case .medium: return 1.5
        case .low: return 2
        }
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
    /// Which input point is the TL, TR, BR and BL corner (indexes into the points).
    public var order: [Int]

    public enum Quality: String, Codable, Sendable {
        case good
        case check
    }
}

/// The server's corner order (arCornerOrder): the four points as TL, TR, BR, BL by GRAVITY, never by tap order. The
/// two highest (+Y) are the top; left/right run along the wall, signed so that AR's origin (where the session began,
/// on the person's side of the wall) is in front. If the origin lies in the wall's plane, a fixed world axis decides.
/// Returns indexes into `p`.
public func arCornerOrder(_ p: [Vec3]) -> [Int] {
    // Highest first; ties keep the lower index first (as the server's stable comparator does)
    let byHeight = [0, 1, 2, 3].sorted { a, b in p[a].y != p[b].y ? p[a].y > p[b].y : a < b }
    let top = [byHeight[0], byHeight[1]]
    let bottom = [byHeight[2], byHeight[3]]
    func horiz(_ a: Vec3, _ b: Vec3) -> Vec3 { Vec3(b.x - a.x, 0, b.z - a.z) }
    var u = horiz(p[top[0]], p[top[1]])
    if u.length < 1e-9 { u = horiz(p[bottom[0]], p[bottom[1]]) }
    let centroid = Vec3((p[0].x + p[1].x + p[2].x + p[3].x) / 4, (p[0].y + p[1].y + p[2].y + p[3].y) / 4, (p[0].z + p[1].z + p[2].z + p[3].z) / 4)
    let toViewer = u.cross(Vec3(0, 1, 0))
    let side = toViewer.dot(Vec3.zero - centroid)
    let flip = abs(side) > 1e-9 ? side < 0 : (u.x < 0 || (u.x == 0 && u.z < 0))
    if flip { u = Vec3(-u.x, 0, -u.z) }
    func along(_ i: Int) -> Double { p[i].dot(u) }
    let (tl, tr) = along(top[0]) <= along(top[1]) ? (top[0], top[1]) : (top[1], top[0])
    let (bl, br) = along(bottom[0]) <= along(bottom[1]) ? (bottom[0], bottom[1]) : (bottom[1], bottom[0])
    return [tl, tr, br, bl]
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

/// The window's size from its four frame corners in AR space (metres), in any tap order: a port of the server's
/// sizeFromArPoints (packages/shared/src/window-photo-math.ts). Width = mean of top and bottom, height = mean of left
/// and right; 'check' when the points are not one flat frame (> 0.5 in), a corner is > 4 degrees off square, or
/// opposite sides differ by > 3%. Uncertainty per dimension, in quadrature: the point noise (sqrt of the sum of the four
/// corners' sigma^2, over 2; a corner's sigma is the larger of the device's and its measured spread), the scale error
/// (a share of the side by device: 1%, 0.6% with LiDAR), half the difference between opposite sides, and the off-plane rms.
/// Nil for degenerate input (not four finite points, or a side of zero length).
public func sizeFromArPoints(_ pointsM: [Vec3], device: ArDevice? = nil, cornerSpreadM: [Double]? = nil) -> ArSize? {
    guard pointsM.count == 4, pointsM.allSatisfy({ $0.isFinite }) else { return nil }
    let order = arCornerOrder(pointsM)
    let p = order.map { pointsM[$0] * inchesPerMetre }
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
    let c = Vec3((p[0].x + p[1].x + p[2].x + p[3].x) / 4, (p[0].y + p[1].y + p[2].y + p[3].y) / 4, (p[0].z + p[1].z + p[2].z + p[3].z) / 4)
    let off: [Double] = nLen > 1e-9 ? p.map { abs(($0 - c).dot(n)) / nLen } : [0, 0, 0, 0]
    let maxOff = off.max() ?? 0
    let rmsOff = ((off[0] * off[0] + off[1] * off[1] + off[2] * off[2] + off[3] * off[3]) / 4).squareRoot()

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

    let deviceSigmaM = ArLimits.sigma(device)
    func spread(_ i: Int) -> Double {
        guard let s = cornerSpreadM, i < s.count, s[i].isFinite, s[i] > 0 else { return 0 }
        return s[i]
    }
    let cornerSigmaIn = order.map { max(deviceSigmaM, spread($0)) * inchesPerMetre }
    let pointIn = cornerSigmaIn.reduce(0) { $0 + $1 * $1 }.squareRoot() / 2
    func u(_ side: Double, _ diff: Double) -> Double {
        let scale = ArLimits.scale(device) * side
        return (pointIn * pointIn + scale * scale + (diff / 2) * (diff / 2) + rmsOff * rmsOff).squareRoot()
    }
    return ArSize(
        widthIn: widthIn,
        heightIn: heightIn,
        uncertaintyWidthIn: u(widthIn, abs(top - bottom)),
        uncertaintyHeightIn: u(heightIn, abs(left - right)),
        quality: reasons.isEmpty ? .good : .check,
        reasons: reasons,
        order: order
    )
}

/// The size a pass shows on the phone before the server sizes it: the same math the server runs.
public func previewArSize(_ pointsM: [Vec3], device: ArDevice, cornerSpreadM: [Double]?) -> ArSize? {
    sizeFromArPoints(pointsM, device: device, cornerSpreadM: cornerSpreadM)
}

/// `toFixed` as JavaScript writes it (for the reasons' text).
func fixed(_ v: Double, _ digits: Int) -> String {
    String(format: "%.\(digits)f", v)
}
