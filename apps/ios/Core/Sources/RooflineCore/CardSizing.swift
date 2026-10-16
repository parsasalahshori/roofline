import Foundation

// Sizing a window from ONE photo with a standard bank card lying flat on the glass (the "card" scale).
//
// The card is just a reference rectangle of known size, exactly like the sheet of printer paper in the server's
// packages/shared/src/window-photo-math.ts (homography, applyHomography, quadSize, sizeFromReference): the homography
// from the card's four photo corners to its real rectangle maps the window frame's four corners into inches. This file
// is the phone's live preview of that; the server recomputes the real size from the same data. Keep the two in step.
// The uncertainty is this app's own: first-order propagation of the corner taps through the whole pipeline.
//
// Points are photo pixels, x right, y DOWN. Quads are ordered top-left, top-right, bottom-right, bottom-left.

/// Thresholds and noise for the bank-card scale. The noise numbers are UNCALIBRATED until the field test (tape-measured
/// windows, real taps on real phones); the sanity thresholds are the same as ArLimits so a card and an AR size agree on
/// what a clean rectangle is.
public enum CardLimits {
    /// ISO/IEC 7810 ID-1 bank card, millimetres.
    public static let widthMm = 85.60
    public static let heightMm = 53.98
    public static let mmPerInch = 25.4
    /// The card in inches: 3.3701 x 2.1252.
    public static let widthIn = widthMm / mmPerInch
    public static let heightIn = heightMm / mmPerInch
    /// Long side over short side of a real card (1.586).
    public static let aspect = widthMm / heightMm
    /// The card quad's long/short pixel sides may differ from `aspect` by this share (a card seen at a slant looks a
    /// little squarer or longer than it is).
    public static let aspectTolerance = 0.25

    /// 'check' above this uncertainty, inches (3/8 in).
    public static let checkAboveIn = 0.375

    /// Tap noise per corner, photo pixels, 1 sigma, for a photo whose long side is 3000 px (scaled by long side / 3000).
    /// UNCALIBRATED until the field test.
    public static let tapSigmaPxAt3000 = 2.0
    /// A real card's rounded corners make the visual corner ambiguous: extra 1 sigma per CARD corner, millimetres
    /// (converted to pixels with the card's own scale).
    public static let cardCornerSigmaMm = 0.5
    /// What the corner taps cannot explain, as a share of each length (1 sigma): lens distortion the phone left in the
    /// photo, and a frame that sits a little proud of the glass (its inside edge is nearer the camera than the card,
    /// so it looks up to about 1% bigger). Added in quadrature, so the answer is never more certain than this.
    /// UNCALIBRATED until the field test.
    public static let modelSigma = 0.005

    /// A corner further than this off square (degrees) in the card's plane: 'check' (ArLimits.maxCornerOffDeg).
    public static let maxCornerOffDeg = 4.0
    /// Opposite sides differing by more than this share of their mean: 'check' (ArLimits.maxSideDiff).
    /// Both were set for AR points (millimetres of noise). They are tight for a card: the model's own tap noise on a small
    /// card skews the rectified window past them in most trials (see the calibration notes in CardChecks.swift).
    public static let maxSideDiff = 0.03
    /// The window quad must cover at least this many times the card quad's area, else the corners were tapped on or
    /// near the card.
    public static let minAreaRatio = 4.0

    /// Central-difference step for the uncertainty, photo pixels.
    public static let jacobianStepPx = 0.25
    /// Two taps closer than this (pixels) are the same tap.
    public static let minPointGapPx = 1.0
    /// A quadrilateral whose corner turns by less than this sine (about 3 degrees) is flat, not a quad.
    public static let minTurnSine = 0.05
}

/// A size in inches from a reference rectangle, as the server's sizeFromReference returns it.
public struct ReferenceSize: Equatable, Sendable {
    public var widthIn: Double
    public var heightIn: Double

    public init(widthIn: Double, heightIn: Double) {
        self.widthIn = widthIn
        self.heightIn = heightIn
    }
}

public struct CardSize: Equatable, Sendable {
    public var widthIn: Double
    public var heightIn: Double
    /// About 1 sigma, inches, per dimension.
    public var uncertaintyWidthIn: Double
    public var uncertaintyHeightIn: Double
    public var quality: Quality
    /// Why 'check', in plain homeowner words (empty when 'good').
    public var reasons: [String]
    /// Window size as the pixel ratio of window-quad area to card-quad area (how far the scale was extrapolated).
    public var sizeRatio: Double

    public enum Quality: String, Codable, Sendable {
        case good
        case check
    }

    public init(widthIn: Double, heightIn: Double, uncertaintyWidthIn: Double, uncertaintyHeightIn: Double, quality: Quality, reasons: [String], sizeRatio: Double) {
        self.widthIn = widthIn
        self.heightIn = heightIn
        self.uncertaintyWidthIn = uncertaintyWidthIn
        self.uncertaintyHeightIn = uncertaintyHeightIn
        self.quality = quality
        self.reasons = reasons
        self.sizeRatio = sizeRatio
    }
}

// MARK: - The server's math (window-photo-math.ts), line for line

/// The homography the server's `homography(src, dst)` computes: direct linear transform with h33 = 1, an 8 x 8 system
/// solved by Gaussian elimination with partial pivoting (the same operations in the same order, so the numbers match
/// the TypeScript to the last digits).
public enum Homography {
    /// 3x3 homography, row-major, mapping `src` -> `dst` (four points each). Nil when the 8 x 8 system is singular (two
    /// corners the same, four in a line), when there are not four points each, or when a coordinate is not finite. Like the
    /// server's, it does not always notice three corners in a line: that can come back as a rank-deficient matrix, which
    /// is why CardSizing.orderedQuad refuses such taps first.
    public static func solve(src: [Vec2], dst: [Vec2]) -> [Double]? {
        guard src.count == 4, dst.count == 4, (src + dst).allSatisfy({ $0.x.isFinite && $0.y.isFinite }) else { return nil }
        var a: [[Double]] = []
        var b: [Double] = []
        for i in 0..<4 {
            let x = src[i].x, y = src[i].y
            let u = dst[i].x, v = dst[i].y
            a.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
            b.append(u)
            a.append([0, 0, 0, x, y, 1, -v * x, -v * y])
            b.append(v)
        }
        guard let h = gaussSolve(a, b) else { return nil }
        return h + [1]
    }

    /// The point `p` through the homography `h` (nine numbers, row-major): the server's `applyHomography`. A point on
    /// the plane's line at infinity comes back infinite or NaN, as in JavaScript.
    public static func apply(_ h: [Double], _ p: Vec2) -> Vec2 {
        guard h.count == 9 else { return Vec2(.nan, .nan) }
        let w = h[6] * p.x + h[7] * p.y + h[8]
        return Vec2((h[0] * p.x + h[1] * p.y + h[2]) / w, (h[3] * p.x + h[4] * p.y + h[5]) / w)
    }

    /// Gaussian elimination with partial pivoting. Nil for a singular system.
    private static func gaussSolve(_ a: [[Double]], _ b: [Double]) -> [Double]? {
        let n = b.count
        var m = (0..<n).map { a[$0] + [b[$0]] }
        for c in 0..<n {
            var p = c
            for r in (c + 1)..<n where abs(m[r][c]) > abs(m[p][c]) { p = r }
            if abs(m[p][c]) < 1e-12 { return nil }
            m.swapAt(c, p)
            for r in 0..<n where r != c {
                let f = m[r][c] / m[c][c]
                for k in c...n { m[r][k] -= f * m[c][k] }
            }
        }
        return (0..<n).map { m[$0][n] / m[$0][$0] }
    }
}

/// Width and height of a quad that is already in inches: the mean of opposite sides (the server's `quadSize`).
/// `q` is TL, TR, BR, BL (anything else gives NaN).
public func quadSize(_ q: [Vec2]) -> ReferenceSize {
    guard q.count == 4 else { return ReferenceSize(widthIn: .nan, heightIn: .nan) }
    return ReferenceSize(
        widthIn: (cardDistance(q[0], q[1]) + cardDistance(q[3], q[2])) / 2,
        heightIn: (cardDistance(q[0], q[3]) + cardDistance(q[1], q[2])) / 2
    )
}

/// The window's size in inches from a reference rectangle of known size lying in the same plane (a sheet of paper taped
/// to the glass, or a bank card on it): a port of the server's `sizeFromReference`. Both quads are TL, TR, BR, BL in
/// photo pixels. Nil when the reference corners are degenerate.
public func sizeFromReference(windowQuad: [Vec2], referenceQuad: [Vec2], refWidthIn: Double, refHeightIn: Double) -> ReferenceSize? {
    guard windowQuad.count == 4 else { return nil }
    let real = [Vec2(0, 0), Vec2(refWidthIn, 0), Vec2(refWidthIn, refHeightIn), Vec2(0, refHeightIn)]
    guard let h = Homography.solve(src: referenceQuad, dst: real) else { return nil }
    return quadSize(windowQuad.map { Homography.apply(h, $0) })
}

// MARK: - Bank-card sizing

public enum CardSizing {
    // MARK: Corner order

    /// The four photo points as TL, TR, BR, BL (clockwise on screen, y down), whatever order they were tapped. Nil unless
    /// four finite points forming a convex, non-degenerate quadrilateral.
    ///
    /// Four points in convex position make exactly one quadrilateral, so a tap order that crosses itself (a bowtie in the
    /// order tapped) is the same quad as the tidy order and gives the same answer; what returns nil is a point set that
    /// is not a quad at all: two points on top of each other, three in (nearly) a line, or one point inside the triangle
    /// of the others (a dart). The corners are put in clockwise order around their centre; the top edge is the clockwise
    /// edge that points most to the right (windows are photographed upright), and its left end is TL.
    public static func orderedQuad(_ points: [Vec2]) -> [Vec2]? {
        guard points.count == 4, points.allSatisfy({ $0.x.isFinite && $0.y.isFinite }) else { return nil }
        for i in 0..<4 {
            for j in (i + 1)..<4 where cardDistance(points[i], points[j]) < CardLimits.minPointGapPx { return nil }
        }
        let cx = points.reduce(0) { $0 + $1.x } / 4
        let cy = points.reduce(0) { $0 + $1.y } / 4
        // Angle grows from +x towards +y, which is clockwise on a screen whose y points down
        let around = points.sorted { atan2($0.y - cy, $0.x - cx) < atan2($1.y - cy, $1.x - cx) }
        // Convex and not flat: every corner turns the same way (positive cross, y down) by at least minTurnSine
        for i in 0..<4 {
            let e1 = cardSub(around[(i + 1) % 4], around[i])
            let e2 = cardSub(around[(i + 2) % 4], around[(i + 1) % 4])
            let l = cardLength(e1) * cardLength(e2)
            guard l > 0, cardCross(e1, e2) / l > CardLimits.minTurnSine else { return nil }
        }
        // The top edge: the clockwise edge pointing most to the right. Ties (a window turned exactly 45 degrees) go to
        // the higher, then the lefter start, so the answer never depends on where the sort began.
        func score(_ k: Int) -> Double {
            let e = cardSub(around[(k + 1) % 4], around[k])
            return e.x / cardLength(e)
        }
        var best = 0
        for k in 1..<4 {
            let d = score(k) - score(best)
            let a = around[k], b = around[best]
            if d > 1e-9 || (abs(d) <= 1e-9 && (a.y < b.y || (a.y == b.y && a.x < b.x))) { best = k }
        }
        return (0..<4).map { around[(best + $0) % 4] }
    }

    /// The card's four corners in the order the API wants: TL, TR, BR, BL of a LANDSCAPE card, i.e. edge 0->1 is the long
    /// (85.60 mm) side. If the card lies portrait in the photo (its long side more vertical), the labelling is rotated by a
    /// quarter turn (clockwise order is kept). Nil when `orderedQuad` is nil.
    ///
    /// Portrait means the left and right sides are longer than the top and bottom, on average (a card lying at a tilt is
    /// judged by its sides in the photo, not by the photo's axes).
    public static func cardCornersForAPI(_ points: [Vec2]) -> [Vec2]? {
        guard let q = orderedQuad(points) else { return nil }
        let across = (cardDistance(q[0], q[1]) + cardDistance(q[3], q[2])) / 2
        let down = (cardDistance(q[0], q[3]) + cardDistance(q[1], q[2])) / 2
        return down > across ? [q[1], q[2], q[3], q[0]] : q
    }

    // MARK: Noise

    /// One tap's noise, photo pixels, 1 sigma: `tapSigmaPxAt3000` scaled by the photo's long side over 3000.
    public static func tapSigmaPx(imageWidthPx: Double, imageHeightPx: Double) -> Double {
        CardLimits.tapSigmaPxAt3000 * max(imageWidthPx, imageHeightPx) / 3000
    }

    /// The 1-sigma noise, photo pixels, the uncertainty model gives each of the eight taps, per coordinate: the card's
    /// four corners in the API's order, then the window's four (TL, TR, BR, BL). A window corner has the tap noise; a card
    /// corner has the tap noise plus the rounded-corner ambiguity (`cardCornerSigmaMm` at the card's own scale), in
    /// quadrature. Nil for degenerate input, as `size`.
    public static func tapSigmasPx(cardCorners: [Vec2], windowCorners: [Vec2], imageWidthPx: Double, imageHeightPx: Double) -> [Double]? {
        guard imageWidthPx.isFinite, imageHeightPx.isFinite, imageWidthPx > 0, imageHeightPx > 0,
              let card = cardCornersForAPI(cardCorners), orderedQuad(windowCorners) != nil else { return nil }
        return sigmas(card: card, imageWidthPx: imageWidthPx, imageHeightPx: imageHeightPx)
    }

    // MARK: The size

    /// The window's size from the card on its glass. `cardCorners` any tap order (normalised internally exactly like
    /// `cardCornersForAPI`), `windowCorners` any tap order (ordered by `orderedQuad`: width along the top and bottom sides,
    /// height along left and right, because windows are photographed upright). `imageWidthPx` / `imageHeightPx` are the
    /// photo's size (they set the pixel noise). Nil for degenerate input (not four good points each, a singular system,
    /// a window corner on the plane's line at infinity, no photo size).
    ///
    /// Size: the server's sizeFromReference with the card as the reference rectangle (3.3701 x 2.1252 in).
    ///
    /// Uncertainty, 1 sigma per dimension: each of the 16 tap coordinates (8 points) is nudged +/- `jacobianStepPx` and the
    /// whole pipeline (homography, mapping, mean of opposite sides) is recomputed, which gives the sensitivity of width
    /// and height to that coordinate; the sensitivities, weighted by that coordinate's noise (`tapSigmasPx`), are added in
    /// quadrature (first order), then `modelSigma` of the length itself, also in quadrature. Nothing else is added.
    ///
    /// Read the numbers with this in mind: the card fixes the plane's scale AND its perspective, and a bank card is small.
    /// Its perspective terms are only known to a few percent of the card's size, and that error grows in step with the
    /// distance the scale is carried, so the uncertainty grows roughly with the SQUARE of the window/card size ratio. A card
    /// spanning ~135 px next to a 60 in window gives tens of inches (hopeless); it takes a card that is a good share of
    /// the window to reach 3/8 in. The 'check' rule makes the app say so instead of guessing.
    ///
    /// 'check' when the uncertainty is above `checkAboveIn` or a sanity rule fails (each adds a reason in plain words):
    /// the card quad does not look like a bank card (pixel aspect off 1.586 by more than 25%); the window is not roughly a
    /// rectangle in the card's plane (a corner more than 4 degrees off square, or opposite sides differing by more than
    /// 3%); the card's centre is not inside the window quad; the window quad is under 4x the card quad's area.
    public static func size(cardCorners: [Vec2], windowCorners: [Vec2], imageWidthPx: Double, imageHeightPx: Double) -> CardSize? {
        guard imageWidthPx.isFinite, imageHeightPx.isFinite, imageWidthPx > 0, imageHeightPx > 0,
              let card = cardCornersForAPI(cardCorners), let window = orderedQuad(windowCorners),
              let base = rectify(card: card, window: window) else { return nil }
        let sig = sigmas(card: card, imageWidthPx: imageWidthPx, imageHeightPx: imageHeightPx)

        // Sensitivity of (width, height) to each of the 16 coordinates, by central differences through the whole pipeline
        let points = card + window
        let step = CardLimits.jacobianStepPx
        var varWidth = 0.0
        var varHeight = 0.0
        for i in 0..<8 {
            for axis in 0..<2 {
                var plus = points
                var minus = points
                if axis == 0 {
                    plus[i].x += step
                    minus[i].x -= step
                } else {
                    plus[i].y += step
                    minus[i].y -= step
                }
                guard let a = rectify(card: Array(plus[0..<4]), window: Array(plus[4..<8])),
                      let b = rectify(card: Array(minus[0..<4]), window: Array(minus[4..<8])) else { return nil }
                let dWidth = (a.size.widthIn - b.size.widthIn) / (2 * step)
                let dHeight = (a.size.heightIn - b.size.heightIn) / (2 * step)
                varWidth += dWidth * dWidth * sig[i] * sig[i]
                varHeight += dHeight * dHeight * sig[i] * sig[i]
            }
        }
        let modelWidth = CardLimits.modelSigma * base.size.widthIn
        let modelHeight = CardLimits.modelSigma * base.size.heightIn
        let uncertaintyWidth = (varWidth + modelWidth * modelWidth).squareRoot()
        let uncertaintyHeight = (varHeight + modelHeight * modelHeight).squareRoot()
        guard uncertaintyWidth.isFinite, uncertaintyHeight.isFinite else { return nil }

        let cardArea = cardPolygonArea(card)
        let windowArea = cardPolygonArea(window)
        guard cardArea > 0 else { return nil }
        let ratio = windowArea / cardArea

        var reasons: [String] = []
        // 1. The card quad looks like a bank card
        let longSide = (cardDistance(card[0], card[1]) + cardDistance(card[3], card[2])) / 2
        let shortSide = (cardDistance(card[0], card[3]) + cardDistance(card[1], card[2])) / 2
        if abs(longSide / shortSide / CardLimits.aspect - 1) > CardLimits.aspectTolerance {
            reasons.append("The four card corners don't look like a bank card.")
        }
        // 2. The window is a clean rectangle in the card's plane
        let quad = base.quad
        let top = cardDistance(quad[0], quad[1]), bottom = cardDistance(quad[3], quad[2])
        let left = cardDistance(quad[0], quad[3]), right = cardDistance(quad[1], quad[2])
        var worstCorner = 0.0
        for i in 0..<4 {
            let a = cardSub(quad[(i + 3) % 4], quad[i])
            let b = cardSub(quad[(i + 1) % 4], quad[i])
            let cosv = (a.x * b.x + a.y * b.y) / (cardLength(a) * cardLength(b))
            worstCorner = max(worstCorner, abs(acos(max(-1, min(1, cosv))) * 180 / .pi - 90))
        }
        let widthDiff = abs(top - bottom) / base.size.widthIn
        let heightDiff = abs(left - right) / base.size.heightIn
        if !(worstCorner <= CardLimits.maxCornerOffDeg) || widthDiff > CardLimits.maxSideDiff || heightDiff > CardLimits.maxSideDiff {
            reasons.append("The window corners don't make a clean rectangle.")
        }
        // 3. The card is on the glass: its centre is inside the window quad
        let centre = Vec2(card.reduce(0) { $0 + $1.x } / 4, card.reduce(0) { $0 + $1.y } / 4)
        let inside = (0..<4).allSatisfy { i in cardCross(cardSub(window[(i + 1) % 4], window[i]), cardSub(centre, window[i])) > 0 }
        if !inside {
            reasons.append("The card is not on the window glass.")
        }
        // 4. The window corners are not on or next to the card
        if ratio < CardLimits.minAreaRatio {
            reasons.append("The window corners look too close together.")
        }
        // 5. Too uncertain. In practice it is the corner taps that cause it (a small card carried over a big window): once
        // the window is 4x the card's area the taps' share is far above the model term's, so the advice is always the same.
        if max(uncertaintyWidth, uncertaintyHeight) > CardLimits.checkAboveIn {
            reasons.append("The card looks small next to the window, so the size is less sure. A closer photo helps.")
        }

        return CardSize(
            widthIn: base.size.widthIn,
            heightIn: base.size.heightIn,
            uncertaintyWidthIn: uncertaintyWidth,
            uncertaintyHeightIn: uncertaintyHeight,
            quality: reasons.isEmpty ? .good : .check,
            reasons: reasons,
            sizeRatio: ratio
        )
    }

    // MARK: Internals

    private static let realCard = [Vec2(0, 0), Vec2(CardLimits.widthIn, 0), Vec2(CardLimits.widthIn, CardLimits.heightIn), Vec2(0, CardLimits.heightIn)]

    /// The window quad (already ordered) through the card's homography: the quad in inches and its size. Nil when the
    /// system is singular, a corner (or a card corner) sits on the plane's line at infinity or on the other side of it
    /// from the rest, or the result is not a finite, positive size.
    private static func rectify(card: [Vec2], window: [Vec2]) -> (quad: [Vec2], size: ReferenceSize)? {
        guard let h = Homography.solve(src: card, dst: realCard) else { return nil }
        let ws = (card + window).map { h[6] * $0.x + h[7] * $0.y + h[8] }
        guard ws.allSatisfy({ $0.isFinite && $0 > 0 }) || ws.allSatisfy({ $0.isFinite && $0 < 0 }) else { return nil }
        let quad = window.map { Homography.apply(h, $0) }
        guard quad.allSatisfy({ $0.x.isFinite && $0.y.isFinite }) else { return nil }
        let size = quadSize(quad)
        guard size.widthIn.isFinite, size.heightIn.isFinite, size.widthIn > 1e-9, size.heightIn > 1e-9 else { return nil }
        return (quad, size)
    }

    /// Per-coordinate tap noise for the eight points (card in API order, then window), pixels.
    private static func sigmas(card: [Vec2], imageWidthPx: Double, imageHeightPx: Double) -> [Double] {
        let tap = tapSigmaPx(imageWidthPx: imageWidthPx, imageHeightPx: imageHeightPx)
        // The card's own scale: its perimeter in pixels over its perimeter in millimetres
        let perimeter = (0..<4).reduce(0.0) { $0 + cardDistance(card[$1], card[($1 + 1) % 4]) }
        let pxPerMm = perimeter / (2 * (CardLimits.widthMm + CardLimits.heightMm))
        let cardSigma = (tap * tap + (CardLimits.cardCornerSigmaMm * pxPerMm) * (CardLimits.cardCornerSigmaMm * pxPerMm)).squareRoot()
        return [cardSigma, cardSigma, cardSigma, cardSigma, tap, tap, tap, tap]
    }
}

// MARK: - 2D helpers (file-private so they cannot clash with other files)

private func cardSub(_ a: Vec2, _ b: Vec2) -> Vec2 { Vec2(a.x - b.x, a.y - b.y) }
private func cardLength(_ a: Vec2) -> Double { hypot(a.x, a.y) }
private func cardCross(_ a: Vec2, _ b: Vec2) -> Double { a.x * b.y - a.y * b.x }
private func cardDistance(_ a: Vec2, _ b: Vec2) -> Double { hypot(a.x - b.x, a.y - b.y) }

/// Area of a simple polygon (shoelace), always positive.
private func cardPolygonArea(_ p: [Vec2]) -> Double {
    var s = 0.0
    for i in 0..<p.count {
        let a = p[i], b = p[(i + 1) % p.count]
        s += a.x * b.y - b.x * a.y
    }
    return abs(s) / 2
}
