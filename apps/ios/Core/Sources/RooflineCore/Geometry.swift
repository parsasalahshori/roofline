import Foundation

// Small vector and matrix types in Double. The app converts ARKit's simd_float3 / simd_float4x4 into these at the
// edge, so every formula here can be checked on a Mac without ARKit.

/// A point or direction in AR world space, metres. ARKit's world: +Y is up (gravity), right-handed.
public struct Vec3: Equatable, Hashable, Sendable {
    public var x: Double
    public var y: Double
    public var z: Double

    public init(_ x: Double, _ y: Double, _ z: Double) {
        self.x = x
        self.y = y
        self.z = z
    }

    /// From `[x, y, z]`; nil unless exactly three finite numbers.
    public init?(array a: [Double]) {
        guard a.count == 3, a.allSatisfy({ $0.isFinite }) else { return nil }
        self.init(a[0], a[1], a[2])
    }

    public var array: [Double] { [x, y, z] }

    public static let zero = Vec3(0, 0, 0)
    /// World up in ARKit (gravityAndHeading / gravity world alignment).
    public static let up = Vec3(0, 1, 0)

    public static func + (a: Vec3, b: Vec3) -> Vec3 { Vec3(a.x + b.x, a.y + b.y, a.z + b.z) }
    public static func - (a: Vec3, b: Vec3) -> Vec3 { Vec3(a.x - b.x, a.y - b.y, a.z - b.z) }
    public static func * (a: Vec3, s: Double) -> Vec3 { Vec3(a.x * s, a.y * s, a.z * s) }
    public static func * (s: Double, a: Vec3) -> Vec3 { Vec3(a.x * s, a.y * s, a.z * s) }
    public static func / (a: Vec3, s: Double) -> Vec3 { Vec3(a.x / s, a.y / s, a.z / s) }
    public static prefix func - (a: Vec3) -> Vec3 { Vec3(-a.x, -a.y, -a.z) }

    public func dot(_ b: Vec3) -> Double { x * b.x + y * b.y + z * b.z }
    public func cross(_ b: Vec3) -> Vec3 { Vec3(y * b.z - z * b.y, z * b.x - x * b.z, x * b.y - y * b.x) }
    public var length: Double { (x * x + y * y + z * z).squareRoot() }
    public var isFinite: Bool { x.isFinite && y.isFinite && z.isFinite }

    /// Unit vector; nil for a (near) zero vector.
    public var normalized: Vec3? {
        let l = length
        return l > 1e-12 ? self / l : nil
    }

    public func distance(to b: Vec3) -> Double { (self - b).length }

    public static func mean(_ ps: [Vec3]) -> Vec3? {
        guard !ps.isEmpty else { return nil }
        var s = Vec3.zero
        for p in ps { s = s + p }
        return s / Double(ps.count)
    }
}

extension Vec3: Codable {
    // As the API writes points: [x, y, z]
    public init(from decoder: Decoder) throws {
        var c = try decoder.unkeyedContainer()
        let x = try c.decode(Double.self)
        let y = try c.decode(Double.self)
        let z = try c.decode(Double.self)
        self.init(x, y, z)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.unkeyedContainer()
        try c.encode(x)
        try c.encode(y)
        try c.encode(z)
    }
}

/// A point in image pixels (x right, y down).
public struct Vec2: Equatable, Hashable, Sendable {
    public var x: Double
    public var y: Double

    public init(_ x: Double, _ y: Double) {
        self.x = x
        self.y = y
    }

    public var array: [Double] { [x, y] }
}

extension Vec2: Codable {
    public init(from decoder: Decoder) throws {
        var c = try decoder.unkeyedContainer()
        let x = try c.decode(Double.self)
        let y = try c.decode(Double.self)
        self.init(x, y)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.unkeyedContainer()
        try c.encode(x)
        try c.encode(y)
    }
}

/// 4x4 matrix, column-major like simd_float4x4 (`m[col * 4 + row]`).
public struct Mat4: Equatable, Sendable, Codable {
    public var m: [Double]

    public init(_ m: [Double]) {
        precondition(m.count == 16, "Mat4 needs 16 numbers")
        self.m = m
    }

    /// From four columns (each x, y, z, w), the way simd_float4x4 stores them.
    public init(columns c0: [Double], _ c1: [Double], _ c2: [Double], _ c3: [Double]) {
        self.init(c0 + c1 + c2 + c3)
    }

    public static let identity = Mat4([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

    public subscript(row: Int, col: Int) -> Double { m[col * 4 + row] }

    /// The first three entries of a column (axis directions for 0...2, the translation for 3).
    public func column(_ c: Int) -> Vec3 { Vec3(m[c * 4], m[c * 4 + 1], m[c * 4 + 2]) }

    public var translation: Vec3 { column(3) }

    /// A rigid transform: rotation columns and a translation.
    public static func rigid(right: Vec3, up: Vec3, back: Vec3, origin: Vec3) -> Mat4 {
        Mat4(columns: [right.x, right.y, right.z, 0], [up.x, up.y, up.z, 0], [back.x, back.y, back.z, 0], [origin.x, origin.y, origin.z, 1])
    }

    /// Point (w = 1), divided by w.
    public func transform(_ p: Vec3) -> Vec3 {
        let x = self[0, 0] * p.x + self[0, 1] * p.y + self[0, 2] * p.z + self[0, 3]
        let y = self[1, 0] * p.x + self[1, 1] * p.y + self[1, 2] * p.z + self[1, 3]
        let z = self[2, 0] * p.x + self[2, 1] * p.y + self[2, 2] * p.z + self[2, 3]
        let w = self[3, 0] * p.x + self[3, 1] * p.y + self[3, 2] * p.z + self[3, 3]
        return abs(w - 1) < 1e-12 || abs(w) < 1e-12 ? Vec3(x, y, z) : Vec3(x / w, y / w, z / w)
    }

    /// Direction (w = 0).
    public func transformDirection(_ d: Vec3) -> Vec3 {
        Vec3(
            self[0, 0] * d.x + self[0, 1] * d.y + self[0, 2] * d.z,
            self[1, 0] * d.x + self[1, 1] * d.y + self[1, 2] * d.z,
            self[2, 0] * d.x + self[2, 1] * d.y + self[2, 2] * d.z
        )
    }

    /// Inverse of a rigid transform (rotation + translation): R^T and -R^T t. Camera transforms are rigid.
    public var inverseRigid: Mat4 {
        let r0 = column(0), r1 = column(1), r2 = column(2), t = translation
        // Rows of R^T are the columns of R
        return Mat4(columns:
            [r0.x, r1.x, r2.x, 0],
            [r0.y, r1.y, r2.y, 0],
            [r0.z, r1.z, r2.z, 0],
            [-r0.dot(t), -r1.dot(t), -r2.dot(t), 1])
    }

    public static func * (a: Mat4, b: Mat4) -> Mat4 {
        var out = [Double](repeating: 0, count: 16)
        for c in 0..<4 {
            for r in 0..<4 {
                var s = 0.0
                for k in 0..<4 { s += a[r, k] * b[k, c] }
                out[c * 4 + r] = s
            }
        }
        return Mat4(out)
    }
}

/// Median of a list (nil when empty).
public func median(_ values: [Double]) -> Double? {
    guard !values.isEmpty else { return nil }
    let s = values.sorted()
    let m = s.count / 2
    return s.count % 2 == 1 ? s[m] : (s[m - 1] + s[m]) / 2
}
