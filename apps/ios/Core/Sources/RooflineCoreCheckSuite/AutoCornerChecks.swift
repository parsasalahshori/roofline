import Foundation
import RooflineCore

// Checks for proposing the corners (AutoCorners.swift, ArAutoCorners.swift): which of the shapes Vision finds is the window and which
// is the card, the card's corners as the model takes them, and the image-to-wall mapping the AR side uses.
// Vision itself and the camera are not here (the app's tests run Vision on the drawn sample photo); these are the decisions.

// MARK: - Shapes for the picker

private let photoW = 3024.0
private let photoH = 4032.0

private func quad(_ pts: [(Double, Double)]) -> [Vec2] { pts.map { Vec2($0.0, $0.1) } }

/// A rectangle (x0, y0, x1, y1) as TL, TR, BR, BL.
private func rect(_ x0: Double, _ y0: Double, _ x1: Double, _ y1: Double) -> [Vec2] { quad([(x0, y0), (x1, y0), (x1, y1), (x0, y1)]) }

private func cand(_ q: [Vec2], _ confidence: Double = 1) -> QuadCandidate { QuadCandidate(corners: q, confidence: confidence) }

/// A bank card's outline (sharp corners) with its centre at (cx, cy), `long` px on its long side, turned by `deg`.
private func cardOutline(cx: Double, cy: Double, long: Double, deg: Double = 0, portrait: Bool = false) -> [Vec2] {
    let w = long, h = long * CardLimits.heightMm / CardLimits.widthMm
    let (sx, sy) = portrait ? (h, w) : (w, h)
    let a = deg * .pi / 180
    return [(-sx / 2, -sy / 2), (sx / 2, -sy / 2), (sx / 2, sy / 2), (-sx / 2, sy / 2)].map { (dx, dy) in
        Vec2(cx + dx * cos(a) - dy * sin(a), cy + dx * sin(a) + dy * cos(a))
    }
}

/// What Vision finds in a photo of a window with a card on the glass: the casing, the frame, two panes, the card, a pane-sized
/// shape of the siding, and the photo's own border.
private struct Scene {
    var casing = rect(640, 880, 2380, 3380)
    var frame = rect(760, 1000, 2260, 3260)
    var upper = rect(840, 1080, 2180, 2000)
    var lower = rect(840, 2100, 2180, 3180)
    /// The opening that holds both panes: the inside of the frame.
    var opening = rect(840, 1080, 2180, 3180)
    var card = cardOutline(cx: 1000, cy: 2950, long: 172, deg: -3)
    var border = rect(4, 6, 3020, 4026)
}

private func dist(_ a: Vec2, _ b: Vec2) -> Double { ((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)).squareRoot() }

private func nearQuad(_ ctx: CheckContext, _ a: [Vec2]?, _ b: [Vec2], _ tol: Double, _ what: String, line: UInt = #line) {
    guard let a = a, a.count == 4 else {
        ctx.expect(false, "\(what): nothing found", line: line)
        return
    }
    for i in 0..<4 { ctx.expect(abs(a[i].x - b[i].x) <= tol && abs(a[i].y - b[i].y) <= tol, "\(what) corner \(i): \(a[i]) vs \(b[i])", line: line) }
}

// MARK: - A camera for the AR checks

private let nativeK = CameraIntrinsics(fx: 1400, fy: 1400, cx: 960, cy: 720, width: 1920, height: 1440)

private func windowOnWall(centre: Vec3 = Vec3(0.3, 1.5, -2), width: Double = 0.9, height: Double = 1.5) -> [Vec3] {
    let hw = width / 2, hh = height / 2
    return [Vec3(centre.x - hw, centre.y + hh, centre.z), Vec3(centre.x + hw, centre.y + hh, centre.z),
            Vec3(centre.x + hw, centre.y - hh, centre.z), Vec3(centre.x - hw, centre.y - hh, centre.z)]
}

private let wall = Plane(point: Vec3(0, 0, -2), normal: Vec3(0, 0, 1))!

// MARK: - The checks

let autoCornerChecks: [Check] = [
    Check("AutoCorners: a rectangle seen at an angle is a rectangle; a bowtie, a sliver and a dart are not") { ctx in
        ctx.expect(AutoCorners.rectangleLike(rect(100, 100, 900, 700)) != nil)
        // Perspective: the top narrower than the bottom
        ctx.expect(AutoCorners.rectangleLike(quad([(200, 100), (800, 120), (950, 800), (50, 790)])) != nil)
        // Crossed (a bowtie in this order is the same quad as the tidy order: it is ordered, not refused)
        let bowtie = AutoCorners.rectangleLike(quad([(100, 100), (900, 700), (900, 100), (100, 700)]))
        ctx.equal(bowtie?.count, 4)
        // One corner inside the triangle of the others
        ctx.expect(AutoCorners.rectangleLike(quad([(100, 100), (900, 100), (900, 700), (700, 300)])) == nil)
        // A corner that turns by 30 degrees is no window
        ctx.expect(AutoCorners.rectangleLike(quad([(100, 100), (900, 100), (1300, 700), (500, 700)])) == nil)
        // A trapezoid far wider at one end than the other
        ctx.expect(AutoCorners.rectangleLike(quad([(400, 100), (600, 100), (1000, 700), (0, 700)])) == nil)
        ctx.expect(AutoCorners.rectangleLike(quad([(1, 1), (2, 2)])) == nil)
    },

    Check("AutoCorners.pickWindow: the large outer frame wins over a pane, the card and the photo's border; the casing round it is stepped past") { ctx in
        let s = Scene()
        // The casing is the biggest believable shape, with the frame and the panes inside it: the casing is not the window, the frame
        // inside it is ("the inside of the frame, not the trim")
        let all = [cand(s.border), cand(s.frame), cand(s.upper), cand(s.lower), cand(s.card), cand(s.casing)]
        let picked = AutoCorners.pickWindow(all, imageWidth: photoW, imageHeight: photoH)
        nearQuad(ctx, picked?.corners, s.frame, 0.5, "frame inside the casing")
        // Casing and panes only (the frame's own edge not found): the opening that holds both panes
        nearQuad(ctx, AutoCorners.pickWindow([cand(s.casing), cand(s.upper), cand(s.lower)], imageWidth: photoW, imageHeight: photoH)?.corners, s.opening, 0.5, "panes")
        // With no casing the frame is the outer shape, and its opening (both panes together) is the answer, not one pane
        let noCasing = [cand(s.border), cand(s.frame), cand(s.upper), cand(s.lower), cand(s.card)]
        nearQuad(ctx, AutoCorners.pickWindow(noCasing, imageWidth: photoW, imageHeight: photoH)?.corners, s.opening, 0.5, "opening")
        // Nothing inside the outer shape: it is the window
        nearQuad(ctx, AutoCorners.pickWindow([cand(s.border), cand(s.frame), cand(s.card)], imageWidth: photoW, imageHeight: photoH)?.corners, s.frame, 0.5, "bare frame")
        // Only panes and a card: the biggest pane is smaller than the frame it is in, but it is all there is
        let panes = [cand(s.upper), cand(s.lower), cand(s.card)]
        nearQuad(ctx, AutoCorners.pickWindow(panes, imageWidth: photoW, imageHeight: photoH)?.corners, s.lower, 0.5, "pane")
        // The order the candidates come in does not matter
        nearQuad(ctx, AutoCorners.pickWindow(noCasing.reversed(), imageWidth: photoW, imageHeight: photoH)?.corners, s.opening, 0.5, "reversed")
    },

    Check("AutoCorners.openingInside: a ring of casing is stepped past, a thin edge, a card or a second window is not") { ctx in
        let s = Scene()
        let both = [cand(s.upper), cand(s.lower)]
        nearQuad(ctx, AutoCorners.openingInside(s.frame, candidates: both), s.opening, 0.5, "panes")
        // The same edge found twice (a shape 95% of the outer one) is not a ring
        let twin = rect(645, 885, 2375, 3375)
        ctx.expect(AutoCorners.openingInside(s.casing, candidates: [cand(twin)]) == nil)
        // A card, a latch: too small to be a pane
        ctx.expect(AutoCorners.openingInside(s.frame, candidates: [cand(s.card), cand(rect(1500, 2000, 1700, 2060))]) == nil)
        // Two small shapes far apart do not make an opening of the outer shape (they fill under 55% of it)
        let a = rect(800, 1050, 1300, 1550), b = rect(1700, 2600, 2200, 3100)
        ctx.expect(AutoCorners.openingInside(s.frame, candidates: [cand(a), cand(b)]) == nil)
        // Shapes outside the outer one do not count
        ctx.expect(AutoCorners.openingInside(s.upper, candidates: [cand(s.frame), cand(s.lower)]) == nil)
        // Low confidence does not count
        ctx.expect(AutoCorners.openingInside(s.frame, candidates: [cand(s.upper, 0.2), cand(s.lower, 0.2)]) == nil)
        // With the card known, the opening must hold it; so must the aimed-at point
        ctx.expect(AutoCorners.openingInside(s.frame, candidates: both, card: s.card) != nil)
        ctx.expect(AutoCorners.openingInside(s.frame, candidates: both, card: cardOutline(cx: 790, cy: 1020, long: 60)) == nil)
        ctx.expect(AutoCorners.openingInside(s.frame, candidates: both, aimedAt: Vec2(1500, 2000)) != nil)
        ctx.expect(AutoCorners.openingInside(s.frame, candidates: both, aimedAt: Vec2(300, 300)) == nil)
    },

    Check("AutoCorners.pickWindow: nothing believable gives nothing") { ctx in
        let s = Scene()
        // Only the photo's own border, the card, and a shape of the photo's size
        ctx.expect(AutoCorners.pickWindow([cand(s.border), cand(s.card), cand(rect(0, 0, 3024, 4032))], imageWidth: photoW, imageHeight: photoH) == nil)
        // Low confidence is not good confidence
        ctx.expect(AutoCorners.pickWindow([cand(s.frame, 0.3)], imageWidth: photoW, imageHeight: photoH) == nil)
        ctx.expect(AutoCorners.pickWindow([cand(s.frame, AutoCorners.minConfidence - 0.01)], imageWidth: photoW, imageHeight: photoH) == nil)
        ctx.expect(AutoCorners.pickWindow([cand(s.frame, AutoCorners.minConfidence)], imageWidth: photoW, imageHeight: photoH) != nil)
        // Too small, too thin
        ctx.expect(AutoCorners.pickWindow([cand(rect(1000, 1000, 1300, 1300))], imageWidth: photoW, imageHeight: photoH) == nil)
        ctx.expect(AutoCorners.pickWindow([cand(rect(200, 1000, 2800, 1300))], imageWidth: photoW, imageHeight: photoH) == nil)
        ctx.expect(AutoCorners.pickWindow([], imageWidth: photoW, imageHeight: photoH) == nil)
        ctx.expect(AutoCorners.pickWindow([cand(s.frame)], imageWidth: 0, imageHeight: 0) == nil)
        // A shape hugging three edges of the photo (a wall seen edge to edge) is the picture's border
        ctx.expect(AutoCorners.pickWindow([cand(rect(10, 10, 3010, 2500))], imageWidth: photoW, imageHeight: photoH) == nil)
        // But a big window with room round it is fine
        ctx.expect(AutoCorners.pickWindow([cand(rect(300, 400, 2700, 3600))], imageWidth: photoW, imageHeight: photoH) != nil)
    },

    Check("AutoCorners.pickWindow: with a point aimed at, the window that holds it (the AR reticle), not a bigger one beside it") { ctx in
        let left = rect(100, 600, 1300, 3000)
        let right = rect(1500, 400, 2900, 3600)
        let all = [cand(left), cand(right)]
        // Without an aim the bigger one
        nearQuad(ctx, AutoCorners.pickWindow(all, imageWidth: photoW, imageHeight: photoH)?.corners, right, 0.5, "bigger")
        nearQuad(ctx, AutoCorners.pickWindow(all, imageWidth: photoW, imageHeight: photoH, aimedAt: Vec2(700, 1800))?.corners, left, 0.5, "aimed left")
        nearQuad(ctx, AutoCorners.pickWindow(all, imageWidth: photoW, imageHeight: photoH, aimedAt: Vec2(2200, 1800))?.corners, right, 0.5, "aimed right")
        // On a frame's edge counts as on it; far outside does not
        ctx.expect(AutoCorners.pickWindow(all, imageWidth: photoW, imageHeight: photoH, aimedAt: Vec2(1320, 1800)) != nil)
        ctx.expect(AutoCorners.pickWindow([cand(left)], imageWidth: photoW, imageHeight: photoH, aimedAt: Vec2(2000, 1800)) == nil)
        // Aimed at the middle of nothing: no window
        ctx.expect(AutoCorners.pickWindow([cand(left), cand(rect(1500, 400, 2900, 700))], imageWidth: photoW, imageHeight: photoH, aimedAt: Vec2(1400, 3500)) == nil)
    },

    Check("AutoCorners.pickCard: the card-shaped shape inside the window, either way round, and not a pane or a sliver") { ctx in
        let s = Scene()
        let all = [cand(s.border), cand(s.frame), cand(s.upper), cand(s.lower), cand(s.card), cand(s.casing)]
        nearQuad(ctx, AutoCorners.pickCard(all, imageWidth: photoW, imageHeight: photoH)?.corners, CardSizing.orderedQuad(s.card)!, 0.5, "card")
        // A portrait card
        let portrait = cardOutline(cx: 1000, cy: 2950, long: 172, deg: 4, portrait: true)
        nearQuad(ctx, AutoCorners.pickCard([cand(s.frame), cand(portrait)], imageWidth: photoW, imageHeight: photoH)?.corners, CardSizing.orderedQuad(portrait)!, 0.5, "portrait")
        // A pane's proportion is not a card's, nor is a square, nor a shape as big as a pane
        ctx.expect(AutoCorners.pickCard([cand(rect(1000, 2900, 1172, 3072))], imageWidth: photoW, imageHeight: photoH) == nil)
        ctx.expect(AutoCorners.pickCard([cand(s.upper)], imageWidth: photoW, imageHeight: photoH) == nil)
        // Too small to be tapped by anyone (the server's floor is 0.75% of the photo's long side, about 30 px here)
        ctx.expect(AutoCorners.pickCard([cand(cardOutline(cx: 1000, cy: 2950, long: 30))], imageWidth: photoW, imageHeight: photoH) == nil)
        // Given a window, a card-shaped shape outside it is not the card
        let outside = cardOutline(cx: 300, cy: 500, long: 172)
        ctx.expect(AutoCorners.pickCard([cand(outside)], imageWidth: photoW, imageHeight: photoH, window: s.frame) == nil)
        ctx.expect(AutoCorners.pickCard([cand(outside)], imageWidth: photoW, imageHeight: photoH) != nil)
        // Of two card-shaped shapes, the one in the card's proportion
        let good = cardOutline(cx: 1000, cy: 2950, long: 172)
        let bad = rect(1500, 2900, 1700, 3030) // 200 x 130 = 1.54, still card-like but 0.05 off
        let ranked = AutoCorners.rankedCards([cand(bad), cand(good)], imageWidth: photoW, imageHeight: photoH)
        ctx.equal(ranked.count, 2)
        nearQuad(ctx, ranked.first?.corners, CardSizing.orderedQuad(good)!, 0.5, "ranked first")
    },

    Check("AutoCorners.propose: window and card together, and the same photo as taps would") { ctx in
        let s = Scene()
        let p = AutoCorners.propose([cand(s.border), cand(s.upper), cand(s.card), cand(s.frame), cand(s.lower), cand(s.casing)], imageWidth: photoW, imageHeight: photoH)
        nearQuad(ctx, p.window?.corners, s.frame, 0.5, "window")
        nearQuad(ctx, p.card?.corners, CardSizing.orderedQuad(s.card)!, 0.5, "card")
        ctx.expect(!p.isEmpty)
        // The proposed corners are ones the card model takes: no problem to show, a size comes out
        let taps = p.cardTaps!
        let cardForApi = CardSizing.cardCornersForAPI(taps)!
        let window = CardSizing.orderedQuad(p.window!.corners)!
        ctx.expect(CardSizing.problem(cardCorners: cardForApi, windowCorners: window, imageWidthPx: photoW, imageHeightPx: photoH) == nil)
        ctx.expect(CardSizing.size(cardCorners: cardForApi, windowCorners: window, imageWidthPx: photoW, imageHeightPx: photoH) != nil)
        // A card with no window round it is not offered (a card-shaped shape on its own is not a card on a window)...
        let lonely = AutoCorners.propose([cand(s.card)], imageWidth: photoW, imageHeight: photoH)
        ctx.expect(lonely.isEmpty)
        // ...and a window with no card is offered alone: the card screen taps, the window screen has its corners
        let windowOnly = AutoCorners.propose([cand(s.frame), cand(s.upper), cand(s.lower)], imageWidth: photoW, imageHeight: photoH)
        nearQuad(ctx, windowOnly.window?.corners, s.opening, 0.5, "window only")
        ctx.expect(windowOnly.card == nil)
        // Nothing found: nothing proposed (the screens carry on with taps)
        ctx.expect(AutoCorners.propose([], imageWidth: photoW, imageHeight: photoH).isEmpty)
        ctx.expect(AutoCorners.propose([cand(s.frame, 0.2), cand(s.card, 0.2)], imageWidth: photoW, imageHeight: photoH).isEmpty)
    },

    Check("AutoCorners.propose: a card-sized pane does not hide the real window; a card outside any window is not the card") { ctx in
        // A small window whose pane has a card's proportion: the pane is not a card (it is not a few percent of any window), and
        // the window is still found
        let frame = rect(1000, 1500, 2100, 2200)
        let pane = rect(1100, 1560, 2000, 2140)
        let p = AutoCorners.propose([cand(frame), cand(pane)], imageWidth: photoW, imageHeight: photoH)
        nearQuad(ctx, p.window?.corners, pane, 0.5, "window with a card-shaped pane: the opening inside the frame")
        ctx.expect(p.card == nil)
        // Two big shapes, the card inside only one of them: that one is the window
        let other = rect(300, 100, 2900, 800)
        let s = Scene()
        let q = AutoCorners.propose([cand(other), cand(s.frame), cand(s.card)], imageWidth: photoW, imageHeight: photoH)
        nearQuad(ctx, q.window?.corners, s.frame, 0.5, "the one that holds the card")
    },

    Check("AutoCorners.cardTapCorners: the tips of the rounded corners are inside the outline by the model's inset") { ctx in
        let sharp = cardOutline(cx: 1500, cy: 2000, long: 856, deg: 0)
        let taps = AutoCorners.cardTapCorners(sharp)
        ctx.equal(taps.count, 4)
        let across = dist(taps[0], taps[1]), down = dist(taps[0], taps[3])
        // 83.74 : 85.60 and 52.12 : 53.98 (CardLimits.tapRectWidthMm / tapRectHeightMm)
        ctx.near(across / 856, CardLimits.tapRectWidthMm / CardLimits.widthMm, 1e-9)
        ctx.near(down / (856 * CardLimits.heightMm / CardLimits.widthMm), CardLimits.tapRectHeightMm / CardLimits.heightMm, 1e-9)
        // Still centred on the same place, and the same shape order (TL first)
        let c0 = AutoCorners.centroid(sharp), c1 = AutoCorners.centroid(taps)
        ctx.near(c1.x, c0.x, 1e-9)
        ctx.near(c1.y, c0.y, 1e-9)
        ctx.expect(taps[0].x < taps[1].x && taps[0].y < taps[3].y)
        // A portrait card and a turned one are cut the same way round (the LONG side loses the smaller share)
        let portrait = AutoCorners.cardTapCorners(cardOutline(cx: 1500, cy: 2000, long: 856, deg: 0, portrait: true))
        let pAcross = dist(portrait[0], portrait[1]), pDown = dist(portrait[0], portrait[3])
        ctx.near(pDown / 856, CardLimits.tapRectWidthMm / CardLimits.widthMm, 1e-9)
        ctx.near(pAcross / (856 * CardLimits.heightMm / CardLimits.widthMm), CardLimits.tapRectHeightMm / CardLimits.heightMm, 1e-9)
        let turned = AutoCorners.cardTapCorners(cardOutline(cx: 1500, cy: 2000, long: 856, deg: 30))
        ctx.near(dist(turned[0], turned[1]) / 856, CardLimits.tapRectWidthMm / CardLimits.widthMm, 1e-9)
        // Not four points: given back as they were
        ctx.equal(AutoCorners.cardTapCorners([Vec2(1, 1)]).count, 1)
        // Where a person who taps the tips puts the four taps: the card's centre, 83.74 x 52.12 mm
        let sx = 856 * CardLimits.tapRectWidthMm / CardLimits.widthMm, sy = 856 * CardLimits.tapRectHeightMm / CardLimits.widthMm
        let handTapped = [Vec2(1500 - sx / 2, 2000 - sy / 2), Vec2(1500 + sx / 2, 2000 - sy / 2), Vec2(1500 + sx / 2, 2000 + sy / 2), Vec2(1500 - sx / 2, 2000 + sy / 2)]
        for i in 0..<4 {
            ctx.near(taps[i].x, handTapped[i].x, 1e-6)
            ctx.near(taps[i].y, handTapped[i].y, 1e-6)
        }
    },

    Check("AutoCorners.refineCard: the same card from a closer look replaces the first outline, a different shape does not") { ctx in
        let first = PickedQuad(corners: CardSizing.orderedQuad(cardOutline(cx: 1000, cy: 2950, long: 172, deg: -3))!, confidence: 1)
        let closer = CardSizing.orderedQuad(cardOutline(cx: 1001.2, cy: 2949.1, long: 171.1, deg: -3.2))!
        let refined = AutoCorners.refineCard(first: first, candidates: [cand(rect(0, 0, 2000, 3000)), cand(closer)])
        nearQuad(ctx, refined?.corners, closer, 1e-9, "refined")
        // The first look was too big (a shadow round the card): the tighter outline inside it still replaces it
        let loose = PickedQuad(corners: CardSizing.orderedQuad(cardOutline(cx: 1000, cy: 2950, long: 216, deg: -3))!, confidence: 1)
        nearQuad(ctx, AutoCorners.refineCard(first: loose, candidates: [cand(closer)])?.corners, closer, 1e-9, "tighter")
        // Of two shapes in the crop, the one in a card's proportion (not the chip on it, not a sliver)
        let chip = cardOutline(cx: 960, cy: 2930, long: 40)
        nearQuad(ctx, AutoCorners.refineCard(first: loose, candidates: [cand(chip), cand(closer)])?.corners, closer, 1e-9, "not the chip")
        // A shape of another size (the whole crop) or somewhere else is not the card
        ctx.expect(AutoCorners.refineCard(first: first, candidates: [cand(cardOutline(cx: 1000, cy: 2950, long: 300))]) == nil)
        ctx.expect(AutoCorners.refineCard(first: first, candidates: [cand(cardOutline(cx: 1500, cy: 2950, long: 172))]) == nil)
        ctx.expect(AutoCorners.refineCard(first: first, candidates: []) == nil)
    },

    Check("ImageMapping: portrait and native pixels turn into each other; a ray through a pixel runs back to the same pixel") { ctx in
        let native = Vec2(400, 300)
        let portrait = ImageMapping.nativeToPortrait(native, nativeWidth: 1920, nativeHeight: 1440)
        let back = ImageMapping.portraitToNative(portrait, nativeWidth: 1920, nativeHeight: 1440)
        ctx.near(back.x, native.x, 1e-12)
        ctx.near(back.y, native.y, 1e-12)
        for p in [Vec2(0, 0), Vec2(1919, 1439), Vec2(960, 720), Vec2(17, 1200)] {
            let q = ImageMapping.portraitToNative(ImageMapping.nativeToPortrait(p, nativeWidth: 1920, nativeHeight: 1440), nativeWidth: 1920, nativeHeight: 1440)
            ctx.near(q.x, p.x, 1e-12)
            ctx.near(q.y, p.y, 1e-12)
        }
        let cam = camera(at: Vec3(0.2, 1.4, 0), looking: Vec3(0.1, 0, -1))
        guard let r = ImageMapping.ray(throughNativePixel: Vec2(1300, 500), cameraTransform: cam, intrinsics: nativeK) else {
            ctx.expect(false, "no ray")
            return
        }
        ctx.near(r.direction.length, 1, 1e-12)
        let point = r.origin + r.direction * 3
        let px = ImageMapping.project(point, cameraTransform: cam, intrinsics: nativeK)
        ctx.near(px?.x, 1300, 1e-6)
        ctx.near(px?.y, 500, 1e-6)
    },

    Check("ArAutoCorners.worldQuad: the four corners of a window seen by a camera come back onto the wall") { ctx in
        let truth = windowOnWall()
        for (position, forward) in [(Vec3(0, 1.5, 0), Vec3(0, 0, -1)), (Vec3(-0.6, 1.3, 0.4), Vec3(0.35, 0.05, -1)), (Vec3(0.9, 1.8, 0.2), Vec3(-0.25, -0.12, -1))] {
            let cam = camera(at: position, looking: forward)
            // What the detector would report: the corners in the UPRIGHT image, turned back to native for the rays
            let native = truth.compactMap { ImageMapping.project($0, cameraTransform: cam, intrinsics: nativeK) }
            ctx.equal(native.count, 4)
            let viaPortrait = native.map {
                ImageMapping.portraitToNative(ImageMapping.nativeToPortrait($0, nativeWidth: 1920, nativeHeight: 1440), nativeWidth: 1920, nativeHeight: 1440)
            }
            let world = ArAutoCorners.worldQuad(nativePx: viaPortrait, cameraTransform: cam, intrinsics: nativeK, planes: Array(repeating: wall, count: 4))
            ctx.equal(world?.count, 4)
            for i in 0..<4 { ctx.near(world?[i].distance(to: truth[i]), 0, 1e-9, "corner \(i)") }
        }
        // The corners are on a frame that stands 4 cm proud of the wall: the ray meets THAT plane
        let proud = wall.offset(by: 0.04)
        let cam = camera(at: Vec3(0, 1.5, 0), looking: Vec3(0, 0, -1))
        let onFrame = windowOnWall(centre: Vec3(0.3, 1.5, -1.96))
        let px = onFrame.compactMap { ImageMapping.project($0, cameraTransform: cam, intrinsics: nativeK) }
        let w2 = ArAutoCorners.worldQuad(nativePx: px, cameraTransform: cam, intrinsics: nativeK, planes: Array(repeating: proud, count: 4))
        for i in 0..<4 { ctx.near(w2?[i].distance(to: onFrame[i]), 0, 1e-9, "proud corner \(i)") }
        // On the wall plane instead, the same pixels land a little wider: the plane matters
        let w3 = ArAutoCorners.worldQuad(nativePx: px, cameraTransform: cam, intrinsics: nativeK, planes: Array(repeating: wall, count: 4))
        ctx.expect((w3?[0].distance(to: w3?[1] ?? .zero) ?? 0) > onFrame[0].distance(to: onFrame[1]))
        // A plane behind the camera, a plane the rays run along, and the wrong number of corners: nothing
        let behind = Plane(point: Vec3(0, 0, 2), normal: Vec3(0, 0, -1))!
        ctx.expect(ArAutoCorners.worldQuad(nativePx: px, cameraTransform: cam, intrinsics: nativeK, planes: Array(repeating: behind, count: 4)) == nil)
        ctx.expect(ArAutoCorners.worldQuad(nativePx: [Vec2(960, 720), Vec2(961, 720), Vec2(961, 721), Vec2(960, 721)], cameraTransform: cam, intrinsics: nativeK, planes: Array(repeating: Plane(point: Vec3(0, 1.5, 0), normal: Vec3(0, 1, 0))!, count: 4)) == nil)
        ctx.expect(ArAutoCorners.worldQuad(nativePx: Array(px.prefix(3)), cameraTransform: cam, intrinsics: nativeK, planes: Array(repeating: wall, count: 4)) == nil)
    },

    Check("ArAutoCorners.isPlausibleWindow: a window on a wall, not a sliver, a wall, or a shape that is not a rectangle") { ctx in
        ctx.expect(ArAutoCorners.isPlausibleWindow(windowOnWall()))
        ctx.expect(ArAutoCorners.isPlausibleWindow(windowOnWall(width: 0.4, height: 0.3)))
        ctx.expect(!ArAutoCorners.isPlausibleWindow(windowOnWall(width: 0.1, height: 0.3)))
        ctx.expect(!ArAutoCorners.isPlausibleWindow(windowOnWall(width: 6, height: 2.5)))
        var skewed = windowOnWall()
        skewed[1] = skewed[1] + Vec3(0.3, 0, 0)
        ctx.expect(!ArAutoCorners.isPlausibleWindow(skewed))
        var wedge = windowOnWall()
        wedge[0] = wedge[0] + Vec3(0.3, 0, 0)
        wedge[3] = wedge[3] - Vec3(0.3, 0, 0)
        ctx.expect(!ArAutoCorners.isPlausibleWindow(wedge))
        var tilt = windowOnWall()
        tilt[2] = tilt[2] + Vec3(0.25, 0.25, 0)
        ctx.expect(!ArAutoCorners.isPlausibleWindow(tilt))
        ctx.expect(!ArAutoCorners.isPlausibleWindow(Array(windowOnWall().prefix(3))))
        ctx.expect(!ArAutoCorners.isPlausibleWindow([Vec3(.nan, 0, 0)] + windowOnWall().suffix(3)))
        let size = ArAutoCorners.sizeInches(windowOnWall(width: 0.9144, height: 1.5))
        ctx.near(size?.widthIn, 36, 1e-6)
        ctx.near(size?.heightIn, 1.5 * inchesPerMetre, 1e-9)
    },

    Check("Proposed corners go through CornerCapture like taps: the same four points, ordered by gravity, and the wall check still runs") { ctx in
        let truth = windowOnWall(width: 0.9144, height: 1.5)
        let cam = camera(at: Vec3(0, 1.5, 0), looking: Vec3(0, 0, -1))
        let native = truth.compactMap { ImageMapping.project($0, cameraTransform: cam, intrinsics: nativeK) }
        let world = ArAutoCorners.worldQuad(nativePx: native, cameraTransform: cam, intrinsics: nativeK, planes: Array(repeating: wall, count: 4))!
        let offered = world
        var capture = CornerCapture()
        capture.setTracking(normal: true)
        capture.setWallPlane(wall, viewer: Vec3(0, 1.5, 0))
        ctx.expect(capture.canPlaceNext(aimed: true, sampling: false))
        let spreads = [Double](repeating: 0.004, count: 4)
        // Depth points on the wall around each corner (the off-wall check passes)
        for i in 0..<4 {
            let near = (0..<8).map { k in offered[i] + Vec3(0.002 * Double(k % 3), 0.002 * Double(k % 2), 0) }
            ctx.equal(capture.place(CornerEstimate(point: offered[i], spreadM: spreads[i], used: 2, rejected: 0), depthPoints: near), .placed(index: i))
        }
        ctx.expect(capture.isComplete)
        let f = capture.finished(viewer: Vec3(0, 1.5, 0))
        ctx.expect(f != nil)
        // The same corners as taps would give: TL, TR, BR, BL, 36 x 59 1/16 in
        for i in 0..<4 { ctx.near(f?.pointsM[i].distance(to: truth[i]), 0, 1e-9, "corner \(i)") }
        ctx.expect(f?.usedWallPlane == true)
        let size = ArAutoCorners.sizeInches(f?.pointsM ?? [])
        ctx.near(size?.widthIn, 36, 1e-6)
        // The wall check refuses a proposal whose corners are on glass 20 cm behind the wall
        var refused = CornerCapture()
        refused.setTracking(normal: true)
        refused.setWallPlane(wall, viewer: Vec3(0, 1.5, 0))
        let deep = (0..<10).map { _ in offered[0] + Vec3(0, 0, -0.2) }
        if case .offWall = refused.place(CornerEstimate(point: offered[0], spreadM: 0.004, used: 2, rejected: 0), depthPoints: deep) {} else { ctx.expect(false, "expected offWall") }
        // No wall plane yet: a proposal cannot be placed (the same rule as for taps)
        var noWall = CornerCapture()
        noWall.setTracking(normal: true)
        ctx.expect(!noWall.canPlaceNext(aimed: true, sampling: false))
    },
]
