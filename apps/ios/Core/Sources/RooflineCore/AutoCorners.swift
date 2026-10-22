import Foundation

// Proposing the corners instead of asking for four taps. Apple Vision finds the four-sided shapes in a photo or a camera frame
// (VNDetectRectanglesRequest); everything that DECIDES which of them is the window, which is the bank card, and whether the
// camera's shape is believable lives here, as plain maths, so it is checked on a Mac without Vision, UIKit or ARKit.
//
// What the person still does: look, drag a corner if it is off, and confirm. Nothing here changes how a size is worked out: the
// proposed corners go through the same `CardSizing` / `CornerCapture` as corners tapped by hand.

/// A four-sided shape Vision found, before anyone has judged what it is: image pixels (x right, y DOWN), in any order.
public struct QuadCandidate: Equatable, Sendable {
    public var corners: [Vec2]
    /// Vision's confidence, 0...1.
    public var confidence: Double

    public init(corners: [Vec2], confidence: Double) {
        self.corners = corners
        self.confidence = confidence
    }
}

/// A shape chosen as the window or the card: TL, TR, BR, BL (`CardSizing.orderedQuad`).
public struct PickedQuad: Equatable, Sendable {
    public var corners: [Vec2]
    public var confidence: Double

    public init(corners: [Vec2], confidence: Double) {
        self.corners = corners
        self.confidence = confidence
    }
}

/// What the picker made of a photo: the window frame, and the card on the glass, each only when found with good confidence.
public struct AutoCornerProposal: Equatable, Sendable {
    public var window: PickedQuad?
    /// The card's outline as detected (its sharp corners, extrapolated from the edges).
    public var card: PickedQuad?

    public init(window: PickedQuad? = nil, card: PickedQuad? = nil) {
        self.window = window
        self.card = card
    }

    public var isEmpty: Bool { window == nil && card == nil }

    /// The card's four points as a person taps them: at the TIP of each rounded corner, which is a little inside the outline
    /// (`AutoCorners.cardTapCorners`). These go on the photo screen.
    public var cardTaps: [Vec2]? { card.map { AutoCorners.cardTapCorners($0.corners) } }
}

public enum AutoCorners {
    // MARK: Limits (the shapes a window or a card can have in a photo)

    /// Below this Vision confidence a shape is not used.
    public static let minConfidence = 0.5
    /// The window's share of the photo's area: a small one is not the window, a huge one is the wall or the photo's own edge.
    public static let windowAreaShare: ClosedRange<Double> = 0.03...0.88
    /// The window's short side over its long side (a long slider is about 1 : 3).
    public static let windowMinAspect = 0.2
    /// The window's shortest side, as a share of the photo's short side.
    public static let windowMinSideShare = 0.06
    /// Corners this close to the photo's edge (share of the photo's short side) are "on the edge": a shape with three of them is
    /// the picture's own border, not a window.
    public static let borderShare = 0.02
    /// A corner of a real rectangle seen at an angle still turns by about a right angle: perspective moves it this far at most.
    public static let cornerAngleDeg: ClosedRange<Double> = 60...120
    /// Opposite sides of a rectangle in a photo differ by this ratio at most (perspective).
    public static let oppositeSideRatio = 1.6

    /// The card's long over short side (85.60 / 53.98).
    public static let cardAspect = CardLimits.widthMm / CardLimits.heightMm
    /// What a card's long over short side may read in a photo of a card on the glass seen at an angle.
    public static let cardAspectRange: ClosedRange<Double> = 1.3...1.95
    /// The card's long side as a share of the photo's long side: `CardLimits.refuseLongSideFrac` is the server's floor.
    public static let cardLongSideShare: ClosedRange<Double> = 0.012...0.25
    /// The card's area against the window's: the server refuses a card over half the window; a real card is a few percent of one.
    public static let cardOfWindowArea: ClosedRange<Double> = 0.0005...0.12

    // MARK: Shapes

    /// The shape in TL, TR, BR, BL order when it could be a rectangle seen from the front or at an angle: four finite points that
    /// make a convex quadrilateral, every corner turning by about a right angle, opposite sides not wildly different.
    public static func rectangleLike(_ points: [Vec2]) -> [Vec2]? {
        guard let q = CardSizing.orderedQuad(points) else { return nil }
        for i in 0..<4 {
            let a = q[(i + 3) % 4], b = q[i], c = q[(i + 1) % 4]
            let deg = interiorAngleDegrees(a, b, c)
            guard cornerAngleDeg.contains(deg) else { return nil }
        }
        let (top, bottom) = (distance(q[0], q[1]), distance(q[3], q[2]))
        let (left, right) = (distance(q[0], q[3]), distance(q[1], q[2]))
        guard min(top, bottom, left, right) > 0 else { return nil }
        guard max(top, bottom) / min(top, bottom) <= oppositeSideRatio, max(left, right) / min(left, right) <= oppositeSideRatio else { return nil }
        return q
    }

    /// The area of a quadrilateral, px^2.
    public static func area(_ q: [Vec2]) -> Double {
        guard q.count >= 3 else { return 0 }
        var a = 0.0
        for i in 0..<q.count {
            let p = q[i], n = q[(i + 1) % q.count]
            a += p.x * n.y - n.x * p.y
        }
        return abs(a) / 2
    }

    /// The mean of the two horizontal sides and of the two vertical sides of an ordered quad (TL, TR, BR, BL).
    public static func meanSides(_ q: [Vec2]) -> (across: Double, down: Double) {
        ((distance(q[0], q[1]) + distance(q[3], q[2])) / 2, (distance(q[0], q[3]) + distance(q[1], q[2])) / 2)
    }

    /// The point is inside the convex quad (a quad `orderedQuad` made).
    public static func contains(_ q: [Vec2], _ p: Vec2) -> Bool {
        guard q.count >= 3 else { return false }
        var sign = 0.0
        for i in 0..<q.count {
            let a = q[i], b = q[(i + 1) % q.count]
            let cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
            if cross == 0 { continue }
            if sign == 0 { sign = cross } else if (cross > 0) != (sign > 0) { return false }
        }
        return true
    }

    public static func centroid(_ q: [Vec2]) -> Vec2 {
        Vec2(q.reduce(0) { $0 + $1.x } / Double(q.count), q.reduce(0) { $0 + $1.y } / Double(q.count))
    }

    /// Step in once from the outermost shape when it is the casing or trim around the window (see `pickWindow`). The brief's window is
    /// "the inside of the frame, not the trim"; the sizing model puts the frame's corners about an inch in front of the glass.
    public static let skipsCasing = true
    /// The opening that holds all the panes is this share of the outer shape's area, at least and at most, for the outer shape to be
    /// a ring of casing round it (a thin ring is just the frame's own edge).
    public static let openingOfOuter: ClosedRange<Double> = 0.55...0.92
    /// A shape inside the outer one counts as a pane of it: this share of its area, at least and at most (smaller: a card, a latch;
    /// bigger: the same edge found twice).
    public static let paneOfOuter: ClosedRange<Double> = 0.05...0.9

    // MARK: Which shape is the window

    /// The shape that is the window frame, or nil when none is believable (the caller then falls back to taps).
    ///
    /// A window candidate is a rectangle-like shape of a sensible size that is not the photo's own border. Of those the LARGEST
    /// wins: the outer frame, not a pane or a sash inside it (every pane is a smaller shape that lies within the frame). When that
    /// largest shape has other shapes inside it that together fill 55 to 92% of it (the panes, a sash, the frame inside a casing) it is
    /// the casing or trim round the window, not the window: the answer is the opening that holds all of them (`openingInside`), the
    /// inside of the frame, as the person is told to tap it. With
    /// the card known, a shape that does not hold the card is much less likely (the card is on the glass), and a shape too small
    /// to have a card of that size on it is not the window (with `requireCard`, one that does not hold the card is out). With
    /// `aimedAt` (the AR reticle) a shape that does not hold that point, give or take `aimMargin`, is out: the window being looked at.
    public static func pickWindow(_ candidates: [QuadCandidate], imageWidth w: Double, imageHeight h: Double, card: [Vec2]? = nil,
                                  requireCard: Bool = false, aimedAt aim: Vec2? = nil) -> PickedQuad? {
        guard w > 0, h > 0 else { return nil }
        let imageArea = w * h
        var best: (score: Double, pick: PickedQuad)?
        for c in candidates where c.confidence >= minConfidence {
            guard let q = rectangleLike(c.corners) else { continue }
            let share = area(q) / imageArea
            guard windowAreaShare.contains(share) else { continue }
            let (across, down) = meanSides(q)
            guard min(across, down) / max(across, down) >= windowMinAspect, min(across, down) >= windowMinSideShare * min(w, h) else { continue }
            guard !isImageBorder(q, width: w, height: h) else { continue }
            if let aim = aim, !contains(grown(q, by: aimMargin), aim) { continue }
            var score = share * c.confidence
            if let card = card, card.count == 4 {
                // A window is many times the card; the card is on it
                guard area(card) <= cardOfWindowArea.upperBound * area(q) else { continue }
                if !contains(q, centroid(card)) {
                    if requireCard { continue }
                    score *= 0.3
                }
            }
            if best == nil || score > best!.score { best = (score, PickedQuad(corners: q, confidence: c.confidence)) }
        }
        guard let outer = best?.pick else { return nil }
        guard skipsCasing, let inner = openingInside(outer.corners, candidates: candidates, card: card, requireCard: requireCard, aimedAt: aim) else { return outer }
        return PickedQuad(corners: inner, confidence: outer.confidence)
    }

    /// The opening that holds every shape inside `outer` (the panes and sash, the frame inside a casing): the four extreme corners of
    /// all of them, when that is a rectangle-like shape filling `openingOfOuter` of `outer`, still holds the card and the aim. Nil
    /// when nothing is inside, or the shapes inside do not make an opening (a card, a latch, a second window).
    public static func openingInside(_ outer: [Vec2], candidates: [QuadCandidate], card: [Vec2]? = nil, requireCard: Bool = false, aimedAt aim: Vec2? = nil) -> [Vec2]? {
        let outerArea = area(outer)
        guard outerArea > 0 else { return nil }
        let room = grown(outer, by: 1.01)
        var corners: [Vec2] = []
        for c in candidates where c.confidence >= minConfidence {
            guard let q = rectangleLike(c.corners), paneOfOuter.contains(area(q) / outerArea), q.allSatisfy({ contains(room, $0) }) else { continue }
            corners.append(contentsOf: q)
        }
        guard corners.count >= 4 else { return nil }
        // The extreme corners towards each corner of the photo (windows are photographed upright)
        guard let tl = corners.min(by: { $0.x + $0.y < $1.x + $1.y }), let br = corners.max(by: { $0.x + $0.y < $1.x + $1.y }),
              let tr = corners.max(by: { $0.x - $0.y < $1.x - $1.y }), let bl = corners.min(by: { $0.x - $0.y < $1.x - $1.y }),
              let opening = rectangleLike([tl, tr, br, bl]), openingOfOuter.contains(area(opening) / outerArea) else { return nil }
        if let card = card, card.count == 4, !contains(opening, centroid(card)) { return nil }
        if requireCard, card == nil { return nil }
        if let aim = aim, !contains(grown(opening, by: aimMargin), aim) { return nil }
        return opening
    }

    /// The reticle may sit this much outside a window's outline (a share of its size) and still be "on" it: a person aiming at a
    /// frame's corner puts it on the edge.
    public static let aimMargin = 1.08

    /// The quad scaled about its centre.
    static func grown(_ q: [Vec2], by k: Double) -> [Vec2] {
        let c = centroid(q)
        return q.map { Vec2(c.x + ($0.x - c.x) * k, c.y + ($0.y - c.y) * k) }
    }

    /// Three or more corners within `borderShare` of the photo's edge: the picture's border (or a wall edge to edge), not a window.
    static func isImageBorder(_ q: [Vec2], width w: Double, height h: Double) -> Bool {
        let m = borderShare * min(w, h)
        let near = q.filter { $0.x <= m || $0.y <= m || $0.x >= w - m || $0.y >= h - m }.count
        return near >= 3
    }

    // MARK: Which shape is the card

    /// The shape that is the bank card on the glass, or nil. A card candidate is a rectangle-like shape whose sides are in the card's
    /// proportion (85.60 : 53.98, lying either way round, a little changed by the angle it is seen at) and small: a few percent of the
    /// photo's long side. With the window known, the card is inside it (a card-shaped shape elsewhere is not the card). Of the
    /// candidates, the one whose proportion is closest to a card's wins, a bigger one first when two are as good.
    public static func pickCard(_ candidates: [QuadCandidate], imageWidth w: Double, imageHeight h: Double, window: [Vec2]? = nil) -> PickedQuad? {
        rankedCards(candidates, imageWidth: w, imageHeight: h, window: window).first
    }

    /// Every card candidate, best first (see `pickCard`).
    public static func rankedCards(_ candidates: [QuadCandidate], imageWidth w: Double, imageHeight h: Double, window: [Vec2]? = nil) -> [PickedQuad] {
        guard w > 0, h > 0 else { return [] }
        var scored: [(score: Double, pick: PickedQuad)] = []
        for c in candidates where c.confidence >= minConfidence {
            guard let q = rectangleLike(c.corners) else { continue }
            let (across, down) = meanSides(q)
            let long = max(across, down), short = min(across, down)
            guard short > 0, cardAspectRange.contains(long / short), cardLongSideShare.contains(long / max(w, h)) else { continue }
            if let win = window, win.count == 4 {
                guard contains(win, centroid(q)) else { continue }
                guard cardOfWindowArea.contains(area(q) / area(win)) else { continue }
            }
            // 1 for a card's proportion, 0 at the edge of what is allowed; a bigger shape first when two fit as well
            let fit = max(0, 1 - abs(long / short - cardAspect) / 0.45)
            scored.append((fit * c.confidence + 0.01 * min(1, long / (0.05 * max(w, h))), PickedQuad(corners: q, confidence: c.confidence)))
        }
        return scored.sorted { $0.score > $1.score }.map { $0.pick }
    }

    /// Both, from what Vision found. The best card whose centre lies inside a believable window comes first (the card is on the glass,
    /// so the pair has to agree); with none, the window alone (the largest believable shape) and no card. Nothing believable: empty,
    /// and the screens go on with taps.
    public static func propose(_ candidates: [QuadCandidate], imageWidth w: Double, imageHeight h: Double) -> AutoCornerProposal {
        for card in rankedCards(candidates, imageWidth: w, imageHeight: h) {
            if let window = pickWindow(candidates, imageWidth: w, imageHeight: h, card: card.corners, requireCard: true) {
                return AutoCornerProposal(window: window, card: card)
            }
        }
        return AutoCornerProposal(window: pickWindow(candidates, imageWidth: w, imageHeight: h), card: nil)
    }

    // MARK: The card's corners as the model wants them

    /// A card is a rounded rectangle (corner radius 3.18 mm): a person taps the TIP of each rounded corner, and the model
    /// (`CardLimits.tapRectWidthMm`) is told the taps make an 83.74 x 52.12 mm rectangle. A detector that fits lines to the card's
    /// edges finds the SHARP corners instead (85.60 x 53.98 mm), a hair outside the tips, so each corner is moved in by the tip's
    /// inset along both of its sides before it is used as a tap. `sharp` is the card in any order; the result is TL, TR, BR, BL.
    public static func cardTapCorners(_ sharp: [Vec2]) -> [Vec2] {
        guard let q = CardSizing.orderedQuad(sharp) else { return sharp }
        let (across, down) = meanSides(q)
        // The long side of the card is whichever way it lies in the photo
        let longAcross = across >= down
        let inLong = CardLimits.tipInsetMm / CardLimits.widthMm
        let inShort = CardLimits.tipInsetMm / CardLimits.heightMm
        let s = longAcross ? inLong : inShort
        let t = longAcross ? inShort : inLong
        func point(_ u: Double, _ v: Double) -> Vec2 {
            // The quad as a bilinear patch: u along the top and bottom sides, v down the left and right ones
            let top = Vec2(q[0].x + (q[1].x - q[0].x) * u, q[0].y + (q[1].y - q[0].y) * u)
            let bottom = Vec2(q[3].x + (q[2].x - q[3].x) * u, q[3].y + (q[2].y - q[3].y) * u)
            return Vec2(top.x + (bottom.x - top.x) * v, top.y + (bottom.y - top.y) * v)
        }
        return [point(s, t), point(1 - s, t), point(1 - s, 1 - t), point(s, 1 - t)]
    }

    /// The second look at a card: the first pass found it in a small copy of the photo (where a shadow or a reflection can make the outline
    /// bigger than the card), then Vision looked again at the full-size crop around it, where the card fills much of the picture. Of the
    /// shapes found in the crop (already in the photo's pixels) the one that is card-shaped and sits inside the first outline is the
    /// better one (the closest to a card's proportion first); nil when none is, and the first stands.
    public static func refineCard(first: PickedQuad, candidates: [QuadCandidate]) -> PickedQuad? {
        let firstArea = area(first.corners)
        guard firstArea > 0 else { return nil }
        var best: (fit: Double, pick: PickedQuad)?
        for c in candidates where c.confidence >= minConfidence {
            guard let q = rectangleLike(c.corners) else { continue }
            // The same card or a tighter outline of it: inside the first, and not a speck of it (a chip, a logo) nor bigger than it
            let ratio = area(q) / firstArea
            guard ratio > 0.4, ratio < 1.3, contains(first.corners, centroid(q)) else { continue }
            let (across, down) = meanSides(q)
            let aspect = max(across, down) / min(across, down)
            guard cardAspectRange.contains(aspect) else { continue }
            let fit = abs(aspect - cardAspect)
            if best == nil || fit < best!.fit { best = (fit, PickedQuad(corners: q, confidence: c.confidence)) }
        }
        return best?.pick
    }

    // MARK: Helpers

    static func distance(_ a: Vec2, _ b: Vec2) -> Double { ((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)).squareRoot() }

    /// The angle at `b` between the sides to `a` and to `c`, degrees.
    static func interiorAngleDegrees(_ a: Vec2, _ b: Vec2, _ c: Vec2) -> Double {
        let u = Vec2(a.x - b.x, a.y - b.y), v = Vec2(c.x - b.x, c.y - b.y)
        let l = (u.x * u.x + u.y * u.y).squareRoot() * (v.x * v.x + v.y * v.y).squareRoot()
        guard l > 0 else { return 0 }
        return acos(max(-1, min(1, (u.x * v.x + u.y * v.y) / l))) * 180 / .pi
    }
}
