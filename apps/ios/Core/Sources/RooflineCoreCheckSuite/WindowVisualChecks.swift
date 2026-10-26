import Foundation
import RooflineCore

// Checks for the window visualizer: the homography that carries a window onto the photo's four corners, the layout of every kind
// of window and every grid, and how each kind is quoted through the style keys the server offers.

private func wvQuad() -> [Vec2] { [Vec2(403.3, 214.6), Vec2(878.0, 411.1), Vec2(960.4, 1326.8), Vec2(395.5, 1370.7)] }

private func wvCatalog(_ keys: [(String, Bool)]) -> [HomeownerStyleOption] {
    keys.map { HomeownerStyleOption(key: $0.0, label: "Label \($0.0)", hint: nil, tile: nil, atVisit: $0.1) }
}

let windowVisualChecks: [Check] = [
    Check("homography: a canonical rectangle maps onto the four corners and back, within 1e-6") { t in
        let quad = wvQuad()
        guard let h = Homography.rect(width: 36, height: 60, to: quad), let inv = h.inverse() else { return t.expect(false, "no homography") }
        let corners = [Vec2(0, 0), Vec2(36, 0), Vec2(36, 60), Vec2(0, 60)]
        for (k, c) in corners.enumerated() {
            let p = h.apply(c)
            t.near(p.x, quad[k].x, 1e-6, "corner \(k) x")
            t.near(p.y, quad[k].y, 1e-6, "corner \(k) y")
            let back = inv.apply(quad[k])
            t.near(back.x, c.x, 1e-6, "back \(k) x")
            t.near(back.y, c.y, 1e-6, "back \(k) y")
        }
        // Any point inside goes there and back
        var worst = 0.0
        for i in 0...10 {
            for j in 0...10 {
                let p = Vec2(36 * Double(i) / 10, 60 * Double(j) / 10)
                let r = inv.apply(h.apply(p))
                worst = max(worst, hypot(r.x - p.x, r.y - p.y))
            }
        }
        t.expect(worst < 1e-6, "round trip worst \(worst)")
        // The middle of the rectangle lands where the quad's diagonals cross (a projective map keeps that)
        let mid = h.apply(Vec2(18, 30))
        let (a, b, c, d) = (quad[0], quad[2], quad[1], quad[3])
        let den = (a.x - b.x) * (c.y - d.y) - (a.y - b.y) * (c.x - d.x)
        let ix = ((a.x * b.y - a.y * b.x) * (c.x - d.x) - (a.x - b.x) * (c.x * d.y - c.y * d.x)) / den
        let iy = ((a.x * b.y - a.y * b.x) * (c.y - d.y) - (a.y - b.y) * (c.x * d.y - c.y * d.x)) / den
        t.near(mid.x, ix, 1e-6, "diagonals x")
        t.near(mid.y, iy, 1e-6, "diagonals y")
    },
    Check("homography: identity, composition, and a degenerate quad") { t in
        let r = Homography.rect(width: 10, height: 20, to: [Vec2(0, 0), Vec2(10, 0), Vec2(10, 20), Vec2(0, 20)])!
        for (k, v) in [1.0, 0, 0, 0, 1, 0, 0, 0, 1].enumerated() { t.near(r.m[k], v, 1e-9, "identity \(k)") }
        let h = Homography.rect(width: 36, height: 60, to: wvQuad())!
        let scale = Homography([2, 0, 0, 0, 2, 0, 0, 0, 1])
        let both = h.after(scale)
        let p = both.apply(Vec2(5, 7)), q = h.apply(Vec2(10, 14))
        t.near(p.x, q.x, 1e-9, "after x")
        t.near(p.y, q.y, 1e-9, "after y")
        t.expect(Homography.rect(width: 10, height: 10, to: [Vec2(0, 0), Vec2(5, 5), Vec2(10, 10), Vec2(20, 20)]) == nil, "collinear corners have no homography")
    },
    Check("quad: usable corners, a bow-tie and a sliver are told apart") { t in
        t.expect(WindowQuad.isUsable(wvQuad(), imageWidth: 1440, imageHeight: 1920), "a real window quad")
        let bowtie = [Vec2(100, 100), Vec2(400, 400), Vec2(400, 100), Vec2(100, 400)]
        t.expect(!WindowQuad.isUsable(bowtie, imageWidth: 1440, imageHeight: 1920), "bow-tie")
        let sliver = [Vec2(100, 100), Vec2(104, 100), Vec2(104, 800), Vec2(100, 800)]
        t.expect(!WindowQuad.isUsable(sliver, imageWidth: 1440, imageHeight: 1920), "sliver")
        t.expect(!WindowQuad.isUsable([Vec2(0, 0)], imageWidth: 1440, imageHeight: 1920), "one corner")
        t.near(WindowQuad.aspect([Vec2(0, 0), Vec2(100, 0), Vec2(100, 200), Vec2(0, 200)]), 0.5, 1e-9, "aspect")
    },
    Check("viewport: the part of the photo shown holds the window, has the screen's shape, and stays inside the photo") { t in
        let quad = wvQuad()
        let b = WindowQuad.bounds(quad)
        for aspect in [0.8, 1.0, 1.3, 1.6] {
            let v = WindowQuad.viewport(quad: quad, imageWidth: 1440, imageHeight: 1920, aspect: aspect)
            t.near(v.width / v.height, aspect, 1e-9, "shape \(aspect)")
            t.expect(v.x >= -1e-9 && v.y >= -1e-9 && v.x + v.width <= 1440 + 1e-9 && v.y + v.height <= 1920 + 1e-9, "inside the photo \(v)")
            // A tall window in a portrait photo fits a square or taller picture; a wider one is cut at the photo's width (that is all there is)
            if aspect <= 1.0 { t.expect(v.x <= b.minX && v.x + v.width >= b.maxX && v.y <= b.minY && v.y + v.height >= b.maxY, "holds the window \(v)") }
        }
        // A window that fills the photo gives the whole photo's worth of the shape, no more
        let big = WindowQuad.viewport(quad: [Vec2(10, 10), Vec2(1430, 10), Vec2(1430, 1910), Vec2(10, 1910)], imageWidth: 1440, imageHeight: 1920, aspect: 1.3)
        t.expect(big.width <= 1440 + 1e-9 && big.height <= 1920 + 1e-9)
    },
    Check("layout: every kind and grid draws inside its silhouette with sane parts, at several sizes") { t in
        for (w, h) in [(36.0, 60.0), (60.0, 36.0), (24.0, 24.0), (14.0, 14.0), (96.0, 72.0)] {
            for type in VisualWindowType.allCases {
                for grid in VisualGrid.allCases {
                    let l = WindowLayoutBuilder.build(type: type, grid: grid, widthIn: w, heightIn: h)
                    let name = "\(type.rawValue)/\(grid.rawValue) \(Int(w))x\(Int(h))"
                    let box = l.bounds
                    t.expect(!l.silhouette.isEmpty && box.maxX > box.minX && box.maxY > box.minY, "\(name) silhouette")
                    t.expect(!l.glass.isEmpty, "\(name) has glass")
                    t.expect(l.shapes.first { $0.role == .frame } != nil, "\(name) has a frame")
                    var finite = true
                    for s in l.shapes { for p in s.points + s.hole where !(p.x.isFinite && p.y.isFinite) { finite = false } }
                    t.expect(finite, "\(name) finite points")
                    // Everything is inside the frame's outer edge (the infill is the opening itself, cleared where the window is)
                    for s in l.shapes where s.role != .infill && s.role != .hardware {
                        for p in s.points {
                            t.expect(p.x >= box.minX - 1e-6 && p.x <= box.maxX + 1e-6 && p.y >= box.minY - 1e-6 && p.y <= box.maxY + 1e-6, "\(name) \(s.role) \(s.tag) outside the silhouette")
                        }
                    }
                    // Each glass pane has its own area
                    for g in l.glass { t.expect(abs(WindowGeometry.signedArea(g.points)) > 1, "\(name) tiny pane") }
                }
            }
        }
    },
    Check("layout: the frame ring surrounds the opening by its face; a round window leaves wall filler") { t in
        let l = WindowLayoutBuilder.build(type: .picture, grid: .none, widthIn: 36, heightIn: 60)
        let box = l.bounds
        t.near(box.minX, -l.frameFaceIn, 1e-9, "left")
        t.near(box.maxY, 60 + l.frameFaceIn, 1e-9, "bottom")
        t.expect(l.frameFaceIn >= 2 && l.frameFaceIn <= 3, "frame face \(l.frameFaceIn)")
        t.equal(l.shapes(.infill).count, 0, "a rectangle needs no filler")
        let c = WindowLayoutBuilder.build(type: .circle, grid: .none, widthIn: 36, heightIn: 60)
        t.equal(c.shapes(.infill).count, 1, "a circle in a tall opening leaves filler")
        // The circle is a circle: radius 18, centred in the opening
        let hole = c.shapes(.frame)[0].hole
        let cx = hole.map(\.x).reduce(0, +) / Double(hole.count), cy = hole.map(\.y).reduce(0, +) / Double(hole.count)
        t.near(cx, 18, 1e-6, "circle cx")
        t.near(cy, 30, 1e-6, "circle cy")
        for p in hole { t.near(hypot(p.x - 18, p.y - 30), 18, 1e-6, "circle radius") }
        // The arch's top touches the top of the opening
        let a = WindowLayoutBuilder.build(type: .arch, grid: .none, widthIn: 36, heightIn: 60)
        t.near(WindowGeometry.box(a.shapes(.frame)[0].hole).minY, 0, 1e-6, "arch apex")
        t.equal(a.shapes(.infill).count, 1, "an arch leaves its corners")
    },
    Check("layout: hung windows have a meeting rail, two sashes and a lock; sliders their stiles; casements a crank") { t in
        let dh = WindowLayoutBuilder.build(type: .doubleHung, grid: .none, widthIn: 36, heightIn: 60)
        t.equal(dh.glass.count, 2, "two panes")
        t.expect(dh.shapes.contains { $0.role == .seam && $0.tag == "meeting-rail" }, "meeting rail")
        t.equal(dh.hardware.filter { $0.tag == "lock" }.count, 1, "one lock")
        t.equal(dh.hardware.filter { $0.tag == "latch" }.count, 2, "two tilt latches on a double-hung")
        let sh = WindowLayoutBuilder.build(type: .singleHung, grid: .none, widthIn: 36, heightIn: 60)
        t.equal(sh.hardware.filter { $0.tag == "latch" }.count, 0, "a single-hung has no tilt latches")
        // The meeting rail is in the middle
        let rail = dh.shapes.first { $0.tag == "meeting-rail" }!
        t.near(rail.points[0].y, 30, 1e-9, "rail height")
        let s2 = WindowLayoutBuilder.build(type: .slider2, grid: .none, widthIn: 60, heightIn: 36)
        t.equal(s2.glass.count, 2, "slider 2 panes")
        t.near(s2.shapes.first { $0.tag == "meeting-stile" }!.points[0].x, 30, 1e-9, "meeting stile in the middle")
        let s3 = WindowLayoutBuilder.build(type: .slider3, grid: .none, widthIn: 72, heightIn: 36)
        t.equal(s3.glass.count, 3, "slider 3 panes")
        // The middle pane of a 3-lite slider is the widest
        let widths = s3.glass.map { WindowGeometry.box($0.points).maxX - WindowGeometry.box($0.points).minX }
        t.expect(widths[1] > widths[0] && widths[1] > widths[2], "middle pane widest: \(widths)")
        t.equal(WindowLayoutBuilder.build(type: .casement, grid: .none, widthIn: 30, heightIn: 48).hardware.filter { $0.tag == "crank" }.count, 1, "casement crank")
        t.equal(WindowLayoutBuilder.build(type: .casementPair, grid: .none, widthIn: 60, heightIn: 48).hardware.filter { $0.tag == "crank" }.count, 2, "pair cranks")
        t.equal(WindowLayoutBuilder.build(type: .awning, grid: .none, widthIn: 36, heightIn: 24).hardware.filter { $0.tag == "crank" }.count, 1, "awning crank")
        t.equal(WindowLayoutBuilder.build(type: .hopper, grid: .none, widthIn: 36, heightIn: 24).hardware.filter { $0.tag == "crank" }.count, 0, "hopper has no crank")
        t.equal(WindowLayoutBuilder.build(type: .picture, grid: .none, widthIn: 36, heightIn: 48).hardware.count, 0, "a picture window has no hardware")
        t.equal(WindowLayoutBuilder.build(type: .pictureCasements, grid: .none, widthIn: 72, heightIn: 48).glass.count, 3, "picture + casements has three panes")
        // The middle pane of the combo is fixed glass, twice as wide as each casement's
        let pc = WindowLayoutBuilder.build(type: .pictureCasements, grid: .none, widthIn: 72, heightIn: 48).glass.map { WindowGeometry.box($0.points) }
        t.expect((pc[1].maxX - pc[1].minX) > 1.6 * (pc[0].maxX - pc[0].minX), "fixed middle is wider")
    },
    Check("layout: bay, bow and garden are angled panels flat-projected inside the opening") { t in
        let bay = WindowLayoutBuilder.build(type: .bay, grid: .none, widthIn: 72, heightIn: 54)
        t.equal(bay.glass.count, 3, "bay: three panels")
        t.equal(bay.shapes(.board).count, 2, "bay: head and seat")
        let bow = WindowLayoutBuilder.build(type: .bow, grid: .none, widthIn: 96, heightIn: 54)
        t.equal(bow.glass.count, 5, "bow: five panels")
        // Panels step back from the wall edges: the middle panel is shorter than the outer ones
        let heights = bow.glass.map { g -> Double in let b = WindowGeometry.box(g.points); return b.maxY - b.minY }
        t.expect(heights[2] < heights[0], "bow: the middle panel recedes: \(heights)")
        t.equal(heights.count, 5)
        let garden = WindowLayoutBuilder.build(type: .garden, grid: .colonial, widthIn: 48, heightIn: 36)
        t.equal(garden.glass.count, 4, "garden: roof, two sides, front")
        t.equal(garden.shapes(.board).count, 1, "garden: a shelf")
        // Only the front pane carries bars
        t.expect(garden.muntins.count > 0, "garden front is gridded")
        let front = garden.glass.first { $0.tag == "glass" }!
        let fb = WindowGeometry.box(front.points)
        for m in garden.muntins {
            let b = WindowGeometry.box(m.points)
            t.expect(b.minX >= fb.minX - 0.5 && b.maxX <= fb.maxX + 0.5 && b.minY >= fb.minY - 0.5 && b.maxY <= fb.maxY + 0.5, "garden bars stay in the front pane")
        }
    },
    Check("grids: bars per pattern on a 36 x 60 double-hung and a 60 x 36 slider") { t in
        func bars(_ type: VisualWindowType, _ grid: VisualGrid, _ w: Double, _ h: Double) -> Int {
            WindowLayoutBuilder.build(type: type, grid: grid, widthIn: w, heightIn: h).muntins.count
        }
        t.equal(bars(.doubleHung, .none, 36, 60), 0, "no grid")
        // 6 over 6: one upright and two crossbars in each sash
        t.equal(bars(.doubleHung, .colonial, 36, 60), 6, "colonial 6/6")
        t.equal(bars(.doubleHung, .topOnly, 36, 60), 3, "top-only: the upper sash only")
        t.equal(bars(.doubleHung, .prairie, 36, 60), 8, "prairie: four bars a pane")
        t.equal(bars(.doubleHung, .queenAnne, 36, 60), 6, "Queen Anne: a crossbar and five uprights on the upper sash")
        t.expect(bars(.doubleHung, .diamond, 36, 60) > 12, "diamond lattice")
        t.equal(bars(.slider2, .colonial, 60, 36), 8, "slider colonial: 2 x 4 lites a pane")
        t.equal(bars(.picture, .colonial, 36, 60), 6, "picture colonial: 2 x 6")
        t.equal(bars(.casement, .none, 30, 48), 0, "casement without a grid")
        // The colonial counts follow the pane
        let a = WindowLayoutBuilder.colonialCounts(width: 32.76, height: 27.6)
        t.equal(a.cols, 2); t.equal(a.rows, 3)
        let narrow = WindowLayoutBuilder.colonialCounts(width: 9, height: 30)
        t.equal(narrow.cols, 1, "a narrow vent has no upright"); t.equal(narrow.rows, 3)
        // Every bar is a thin quad inside its pane's box
        let dh = WindowLayoutBuilder.build(type: .doubleHung, grid: .prairie, widthIn: 36, heightIn: 60)
        for m in dh.muntins {
            t.equal(m.points.count, 4, "bar is a quad")
            let b = WindowGeometry.box(m.points)
            t.expect(b.minX >= 0 && b.maxX <= 36 && b.minY >= 0 && b.maxY <= 60, "bar inside the opening")
        }
        // Bars on a round-top pane are cut to its shape
        let arch = WindowLayoutBuilder.build(type: .arch, grid: .colonial, widthIn: 36, heightIn: 60)
        t.expect(arch.muntins.count >= 4, "arch has bars")
        let pane = arch.glass[0].points
        for m in arch.muntins { for p in m.points { t.expect(insideOrNear(p, pane, 0.6), "arch bar end inside the glass") } }
    },
    Check("polygon helpers: offset, clip, bar") { t in
        let r = WindowGeometry.rect(0, 0, 10, 20)
        let out = WindowGeometry.offset(r, by: 2)
        let b = WindowGeometry.box(out)
        t.near(b.minX, -2, 1e-9); t.near(b.maxX, 12, 1e-9); t.near(b.minY, -2, 1e-9); t.near(b.maxY, 22, 1e-9)
        let inn = WindowGeometry.box(WindowGeometry.offset(r, by: -1))
        t.near(inn.minX, 1, 1e-9); t.near(inn.maxX, 9, 1e-9)
        // Winding does not matter
        let rev = WindowGeometry.box(WindowGeometry.offset(Array(r.reversed()), by: 2))
        t.near(rev.minX, -2, 1e-9)
        let c = WindowGeometry.clip(Vec2(-5, 10), Vec2(15, 10), to: r)
        t.near(c?.0.x, 0, 1e-9, "clip start"); t.near(c?.1.x, 10, 1e-9, "clip end")
        t.expect(WindowGeometry.clip(Vec2(-5, 30), Vec2(15, 30), to: r) == nil, "a line outside")
        let bar = WindowGeometry.bar(Vec2(0, 0), Vec2(10, 0), width: 1)
        t.near(WindowGeometry.signedArea(bar).magnitude, 10, 1e-9, "bar area")
    },
    Check("quote mapping: every kind lands on a style key the catalog offers") { t in
        let plain = HomeownerStyleOption.plain
        let full = wvCatalog([("double-hung", false), ("single-hung", false), ("slider-2", false), ("slider-3", false), ("picture", false), ("casement", true), ("awning", true), ("arch", true), ("circle", true)])
        let few = wvCatalog([("double-hung", false), ("picture", false)])
        for options in [plain, full, few, []] {
            let keys = Set((options.isEmpty ? plain : options).map(\.key))
            for type in VisualWindowType.allCases {
                let m = VisualCatalog.mapping(for: type, offered: options)
                t.expect(keys.contains(m.key), "\(type.rawValue) -> \(m.key) is not offered")
            }
        }
        // WinChoice's four tiles
        func map(_ type: VisualWindowType) -> VisualStyleMapping { VisualCatalog.mapping(for: type, offered: plain) }
        t.equal(map(.doubleHung).key, "double-hung"); t.expect(map(.doubleHung).exact && !map(.doubleHung).atVisit)
        t.equal(map(.singleHung).key, "double-hung", "single-hung rides the up-and-down tile"); t.expect(!map(.singleHung).exact)
        t.equal(map(.slider2).key, "slider-2")
        t.equal(map(.slider3).key, "slider-2", "a 3-lite slider rides the sideways tile")
        t.equal(map(.picture).key, "picture"); t.expect(!map(.picture).atVisit)
        for type in [VisualWindowType.casement, .casementPair, .awning, .hopper, .pictureCasements, .bay, .bow, .garden, .arch, .halfRound, .circle, .specialty] {
            t.expect(map(type).atVisit, "\(type.rawValue) is quoted at the visit")
            t.equal(map(type).key, "arch", "\(type.rawValue) sends the odd-shape tile's key")
        }
        t.equal(map(.bay).quoteLine, "Quoted at your visit")
        t.equal(map(.doubleHung).quoteLine, "Quoted as opens up and down")
        // A company that lists every style gets exact keys, still at-visit where it says so
        let f = VisualCatalog.mapping(for: .singleHung, offered: full)
        t.equal(f.key, "single-hung"); t.expect(f.exact)
        let cm = VisualCatalog.mapping(for: .casementPair, offered: full)
        t.equal(cm.key, "casement"); t.expect(cm.atVisit)
        // No odd-shape tile at all: a bay goes to the picture choice, nothing invented
        t.equal(VisualCatalog.mapping(for: .bay, offered: few).key, "picture")
    },
    Check("looks: starting kind from a style, summary line, and a tolerant decode") { t in
        t.equal(VisualCatalog.startingType(styleKey: "slider-2", offered: HomeownerStyleOption.plain), .slider2)
        t.equal(VisualCatalog.startingType(styleKey: nil, offered: HomeownerStyleOption.plain), .doubleHung)
        t.equal(VisualCatalog.startingType(styleKey: "arch", offered: HomeownerStyleOption.plain), .arch)
        t.equal(VisualCatalog.startingType(styleKey: "weird", offered: wvCatalog([("weird", true)])), .bay)
        let look = WindowVisualLook(type: .casement, grid: .prairie, glass: .lowE, cleanGlass: true)
        t.equal(look.summary(colorLabel: "Black"), "Casement, black, prairie grid, low-e glass")
        t.equal(WindowVisualLook().summary(colorLabel: nil), "Double-hung")
        let data = try JSONEncoder().encode(look)
        t.equal(try JSONDecoder().decode(WindowVisualLook.self, from: data), look)
        let odd = try JSONDecoder().decode(WindowVisualLook.self, from: Data(#"{"type":"nope","grid":3,"cleanGlass":"x"}"#.utf8))
        t.equal(odd, WindowVisualLook(), "garbage falls back to the defaults")
        // Nothing in the gallery is without words
        for type in VisualWindowType.allCases { t.expect(!type.title.isEmpty && !type.summary.isEmpty) }
        t.equal(VisualWindowType.gallery.count, 17)
        t.equal(VisualGrid.allCases.count, 6); t.equal(VisualGlass.allCases.count, 3)
    },
]

private func insideOrNear(_ p: Vec2, _ poly: [Vec2], _ tol: Double) -> Bool {
    // Inside a convex polygon, with a margin of `tol` inches (bars are thin quads, so their corners poke out a little)
    let grown = WindowGeometry.offset(poly, by: tol)
    var sign = 0.0
    for i in 0..<grown.count {
        let a = grown[i], b = grown[(i + 1) % grown.count]
        let cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
        if abs(cross) < 1e-9 { continue }
        if sign == 0 { sign = cross > 0 ? 1 : -1 } else if (cross > 0) != (sign > 0) { return false }
    }
    return true
}
