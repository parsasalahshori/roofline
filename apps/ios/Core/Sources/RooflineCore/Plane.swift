import Foundation

/// An infinite plane: a point on it and a unit normal.
public struct Plane: Equatable, Sendable, Codable {
    public var point: Vec3
    public var normal: Vec3

    /// Nil when the normal has no length.
    public init?(point: Vec3, normal: Vec3) {
        guard let n = normal.normalized, point.isFinite else { return nil }
        self.point = point
        self.normal = n
    }

    public func signedDistance(_ p: Vec3) -> Double { (p - point).dot(normal) }
    public func distance(_ p: Vec3) -> Double { abs(signedDistance(p)) }
    /// The foot of the perpendicular from `p`.
    public func project(_ p: Vec3) -> Vec3 { p - normal * signedDistance(p) }

    /// The same plane moved along its normal by `offset` metres.
    public func offset(by offset: Double) -> Plane {
        var out = self
        out.point = point + normal * offset
        return out
    }

    /// The same plane with its normal facing `viewer` (the camera), so "in front of the wall" is +.
    public func facing(_ viewer: Vec3) -> Plane {
        var out = self
        if (viewer - point).dot(normal) < 0 { out.normal = -normal }
        return out
    }

    /// Where a ray from `origin` along `direction` meets the plane; nil when it runs parallel or the plane is behind.
    public func intersect(rayOrigin origin: Vec3, direction: Vec3) -> Vec3? {
        guard let d = direction.normalized else { return nil }
        let denom = d.dot(normal)
        guard abs(denom) > 1e-6 else { return nil }
        let t = (point - origin).dot(normal) / denom
        guard t > 0, t.isFinite else { return nil }
        return origin + d * t
    }

    /// Angle between the plane's normal and gravity's up, degrees: 90 for an upright wall, 0 for a floor.
    public var tiltFromUpDegrees: Double {
        let c = max(-1, min(1, abs(normal.dot(.up))))
        return acos(c) * 180 / .pi
    }

    public var isVertical: Bool { tiltFromUpDegrees > 70 }

    /// Least-squares plane through the points (smallest-eigenvalue direction of their scatter). Nil for fewer than
    /// three points, or points in (nearly) a line.
    public static func fit(_ points: [Vec3]) -> Plane? {
        guard points.count >= 3, let c = Vec3.mean(points) else { return nil }
        var a = [[Double]](repeating: [0, 0, 0], count: 3)
        for p in points {
            let d = p - c
            let v = [d.x, d.y, d.z]
            for i in 0..<3 { for j in 0..<3 { a[i][j] += v[i] * v[j] } }
        }
        let (values, vectors) = symmetricEigen3(a)
        // Ascending eigenvalues: [0] is the normal; [1] near zero means the points are on a line.
        let spread = values[2]
        guard spread > 1e-12, values[1] > spread * 1e-8 else { return nil }
        return Plane(point: c, normal: Vec3(vectors[0][0], vectors[0][1], vectors[0][2]))
    }

    /// Root-mean-square distance of the points from the plane.
    public func rmsDistance(_ points: [Vec3]) -> Double {
        guard !points.isEmpty else { return 0 }
        let s = points.reduce(0.0) { $0 + signedDistance($1) * signedDistance($1) }
        return (s / Double(points.count)).squareRoot()
    }
}

/// Eigen decomposition of a symmetric 3x3 matrix (cyclic Jacobi). Eigenvalues ascending, with their unit vectors.
public func symmetricEigen3(_ input: [[Double]]) -> (values: [Double], vectors: [[Double]]) {
    var a = input
    var v: [[Double]] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
    for _ in 0..<60 {
        let off = a[0][1] * a[0][1] + a[0][2] * a[0][2] + a[1][2] * a[1][2]
        if off < 1e-30 { break }
        for (p, q) in [(0, 1), (0, 2), (1, 2)] {
            if abs(a[p][q]) < 1e-300 { continue }
            let theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
            let t = (theta >= 0 ? 1.0 : -1.0) / (abs(theta) + (theta * theta + 1).squareRoot())
            let c = 1 / (t * t + 1).squareRoot()
            let s = t * c
            // Rotate rows/columns p and q
            for k in 0..<3 {
                let akp = a[k][p], akq = a[k][q]
                a[k][p] = c * akp - s * akq
                a[k][q] = s * akp + c * akq
            }
            for k in 0..<3 {
                let apk = a[p][k], aqk = a[q][k]
                a[p][k] = c * apk - s * aqk
                a[q][k] = s * apk + c * aqk
            }
            for k in 0..<3 {
                let vkp = v[k][p], vkq = v[k][q]
                v[k][p] = c * vkp - s * vkq
                v[k][q] = s * vkp + c * vkq
            }
        }
    }
    // Columns of v are the eigenvectors
    let pairs = (0..<3).map { i in (a[i][i], [v[0][i], v[1][i], v[2][i]]) }.sorted { $0.0 < $1.0 }
    return (pairs.map { $0.0 }, pairs.map { $0.1 })
}
