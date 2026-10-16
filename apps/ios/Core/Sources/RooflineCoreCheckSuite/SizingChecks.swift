import Foundation
import RooflineCore

let inch = 1 / 39.37007874

let sizingChecks: [Check] = [
    Check("gravityOrderedCorners: any tap order gives TL, TR, BR, BL") { ctx in
        let r = rect(w: 36 * inch, h: 48 * inch)
        let viewer = Vec3(0, 1.4, 0)
        for order in [[0, 1, 2, 3], [2, 0, 3, 1], [3, 2, 1, 0], [1, 3, 0, 2]] {
            let tapped = order.map { r[$0] }
            let g = gravityOrderedCorners(tapped, viewer: viewer)
            ctx.expect(g != nil, "ordered")
            for i in 0..<4 { near3(ctx, g?[i], r[i], 1e-12, "order \(order) corner \(i)") }
        }
    },
    Check("gravityOrderedCorners: left and right as the camera sees them, on a turned wall") { ctx in
        let r = yaw(rect(w: 1, h: 1.4), 35, pivot: Vec3(0, 1.2, -1.5))
        let g = gravityOrderedCorners([r[2], r[0], r[1], r[3]], viewer: Vec3(0, 1.4, 0))!
        for i in 0..<4 { near3(ctx, g[i], r[i], 1e-12, "corner \(i)") }
        // Seen from behind the wall the left/right swap (a mirror: the same size)
        let m = gravityOrderedCorners(r, viewer: Vec3(0, 1.4, -4))!
        near3(ctx, m[0], r[1], 1e-12, "mirrored TL")
        ctx.expect(gravityOrderedCorners([Vec3(0, 0, 0), Vec3(1, 0, 0), Vec3(1, 0, 1), Vec3(0, 0, 1)]) == nil, "a floor has no up")
    },
    Check("arCornerOrder: the server's order, seen from AR's origin") { ctx in
        let r = rect(w: 30 * inch, h: 50 * inch) // the wall faces the origin (+z side)
        ctx.equal(arCornerOrder(r), [0, 1, 2, 3])
        ctx.equal(arCornerOrder([r[2], r[0], r[3], r[1]]), [1, 3, 0, 2])
        // A wall behind the origin (the person turned round): left/right as seen from the origin
        let behind = r.map { Vec3(-$0.x, $0.y, -$0.z) }
        let o = arCornerOrder(behind)
        ctx.expect(behind[o[0]].x > behind[o[1]].x, "seen from the origin, TL is further +x on a wall facing -z")
    },
    Check("sizeFromArPoints: a square 36 x 48 in frame, as the server sizes it") { ctx in
        let s = sizeFromArPoints(rect(w: 36 * inch, h: 48 * inch))
        ctx.near(s?.widthIn, 36, 1e-9)
        ctx.near(s?.heightIn, 48, 1e-9)
        ctx.equal(s?.quality, .good)
        // Perfect rectangle, no device (webxr, 6 mm): point noise 6 mm and 1% of the side, in quadrature
        let sigmaIn = 0.006 * 39.37007874
        ctx.near(s?.uncertaintyWidthIn, (sigmaIn * sigmaIn + 0.36 * 0.36).squareRoot(), 1e-12)
        ctx.near(s?.uncertaintyHeightIn, (sigmaIn * sigmaIn + 0.48 * 0.48).squareRoot(), 1e-12)
        ctx.equal(s?.order, [0, 1, 2, 3])
    },
    Check("sizeFromArPoints: corners tapped out of order are sized the same (bug B9)") { ctx in
        let r = rect(w: 30 * inch, h: 60 * inch)
        let g = sizeFromArPoints([r[3], r[0], r[2], r[1]], device: .arkitLidar)
        ctx.near(g?.widthIn, 30, 1e-9)
        ctx.near(g?.heightIn, 60, 1e-9)
        ctx.equal(g?.order, [1, 3, 2, 0])
    },
    Check("sizeFromArPoints: 'check' reasons match the server's wording") { ctx in
        var r = rect(w: 36 * inch, h: 48 * inch)
        r[1] = r[1] + Vec3(5 * inch, 0, 0) // top-right pulled out 5 in: off square, top longer than bottom
        let s = sizeFromArPoints(r)!
        ctx.equal(s.quality, .check)
        ctx.expect(s.reasons.contains { $0.hasPrefix("a corner is ") && $0.hasSuffix("° off square") }, "\(s.reasons)")
        ctx.expect(s.reasons.contains { $0.hasPrefix("top and bottom differ by ") }, "\(s.reasons)")
        var o = rect(w: 36 * inch, h: 48 * inch)
        o[0] = o[0] + Vec3(0, 0, 3 * inch) // one corner 3 in off the wall: each point 0.75 in off the best plane
        let off = sizeFromArPoints(o)!
        ctx.expect(off.reasons.contains { $0.hasPrefix("the corners are not on one flat frame (") && $0.hasSuffix(" in off)") }, "\(off.reasons)")
        ctx.expect(sizeFromArPoints([Vec3(0, 0, 0), Vec3(0, 0, 0), Vec3(1, 0, 0), Vec3(1, 1, 0)]) == nil, "a side of zero length")
        ctx.expect(sizeFromArPoints(Array(rect(w: 1, h: 1).prefix(3))) == nil, "three points")
        ctx.expect(sizeFromArPoints([Vec3(.nan, 0, 0)] + rect(w: 1, h: 1).suffix(3)) == nil, "not finite")
    },
    Check("sizeFromArPoints: device sigma, a wider measured spread wins for its corner") { ctx in
        let r = rect(w: 36 * inch, h: 48 * inch)
        let lidar = sizeFromArPoints(r, device: .arkitLidar)!
        let plain = sizeFromArPoints(r, device: .arkit)!
        ctx.expect(lidar.uncertaintyWidthIn < plain.uncertaintyWidthIn, "LiDAR is tighter")
        let small = sizeFromArPoints(r, device: .arkitLidar, cornerSpreadM: [0.001, 0.001, 0.001, 0.001])!
        ctx.near(small.uncertaintyWidthIn, lidar.uncertaintyWidthIn, 1e-12, "spread below the device sigma: the device wins")
        let wide = sizeFromArPoints(r, device: .arkitLidar, cornerSpreadM: [0.012, 0.0025, 0.0025, 0.0025])!
        let pin = (0.012 * 0.012 + 3 * 0.0025 * 0.0025).squareRoot() / 2 * 39.37007874
        ctx.near(wide.uncertaintyWidthIn, (pin * pin + 0.36 * 0.36).squareRoot(), 1e-12)
        ctx.near(ArLimits.sigma(nil), 0.006)
        ctx.near(previewArSize(r, device: .arkit, cornerSpreadM: nil)?.uncertaintyWidthIn, plain.uncertaintyWidthIn, 0)
    },
]
