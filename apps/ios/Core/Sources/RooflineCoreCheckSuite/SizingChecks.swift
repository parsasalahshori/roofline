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
    Check("sizeFromArPoints: a square 36 x 48 in frame, as the server sizes it") { ctx in
        let s = sizeFromArPoints(rect(w: 36 * inch, h: 48 * inch))
        ctx.near(s?.widthIn, 36, 1e-9)
        ctx.near(s?.heightIn, 48, 1e-9)
        ctx.equal(s?.quality, .good)
        // Perfect rectangle: the ± is the point sigma alone, 3 mm = 0.1181 in
        ctx.near(s?.uncertaintyWidthIn, 0.003 * 39.37007874, 1e-12)
        ctx.near(s?.uncertaintyHeightIn, 0.003 * 39.37007874, 1e-12)
    },
    Check("sizeFromArPoints: corners tapped out of order are sized the same (bug B9)") { ctx in
        let r = rect(w: 30 * inch, h: 60 * inch)
        let shuffled = [r[3], r[0], r[2], r[1]]
        let g = sizeFromArPoints(shuffled)
        ctx.near(g?.widthIn, 30, 1e-9)
        ctx.near(g?.heightIn, 60, 1e-9)
        // Without gravity order the same taps make a bow-tie and come out wrong
        let t = sizeFromArPoints(shuffled, gravityOrder: false)
        ctx.expect(t == nil || abs(t!.widthIn - 30) > 1 || t!.quality == .check, "tap order is wrong")
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
    Check("sizeFromArPoints: uncertainty adds the side difference, the scale term, the device sigma") { ctx in
        var r = rect(w: 36 * inch, h: 48 * inch)
        r[2] = r[2] + Vec3(0.5 * inch, 0, 0) // bottom 0.5 in longer
        let s = sizeFromArPoints(r, sigmaM: 0, scaleFraction: 0, gravityOrder: true)!
        ctx.near(s.uncertaintyWidthIn, 0.25, 1e-3, "half the side difference")
        let sc = sizeFromArPoints(rect(w: 36 * inch, h: 48 * inch), sigmaM: 0, scaleFraction: 0.01)!
        ctx.near(sc.uncertaintyWidthIn, 0.36, 1e-9, "1% of 36 in")
        ctx.near(sc.uncertaintyHeightIn, 0.48, 1e-9, "1% of 48 in")
        let m = ArSigmaModel.default
        ctx.near(m.sigma(device: .arkitLidar, cornerSpreadM: nil), m.pointSigmaM[.arkitLidar]!)
        ctx.near(m.sigma(device: .arkitLidar, cornerSpreadM: [0.01, 0.01, 0.01, 0.01]), 0.01, 1e-12, "a measured spread wider than the device's")
        ctx.near(m.sigma(device: nil, cornerSpreadM: nil), 0.003)
        let p = previewArSize(rect(w: 36 * inch, h: 48 * inch), device: .arkit, cornerSpreadM: nil)!
        ctx.expect(p.uncertaintyWidthIn > 0.36, "preview includes the scale term")
    },
]
