import Foundation
import RooflineCore

// Checks for the bank-card photo sizing (CardSizing.swift).
//
// CALIBRATION, measured with CardLimits as shipped (tap noise 2.0 px at a 3000 px long side, card corner 0.5 mm, model 0.5%).
// One 2250 x 3000 px photo; the window is always the same 1425 x 2385 px quad and only the card's size changes (the window
// in inches is that quad over the card's scale). First-order uncertainty, 1 sigma, inches:
//
//   card long side   window (in)      width     height    quality   Monte Carlo sd / model (width, height)
//   1195 px          4.0 x 6.7        0.059     0.179     check *   0.95  0.96
//    999 px          4.8 x 8.0        0.091     0.275     good      0.94  0.96
//    801 px          6.0 x 10.0       0.161     0.466     check     0.94  0.95
//    603 px          8.0 x 13.4       0.338     0.929     check     0.96  0.95
//    403 px          12.0 x 20.1      0.979     2.533     check     1.04  1.00
//    303 px          16.0 x 26.8      2.124     5.338     check     1.25  1.12
//    202 px          24.0 x 40.2      6.598     16.130    check     (heavy tails: the linear model no longer holds)
//    137 px          35.6 x 59.5      20.644    49.628    check
//    101 px          48.0 x 80.4      50.362    120.162   check
//     61 px          80.0 x 134.0     242.228   581.437   check
//   The reference scene (card 136 px, window 35.625 x 59.625 in, same photo): 20.733 / 49.839, check.
//   * the window quad is under 4x the card's area, so 'corners too close together' as well.
//
// So a free homography from a bank card carries its scale to a window only a few times the card's size: the card's
// perspective terms are barely determined by ~130 px of quad, and the error grows about with the square of the size ratio
// (a 1 px tap on a 136 px card moves a 60 in height by about 10 in). The first estimate was 1/4 to 1/2 in at 135 px next to
// a 60 in window and under 1/8 in at 600 px; the model, as specified, gives +/- 21 / 50 in and +/- 0.34 / 0.93 in. The
// checks pin what the model really does, and that the 'check' rule catches it.
//
// Also measured: with the model's own noise on the taps, the 4 degree / 3% 'clean rectangle' rule (copied from the AR path,
// where the noise is millimetres) fires in 67% of trials in the 1000 px scene and in 78% to 95% from 800 px down, so only
// about a third of noisy taps in the best scene stay 'good'. Those thresholds are tighter than the extrapolation noise.

// MARK: - Synthetic scenes

/// The window glass (a plane, inches, y down) seen by a camera: a known homography from plane inches to photo pixels, so
/// every corner is projected exactly and the truth is known.
private struct CardCheckScene {
    var pxPerIn: Double
    var windowWIn: Double
    var windowHIn: Double
    var rotationDeg = 1.5
    /// Perspective as the plane's depth change per photo pixel, so a scene looks the same at any scale.
    var perspX = 1e-5
    var perspY = -7.5e-6
    var offset = Vec2(300, 280)
    var imageWidthPx = 2250.0
    var imageHeightPx = 3000.0

    /// The reference scene: about 40 px per inch, 1.5 degrees of turn, a small perspective term, a 35.625 x 59.625 in window.
    static let reference = CardCheckScene(pxPerIn: 40, windowWIn: 35.625, windowHIn: 59.625)

    /// The same 1425 x 2385 px window quad in the photo, with a card whose long side spans `cardPx` px.
    static func closeUp(cardPx: Double) -> CardCheckScene {
        let ppi = cardPx / CardLimits.widthIn
        return CardCheckScene(pxPerIn: ppi, windowWIn: 1425 / ppi, windowHIn: 2385 / ppi)
    }

    var matrix: [Double] {
        let a = rotationDeg * .pi / 180
        return [pxPerIn * cos(a), -pxPerIn * sin(a), offset.x, pxPerIn * sin(a), pxPerIn * cos(a), offset.y, perspX * pxPerIn, perspY * pxPerIn, 1]
    }

    func photo(_ x: Double, _ y: Double) -> Vec2 { Homography.apply(matrix, Vec2(x, y)) }

    /// The window frame's corners in the photo: TL, TR, BR, BL.
    var window: [Vec2] { [photo(0, 0), photo(windowWIn, 0), photo(windowWIn, windowHIn), photo(0, windowHIn)] }

    /// A rectangle on the glass with its top-left at plane (x, y) inches, turned `tiltDeg` about its centre: TL, TR, BR, BL.
    func rectangle(x: Double, y: Double, w: Double, h: Double, tiltDeg: Double = 0) -> [Vec2] {
        let cx = x + w / 2, cy = y + h / 2, t = tiltDeg * .pi / 180
        return [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)].map { c in
            photo(cx + c.0 * cos(t) - c.1 * sin(t), cy + c.0 * sin(t) + c.1 * cos(t))
        }
    }

    /// A w x h in rectangle lying near the window's lower-left corner, `marginPx` (at this scene's scale) in from the edges.
    func lowerLeft(w: Double, h: Double, tiltDeg: Double = 0, marginPx: Double = 60) -> [Vec2] {
        let m = marginPx / pxPerIn
        return rectangle(x: m, y: windowHIn - m - h, w: w, h: h, tiltDeg: tiltDeg)
    }

    /// The bank card lying near the window's lower-left corner.
    func card(portrait: Bool = false, tiltDeg: Double = 0) -> [Vec2] {
        portrait ? lowerLeft(w: CardLimits.heightIn, h: CardLimits.widthIn, tiltDeg: tiltDeg) : lowerLeft(w: CardLimits.widthIn, h: CardLimits.heightIn, tiltDeg: tiltDeg)
    }

    func size(card: [Vec2], window: [Vec2]) -> CardSize? {
        CardSizing.size(cardCorners: card, windowCorners: window, imageWidthPx: imageWidthPx, imageHeightPx: imageHeightPx)
    }
}

/// A seeded linear congruential generator (Knuth's MMIX constants) with Box-Muller: no system randomness, so every run of
/// a check sees the same numbers.
private struct CardRNG {
    var state: UInt64

    mutating func unit() -> Double {
        state = state &* 6364136223846793005 &+ 1442695040888963407
        return (Double(state >> 11) + 0.5) / 9007199254740992
    }

    mutating func gaussian() -> Double {
        let u1 = unit(), u2 = unit()
        return (-2 * log(u1)).squareRoot() * cos(2 * Double.pi * u2)
    }
}

/// All 24 orders of the indexes 0...3.
private func cardPermutations() -> [[Int]] {
    var out: [[Int]] = []
    func go(_ prefix: [Int], _ rest: [Int]) {
        if rest.isEmpty {
            out.append(prefix)
            return
        }
        for (i, x) in rest.enumerated() {
            var r = rest
            r.remove(at: i)
            go(prefix + [x], r)
        }
    }
    go([], [0, 1, 2, 3])
    return out
}

/// Length of the edge from corner i to corner i + 1.
private func cardEdge(_ q: [Vec2], _ i: Int) -> Double {
    hypot(q[(i + 1) % 4].x - q[i].x, q[(i + 1) % 4].y - q[i].y)
}

/// Shoelace area, positive when the corners run clockwise on a screen (y down).
private func cardSignedArea(_ q: [Vec2]) -> Double {
    var s = 0.0
    for i in 0..<q.count {
        let a = q[i], b = q[(i + 1) % q.count]
        s += a.x * b.y - b.x * a.y
    }
    return s / 2
}

private func cardMean(_ v: [Double]) -> Double { v.reduce(0, +) / Double(v.count) }

private func cardStdDev(_ v: [Double]) -> Double {
    let m = cardMean(v)
    return (v.reduce(0) { $0 + ($1 - m) * ($1 - m) } / Double(v.count - 1)).squareRoot()
}

private func cardCentre(_ q: [Vec2]) -> Vec2 {
    Vec2(q.reduce(0) { $0 + $1.x } / Double(q.count), q.reduce(0) { $0 + $1.y } / Double(q.count))
}

// The reasons the app shows, in the words it shows them
private let cardNotABankCard = "The four card corners don't look like a bank card."
private let cardNotARectangle = "The window corners don't make a clean rectangle."
private let cardNotOnTheGlass = "The card is not on the window glass."
private let cardTooClose = "The window corners look too close together."
private let cardLooksSmall = "The card looks small next to the window, so the size is less sure. A closer photo helps."

// MARK: - Parity with the server

/// One photo's worth of server output. GENERATED with Node 22 from the server's real TypeScript
/// (packages/shared/src/window-photo-math.ts), run from the repo root; it prints one JSON object with, per case, the inputs
/// and the server's `homography` (H), `sizeFromReference` (size) and `applyHomography(H, [1000, 2000])` (probe):
///
///   node --experimental-strip-types -e "import('./packages/shared/src/window-photo-math.ts').then(m => {
///     const sets = {
///       paper: [[[1410.4,1942.5],[1793.1,1957.8],[1778.9,2440.2],[1398.2,2421.6]], [[402.7,311.4],[2233.9,352.6],[2201.3,2873.5],[377.8,2848.9]], 8.5, 11],
///       card: [[[812.4,2410.7],[951.3,2399.2],[958.6,2486.9],[820.1,2499.4]], [[300.2,280.7],[1700.9,312.4],[1668.3,2711.8],[241.6,2712.9]], 85.6 / 25.4, 53.98 / 25.4],
///       index: [[[2010,1500],[2480,1560],[2495,2160],[2002,2110]], [[1650.5,820.3],[3120.8,905.9],[3198.4,3010.2],[1580.9,2880.7]], 4, 6],
///       twoSame: [[[100,100],[100,100],[300,200],[100,200]], [[0,0],[1000,0],[1000,1000],[0,1000]], 4, 6],
///       threeCollinear: [[[100,100],[200,100],[300,100],[100,200]], [[0,0],[1000,0],[1000,1000],[0,1000]], 4, 6] };
///     const out = {};
///     for (const [k, [ref, win, w, h]] of Object.entries(sets)) {
///       const H = m.homography(ref, [[0,0],[w,0],[w,h],[0,h]]);
///       out[k] = { ref, win, w, h, H, size: m.sizeFromReference(win, ref, w, h), probe: H && m.applyHomography(H, [1000, 2000]) }; }
///     console.log(JSON.stringify(out)); })"
///
/// JSON.stringify prints the shortest text that parses back to the same double, so the literals below are the server's
/// doubles exactly; nil is the server's null. The Swift port reproduces them to the last bit (it does the same operations in
/// the same order); the checks allow 1e-9.
private struct CardParityCase {
    let name: String
    let reference: [Vec2]
    let window: [Vec2]
    let refWidthIn: Double
    let refHeightIn: Double
    let h: [Double]?
    let size: (Double, Double)?
    let probe: Vec2?
}

private let cardParityCases: [CardParityCase] = [
    CardParityCase(name: "paper", reference: [Vec2(1410.4, 1942.5), Vec2(1793.1, 1957.8), Vec2(1778.9, 2440.2), Vec2(1398.2, 2421.6)],
                   window: [Vec2(402.7, 311.4), Vec2(2233.9, 352.6), Vec2(2201.3, 2873.5), Vec2(377.8, 2848.9)],
                   refWidthIn: 8.5, refHeightIn: 11,
                   h: [0.022513133872940974, 0.0005732837262573234, -32.8661276526508, -0.0009192792332431265, 0.02299399755308136, -43.36928881629444, 1.9045382983821687e-05, -9.95894393792716e-06, 1],
                   size: (40.921153253534044, 57.50474624684104), probe: Vec2(-9.21446599385229, 1.7009111098894456)),
    CardParityCase(name: "card", reference: [Vec2(812.4, 2410.7), Vec2(951.3, 2399.2), Vec2(958.6, 2486.9), Vec2(820.1, 2499.4)],
                   window: [Vec2(300.2, 280.7), Vec2(1700.9, 312.4), Vec2(1668.3, 2711.8), Vec2(241.6, 2712.9)],
                   refWidthIn: 3.37007874015748, refHeightIn: 2.1251968503937007,
                   h: [0.021396949883254437, -0.0018574578816354206, -12.905108369897391, 0.0017658889781764693, 0.021328867745105055, -52.85210967899531, -7.633610470808252e-05, -1.6319530726881927e-05, 1],
                   size: (34.512314652176016, 56.77220017516713), probe: Vec2(5.361158935951596, -9.459315712113687)),
    CardParityCase(name: "index", reference: [Vec2(2010, 1500), Vec2(2480, 1560), Vec2(2495, 2160), Vec2(2002, 2110)],
                   window: [Vec2(1650.5, 820.3), Vec2(3120.8, 905.9), Vec2(3198.4, 3010.2), Vec2(1580.9, 2880.7)],
                   refWidthIn: 4, refHeightIn: 6,
                   h: [0.008442567246029648, 0.00011072219339055474, -17.13564345460542, -0.00133438263456632, 0.010452663970769518, -12.996886860675977, -5.4008276018747973e-05, 8.179680053579274e-05, 1],
                   size: (13.046714255214678, 20.77794127712239), probe: Vec2(-7.634953013993088, 5.924788565479347)),
    CardParityCase(name: "twoSame", reference: [Vec2(100, 100), Vec2(100, 100), Vec2(300, 200), Vec2(100, 200)],
                   window: [Vec2(0, 0), Vec2(1000, 0), Vec2(1000, 1000), Vec2(0, 1000)],
                   refWidthIn: 4, refHeightIn: 6,
                   h: nil,
                   size: nil, probe: nil),
    // A quirk worth keeping: three reference corners in a line are NOT always null on the server. Its 8 x 8 system stays
    // solvable here (no pivot under 1e-12) and gives a rank-deficient homography and a size of ~0. Same pivoting, same answer.
    // (CardSizing never gets here: orderedQuad refuses taps like these first.)
    CardParityCase(name: "threeCollinear", reference: [Vec2(100, 100), Vec2(200, 100), Vec2(300, 100), Vec2(100, 200)],
                   window: [Vec2(0, 0), Vec2(1000, 0), Vec2(1000, 1000), Vec2(0, 1000)],
                   refWidthIn: 4, refHeightIn: 6,
                   h: [8.28966525053449e-19, 4.437342591868191e-34, -7.771561172376083e-17, 3.315866100213796e-18, -0.05999999999999994, 5.9999999999999964, -4.934324553889585e-19, -0.009999999999999997, 1],
                   size: (3.1821886520957096e-15, 3.1796920079941944e-15), probe: Vec2(-3.953952175419417e-17, 5.9999999999999964)),
]

// MARK: - The checks

let cardChecks: [Check] = [
    Check("Homography: the corners land on the rectangle; a degenerate quad has no homography") { ctx in
        let src = [Vec2(10, 20), Vec2(310, 30), Vec2(300, 420), Vec2(5, 400)]
        let dst = [Vec2(0, 0), Vec2(3, 0), Vec2(3, 4), Vec2(0, 4)]
        guard let h = Homography.solve(src: src, dst: dst) else {
            ctx.expect(false, "four good corners have a homography")
            return
        }
        ctx.equal(h.count, 9)
        ctx.equal(h[8], 1, "h33 is 1")
        for i in 0..<4 {
            let p = Homography.apply(h, src[i])
            ctx.near(p.x, dst[i].x, 1e-9, "corner \(i) x")
            ctx.near(p.y, dst[i].y, 1e-9, "corner \(i) y")
        }
        // A plain scale and shift comes back exactly: 100 px = 1 in
        let ref = [Vec2(100, 100), Vec2(200, 100), Vec2(200, 300), Vec2(100, 300)]
        let flat = Homography.solve(src: ref, dst: [Vec2(0, 0), Vec2(1, 0), Vec2(1, 2), Vec2(0, 2)])
        let want = [0.01, 0, -1, 0, 0.01, -1, 0, 0, 1]
        for i in 0..<9 { ctx.near(flat?[i], want[i], 1e-12, "flat h\(i)") }
        let window = sizeFromReference(windowQuad: [Vec2(100, 100), Vec2(1100, 100), Vec2(1100, 2100), Vec2(100, 2100)], referenceQuad: ref, refWidthIn: 1, refHeightIn: 2)
        ctx.near(window?.widthIn, 10, 1e-9)
        ctx.near(window?.heightIn, 20, 1e-9)
        // Nothing to solve
        ctx.expect(Homography.solve(src: [Vec2(100, 100), Vec2(100, 100), Vec2(300, 200), Vec2(100, 200)], dst: dst) == nil, "two corners the same")
        ctx.expect(Homography.solve(src: [Vec2(100, 100), Vec2(200, 100), Vec2(300, 100), Vec2(400, 100)], dst: dst) == nil, "four in a line")
        ctx.expect(Homography.solve(src: Array(src.prefix(3)), dst: dst) == nil, "three points")
        ctx.expect(Homography.solve(src: [Vec2(.nan, 0)] + src.suffix(3), dst: dst) == nil, "not finite")
        ctx.expect(sizeFromReference(windowQuad: Array(src.prefix(3)), referenceQuad: src, refWidthIn: 3, refHeightIn: 4) == nil, "a window of three corners")
        ctx.expect(Homography.apply([1, 2, 3], Vec2(1, 1)).x.isNaN, "a matrix of the wrong size gives NaN, not a crash")
        ctx.expect(quadSize(Array(src.prefix(3))).widthIn.isNaN, "a quad of three corners gives NaN, not a crash")
    },
    Check("Parity with the server's TypeScript: homography, applyHomography and sizeFromReference on three photos and two degenerate quads") { ctx in
        for c in cardParityCases {
            let real = [Vec2(0, 0), Vec2(c.refWidthIn, 0), Vec2(c.refWidthIn, c.refHeightIn), Vec2(0, c.refHeightIn)]
            let h = Homography.solve(src: c.reference, dst: real)
            if let want = c.h {
                if let got = h {
                    for i in 0..<9 { ctx.near(got[i], want[i], 1e-9, "\(c.name) h\(i)") }
                    if let probe = c.probe {
                        let p = Homography.apply(got, Vec2(1000, 2000))
                        ctx.near(p.x, probe.x, 1e-9, "\(c.name) probe x")
                        ctx.near(p.y, probe.y, 1e-9, "\(c.name) probe y")
                    }
                } else {
                    ctx.expect(false, "\(c.name): the server solves it, we returned nil")
                }
            } else {
                ctx.expect(h == nil, "\(c.name): the server returns null, so do we")
            }
            let size = sizeFromReference(windowQuad: c.window, referenceQuad: c.reference, refWidthIn: c.refWidthIn, refHeightIn: c.refHeightIn)
            if let want = c.size {
                ctx.near(size?.widthIn, want.0, 1e-9, "\(c.name) width")
                ctx.near(size?.heightIn, want.1, 1e-9, "\(c.name) height")
            } else {
                ctx.expect(size == nil, "\(c.name): no size")
            }
        }
        // The bank-card case is the card the app uses, and CardSizing.size is that same pipeline (corners tapped out of order)
        guard let card = cardParityCases.first(where: { $0.name == "card" }), let want = card.size else {
            ctx.expect(false, "the card case")
            return
        }
        ctx.equal(card.refWidthIn, CardLimits.widthIn, "the card's width in inches")
        ctx.equal(card.refHeightIn, CardLimits.heightIn, "the card's height in inches")
        let w = card.window
        let s = CardSizing.size(cardCorners: card.reference.reversed(), windowCorners: [w[2], w[0], w[3], w[1]], imageWidthPx: 3024, imageHeightPx: 4032)
        ctx.near(s?.widthIn, want.0, 1e-9, "CardSizing.size width")
        ctx.near(s?.heightIn, want.1, 1e-9, "CardSizing.size height")
    },
    Check("CardSizing.orderedQuad: every tap order gives TL, TR, BR, BL, clockwise (a bowtie order is just another order)") { ctx in
        let scene = CardCheckScene.reference
        let quads: [(String, [Vec2])] = [
            ("an upright window", [Vec2(300, 280), Vec2(1700, 312), Vec2(1668, 2711), Vec2(242, 2713)]),
            ("a card tilted 25 degrees", scene.card(tiltDeg: 25)),
            ("a card tilted -35 degrees, portrait", scene.card(portrait: true, tiltDeg: -35)),
            ("a tall trapezoid", [Vec2(500, 400), Vec2(900, 380), Vec2(1100, 2000), Vec2(300, 2050)]),
            ("a wide window turned 20 degrees", [Vec2(500, 500), Vec2(2003.5, 1047.2), Vec2(1661.5, 1986.9), Vec2(158, 1439.7)]),
            // 2400 x 600, turned 20 degrees counter-clockwise: seen from the centre TL comes last in angle, so the start must be chosen
            ("a very wide window turned 20 degrees the other way", [Vec2(400, 1800), Vec2(2655.3, 979.2), Vec2(2860.5, 1543), Vec2(605.2, 2363.8)]),
        ]
        for (name, canonical) in quads {
            ctx.expect(cardSignedArea(canonical) > 0, "\(name): the expected order is clockwise")
            for perm in cardPermutations() {
                let got = CardSizing.orderedQuad(perm.map { canonical[$0] })
                ctx.expect(got == canonical, "\(name) tapped \(perm): \(String(describing: got))")
            }
        }
        // The tap order TL, BR, TR, BL crosses itself (a bowtie): the same four points are the same quad
        let w = quads[0].1
        ctx.equal(CardSizing.orderedQuad([w[0], w[2], w[1], w[3]]) ?? [], w, "bowtie tap order")
        // A square turned exactly 45 degrees: the top corner is TL whatever the order
        let diamond = [Vec2(500, 100), Vec2(900, 500), Vec2(500, 900), Vec2(100, 500)]
        for perm in cardPermutations() {
            ctx.expect(CardSizing.orderedQuad(perm.map { diamond[$0] }) == diamond, "diamond tapped \(perm)")
        }
    },
    Check("CardSizing.orderedQuad: nil for equal, collinear, flat, dart and non-finite points") { ctx in
        let good = [Vec2(300, 280), Vec2(1700, 312), Vec2(1668, 2711), Vec2(242, 2713)]
        ctx.expect(CardSizing.orderedQuad(good) != nil, "a good quad")
        func everyOrderIsNil(_ name: String, _ p: [Vec2]) {
            for perm in cardPermutations() {
                ctx.expect(CardSizing.orderedQuad(perm.map { p[$0] }) == nil, "\(name) tapped \(perm)")
            }
        }
        everyOrderIsNil("two points the same", [Vec2(100, 100), Vec2(100, 100), Vec2(900, 500), Vec2(200, 800)])
        everyOrderIsNil("two points half a pixel apart (a convex quad otherwise)", [Vec2(100, 100), Vec2(900, 120), Vec2(900.3, 120.4), Vec2(120, 880)])
        everyOrderIsNil("four in a line", [Vec2(0, 0), Vec2(100, 100), Vec2(200, 200), Vec2(300, 300)])
        everyOrderIsNil("three in a line", [Vec2(100, 100), Vec2(500, 100), Vec2(900, 100), Vec2(300, 700)])
        everyOrderIsNil("a dart: one corner inside the triangle of the others", [Vec2(100, 100), Vec2(900, 150), Vec2(500, 900), Vec2(480, 400)])
        everyOrderIsNil("a corner almost straight", [Vec2(100, 100), Vec2(500, 96), Vec2(900, 100), Vec2(500, 900)])
        ctx.expect(CardSizing.orderedQuad(Array(good.prefix(3))) == nil, "three points")
        ctx.expect(CardSizing.orderedQuad(good + [Vec2(10, 10)]) == nil, "five points")
        ctx.expect(CardSizing.orderedQuad([]) == nil, "no points")
        ctx.expect(CardSizing.orderedQuad([Vec2(.nan, 1)] + good.suffix(3)) == nil, "NaN")
        ctx.expect(CardSizing.orderedQuad([Vec2(.infinity, 1)] + good.suffix(3)) == nil, "infinite")
        // A small quad is still a quad: 30 px across is fine
        ctx.expect(CardSizing.orderedQuad([Vec2(10, 10), Vec2(40, 10), Vec2(40, 29), Vec2(10, 29)]) != nil, "a small but real quad")
    },
    Check("CardSizing.cardCornersForAPI: the long side is edge 0->1, clockwise kept (landscape, portrait, tilted)") { ctx in
        let scene = CardCheckScene.reference
        let cases: [(String, Bool, Double)] = [
            ("landscape", false, 0), ("portrait", true, 0), ("landscape tilted 20", false, 20), ("landscape tilted -35", false, -35),
            ("portrait tilted 25", true, 25), ("portrait tilted -40", true, -40),
        ]
        for (name, portrait, tilt) in cases {
            let card = scene.card(portrait: portrait, tiltDeg: tilt)
            var first: [Vec2]?
            for perm in cardPermutations() {
                guard let api = CardSizing.cardCornersForAPI(perm.map { card[$0] }) else {
                    ctx.expect(false, "\(name) tapped \(perm): nil")
                    continue
                }
                if first == nil { first = api }
                ctx.expect(api == first, "\(name) tapped \(perm): the same labelling whatever the tap order")
                ctx.expect(cardSignedArea(api) > 0, "\(name) tapped \(perm): clockwise")
                ctx.expect((cardEdge(api, 0) + cardEdge(api, 2)) / 2 > (cardEdge(api, 1) + cardEdge(api, 3)) / 2, "\(name) tapped \(perm): edge 0->1 is the long side")
                ctx.expect(Set(api) == Set(card), "\(name): the same four corners")
            }
        }
        // Landscape upright: the plain TL, TR, BR, BL. Portrait: the same corners turned a quarter, (c1, c2, c3, c0)
        let landscape = scene.card()
        ctx.equal(CardSizing.cardCornersForAPI(landscape) ?? [], landscape, "landscape is unchanged")
        let portrait = scene.card(portrait: true)
        if let o = CardSizing.orderedQuad(portrait) {
            ctx.equal(CardSizing.cardCornersForAPI(portrait) ?? [], [o[1], o[2], o[3], o[0]], "portrait is relabelled by a quarter turn")
        } else {
            ctx.expect(false, "portrait card has an order")
        }
        ctx.expect(CardSizing.cardCornersForAPI([Vec2(1, 1), Vec2(2, 2), Vec2(3, 3), Vec2(4, 4)]) == nil, "nil when there is no quad")
    },
    Check("CardSizing.size: no noise, the card gives the window's true size (landscape, portrait, tilted; any tap order)") { ctx in
        let scenes: [(String, CardCheckScene)] = [
            ("reference", CardCheckScene.reference),
            ("strong perspective", CardCheckScene(pxPerIn: 30, windowWIn: 35.625, windowHIn: 59.625, rotationDeg: -2.5, perspX: 4e-5, perspY: -3e-5, offset: Vec2(250, 200))),
            ("a small window up close", CardCheckScene.closeUp(cardPx: 800)),
        ]
        let cards: [(String, Bool, Double)] = [("landscape", false, 0), ("portrait", true, 0), ("tilted 25", false, 25), ("portrait tilted -30", true, -30)]
        let perms = cardPermutations()
        for (sceneName, scene) in scenes {
            let window = scene.window
            for (cardName, portrait, tilt) in cards {
                let card = scene.card(portrait: portrait, tiltDeg: tilt)
                for (i, perm) in perms.enumerated() {
                    // 7 is coprime with 24, so every window order is paired with some card order
                    let s = scene.size(card: perm.map { card[$0] }, window: perms[(i * 7 + 5) % perms.count].map { window[$0] })
                    guard let s = s else {
                        ctx.expect(false, "\(sceneName), \(cardName) card, order \(perm): nil")
                        continue
                    }
                    ctx.near(s.widthIn, scene.windowWIn, 1e-6, "\(sceneName), \(cardName) card, order \(perm): width")
                    ctx.near(s.heightIn, scene.windowHIn, 1e-6, "\(sceneName), \(cardName) card, order \(perm): height")
                }
            }
        }
        // CardSizing.size is the server's sizeFromReference on the corners in the API's order; sizeRatio is the area ratio
        let scene = CardCheckScene.reference
        let card = scene.card(tiltDeg: 12)
        let window = scene.window
        guard let s = scene.size(card: [card[3], card[1], card[0], card[2]], window: [window[1], window[3], window[0], window[2]]),
              let api = CardSizing.cardCornersForAPI(card), let ordered = CardSizing.orderedQuad(window),
              let server = sizeFromReference(windowQuad: ordered, referenceQuad: api, refWidthIn: CardLimits.widthIn, refHeightIn: CardLimits.heightIn) else {
            ctx.expect(false, "the reference scene sizes")
            return
        }
        ctx.near(s.widthIn, server.widthIn, 1e-9, "same as sizeFromReference")
        ctx.near(s.heightIn, server.heightIn, 1e-9, "same as sizeFromReference")
        let ratio = cardSignedArea(ordered) / cardSignedArea(api)
        ctx.near(s.sizeRatio, ratio, 1e-9 * ratio, "window area over card area")
    },
    Check("CardSizing.tapSigmasPx: the window corners have the tap noise, the card corners a little more") { ctx in
        let scene = CardCheckScene.reference
        let card = scene.card(), window = scene.window
        guard let sig = CardSizing.tapSigmasPx(cardCorners: card, windowCorners: window, imageWidthPx: 2250, imageHeightPx: 3000) else {
            ctx.expect(false, "sigmas")
            return
        }
        ctx.equal(sig.count, 8)
        for i in 4..<8 { ctx.near(sig[i], 2.0, 1e-12, "window corner \(i - 4) at a 3000 px long side") }
        // The card's scale: its perimeter in photo pixels over its perimeter in millimetres
        let perimeter = (0..<4).reduce(0.0) { $0 + cardEdge(card, $1) }
        let pxPerMm = perimeter / (2 * (85.6 + 53.98))
        for i in 0..<4 { ctx.near(sig[i], (4 + 0.25 * pxPerMm * pxPerMm).squareRoot(), 1e-9, "card corner \(i)") }
        ctx.expect(sig[0] > sig[4], "a card corner is less certain than a window corner")
        // Scales with the photo's long side, in either orientation
        let big = CardSizing.tapSigmasPx(cardCorners: card, windowCorners: window, imageWidthPx: 6000, imageHeightPx: 4500)
        ctx.near(big?[4], 4.0, 1e-12, "a 6000 px long side doubles the tap noise")
        let small = CardSizing.tapSigmasPx(cardCorners: card, windowCorners: window, imageWidthPx: 1000, imageHeightPx: 1500)
        ctx.near(small?[7], 1.0, 1e-12, "a 1500 px long side halves it")
        ctx.near(CardSizing.tapSigmaPx(imageWidthPx: 3024, imageHeightPx: 4032), 2.0 * 4032 / 3000, 1e-12)
        ctx.expect(CardSizing.tapSigmasPx(cardCorners: card, windowCorners: window, imageWidthPx: 0, imageHeightPx: 3000) == nil, "no photo size")
    },
    Check("CardSizing.size: the uncertainty matches a Monte Carlo of the taps (card 1000, 600 and 400 px)") { ctx in
        // 400 trials of gaussian noise on the eight taps with the model's own sigmas (and the model term as a scale error),
        // then the plain server pipeline. In the linear regime the sample sd is within a few percent of the reported value.
        for cardPx in [1000.0, 600, 400] {
            let scene = CardCheckScene.closeUp(cardPx: cardPx)
            let card = scene.card(), window = scene.window
            guard let s = scene.size(card: card, window: window),
                  let api = CardSizing.cardCornersForAPI(card), let ordered = CardSizing.orderedQuad(window),
                  let sig = CardSizing.tapSigmasPx(cardCorners: card, windowCorners: window, imageWidthPx: scene.imageWidthPx, imageHeightPx: scene.imageHeightPx) else {
                ctx.expect(false, "card \(cardPx) px: sizes")
                continue
            }
            var rng = CardRNG(state: 20261016)
            var widths: [Double] = [], heights: [Double] = []
            for _ in 0..<400 {
                var noisyCard: [Vec2] = [], noisyWindow: [Vec2] = []
                for i in 0..<4 { noisyCard.append(Vec2(api[i].x + rng.gaussian() * sig[i], api[i].y + rng.gaussian() * sig[i])) }
                for i in 0..<4 { noisyWindow.append(Vec2(ordered[i].x + rng.gaussian() * sig[4 + i], ordered[i].y + rng.gaussian() * sig[4 + i])) }
                guard let r = sizeFromReference(windowQuad: noisyWindow, referenceQuad: noisyCard, refWidthIn: CardLimits.widthIn, refHeightIn: CardLimits.heightIn) else { continue }
                widths.append(r.widthIn * (1 + CardLimits.modelSigma * rng.gaussian()))
                heights.append(r.heightIn * (1 + CardLimits.modelSigma * rng.gaussian()))
            }
            ctx.equal(widths.count, 400, "card \(cardPx) px: every trial solved")
            guard widths.count > 100 else { continue }
            let rw = cardStdDev(widths) / s.uncertaintyWidthIn
            let rh = cardStdDev(heights) / s.uncertaintyHeightIn
            ctx.expect(rw > 0.75 && rw < 1.25, "card \(cardPx) px: width sd / reported = \(rw)")
            ctx.expect(rh > 0.75 && rh < 1.25, "card \(cardPx) px: height sd / reported = \(rh)")
            // The cloud is centred on the truth, within half a sigma
            ctx.expect(abs(cardMean(widths) - scene.windowWIn) < 0.5 * s.uncertaintyWidthIn, "card \(cardPx) px: mean width \(cardMean(widths)) vs \(scene.windowWIn)")
            ctx.expect(abs(cardMean(heights) - scene.windowHIn) < 0.5 * s.uncertaintyHeightIn, "card \(cardPx) px: mean height \(cardMean(heights)) vs \(scene.windowHIn)")
        }
    },
    Check("CardSizing.size: the uncertainty is the 16 weighted sensitivities and the model term, in quadrature") { ctx in
        // Recomputed here with a different step (0.1 px instead of 0.25) straight through the server pipeline
        for cardPx in [1000.0, 600] {
            let scene = CardCheckScene.closeUp(cardPx: cardPx)
            let card = scene.card(), window = scene.window
            guard let s = scene.size(card: card, window: window),
                  let api = CardSizing.cardCornersForAPI(card), let ordered = CardSizing.orderedQuad(window),
                  let sig = CardSizing.tapSigmasPx(cardCorners: card, windowCorners: window, imageWidthPx: scene.imageWidthPx, imageHeightPx: scene.imageHeightPx) else {
                ctx.expect(false, "card \(cardPx) px: sizes")
                continue
            }
            let points = api + ordered
            var varWidth = 0.0, varHeight = 0.0
            for i in 0..<8 {
                for axis in 0..<2 {
                    func at(_ d: Double) -> ReferenceSize? {
                        var p = points
                        if axis == 0 { p[i].x += d } else { p[i].y += d }
                        return sizeFromReference(windowQuad: Array(p[4..<8]), referenceQuad: Array(p[0..<4]), refWidthIn: CardLimits.widthIn, refHeightIn: CardLimits.heightIn)
                    }
                    guard let a = at(0.1), let b = at(-0.1) else {
                        ctx.expect(false, "card \(cardPx) px: coordinate \(i) axis \(axis) does not solve")
                        continue
                    }
                    let dWidth = (a.widthIn - b.widthIn) / 0.2 * sig[i]
                    let dHeight = (a.heightIn - b.heightIn) / 0.2 * sig[i]
                    varWidth += dWidth * dWidth
                    varHeight += dHeight * dHeight
                }
            }
            let modelWidth = CardLimits.modelSigma * s.widthIn
            let modelHeight = CardLimits.modelSigma * s.heightIn
            let wantWidth = (varWidth + modelWidth * modelWidth).squareRoot()
            let wantHeight = (varHeight + modelHeight * modelHeight).squareRoot()
            ctx.near(s.uncertaintyWidthIn, wantWidth, 2e-3 * wantWidth, "card \(cardPx) px: width")
            ctx.near(s.uncertaintyHeightIn, wantHeight, 2e-3 * wantHeight, "card \(cardPx) px: height")
            // The model term is really in (it is 3.6% of the width at 1000 px, under 1% at 600 px): the taps alone are smaller
            if cardPx == 1000 { ctx.expect(varWidth.squareRoot() < 0.98 * s.uncertaintyWidthIn, "card \(cardPx) px: the model term adds to the width") }
        }
    },
    Check("CardSizing.size: uncertainty grows with the window/card ratio (height +/- in: card 1000 px 0.27, 600 px 0.93, 300 px 5.3, 136 px 50, 60 px 580)") { ctx in
        // Only the card's size changes (see the table at the top): the uncertainty grows faster than the card shrinks
        var previous: CardSize?
        var previousSpan = 0.0
        for span in [1000.0, 800, 600, 400, 300, 200, 135, 100, 60] {
            let scene = CardCheckScene.closeUp(cardPx: span)
            guard let s = scene.size(card: scene.card(), window: scene.window) else {
                ctx.expect(false, "card \(span) px: nil")
                continue
            }
            if let p = previous {
                let shrink = previousSpan / span
                ctx.expect(s.uncertaintyWidthIn > p.uncertaintyWidthIn * shrink, "card \(span) px: width \(s.uncertaintyWidthIn) vs \(p.uncertaintyWidthIn)")
                ctx.expect(s.uncertaintyHeightIn > p.uncertaintyHeightIn * shrink, "card \(span) px: height \(s.uncertaintyHeightIn) vs \(p.uncertaintyHeightIn)")
                ctx.expect(s.sizeRatio > p.sizeRatio, "card \(span) px: the ratio grows")
            }
            previous = s
            previousSpan = span
        }
        func at(_ span: Double) -> CardSize? {
            let scene = CardCheckScene.closeUp(cardPx: span)
            return scene.size(card: scene.card(), window: scene.window)
        }
        // A card of 1000 px next to a 4.8 x 8.0 in window: good, though still not under 1/8 in
        if let s = at(1000) {
            ctx.equal(s.quality, .good)
            ctx.expect(s.reasons.isEmpty, "\(s.reasons)")
            ctx.expect(s.uncertaintyWidthIn > 0.06 && s.uncertaintyWidthIn < 0.13, "width +/- \(s.uncertaintyWidthIn)")
            ctx.expect(s.uncertaintyHeightIn > 0.2 && s.uncertaintyHeightIn < 0.35, "height +/- \(s.uncertaintyHeightIn)")
        } else {
            ctx.expect(false, "card 1000 px")
        }
        // 600 px next to an 8.0 x 13.4 in window: already past 3/8 in
        if let s = at(600) {
            ctx.equal(s.quality, .check)
            ctx.expect(s.reasons.contains(cardLooksSmall), "\(s.reasons)")
            ctx.expect(s.uncertaintyHeightIn > 0.7 && s.uncertaintyHeightIn < 1.2, "height +/- \(s.uncertaintyHeightIn)")
        } else {
            ctx.expect(false, "card 600 px")
        }
        // The reference scene: a 136 px card next to a 35.6 x 59.6 in window is hopeless for a free homography
        let reference = CardCheckScene.reference
        if let s = reference.size(card: reference.card(), window: reference.window) {
            ctx.equal(s.quality, .check)
            ctx.expect(s.reasons.contains(cardLooksSmall), "\(s.reasons)")
            ctx.expect(s.uncertaintyWidthIn > 12 && s.uncertaintyWidthIn < 35, "width +/- \(s.uncertaintyWidthIn)")
            ctx.expect(s.uncertaintyHeightIn > 30 && s.uncertaintyHeightIn < 80, "height +/- \(s.uncertaintyHeightIn)")
            ctx.near(s.widthIn, 35.625, 1e-6)
            ctx.near(s.heightIn, 59.625, 1e-6)
        } else {
            ctx.expect(false, "the reference scene")
        }
        // A tiny card (60 px) in a huge frame: 'check', and it says why
        if let s = at(60) {
            ctx.equal(s.quality, .check)
            ctx.expect(s.reasons.contains(cardLooksSmall), "\(s.reasons)")
            ctx.expect(s.uncertaintyHeightIn > 100, "height +/- \(s.uncertaintyHeightIn)")
        } else {
            ctx.expect(false, "card 60 px")
        }
    },
    Check("CardSizing.size: 'check' with a plain reason when the card or the window corners are wrong") { ctx in
        let scene = CardCheckScene.closeUp(cardPx: 1000)
        let card = scene.card(), window = scene.window
        guard let control = scene.size(card: card, window: window) else {
            ctx.expect(false, "the control scene sizes")
            return
        }
        ctx.equal(control.quality, .good, "control")
        ctx.expect(control.reasons.isEmpty, "control: \(control.reasons)")
        ctx.expect(control.sizeRatio >= CardLimits.minAreaRatio, "control ratio \(control.sizeRatio)")
        var allReasons: [String] = []
        func expectCheck(_ name: String, _ s: CardSize?, has: String, hasNot: [String]) {
            guard let s = s else {
                ctx.expect(false, "\(name): nil")
                return
            }
            ctx.equal(s.quality, .check, name)
            ctx.expect(s.reasons.contains(has), "\(name): \(s.reasons)")
            for other in hasNot { ctx.expect(!s.reasons.contains(other), "\(name): should not say '\(other)'") }
            allReasons += s.reasons
        }
        // The card lies beside the window, not on the glass
        let beside = scene.rectangle(x: scene.windowWIn + 0.3, y: scene.windowHIn - 0.5 - CardLimits.heightIn, w: CardLimits.widthIn, h: CardLimits.heightIn)
        expectCheck("card beside the window", scene.size(card: beside, window: window), has: cardNotOnTheGlass, hasNot: [cardNotABankCard, cardNotARectangle])
        // One window corner tapped 150 px out: not a rectangle in the card's plane
        var skewed = window
        skewed[1] = Vec2(skewed[1].x + 150, skewed[1].y)
        expectCheck("a skewed window", scene.size(card: card, window: skewed), has: cardNotARectangle, hasNot: [cardNotABankCard, cardNotOnTheGlass])
        // Only the corner rule: both top corners 240 px along leave equal sides but corners 5.7 degrees off square
        var leaning = window
        leaning[0].x += 240
        leaning[1].x += 240
        expectCheck("a leaning window", scene.size(card: card, window: leaning), has: cardNotARectangle, hasNot: [cardNotABankCard, cardNotOnTheGlass, cardTooClose])
        // Only the side rule: a window 4% wider at the top, its sides leaning under a degree
        var wider = window
        wider[0].x -= 28.5
        wider[1].x += 28.5
        expectCheck("a window wider at the top", scene.size(card: card, window: wider), has: cardNotARectangle, hasNot: [cardNotABankCard, cardNotOnTheGlass, cardTooClose])
        // Window corners tapped round the card itself
        let c = cardCentre(card)
        let round = card.map { Vec2(c.x + ($0.x - c.x) * 1.5, c.y + ($0.y - c.y) * 1.5) }
        expectCheck("corners round the card", scene.size(card: card, window: round), has: cardTooClose, hasNot: [cardNotABankCard, cardNotOnTheGlass])
        // Four "card" corners that are not a bank card: a square, and a long strip (on a smaller window, so they fit)
        let up = CardCheckScene.closeUp(cardPx: 600)
        let upWindow = up.window
        expectCheck("a square card", up.size(card: up.lowerLeft(w: 2.125, h: 2.125), window: upWindow), has: cardNotABankCard, hasNot: [cardNotOnTheGlass])
        expectCheck("a long strip", up.size(card: up.lowerLeft(w: 4.5, h: 2.125), window: upWindow), has: cardNotABankCard, hasNot: [cardNotOnTheGlass])
        // A card seen at a slant looks a little squarer or longer, and a pixel aspect 20% off is still accepted (1.586 +/- 25%)
        if let s = up.size(card: up.lowerLeft(w: 3.3701 * 0.8, h: 2.1252), window: upWindow) {
            ctx.expect(!s.reasons.contains(cardNotABankCard), "a card with its aspect 20% off: \(s.reasons)")
        } else {
            ctx.expect(false, "foreshortened card")
        }
        // In plain words, for a homeowner
        let jargon = ["homography", "matrix", "sigma", "pixel", " px", "jacobian", "degenerate", "uncertainty"]
        ctx.expect(!allReasons.isEmpty, "some reasons")
        for reason in allReasons + [cardLooksSmall] {
            for word in jargon { ctx.expect(!reason.lowercased().contains(word), "'\(reason)' says '\(word)'") }
            ctx.expect(reason.hasSuffix("."), "'\(reason)' is a sentence")
        }
    },
    Check("CardSizing.size: degenerate input is nil, never a guess") { ctx in
        let scene = CardCheckScene.closeUp(cardPx: 1000)
        let card = scene.card(), window = scene.window
        func size(_ c: [Vec2], _ w: [Vec2], _ imageW: Double = 2250, _ imageH: Double = 3000) -> CardSize? {
            CardSizing.size(cardCorners: c, windowCorners: w, imageWidthPx: imageW, imageHeightPx: imageH)
        }
        ctx.expect(size(card, window) != nil, "control")
        ctx.expect(size([card[0], card[1], card[1], card[3]], window) == nil, "card: two corners the same")
        ctx.expect(size([card[0], card[1], Vec2(2 * card[1].x - card[0].x, 2 * card[1].y - card[0].y), card[3]], window) == nil, "card: three in a line")
        ctx.expect(size(Array(card.prefix(3)), window) == nil, "card: three corners")
        ctx.expect(size([Vec2(.nan, 0)] + card.suffix(3), window) == nil, "card: NaN")
        ctx.expect(size(card, [window[0], window[1], window[2], cardCentre(window)]) == nil, "window: a dart")
        ctx.expect(size(card, window + [window[0]]) == nil, "window: five corners")
        ctx.expect(size(card, [Vec2(.infinity, 0)] + window.suffix(3)) == nil, "window: infinite")
        ctx.expect(size(card, window, 0, 3000) == nil, "no photo width")
        ctx.expect(size(card, window, 2250, -1) == nil, "negative photo height")
        ctx.expect(size(card, window, .nan, 3000) == nil, "photo width NaN")
        // A window corner on the far side of the plane's horizon is no rectangle on that plane: nil
        let trapezoid = [Vec2(1000, 1000), Vec2(1100, 1010), Vec2(1090, 1060), Vec2(1005, 1065)]
        let real = [Vec2(0, 0), Vec2(CardLimits.widthIn, 0), Vec2(CardLimits.widthIn, CardLimits.heightIn), Vec2(0, CardLimits.heightIn)]
        if let api = CardSizing.cardCornersForAPI(trapezoid), let h = Homography.solve(src: api, dst: real), abs(h[6]) > 1e-9 {
            let x = (-1 - h[8] - h[7] * 300) / h[6] // depth w = -1 at (x, 300)
            let across = [Vec2(1200, 300), Vec2(x, 300), Vec2(x, 2700), Vec2(1200, 2700)]
            let depths = (api + across).map { h[6] * $0.x + h[7] * $0.y + h[8] }
            ctx.expect(depths[0] > 0 && depths.suffix(4).contains { $0 < 0 }, "the window reaches past the horizon: \(depths)")
            ctx.expect(CardSizing.orderedQuad(across) != nil, "that window is a fine quad on the photo")
            ctx.expect(size(trapezoid, across) == nil, "past the horizon")
        } else {
            ctx.expect(false, "the foreshortened card has a homography")
        }
    },
    Check("CardLimits: the card is 3.3701 x 2.1252 in and the thresholds are as agreed") { ctx in
        ctx.near(CardLimits.widthIn, 3.3701, 5e-5)
        ctx.near(CardLimits.heightIn, 2.1252, 5e-5)
        ctx.near(CardLimits.aspect, 1.5858, 5e-5)
        ctx.equal(CardLimits.widthMm, 85.60)
        ctx.equal(CardLimits.heightMm, 53.98)
        ctx.equal(CardLimits.mmPerInch, 25.4)
        ctx.equal(CardLimits.checkAboveIn, 0.375)
        ctx.equal(CardLimits.tapSigmaPxAt3000, 2.0)
        ctx.equal(CardLimits.cardCornerSigmaMm, 0.5)
        ctx.equal(CardLimits.maxCornerOffDeg, 4.0, "the same as ArLimits.maxCornerOffDeg")
        ctx.equal(CardLimits.maxSideDiff, 0.03, "the same as ArLimits.maxSideDiff")
        ctx.expect(CardLimits.modelSigma > 0 && CardLimits.modelSigma <= 0.01, "a small model term")
        ctx.equal(CardSize.Quality.good.rawValue, "good")
        ctx.equal(CardSize.Quality.check.rawValue, "check")
    },
]
