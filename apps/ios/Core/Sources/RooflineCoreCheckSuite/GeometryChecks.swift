import Foundation
import RooflineCore

/// A window `w` x `h` metres on a wall facing +z at distance `z`, its centre at (cx, cy): TL, TR, BR, BL as seen from +z.
func rect(w: Double, h: Double, cx: Double = 0, cy: Double = 1.2, z: Double = -1.5) -> [Vec3] {
    [Vec3(cx - w / 2, cy + h / 2, z), Vec3(cx + w / 2, cy + h / 2, z), Vec3(cx + w / 2, cy - h / 2, z), Vec3(cx - w / 2, cy - h / 2, z)]
}

/// Turned about the vertical axis by `deg` around `pivot`.
func yaw(_ ps: [Vec3], _ deg: Double, pivot: Vec3 = .zero) -> [Vec3] {
    let a = deg * .pi / 180
    return ps.map { p in
        let d = p - pivot
        return pivot + Vec3(d.x * cos(a) + d.z * sin(a), d.y, -d.x * sin(a) + d.z * cos(a))
    }
}

func near3(_ ctx: CheckContext, _ a: Vec3?, _ b: Vec3, _ tol: Double = 1e-9, _ m: String = "", line: UInt = #line) {
    guard let a = a else {
        ctx.expect(false, "\(m) nil", line: line)
        return
    }
    ctx.expect(a.distance(to: b) <= tol, "\(m) expected \(b.array), got \(a.array)", line: line)
}

/// A camera at `origin` looking along `forward` with world up.
func camera(at origin: Vec3, looking forward: Vec3) -> Mat4 {
    let back = (-forward).normalized!
    let right = Vec3.up.cross(back).normalized!
    let up = back.cross(right)
    return Mat4.rigid(right: right, up: up, back: back, origin: origin)
}

let geometryChecks: [Check] = [
    Check("Mat4: rigid inverse undoes the transform") { ctx in
        let t = camera(at: Vec3(0.3, 1.5, 2), looking: Vec3(0.2, -0.1, -1))
        let p = Vec3(1, 2, 3)
        near3(ctx, t.inverseRigid.transform(t.transform(p)), p, 1e-12)
        let i = t * t.inverseRigid
        for k in 0..<16 { ctx.near(i.m[k], Mat4.identity.m[k], 1e-12) }
    },
    Check("Plane: fit, distance, projection, ray intersection") { ctx in
        let pts = [Vec3(0, 0, -2), Vec3(1, 0, -2), Vec3(0, 1, -2), Vec3(1, 1, -2.0), Vec3(0.5, 0.3, -2)]
        let p = Plane.fit(pts)
        ctx.expect(p != nil, "fit")
        ctx.near(abs(p!.normal.z), 1, 1e-9, "normal along z")
        ctx.near(p!.distance(Vec3(3, 4, 0)), 2, 1e-9)
        near3(ctx, p!.project(Vec3(3, 4, 0)), Vec3(3, 4, -2), 1e-9)
        near3(ctx, p!.intersect(rayOrigin: .zero, direction: Vec3(0, 0, -1)), Vec3(0, 0, -2), 1e-9)
        ctx.expect(p!.intersect(rayOrigin: .zero, direction: Vec3(0, 0, 1)) == nil, "behind")
        ctx.expect(p!.intersect(rayOrigin: .zero, direction: Vec3(1, 0, 0)) == nil, "parallel")
        ctx.expect(Plane.fit([Vec3(0, 0, 0), Vec3(1, 1, 1), Vec3(2, 2, 2)]) == nil, "collinear has no plane")
        ctx.expect(p!.isVertical, "a wall facing z is vertical")
        ctx.equal(p!.facing(Vec3(0, 0, 5)).normal.z > 0, true, "faces the viewer")
        ctx.near(p!.offset(by: 0.1).facing(Vec3(0, 0, 5)).distance(Vec3(0, 0, -2)), 0.1, 1e-12)
    },
    Check("Plane: least-squares normal on a tilted, noisy wall") { ctx in
        var pts: [Vec3] = []
        var seed: UInt64 = 7
        func rnd() -> Double {
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            return Double(seed >> 11) / Double(UInt64(1) << 53) - 0.5
        }
        for i in 0..<40 { pts.append(Vec3(Double(i % 8) * 0.2, Double(i / 8) * 0.3, -1.5 + rnd() * 0.002)) }
        let turned = yaw(pts, 25)
        let p = Plane.fit(turned)!
        let expected = yaw([Vec3(0, 0, 1)], 25)[0]
        ctx.near(abs(p.normal.dot(expected)), 1, 1e-4, "normal")
    },
    Check("Eigen: a diagonal matrix") { ctx in
        let (v, vec) = symmetricEigen3([[3, 0, 0], [0, 1, 0], [0, 0, 2]])
        ctx.near(v[0], 1)
        ctx.near(v[1], 2)
        ctx.near(v[2], 3)
        ctx.near(abs(vec[0][1]), 1)
    },
    Check("ImageMapping: project / unproject round trip, centre maps to the principal point") { ctx in
        let k = CameraIntrinsics(fx: 1500, fy: 1500, cx: 960, cy: 720, width: 1920, height: 1440)
        let cam = camera(at: Vec3(0, 1.4, 0), looking: Vec3(0, 0, -1))
        let c = ImageMapping.project(Vec3(0, 1.4, -2), cameraTransform: cam, intrinsics: k)
        ctx.near(c?.x, 960, 1e-9)
        ctx.near(c?.y, 720, 1e-9)
        // Up in the world is up in the image (smaller y), right is right
        let up = ImageMapping.project(Vec3(0.1, 1.5, -2), cameraTransform: cam, intrinsics: k)!
        ctx.expect(up.y < 720 && up.x > 960, "orientation \(up)")
        let back = ImageMapping.unproject(up, depth: 2, cameraTransform: cam, intrinsics: k)
        near3(ctx, back, Vec3(0.1, 1.5, -2), 1e-9)
        ctx.expect(ImageMapping.project(Vec3(0, 1.4, 1), cameraTransform: cam, intrinsics: k) == nil, "behind the camera")
        let d = k.scaled(toWidth: 256, height: 192)
        ctx.near(d.cx, 128)
        ctx.near(d.fx, 200)
    },
    Check("ImageMapping: native landscape to upright portrait, clamp, inset") { ctx in
        // Native 1920 x 1440 turned clockwise: native top-left -> portrait top-right, native bottom-left -> top-left
        let w = 1920.0, h = 1440.0
        let tl = ImageMapping.nativeToPortrait(Vec2(0, 0), nativeWidth: w, nativeHeight: h)
        ctx.equal(tl, Vec2(1440, 0))
        ctx.equal(ImageMapping.nativeToPortrait(Vec2(0, h), nativeWidth: w, nativeHeight: h), Vec2(0, 0))
        ctx.equal(ImageMapping.nativeToPortrait(Vec2(w, h), nativeWidth: w, nativeHeight: h), Vec2(0, 1920))
        ctx.equal(ImageMapping.clamp(Vec2(-3, 2000.04), width: 1440, height: 1920), Vec2(0, 1920))
        ctx.equal(ImageMapping.insetCorners(width: 1000, height: 2000), [Vec2(150, 300), Vec2(850, 300), Vec2(850, 1700), Vec2(150, 1700)])
        ctx.equal(ImageMapping.rescale([Vec2(100, 200)], from: (1000, 2000), to: (500, 1000)), [Vec2(50, 100)])
    },
    Check("RoomPlanMath: surface corners and view score") { ctx in
        // A window 1 m x 1.2 m centred at (0, 1.5, -3), facing +z
        let t = Mat4.rigid(right: Vec3(1, 0, 0), up: .up, back: Vec3(0, 0, 1), origin: Vec3(0, 1.5, -3))
        let c = RoomPlanMath.corners(transform: t, widthM: 1, heightM: 1.2, viewer: Vec3(0, 1.5, 0))
        near3(ctx, c[0], Vec3(-0.5, 2.1, -3), 1e-12, "TL")
        near3(ctx, c[2], Vec3(0.5, 0.9, -3), 1e-12, "BR")
        let k = CameraIntrinsics(fx: 1500, fy: 1500, cx: 960, cy: 720, width: 1920, height: 1440)
        let front = RoomPlanMath.viewScore(corners: c, cameraTransform: camera(at: Vec3(0, 1.5, 0), looking: Vec3(0, 0, -1)), intrinsics: k)
        let side = RoomPlanMath.viewScore(corners: c, cameraTransform: camera(at: Vec3(2.2, 1.5, -1), looking: Vec3(-1, 0, -1)), intrinsics: k)
        let away = RoomPlanMath.viewScore(corners: c, cameraTransform: camera(at: Vec3(0, 1.5, 0), looking: Vec3(0, 0, 1)), intrinsics: k)
        ctx.expect(front > 0 && front > side, "front \(front) > side \(side)")
        ctx.equal(away, 0, "looking away")
    },
]
