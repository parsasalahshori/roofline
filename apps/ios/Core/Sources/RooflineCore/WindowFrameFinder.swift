import Foundation

// Two sizes for one window. The rectangle the person confirms is the OPENING: where the wall stops (the trim or casing's inner edge), which
// is what is measured, shown big and sent. Just inside it is the window's own FRAME: the sash and its rails, a centimetre or two in on each
// side, which is what a tape measure across the window reads. This finds that inner edge in the photo: from each side of the opening it
// searches INWARD, between about 0.6 cm and 8 cm, for the first clear edge running parallel to that side along most of its length, and returns
// the inner rectangle on the same plane. Sides that find nothing take the median inset of the sides that did; fewer than two sides: no answer.
//
// The search works on the photo along the side itself. For each of up to ~160 places along the middle 80% of the side, the picture is sampled
// across it (from the opening's edge to 8 cm in, a half pixel at a time, through the plane's own projection, so a window seen at an angle is
// searched where it really is). The step in brightness across the line is measured at every depth; the edge at a depth is the step that at
// least 70% of the places agree on (a percentile, not a sum: a long line counts, a short bright thing such as a cord, a latch or a slat's
// end does not). The first such edge inward, nearly as strong as the strongest in the strip, is the window's. Blinds are why it is the FIRST
// rather than the strongest: slats make strong level lines further in, and a frame's edge is often the fainter of the two.

public enum WindowFrameFinder {
    /// The frame's edge lies this far inside the opening's (metres).
    public static let minInsetM = 0.006
    public static let maxInsetM = 0.08
    /// The line must be seen at this share of the places along the middle of the side (the ends, where the sides meet, are left out).
    public static let spanShare = 0.5
    public static let endShare = 0.1
    /// A step in brightness across a 2 px wide line, in grey levels (0...255), below which the picture is not clear about an edge.
    public static let minStep = 12.0
    /// The first edge counts when it is at least this share of the strongest edge in the strip.
    public static let firstShare = 0.1
    /// Insets this close (metres, or this share of the inset, whichever is more) are the same thickness of frame.
    public static let agreeM = 0.008
    public static let agreeShare = 0.3
    /// Two opposite edges this close (metres) and of like strength are one thin line (a cord, the gap between two slats), not a frame.
    public static let thinLineM = 0.009
    /// Edges this far apart (pixels) are the same edge: a blurred one is one peak.
    static let mergePx = 3.0
    /// The search is made in steps of this many pixels, and the edge is measured over this half-width (pixels).
    static let stepPx = 0.5
    static let halfBaselinePx = 1.0
    /// The line may lean this far end to end (pixels) from where the plane says it should be: the depth's plane is a degree off at times.
    static let leanPx = 2

    public enum Side: Int, CaseIterable, Sendable {
        case left, right, top, bottom

        var handle: FrozenRect.Handle {
            switch self {
            case .left: return .left
            case .right: return .right
            case .top: return .top
            case .bottom: return .bottom
            }
        }

        var upright: Bool { self == .left || self == .right }
    }

    /// An edge found inside a side: how far in it is, how strong (the step across it in grey levels, over 2 px) and which way (brighter
    /// inside, or darker).
    public struct Edge: Equatable, Sendable {
        public var insetM: Double
        public var step: Double
        public var brighterInside: Bool

        public init(insetM: Double, step: Double, brighterInside: Bool) {
            self.insetM = insetM
            self.step = step
            self.brighterInside = brighterInside
        }
    }

    public struct Found: Equatable, Sendable {
        /// The frame's rectangle, on the opening's plane and inside it.
        public var rect: FrozenRect
        /// How far in each side is, in metres: left, right, top, bottom.
        public var insetsM: [Double]
        /// For each side: it found its own edge in the photo (false: it takes the median inset of the sides that did).
        public var seen: [Bool]

        public var widthM: Double { rect.widthM }
        public var heightM: Double { rect.heightM }

        /// The window's size: the opening's size (as sent: the fitted, sized rectangle) less the frame's insets.
        public func size(inOpening opening: FrozenResult) -> WindowFrameSize? {
            let w = opening.widthIn - (insetsM[0] + insetsM[1]) * inchesPerMetre
            let h = opening.heightIn - (insetsM[2] + insetsM[3]) * inchesPerMetre
            guard w > 0, h > 0 else { return nil }
            return WindowFrameSize(widthIn: w, heightIn: h)
        }
    }

    /// The window's frame inside `opening`, or nil when fewer than two sides find a clear edge of their own. `photo` gives grey patches of the
    /// photo (x, y, width, height in its pixels, already inside it).
    public static func find(opening: FrozenRect, view: FrozenView, photo: OpeningFinder.PatchSource) -> Found? {
        var insets = [Double?](repeating: nil, count: 4)
        for side in Side.allCases {
            insets[side.rawValue] = first(of: edges(of: side, opening: opening, view: view, photo: photo))?.insetM
        }
        return assemble(insets: agreeing(insets), opening: opening)
    }

    /// A frame is about as thick on every side: the insets that agree with the most others (within `agreeM` or `agreeShare` of one another)
    /// stay, the rest are dropped as a slat, a cord or a shadow taken for the frame. Nil for every side when no two agree.
    public static func agreeing(_ insets: [Double?]) -> [Double?] {
        let found = insets.enumerated().compactMap { i, v in v.map { (i, $0) } }
        var best: [Int] = []
        for (_, centre) in found {
            let tol = max(agreeM, agreeShare * centre)
            let group = found.filter { abs($0.1 - centre) <= tol }.map { $0.0 }
            if group.count > best.count { best = group }
        }
        guard best.count >= 2 else { return [Double?](repeating: nil, count: insets.count) }
        return insets.enumerated().map { best.contains($0.offset) ? $0.element : nil }
    }

    /// The rectangle from each side's inset (nil where the side found none): missing sides take the median of those that did.
    public static func assemble(insets: [Double?], opening: FrozenRect) -> Found? {
        let seen = insets.compactMap { $0 }
        guard seen.count >= 2, let med = median(seen) else { return nil }
        let used = insets.map { $0 ?? med }
        var rect = opening
        rect.left += used[0]
        rect.right -= used[1]
        rect.top -= used[2]
        rect.bottom += used[3]
        guard rect.right - rect.left >= FrozenRect.minSideM, rect.top - rect.bottom >= FrozenRect.minSideM else { return nil }
        return Found(rect: rect, insetsM: used, seen: insets.map { $0 != nil })
    }

    /// The first edge inward that is nearly as strong as the strongest one in the strip (`firstShare`), or nil when there is none.
    public static func first(of edges: [Edge]) -> Edge? {
        guard let strongest = edges.map({ $0.step }).max() else { return nil }
        return edges.sorted { $0.insetM < $1.insetM }.first { $0.step >= firstShare * strongest }
    }

    // MARK: Searching a side

    /// Every clear edge parallel to one side of the opening, between `minInsetM` and `maxInsetM` inside it, nearest first.
    public static func edges(of side: Side, opening o: FrozenRect, view: FrozenView, photo: OpeningFinder.PatchSource) -> [Edge] {
        let upright = side.upright
        let lo = upright ? o.bottom : o.left, hi = upright ? o.top : o.right
        let along0 = lo + (hi - lo) * endShare, along1 = hi - (hi - lo) * endShare
        let edgeValue: Double, inward: Double
        switch side {
        case .left: (edgeValue, inward) = (o.left, 1)
        case .right: (edgeValue, inward) = (o.right, -1)
        case .top: (edgeValue, inward) = (o.top, -1)
        case .bottom: (edgeValue, inward) = (o.bottom, 1)
        }
        func world(_ along: Double, _ inset: Double) -> Vec3 {
            let across = edgeValue + inward * inset
            return upright ? o.point(s: across, t: along) : o.point(s: along, t: across)
        }
        guard let a0 = view.photoPixel(ofWorld: world(along0, 0)), let a1 = view.photoPixel(ofWorld: world(along1, 0)) else { return [] }
        let lengthPx = hypot(a1.x - a0.x, a1.y - a0.y)
        guard lengthPx >= 40 else { return [] }
        let n = min(160, max(16, Int(lengthPx / 3)))

        // Each place along the side: where its profile starts (the opening's edge) and ends (maxInsetM in), on the photo
        var starts: [Vec2] = [], ends: [Vec2] = []
        for i in 0..<n {
            let along = along0 + (along1 - along0) * Double(i) / Double(n - 1)
            guard let p = view.photoPixel(ofWorld: world(along, 0)), let q = view.photoPixel(ofWorld: world(along, maxInsetM)) else { return [] }
            starts.append(p)
            ends.append(q)
        }
        let acrossPx = zip(starts, ends).map { hypot($1.x - $0.x, $1.y - $0.y) }.reduce(0, +) / Double(n)
        // Too far away for a 2 px wide line to mean anything within 8 cm
        guard acrossPx >= 14 else { return [] }
        let k = min(400, max(24, Int((acrossPx / stepPx).rounded())))
        let h = max(1, Int((halfBaselinePx / stepPx).rounded()))
        let margin = h + 2 * leanPx + 2
        let count = k + 1 + 2 * margin

        // The grey patch holding every profile (the profiles run a little past both ends)
        var minX = Double.infinity, maxX = -Double.infinity, minY = Double.infinity, maxY = -Double.infinity
        let extend = Double(margin) / Double(k)
        for (p, q) in zip(starts, ends) {
            for t in [-extend, 1 + extend] {
                let x = p.x + (q.x - p.x) * t, y = p.y + (q.y - p.y) * t
                minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
            }
        }
        let x0 = max(0, Int((minX - 3).rounded(.down))), y0 = max(0, Int((minY - 3).rounded(.down)))
        let x1 = min(Int(view.photoWidthPx), Int((maxX + 3).rounded(.up))), y1 = min(Int(view.photoHeightPx), Int((maxY + 3).rounded(.up)))
        guard x1 - x0 >= 8, y1 - y0 >= 8, let patch = photo(x0, y0, x1 - x0, y1 - y0), patch.isValid, patch.width == x1 - x0, patch.height == y1 - y0 else { return [] }

        // The brightness along each profile (NaN where it leaves the patch)
        var grey = [Float](repeating: .nan, count: n * count)
        for i in 0..<n {
            let p = starts[i], q = ends[i]
            for j in 0..<count {
                let t = Double(j - margin) / Double(k)
                grey[i * count + j] = sample(patch, x: p.x + (q.x - p.x) * t - Double(x0), y: p.y + (q.y - p.y) * t - Double(y0))
            }
        }

        // The step across the line at each depth, for each way the line may lean: the value 70% of the places reach
        let leans = Array(-leanPx...leanPx)
        var best = [Double](repeating: 0, count: k + 1)
        var rising = [Bool](repeating: true, count: k + 1)
        var values: [Float] = []
        values.reserveCapacity(n)
        for lean in leans {
            for depth in 0...k {
                values.removeAll(keepingCapacity: true)
                for i in 0..<n {
                    // The lean runs from -lean/2 px at one end to +lean/2 px at the other, in steps
                    let shift = Int((Double(lean) * 2 * (Double(i) / Double(n - 1) - 0.5)).rounded())
                    let j = depth + margin + shift
                    guard j - h >= 0, j + h < count else { continue }
                    let g = grey[i * count + j + h] - grey[i * count + j - h]
                    if g.isFinite { values.append(g) }
                }
                guard values.count >= max(8, n / 2) else { continue }
                values.sort()
                let m = values.count
                let up = Double(values[Int(Double(m - 1) * (1 - spanShare))])
                let down = -Double(values[Int(Double(m - 1) * spanShare)])
                let strength = max(up, down)
                if strength > best[depth] {
                    best[depth] = strength
                    rising[depth] = up >= down
                }
            }
        }

        // A little smoothing, then the peaks
        let smooth = (0...k).map { d -> Double in
            var sum = 0.0, weight = 0.0
            for j in -2...2 where d + j >= 0 && d + j <= k {
                let w = Double(3 - abs(j))
                sum += best[d + j] * w
                weight += w
            }
            return sum / weight
        }
        let kMin = Int((minInsetM / maxInsetM * Double(k)).rounded(.up))
        let window = Int((mergePx / stepPx).rounded())
        var out: [Edge] = []
        guard kMin + 1 < k else { return [] }
        for d in kMin..<k where smooth[d] >= minStep {
            // A peak: no weaker than anything within a few pixels each way inside the search (the earlier of two equal ones). The tail of the
            // opening's own strong edge, before `kMin`, does not count against an edge close to it.
            var isPeak = true
            for j in 1...window {
                if d - j >= kMin, smooth[d - j] > smooth[d] { isPeak = false; break }
                if d + j <= k, smooth[d + j] >= smooth[d] { isPeak = false; break }
            }
            // At the edge of the search it is the slope of something further out, not an edge
            guard isPeak, d > kMin, d < k else { continue }
            out.append(Edge(insetM: maxInsetM * Double(d) / Double(k), step: smooth[d], brighterInside: rising[d]))
        }
        return withoutThinLines(out)
    }

    /// The edges without those that are the two sides of one thin line: a dark line makes a step down and a step up right after it.
    public static func withoutThinLines(_ edges: [Edge]) -> [Edge] {
        let e = edges.sorted { $0.insetM < $1.insetM }
        var out: [Edge] = []
        var i = 0
        while i < e.count {
            if i + 1 < e.count, e[i].brighterInside != e[i + 1].brighterInside, e[i + 1].insetM - e[i].insetM <= thinLineM,
               e[i].step / e[i + 1].step < 2.5, e[i + 1].step / e[i].step < 2.5 {
                i += 2
            } else {
                out.append(e[i])
                i += 1
            }
        }
        return out
    }

    /// Bilinear grey at a point (patch pixels; pixel (i, j) covers i...i+1), NaN outside the patch.
    private static func sample(_ patch: GrayPatch, x: Double, y: Double) -> Float {
        let u = x - 0.5, v = y - 0.5
        let i = Int(u.rounded(.down)), j = Int(v.rounded(.down))
        guard i >= 0, j >= 0, i + 1 < patch.width, j + 1 < patch.height else { return .nan }
        let fx = Float(u - Double(i)), fy = Float(v - Double(j))
        let a = Float(patch.pixels[j * patch.width + i]), b = Float(patch.pixels[j * patch.width + i + 1])
        let c = Float(patch.pixels[(j + 1) * patch.width + i]), d = Float(patch.pixels[(j + 1) * patch.width + i + 1])
        return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
    }
}

/// The window's own size (inside the opening), in inches: what the screens show next to the opening's. Never sent to the server.
public struct WindowFrameSize: Codable, Equatable, Sendable {
    public var widthIn: Double
    public var heightIn: Double
    /// Not seen in the photo (blinds over the frame): the opening less a typical frame (`typicalFrameM` each side). Optional so
    /// sizes saved before it still read.
    public var estimated: Bool?

    public init(widthIn: Double, heightIn: Double, estimated: Bool? = nil) {
        self.widthIn = widthIn
        self.heightIn = heightIn
        self.estimated = estimated
    }

    /// A window frame's usual width inside the opening, each side (the owner's own window: 88 cm opening, 84.5 cm window).
    public static let typicalFrameM = 0.0175
    /// The window when its frame could not be seen: the opening less `typicalFrameM` on every side, marked estimated.
    public static func estimate(openingWidthIn w: Double, openingHeightIn h: Double) -> WindowFrameSize? {
        let inset = 2 * typicalFrameM * inchesPerMetre
        guard w > inset * 2, h > inset * 2 else { return nil }
        return WindowFrameSize(widthIn: w - inset, heightIn: h - inset, estimated: true)
    }

    /// "33 1/4 × 54 3/8 in"
    public var text: String { SizeWording.sizeText(widthIn: widthIn, heightIn: heightIn) }
    /// "Window about 33 1/4 × 54 3/8 in"
    public var line: String { TwoSizes.windowLine(self) }
}

/// The words for the two sizes of one window.
public enum TwoSizes {
    /// "Opening 34 5/8 × 55 3/4 in"
    public static func openingLine(widthIn: Double, heightIn: Double) -> String { "Opening " + SizeWording.sizeText(widthIn: widthIn, heightIn: heightIn) }
    /// "Window about 33 1/4 × 54 3/8 in"
    public static func windowLine(_ s: WindowFrameSize) -> String { "Window about " + s.text + (s.estimated == true ? " (estimated)" : "") }
    /// For VoiceOver: "Window about 33 and a quarter by 54 and 3 eighths inches".
    public static func windowSpoken(_ s: WindowFrameSize) -> String { "Window about " + SizeWording.spokenSize(widthIn: s.widthIn, heightIn: s.heightIn) }
}
