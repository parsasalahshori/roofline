import Foundation

// "Looks like a standard 24 × 36 window." Replacement windows come in a short list of common sizes, so a measured size that lands on one is
// worth saying: it is a way for the homeowner to see that the number is believable. It is a SUGGESTION on the screen only: what is sent to the
// server and what a window is priced on stay the measured size.
//
// Sizes are the nominal width × height in inches of a double-hung or a slider. A unit is made a half inch smaller than its nominal size
// (a "36 × 60" is 35 1/2 × 59 1/2), and a measured opening is a little off, so a measured side matches a nominal side when it is within an inch
// of the nominal or of the nominal minus a half inch.

public struct StandardWindowSize: Equatable, Hashable, Sendable {
    public enum Kind: String, Sendable {
        case doubleHung = "double-hung"
        case slider
        case small
    }

    public let widthIn: Int
    public let heightIn: Int
    public let kind: Kind

    public init(_ widthIn: Int, _ heightIn: Int, _ kind: Kind) {
        self.widthIn = widthIn
        self.heightIn = heightIn
        self.kind = kind
    }

    /// "24 × 36"
    public var label: String { "\(widthIn) × \(heightIn)" }

    /// "Looks like a standard 24 × 36 window"
    public var sentence: String { "Looks like a standard \(label) window" }
}

public enum StandardWindowSizes {
    /// A measured side matches a nominal side within this many inches of the nominal, or of the nominal less `unitAllowanceIn`.
    public static let toleranceIn = 1.0
    public static let unitAllowanceIn = 0.5

    /// Double-hungs in the widths and heights that are stocked, every combination: 24 to 40 wide and 36 to 72 high.
    public static let doubleHungWidthsIn = [24, 28, 30, 32, 34, 36, 40]
    public static let doubleHungHeightsIn = [36, 38, 40, 44, 46, 48, 52, 54, 60, 62, 72]
    /// Sliders (wider than they are high): 36 to 72 wide and 24 to 60 high.
    public static let sliderWidthsIn = [36, 44, 48, 52, 60, 72]
    public static let sliderHeightsIn = [24, 36, 40, 48, 52, 60]

    /// The common sizes, most common first (a tie in the match goes to the earlier one): double-hungs, then sliders, then the one small square.
    public static let all: [StandardWindowSize] = {
        var out: [StandardWindowSize] = []
        for h in doubleHungHeightsIn { for w in doubleHungWidthsIn { out.append(StandardWindowSize(w, h, .doubleHung)) } }
        for h in sliderHeightsIn {
            for w in sliderWidthsIn where w > h && !out.contains(where: { $0.widthIn == w && $0.heightIn == h }) { out.append(StandardWindowSize(w, h, .slider)) }
        }
        out.append(StandardWindowSize(24, 24, .small))
        return out
    }()

    /// How far a measured side is from a nominal one: to the nominal or to the nominal less a half inch, whichever is nearer.
    static func distance(measured: Double, nominal: Int) -> Double {
        min(abs(measured - Double(nominal)), abs(measured - (Double(nominal) - unitAllowanceIn)))
    }

    /// The nearest standard size when BOTH sides are within `toleranceIn` of it (nominal, or nominal less a half inch); else nil. Nearest is
    /// the smallest sum of the two sides' squared distances.
    public static func suggestion(widthIn: Double, heightIn: Double) -> StandardWindowSize? {
        guard widthIn.isFinite, heightIn.isFinite, widthIn > 0, heightIn > 0 else { return nil }
        var best: (size: StandardWindowSize, score: Double)?
        for s in all {
            let dw = distance(measured: widthIn, nominal: s.widthIn), dh = distance(measured: heightIn, nominal: s.heightIn)
            guard dw <= toleranceIn + 1e-9, dh <= toleranceIn + 1e-9 else { continue }
            let score = dw * dw + dh * dh
            if best == nil || score < best!.score - 1e-12 { best = (s, score) }
        }
        return best?.size
    }

    /// The line to show under a measured size, or nil.
    public static func line(widthIn: Double, heightIn: Double) -> String? { suggestion(widthIn: widthIn, heightIn: heightIn)?.sentence }
}
