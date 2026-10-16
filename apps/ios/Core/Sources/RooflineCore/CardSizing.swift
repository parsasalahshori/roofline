import Foundation

// Sizing a window from ONE photo with a standard bank card lying flat on the glass (the "card" scale).
//
// This file is a line-for-line port of the server's packages/shared/src/window-photo-card.ts (`sizeFromCard`, `cardProblem`
// and `inchesInWords`, with the constants it takes from window-photo-sheet.ts and window-photo-math.ts). It is the phone's
// live preview of what the server will compute from the same taps, so the numbers must agree to rounding: the same
// operations in the same order, in Double. CardChecks.swift compares it with the real TypeScript number for number. Keep
// the two in step; when the server's model changes, change this file and regenerate those expectations.
//
// The model has two stages, because the card is tiny next to the window (a window 10 to 30 times the card's size, a card
// 100 to 200 pixels wide in the photo):
//  1. The plane's TILT comes from the window's own four corners (a rectangle seen in perspective, Zhang and He). The card
//     cannot give it: a homography from four taps on a card 150 px wide has a perspective term that is mostly tap noise.
//  2. The card gives the SCALE: its four taps are put on that plane, and the best-fit rectangle of the card's real size
//     gives the distance to the glass. The window's corners are then put on the plane the frame sits on (about an inch in
//     front of the glass, exactly for oblique views) and the size is read off it: width = the mean of the top and bottom
//     edges, height = the mean of the left and right edges.
//
// Points are photo pixels, x right, y DOWN; the principal point is the photo's centre. The window quad is
// top-left, top-right, bottom-right, bottom-left. The card quad is in order around the card (clockwise or not, starting at
// any corner), each tapped at the TIP of the rounded corner.

/// Thresholds and constants of the bank-card model. Every number here is the server's (window-photo-card.ts, and
/// window-photo-sheet.ts for the focal length and viewing angle), under the same meaning, except the two under "Taps",
/// which are the app's own tolerances for putting taps in order.
public enum CardLimits {
    // MARK: The card

    /// ISO/IEC 7810 ID-1 bank card, millimetres (the server's ID1_CARD_MM). Landscape: `widthMm` is the long side.
    public static let widthMm = 85.60
    public static let heightMm = 53.98
    public static let mmPerInch = 25.4
    /// The card in inches: 3.3701 x 2.1252.
    public static let widthIn = widthMm / mmPerInch
    public static let heightIn = heightMm / mmPerInch
    /// The radius of an ID-1 card's rounded corners, millimetres (ISO/IEC 7810: 3.18 mm).
    public static let cornerRadiusMm = 3.18
    /// The tip of a rounded corner sits (1 - 1/sqrt(2)) x radius = 0.93 mm inside the card's true (sharp) corner, along
    /// both edges. A person taps the visible tip, so the four taps make a rectangle this much smaller on every side.
    public static let tipInsetMm = (1 - (0.5).squareRoot()) * cornerRadiusMm
    /// The rectangle the four taps make, millimetres: the card inset by the corner rounding, 83.74 x 52.12 mm. The metric
    /// rectangle the math uses.
    public static let tapRectWidthMm = widthMm - 2 * tipInsetMm
    public static let tapRectHeightMm = heightMm - 2 * tipInsetMm
    /// One-sigma doubt in each side of the tapped rectangle, millimetres: where on the rounded corner the person tapped.
    public static let rectSigmaMm = 0.5

    // MARK: Quality and uncertainty

    /// Quality is 'check' when the larger of the two uncertainties is strictly above this: 3/8 inch.
    public static let checkAboveIn = 3.0 / 8.0
    /// The frame's inner edge sits about this far in front of the glass the card is on, inches.
    public static let defaultOffsetIn = 1.0
    /// One-sigma doubt in that offset, inches: frames stand proud of the glass by anything from nothing to two inches.
    public static let offsetSigmaIn = 0.5
    /// A floor for what the model leaves out (lens distortion, a card that is not quite flat, a window that is not quite
    /// square): 0.1% of the size.
    public static let modelFloor = 0.001
    /// The propagated one-sigma error is multiplied by this so that about 68% of real errors fall inside it.
    public static let sigmaScale = 1.05
    /// The card's longest side is under this share of the photo's long side (about 60 px on a 4032 px photo): 'check'.
    public static let minLongSideFrac = 0.015
    /// ... and under this share (about 30 px on a 4032 px photo) the card is refused: too small to tap.
    public static let refuseLongSideFrac = 0.0075
    /// The sizes accepted, inches.
    public static let minWindowIn = 3.0
    public static let maxWindowIn = 400.0
    /// Offsets accepted, inches (frame in front of + / behind - the glass).
    public static let maxOffsetIn = 6.0
    /// The tapped card, put on the plane, may differ from the real card's long-to-short ratio by this share before it is
    /// 'check' (not a card, or not on the glass).
    public static let shapeTolerance = 0.3
    /// A window side shorter than this many pixels is too small to size from.
    public static let minWindowSidePx = 20.0
    /// An interior angle closer than this to straight (or to folded flat), degrees, is not a corner.
    public static let minCornerDeg = 10.0
    /// The step of the central differences, photo pixels.
    public static let tapStepPx = 0.5

    // MARK: The camera (window-photo-sheet.ts, window-photo-math.ts)

    /// One-sigma doubt in a focal length read from the photo (EXIF rounds it to a whole mm): SHEET_FOCAL_SIGMA.
    public static let focalSigma = 0.03
    /// One-sigma doubt when the photo has no focal length and `defaultFocal35mm` is assumed: SHEET_FOCAL_UNKNOWN_SIGMA.
    public static let focalUnknownSigma = 0.1
    /// A typical phone main camera (about 26 mm equivalent) when the photo does not say: DEFAULT_FOCAL_35MM.
    public static let defaultFocal35mm = 26.0
    /// Phone ultra-wide lenses are under this 35 mm-equivalent focal length: ULTRA_WIDE_FOCAL_35MM.
    public static let ultraWideFocal35mm = 20.0
    /// Viewing angles above this get a different warning, above `steepCheckDeg` the window is 'check'.
    public static let steepWarnDeg = 35.0
    public static let steepCheckDeg = 50.0
    /// The server reads a focal length from the photo only inside this range of 35 mm equivalents (its EXIF reader); a
    /// value outside it is "the photo did not say".
    public static let readableFocal35mm: ClosedRange<Double> = 8...600

    // MARK: Taps

    /// Two taps closer than this (pixels) are the same tap (`CardSizing.orderedQuad`).
    public static let minPointGapPx = 1.0
    /// A quadrilateral whose corner turns by less than this sine (about 3 degrees) is flat, not a quad (`orderedQuad`).
    public static let minTurnSine = 0.05
}

/// What `CardSizing.sizeFromCard` takes: the server's CardSizeInput.
public struct CardSizeInput: Sendable {
    /// The photo as displayed (EXIF orientation applied), pixels; the principal point is at its centre.
    public var widthPx: Double
    public var heightPx: Double
    /// From the 35 mm-equivalent focal length: `(focal35mm / 36) * max(widthPx, heightPx)`.
    public var focalPx: Double
    /// One-sigma doubt in the focal length, a fraction: `CardLimits.focalSigma` (3%) when nil.
    public var focalSigmaFrac: Double?
    /// The card's four corners in photo pixels, each tapped at the TIP of the rounded corner, in order around the card:
    /// clockwise or counterclockwise, starting at any corner.
    public var cardCorners: [Vec2]
    /// The window frame's corners: top-left, top-right, bottom-right, bottom-left, photo pixels.
    public var windowCorners: [Vec2]
    /// How far the frame sits in front of (+) or behind (-) the glass the card is on, inches. `CardLimits.defaultOffsetIn` when nil.
    public var planeOffsetIn: Double?
    /// One-sigma noise of one tapped coordinate, photo pixels. `CardSizing.defaultTapSigmaPx` when nil.
    public var tapSigmaPx: Double?

    public init(widthPx: Double, heightPx: Double, focalPx: Double, focalSigmaFrac: Double? = nil, cardCorners: [Vec2], windowCorners: [Vec2], planeOffsetIn: Double? = nil, tapSigmaPx: Double? = nil) {
        self.widthPx = widthPx
        self.heightPx = heightPx
        self.focalPx = focalPx
        self.focalSigmaFrac = focalSigmaFrac
        self.cardCorners = cardCorners
        self.windowCorners = windowCorners
        self.planeOffsetIn = planeOffsetIn
        self.tapSigmaPx = tapSigmaPx
    }
}

/// The window's size from the card: the server's CardSize. Sizes are not rounded (the server rounds to 0.1 in later).
public struct CardSize: Equatable, Sendable {
    public var widthIn: Double
    public var heightIn: Double
    /// About 1 sigma, inches, per dimension (calibrated: `CardLimits.sigmaScale`).
    public var uncertaintyWidthIn: Double
    public var uncertaintyHeightIn: Double
    public var quality: Quality
    /// Why 'check', in plain homeowner words (empty when 'good').
    public var reasons: [String]
    /// Camera to the glass plane, inches.
    public var distanceIn: Double
    /// How far off square the camera is at the window's middle, degrees.
    public var viewAngleDeg: Double
    /// The window's longest side over the card's long side: the uncertainty grows with it.
    public var sizeRatio: Double

    public enum Quality: String, Codable, Sendable {
        case good
        case check
    }

    public init(widthIn: Double, heightIn: Double, uncertaintyWidthIn: Double, uncertaintyHeightIn: Double, quality: Quality, reasons: [String], distanceIn: Double, viewAngleDeg: Double, sizeRatio: Double) {
        self.widthIn = widthIn
        self.heightIn = heightIn
        self.uncertaintyWidthIn = uncertaintyWidthIn
        self.uncertaintyHeightIn = uncertaintyHeightIn
        self.quality = quality
        self.reasons = reasons
        self.distanceIn = distanceIn
        self.viewAngleDeg = viewAngleDeg
        self.sizeRatio = sizeRatio
    }
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
    /// judged by its sides in the photo, not by the photo's axes). The server does not depend on this labelling (it reads
    /// the card from any starting corner and either winding); it is the API's contract.
    public static func cardCornersForAPI(_ points: [Vec2]) -> [Vec2]? {
        guard let q = orderedQuad(points) else { return nil }
        let across = (cardDistance(q[0], q[1]) + cardDistance(q[3], q[2])) / 2
        let down = (cardDistance(q[0], q[3]) + cardDistance(q[1], q[2])) / 2
        return down > across ? [q[1], q[2], q[3], q[0]] : q
    }

    // MARK: The size

    /// One-sigma noise of one tapped coordinate, photo pixels, when the caller does not say: 0.05% of the photo's long
    /// side, at least 1 px (2 px on 4032). The server's `defaultTapSigmaPx`.
    public static func defaultTapSigmaPx(widthPx: Double, heightPx: Double) -> Double {
        jsMax(1, 0.0005 * jsMax(widthPx, heightPx))
    }

    /// The focal length the server would read from the photo: the number if it is finite and in 8...600, else nil.
    public static func usableFocal35mm(_ focal35mm: Double?) -> Double? {
        guard let f = focal35mm, f.isFinite, CardLimits.readableFocal35mm.contains(f) else { return nil }
        return f
    }

    /// The window's size from a photo with a bank card on the glass: the server's card branch of `sizePhotoWindow`, which
    /// calls `sizeFromCard` with the photo's 35 mm-equivalent focal length. `focal35mm` nil (the photo did not say) means
    /// 26 mm with a 10% doubt; a number means that focal length with a 3% doubt. A value outside 8...600 or not finite is
    /// "did not say", as the server's EXIF reader treats it.
    ///
    /// `cardCorners` are in order around the card (any starting corner, either winding), `windowCorners` are TL, TR, BR, BL
    /// of the photo as displayed. Like the server, this does not put taps in order: a card tapped across (a bow tie) gives
    /// nil, and a window tapped in another order than TL, TR, BR, BL has its width and height mixed up. So pass raw taps
    /// through `cardCornersForAPI` and `orderedQuad` first, as the app does before it sends them. The tap noise is the
    /// server's default (`defaultTapSigmaPx`), the frame offset 1 in.
    ///
    /// Nil when it cannot be sized: not four finite points each, a card or window quad that is not a convex four-cornered
    /// shape (it crosses itself, has three corners in a line, or is a dart), rays that miss the plane in front of the
    /// camera, or a size outside 3...400 in. Unlike the server, this does not stop at `problem`: ask `problem` first, as
    /// the server does, to learn why a photo would be refused with a 422 (a card too small to tap, a card bigger than the
    /// window, corners outside the photo), which `size` may still size.
    public static func size(cardCorners: [Vec2], windowCorners: [Vec2], imageWidthPx: Double, imageHeightPx: Double, focal35mm: Double? = nil) -> CardSize? {
        let known = usableFocal35mm(focal35mm)
        // focalPxFrom35mm(photo.focal35mm ?? DEFAULT_FOCAL_35MM, widthPx, heightPx)
        let focalPx = ((known ?? CardLimits.defaultFocal35mm) / 36) * jsMax(imageWidthPx, imageHeightPx)
        return sizeFromCard(CardSizeInput(
            widthPx: imageWidthPx, heightPx: imageHeightPx, focalPx: focalPx,
            focalSigmaFrac: known == nil ? CardLimits.focalUnknownSigma : nil,
            cardCorners: cardCorners, windowCorners: windowCorners
        ))
    }

    /// A window's size from a photo with an ID-1 card on the glass: the server's `sizeFromCard`, see the file header for
    /// the two stages. Sizes are not rounded.
    ///
    /// Uncertainty (about 1 sigma, per dimension), added in quadrature and multiplied by `CardLimits.sigmaScale`:
    /// first-order propagation by central differences of the 16 tapped coordinates (each `tapSigmaPx`), the focal length
    /// (everything is refitted at f x (1 + s) and f / (1 + s)), the plane offset (`offsetSigmaIn`), the tapped rectangle's
    /// two sides (`rectSigmaMm` each) and a floor of `modelFloor` of the size. The whole figure is CONDITIONAL on the tap
    /// noise: 2 px on a 4032 px photo is a careful fingertip with the magnifier.
    ///
    /// 'check' when the larger uncertainty is above `checkAboveIn`, the view is steeper than `steepCheckDeg`, the card is
    /// small in the photo or does not have a card's shape on the plane, the lens is a wide one (under
    /// `ultraWideFocal35mm`, which bends straight lines), or the window's corners are not a usable view; each gets a reason
    /// in plain words.
    ///
    /// Nil when it cannot be sized at all (see `size`).
    public static func sizeFromCard(_ input: CardSizeInput) -> CardSize? {
        let widthPx = input.widthPx, heightPx = input.heightPx, focalPx = input.focalPx
        let cardCorners = input.cardCorners, windowCorners = input.windowCorners
        guard [widthPx, heightPx, focalPx].allSatisfy({ $0.isFinite && $0 > 0 }) else { return nil }
        let offsetIn = input.planeOffsetIn ?? CardLimits.defaultOffsetIn
        guard offsetIn.isFinite, abs(offsetIn) <= CardLimits.maxOffsetIn else { return nil }
        let tapSigma = input.tapSigmaPx ?? defaultTapSigmaPx(widthPx: widthPx, heightPx: heightPx)
        let focalSigma = input.focalSigmaFrac ?? CardLimits.focalSigma
        guard tapSigma.isFinite, tapSigma >= 0, focalSigma.isFinite, focalSigma >= 0 else { return nil }
        guard cardCorners.count == 4, windowCorners.count == 4, CardMath.finite(cardCorners), CardMath.finite(windowCorners) else { return nil }
        guard CardMath.quadShape(cardCorners) == .ok else { return nil }
        // A rectangle seen from anywhere in front of it is a convex four-cornered shape: a bow tie, a dart or a line is a mistap.
        guard CardMath.quadShape(windowCorners) == .ok else { return nil }

        let cx = widthPx / 2
        let cy = heightPx / 2
        let setup = CardMath.Setup(card: cardCorners, win: windowCorners, focalPx: focalPx, offsetIn: offsetIn, rectWIn: CardMath.rectWIn, rectHIn: CardMath.rectHIn)
        guard let base = CardMath.solve(setup, cx, cy) else { return nil }
        if base.w < CardLimits.minWindowIn || base.h < CardLimits.minWindowIn || base.w > CardLimits.maxWindowIn || base.h > CardLimits.maxWindowIn { return nil }
        let labelling = base.labelling

        // Uncertainty, first order: d(size)/d(each source) by central differences, then the root of the sum of squares.
        var varW = 0.0
        var varH = 0.0
        func add(_ dw: Double, _ dh: Double) {
            varW += dw * dw
            varH += dh * dh
        }
        func diff(_ a: CardMath.Setup, _ b: CardMath.Setup, _ step: Double, _ sigma: Double) -> Bool {
            guard let ra = CardMath.solve(a, cx, cy, labelling), let rb = CardMath.solve(b, cx, cy, labelling) else { return false }
            add(((ra.w - rb.w) / (2 * step)) * sigma, ((ra.h - rb.h) / (2 * step)) * sigma)
            return true
        }
        for onWindow in [false, true] {
            for k in 0..<4 {
                for axis in 0..<2 {
                    var up = onWindow ? setup.win : setup.card
                    var dn = up
                    if axis == 0 {
                        up[k].x += CardLimits.tapStepPx
                        dn[k].x -= CardLimits.tapStepPx
                    } else {
                        up[k].y += CardLimits.tapStepPx
                        dn[k].y -= CardLimits.tapStepPx
                    }
                    var a = setup, b = setup
                    if onWindow {
                        a.win = up
                        b.win = dn
                    } else {
                        a.card = up
                        b.card = dn
                    }
                    if !diff(a, b, CardLimits.tapStepPx, tapSigma) { return nil }
                }
            }
        }
        let sf = 1 + focalSigma
        do {
            var a = setup, b = setup
            a.focalPx = focalPx * sf
            b.focalPx = focalPx / sf
            if !diff(a, b, 1, 1) { return nil }
        }
        do {
            var a = setup, b = setup
            a.offsetIn = offsetIn + CardLimits.offsetSigmaIn
            b.offsetIn = offsetIn - CardLimits.offsetSigmaIn
            if !diff(a, b, 1, 1) { return nil }
        }
        let rw = CardLimits.rectSigmaMm / CardLimits.mmPerInch
        do {
            var a = setup, b = setup
            a.rectWIn = CardMath.rectWIn + rw
            b.rectWIn = CardMath.rectWIn - rw
            if !diff(a, b, 2 * rw, rw) { return nil }
        }
        do {
            var a = setup, b = setup
            a.rectHIn = CardMath.rectHIn + rw
            b.rectHIn = CardMath.rectHIn - rw
            if !diff(a, b, 2 * rw, rw) { return nil }
        }
        add(CardLimits.modelFloor * base.w, CardLimits.modelFloor * base.h)
        let uncertaintyWidth = CardLimits.sigmaScale * varW.squareRoot()
        let uncertaintyHeight = CardLimits.sigmaScale * varH.squareRoot()

        // The angle between the line of sight to the window's middle and the plane's normal.
        let r = base.winRays
        let centre = CardMath.V3(
            (r[0].x + r[1].x + r[2].x + r[3].x) / 4,
            (r[0].y + r[1].y + r[2].y + r[3].y) / 4,
            (r[0].z + r[1].z + r[2].z + r[3].z) / 4
        )
        let viewAngleDeg = (acos(min(1, abs(CardMath.dot3(centre, base.normal)) / CardMath.hypot3(centre.x, centre.y, centre.z))) * 180) / Double.pi
        let sizeRatio = jsMax(base.w, base.h) / CardMath.cardLongIn

        var reasons: [String] = []
        let worst = jsMax(uncertaintyWidth, uncertaintyHeight)
        if worst > CardLimits.checkAboveIn {
            let off = "could be off by about \(inchesInWords(worst))"
            reasons.append(
                viewAngleDeg > CardLimits.steepWarnDeg
                    ? "The size \(off). Stand straight in front of the window, hold the card flat in the middle of the glass and step a little closer."
                    : "The card is small next to this window, so the size \(off). Hold the card flat in the middle of the glass and step a little closer."
            )
        }
        if viewAngleDeg > CardLimits.steepCheckDeg { reasons.append(CardWording.steep) }
        if (focalPx * 36) / jsMax(widthPx, heightPx) < CardLimits.ultraWideFocal35mm { reasons.append(CardWording.wideLens) }
        if CardMath.longSidePx(cardCorners) < CardLimits.minLongSideFrac * jsMax(widthPx, heightPx) { reasons.append(CardWording.cardSmallInPhoto) }
        if abs(base.shapeRatio / (CardMath.rectWIn / CardMath.rectHIn) - 1) > CardLimits.shapeTolerance { reasons.append(CardWording.notACard) }
        if CardMath.sidesPx(windowCorners).contains(where: { $0 < CardLimits.minWindowSidePx }) { reasons.append(CardWording.windowSmallInPhoto) }

        return CardSize(
            widthIn: base.w, heightIn: base.h,
            uncertaintyWidthIn: uncertaintyWidth, uncertaintyHeightIn: uncertaintyHeight,
            quality: reasons.isEmpty ? .good : .check, reasons: reasons,
            distanceIn: base.distanceIn, viewAngleDeg: viewAngleDeg, sizeRatio: sizeRatio
        )
    }

    // MARK: What a person can fix

    /// Why the card and window points cannot be used, in plain words for the homeowner; nil when they can. The server's
    /// `cardProblem` (its 422 `window_unsizable` says the same sentence), without the card-size check: the app always
    /// sends an ID-1 card. Checked, in this order: the photo's size, points inside the photo (a point may be 1 px
    /// outside), the card's corners (crossing, or not a four-cornered shape), the card not too small to tap (under
    /// `CardLimits.refuseLongSideFrac` of the photo's long side), the window's corners (crossing, or not a convex
    /// four-cornered shape), and the card not bigger than the window. Ask it about the corners the app will send
    /// (`cardCornersForAPI`, `orderedQuad`), as `size`.
    public static func problem(cardCorners: [Vec2], windowCorners: [Vec2], imageWidthPx: Double, imageHeightPx: Double) -> String? {
        let widthPx = imageWidthPx, heightPx = imageHeightPx
        if !(widthPx.isFinite && widthPx > 0 && heightPx.isFinite && heightPx > 0) { return CardWording.photo }
        if cardCorners.count != 4 || !CardMath.finite(cardCorners) || !CardMath.inside(cardCorners, widthPx, heightPx) { return CardWording.cardOutside }
        if windowCorners.count != 4 || !CardMath.finite(windowCorners) || !CardMath.inside(windowCorners, widthPx, heightPx) { return CardWording.windowOutside }
        let cardShape = CardMath.quadShape(cardCorners)
        if cardShape == .crossing { return CardWording.cardCrossing }
        if cardShape != .ok { return CardWording.cardShape }
        if CardMath.longSidePx(cardCorners) < CardLimits.refuseLongSideFrac * jsMax(widthPx, heightPx) { return CardWording.cardSmall }
        let windowShape = CardMath.quadShape(windowCorners)
        if windowShape == .crossing { return CardWording.windowCrossing }
        if windowShape != .ok { return CardWording.windowShape }
        if abs(CardMath.signedArea(cardCorners)) >= 0.5 * abs(CardMath.signedArea(windowCorners)) { return CardWording.cardBigger }
        return nil
    }

    /// Inches in words, rounded UP to an eighth (to a whole inch above 4): "1/2 inch", "1 1/4 inches", "6 inches". The
    /// server's `inchesInWords`.
    public static func inchesInWords(_ inches: Double) -> String {
        if !(inches > 0) { return "0 inches" }
        if inches > 4 {
            let whole = inches.rounded(.up)
            return whole.isInfinite ? "Infinity inches" : "\(String(format: "%.0f", whole)) inches"
        }
        let eighths = Int(jsMax(1, (inches * 8 - 1e-9).rounded(.up)))
        let whole = eighths / 8
        var num = eighths % 8
        var den = 8
        while num > 0 && num % 2 == 0 {
            num /= 2
            den /= 2
        }
        let frac = num == 0 ? "" : "\(num)/\(den)"
        let text = [whole > 0 ? String(whole) : "", frac].filter { $0 != "" }.joined(separator: " ")
        return "\(text) \(whole > 1 || (whole == 1 && frac != "") ? "inches" : "inch")"
    }
}

// MARK: - The sentences (the server's, word for word)

/// What the person is told. Word for word the server's: its PROBLEMS table for `problem`, and the fixed reasons of
/// `sizeFromCard` (the two that quote the doubt in inches are built in `sizeFromCard`).
private enum CardWording {
    static let photo = "The photo could not be read. Take it again."
    static let cardOutside = "Some of the card corners are outside the photo. Mark all four corners of the card where they show in the photo."
    static let windowOutside = "Some of the window corners are outside the photo. Mark the corners where they show, or take the photo again from farther back so the whole window is in it."
    static let cardCrossing = "The card corners cross over each other. Mark them one after another around the card."
    static let cardShape = "The four card corners do not make the shape of a card. Mark the tip of each corner of the card again."
    static let cardSmall = "The card is too small in this photo to measure from. Take the photo again a little closer, with the card flat on the glass."
    static let windowCrossing = "The window corners cross over each other. Mark them in order: top left, top right, bottom right, bottom left."
    static let windowShape = "The four window corners do not make the shape of a window. Mark the four corners of the frame again."
    static let cardBigger = "The card looks bigger than the window. Mark the four corners of the card first, then the four corners of the window."

    static let steep = "The photo was taken from well off to one side of the window. Stand straight in front of it and take the photo again."
    static let wideLens = "This photo looks like it was taken with the wide lens, which bends straight lines. Use the main (1x) camera and take it again."
    static let cardSmallInPhoto = "The card looks small in the photo. Step a little closer so it is easy to see, then mark its corners again."
    static let notACard = "The corners marked on the card do not look like a credit card lying flat on the glass. Tape the card flat and mark the tip of each corner again."
    static let windowSmallInPhoto = "The window is very small in this photo. Step a little closer so it fills more of the picture, then mark its corners again."
}

// MARK: - The geometry, as the server does it

/// JavaScript's `Math.max` of two numbers: NaN if either is NaN (Swift's `max` is not).
private func jsMax(_ a: Double, _ b: Double) -> Double {
    if a.isNaN || b.isNaN { return .nan }
    return a > b ? a : b
}

private enum CardMath {
    // The camera frame: x right, y down, z forward; a pixel p is the ray ((px - cx) / f, (py - cy) / f, 1).
    struct V3 {
        var x: Double
        var y: Double
        var z: Double
        init(_ x: Double, _ y: Double, _ z: Double) {
            self.x = x
            self.y = y
            self.z = z
        }
    }

    /// The tapped rectangle, inches: the card inset by the corner rounding.
    static let rectWIn = CardLimits.tapRectWidthMm / CardLimits.mmPerInch
    static let rectHIn = CardLimits.tapRectHeightMm / CardLimits.mmPerInch
    static let cardLongIn = CardLimits.widthMm / CardLimits.mmPerInch
    static let sinMinCorner = sin((CardLimits.minCornerDeg * Double.pi) / 180)

    // MARK: Math.hypot

    /// V8's `Math.hypot` of two or three numbers, operation for operation (scale by the largest, Kahan-summed squares), so
    /// that distances come out as the server's do to the last bit.
    private static func hypotCore(_ v0: Double, _ v1: Double, _ v2: Double, count n: Int) -> Double {
        let a0 = abs(v0), a1 = abs(v1), a2 = abs(v2)
        func at(_ i: Int) -> Double { i == 0 ? a0 : (i == 1 ? a1 : a2) }
        var largest = 0.0
        var sawNaN = false
        for i in 0..<n {
            let v = at(i)
            if v.isNaN {
                sawNaN = true
            } else if v > largest {
                largest = v
            }
        }
        if largest == .infinity { return .infinity }
        if sawNaN { return .nan }
        if largest == 0 { return 0 }
        var sum = 0.0
        var compensation = 0.0
        for i in 0..<n {
            let q = at(i) / largest
            let summand = q * q - compensation
            let preliminary = sum + summand
            compensation = (preliminary - sum) - summand
            sum = preliminary
        }
        return sum.squareRoot() * largest
    }

    static func hypot2(_ a: Double, _ b: Double) -> Double { hypotCore(a, b, 0, count: 2) }
    static func hypot3(_ a: Double, _ b: Double, _ c: Double) -> Double { hypotCore(a, b, c, count: 3) }

    // MARK: Shapes of tapped quads

    static func dist(_ a: Vec2, _ b: Vec2) -> Double { hypot2(a.x - b.x, a.y - b.y) }
    static func cross2(_ o: Vec2, _ a: Vec2, _ b: Vec2) -> Double { (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x) }
    static func finite(_ q: [Vec2]) -> Bool { q.allSatisfy { $0.x.isFinite && $0.y.isFinite } }

    /// Shoelace area, squared units; positive when the corners run clockwise on screen (y down).
    static func signedArea(_ q: [Vec2]) -> Double {
        var s = 0.0
        for i in 0..<q.count {
            let p = q[i], n = q[(i + 1) % q.count]
            s = s + p.x * n.y - n.x * p.y
        }
        return s / 2
    }

    static func segmentsCross(_ p1: Vec2, _ p2: Vec2, _ p3: Vec2, _ p4: Vec2) -> Bool {
        let d1 = cross2(p3, p4, p1)
        let d2 = cross2(p3, p4, p2)
        let d3 = cross2(p1, p2, p3)
        let d4 = cross2(p1, p2, p4)
        return d1 * d2 < 0 && d3 * d4 < 0
    }

    enum Shape {
        case ok, crossing, concave, degenerate
    }

    /// What four corners in order make: crossing (a bow tie), degenerate (a corner that is straight or folded flat: three
    /// in a line, or no area), concave (a dart), else ok (a convex four-cornered shape, either winding).
    static func quadShape(_ q: [Vec2]) -> Shape {
        if segmentsCross(q[0], q[1], q[2], q[3]) || segmentsCross(q[1], q[2], q[3], q[0]) { return .crossing }
        var positive = 0
        for i in 0..<4 {
            let a = q[i]
            let b = q[(i + 1) % 4]
            let c = q[(i + 2) % 4]
            let l1 = dist(a, b)
            let l2 = dist(b, c)
            if !(l1 > 0) || !(l2 > 0) { return .degenerate }
            let sine = cross2(a, b, c) / (l1 * l2)
            if !(abs(sine) >= sinMinCorner) { return .degenerate }
            if sine > 0 { positive += 1 }
        }
        return positive == 4 || positive == 0 ? .ok : .concave
    }

    static func sidesPx(_ q: [Vec2]) -> [Double] { [dist(q[0], q[1]), dist(q[1], q[2]), dist(q[2], q[3]), dist(q[3], q[0])] }
    static func longSidePx(_ q: [Vec2]) -> Double {
        let s = sidesPx(q)
        return jsMax(jsMax(s[0], s[1]), jsMax(s[2], s[3]))
    }
    static func inside(_ q: [Vec2], _ w: Double, _ h: Double) -> Bool {
        q.allSatisfy { $0.x >= -1 && $0.x <= w + 1 && $0.y >= -1 && $0.y <= h + 1 }
    }

    // MARK: Vectors

    static func dot3(_ a: V3, _ b: V3) -> Double { a.x * b.x + a.y * b.y + a.z * b.z }
    static func cross3(_ a: V3, _ b: V3) -> V3 { V3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x) }
    static func sub3(_ a: V3, _ b: V3) -> V3 { V3(a.x - b.x, a.y - b.y, a.z - b.z) }
    static func scale3(_ a: V3, _ s: Double) -> V3 { V3(a.x * s, a.y * s, a.z * s) }
    static func dist3(_ a: V3, _ b: V3) -> Double { hypot3(a.x - b.x, a.y - b.y, a.z - b.z) }

    static func rayOf(_ p: Vec2, _ f: Double, _ cx: Double, _ cy: Double) -> V3 { V3((p.x - cx) / f, (p.y - cy) / f, 1) }

    /// The unit normal, pointing away from the camera, of the plane a rectangle lies in, from its four corner rays in order
    /// (either winding): the rectangle's two edge directions in space (Zhang and He, "Whiteboard scanning", 2007), crossed.
    /// Nil for a degenerate quad.
    static func rectangleNormal(_ m: [V3]) -> V3? {
        let m1 = m[0], m2 = m[1], m4 = m[2], m3 = m[3]
        let k2den = dot3(cross3(m2, m4), m3)
        let k3den = dot3(cross3(m3, m4), m2)
        if !(abs(k2den) > 1e-12) || !(abs(k3den) > 1e-12) { return nil }
        let k2 = dot3(cross3(m1, m4), m3) / k2den
        let k3 = dot3(cross3(m1, m4), m2) / k3den
        let u = V3(k2 * m2.x - m1.x, k2 * m2.y - m1.y, k2 * m2.z - m1.z)
        let v = V3(k3 * m3.x - m1.x, k3 * m3.y - m1.y, k3 * m3.z - m1.z)
        let n = cross3(u, v)
        let len = hypot3(n.x, n.y, n.z)
        if !(len > 0) { return nil }
        let centre = V3((m1.x + m2.x + m3.x + m4.x) / 4, (m1.y + m2.y + m3.y + m4.y) / 4, 1)
        return scale3(n, (dot3(n, centre) < 0 ? -1 : 1) / len)
    }

    /// The card's corner rays put on the plane n . X = 1 and written in that plane's own axes (x along the camera's right,
    /// y down, so a clockwise card on screen is clockwise here), the centroid at the origin. Nil when a ray meets the plane
    /// behind the camera.
    static func onUnitPlane(_ rays: [V3], _ n: V3) -> [Vec2]? {
        var pts: [V3] = []
        for r in rays {
            let d = dot3(r, n)
            if !(d > 1e-9) { return nil }
            pts.append(scale3(r, 1 / d))
        }
        let c = V3(
            (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4,
            (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4,
            (pts[0].z + pts[1].z + pts[2].z + pts[3].z) / 4
        )
        let e1 = V3(1 - n.x * n.x, -n.x * n.y, -n.x * n.z)
        let l1 = hypot3(e1.x, e1.y, e1.z)
        if !(l1 > 1e-9) { return nil }
        let x = scale3(e1, 1 / l1)
        let y = cross3(n, x)
        return pts.map { p in
            let d = sub3(p, c)
            return Vec2(dot3(d, x), dot3(d, y))
        }
    }

    /// How the four taps are labelled: reversed to run clockwise, then started so that the first edge is the long one.
    struct Labelling {
        var reverse: Bool
        var rotate: Bool
    }

    static func orderOf(_ y: [Vec2]) -> Labelling {
        let reverse = signedArea(y) < 0
        let p = reverse ? [y[0], y[3], y[2], y[1]] : y
        let across = dist(p[0], p[1]) + dist(p[3], p[2])
        let down = dist(p[0], p[3]) + dist(p[1], p[2])
        return Labelling(reverse: reverse, rotate: across < down)
    }

    static func labelled(_ q: [Vec2], _ l: Labelling) -> [Vec2] {
        let a = l.reverse ? [q[0], q[3], q[2], q[1]] : q
        return l.rotate ? [a[1], a[2], a[3], a[0]] : a
    }

    /// The distance (along the normal) to a plane n . X = D on which the card's four taps, in the plane's units at D = 1 and
    /// labelled long side first, best fit (least squares, a turn and a scale) a rectangle of rectWIn x rectHIn inches.
    static func distanceFromCard(_ y: [Vec2], _ rectWIn: Double, _ rectHIn: Double) -> Double {
        let t = [Vec2(-rectWIn / 2, -rectHIn / 2), Vec2(rectWIn / 2, -rectHIn / 2), Vec2(rectWIn / 2, rectHIn / 2), Vec2(-rectWIn / 2, rectHIn / 2)]
        // The complex number a with t_i ~ a * z_i: a = sum(conj(z_i) t_i) / sum(|z_i|^2); its length is the distance.
        var re = 0.0
        var im = 0.0
        var zz = 0.0
        for i in 0..<4 {
            let zr = y[i].x, zi = y[i].y
            let tr = t[i].x, ti = t[i].y
            re += zr * tr + zi * ti
            im += zr * ti - zi * tr
            zz += zr * zr + zi * zi
        }
        return hypot2(re, im) / zz
    }

    struct Setup {
        var card: [Vec2]
        var win: [Vec2]
        var focalPx: Double
        var offsetIn: Double
        var rectWIn: Double
        var rectHIn: Double
    }

    struct Solved {
        var w: Double
        var h: Double
        var distanceIn: Double
        var normal: V3
        var shapeRatio: Double
        var winRays: [V3]
        var labelling: Labelling
    }

    /// The window's width and height on the frame's plane. `labelling` fixes how the taps are read (decided once, on the real taps).
    static func solve(_ s: Setup, _ cx: Double, _ cy: Double, _ labelling: Labelling? = nil) -> Solved? {
        let f = s.focalPx
        let winRays = s.win.map { rayOf($0, f, cx, cy) }
        guard let n = rectangleNormal(winRays) else { return nil }
        guard let y = onUnitPlane(s.card.map { rayOf($0, f, cx, cy) }, n) else { return nil }
        let l = labelling ?? orderOf(y)
        let yl = labelled(y, l)
        let D = distanceFromCard(yl, s.rectWIn, s.rectHIn)
        let frame = D - s.offsetIn
        if !(D > 0) || !(frame > 0) { return nil }
        var X: [V3] = []
        for r in winRays {
            let d = dot3(r, n)
            if !(d > 1e-9) { return nil }
            X.append(scale3(r, frame / d))
        }
        let w = (dist3(X[0], X[1]) + dist3(X[3], X[2])) / 2
        let h = (dist3(X[0], X[3]) + dist3(X[1], X[2])) / 2
        if !w.isFinite || !h.isFinite { return nil }
        let long = (dist(yl[0], yl[1]) + dist(yl[3], yl[2])) / 2
        let short = (dist(yl[0], yl[3]) + dist(yl[1], yl[2])) / 2
        return Solved(w: w, h: h, distanceIn: D, normal: n, shapeRatio: long / short, winRays: winRays, labelling: l)
    }
}

// MARK: - 2D helpers for the corner order (file-private so they cannot clash with other files)

private func cardSub(_ a: Vec2, _ b: Vec2) -> Vec2 { Vec2(a.x - b.x, a.y - b.y) }
private func cardLength(_ a: Vec2) -> Double { hypot(a.x, a.y) }
private func cardCross(_ a: Vec2, _ b: Vec2) -> Double { a.x * b.y - a.y * b.x }
private func cardDistance(_ a: Vec2, _ b: Vec2) -> Double { hypot(a.x - b.x, a.y - b.y) }
