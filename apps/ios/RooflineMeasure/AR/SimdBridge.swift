import ARKit
import RooflineCore
import simd

// ARKit's float SIMD types <-> RooflineCore's Double types, at the edge.

extension Vec3 {
    init(_ v: simd_float3) { self.init(Double(v.x), Double(v.y), Double(v.z)) }
    var simd: simd_float3 { simd_float3(Float(x), Float(y), Float(z)) }
}

extension Mat4 {
    /// simd_float4x4 is column-major, as Mat4 is.
    init(_ m: simd_float4x4) {
        self.init(columns:
            [Double(m.columns.0.x), Double(m.columns.0.y), Double(m.columns.0.z), Double(m.columns.0.w)],
            [Double(m.columns.1.x), Double(m.columns.1.y), Double(m.columns.1.z), Double(m.columns.1.w)],
            [Double(m.columns.2.x), Double(m.columns.2.y), Double(m.columns.2.z), Double(m.columns.2.w)],
            [Double(m.columns.3.x), Double(m.columns.3.y), Double(m.columns.3.z), Double(m.columns.3.w)])
    }
}

extension simd_float4x4 {
    var translation: simd_float3 { simd_float3(columns.3.x, columns.3.y, columns.3.z) }
}

extension CameraIntrinsics {
    /// ARCamera.intrinsics (column-major 3x3: fx at [0][0], fy at [1][1], cx at [2][0], cy at [2][1]) for the
    /// native capturedImage of `imageResolution`.
    init(_ camera: ARCamera) {
        let k = camera.intrinsics
        self.init(fx: Double(k.columns.0.x), fy: Double(k.columns.1.y), cx: Double(k.columns.2.x), cy: Double(k.columns.2.y),
                  width: Double(camera.imageResolution.width), height: Double(camera.imageResolution.height))
    }
}

extension Plane {
    /// The infinite plane of an ARPlaneAnchor: the anchor's local y axis is the plane's normal.
    // Checked (ARPlaneAnchor.h): "Planes are defined in the X and Z direction, where Y is the surface's normal",
    // for every alignment, so the normal is transform column 1.
    init?(anchor: ARPlaneAnchor) {
        let t = anchor.transform
        self.init(point: Vec3(t.translation), normal: Vec3(simd_float3(t.columns.1.x, t.columns.1.y, t.columns.1.z)))
    }
}
