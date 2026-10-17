import Foundation

/// How the homeowner app WRITES sizes and accuracy (REDESIGN.md section 8.3). The rules, all in one place so every
/// screen and every test agrees:
/// - sizes are whole inches plus an eighth, reduced ("35 5/8", never "35.625", never "35 4/8");
/// - accuracy is never a bare "±": it is "about 1/8 inch" (or "about ±1 in each" for the room scan), and it is rounded
///   UP to the next eighth, so the app never claims to be more exact than it measured;
/// - "depth sensor", not "LiDAR"; "bank card", not "ID-1" (those live in the screens' copy, not here).
public enum SizeWording {
    /// A length as a tape reads it: whole inches and a reduced fraction of an inch (the numerator is 0 for none).
    public struct Parts: Equatable, Sendable {
        public var whole: Int
        public var numerator: Int
        public var denominator: Int

        public var hasFraction: Bool { numerator != 0 }

        public init(whole: Int, numerator: Int, denominator: Int) {
            self.whole = whole
            self.numerator = numerator
            self.denominator = denominator
        }
    }

    /// The nearest eighth, reduced: 35.625 -> 35 5/8, 35.5 -> 35 1/2, 35.97 -> 36. Negative and non-finite lengths give 0.
    public static func parts(_ inches: Double) -> Parts {
        guard inches.isFinite, inches > 0 else { return Parts(whole: 0, numerator: 0, denominator: 1) }
        return partsFromEighths(Int((inches * 8).rounded()))
    }

    /// "35 5/8", "36", "1/2".
    public static func text(_ inches: Double) -> String {
        let p = parts(inches)
        if !p.hasFraction { return "\(p.whole)" }
        return p.whole == 0 ? "\(p.numerator)/\(p.denominator)" : "\(p.whole) \(p.numerator)/\(p.denominator)"
    }

    /// "35 5/8 × 59 5/8 in".
    public static func sizeText(widthIn: Double, heightIn: Double) -> String {
        "\(text(widthIn)) × \(text(heightIn)) in"
    }

    /// The server's own wording ("35 5/8 x 59 5/8") read back into inches. Nil when it is not two lengths.
    public static func parseSizeLabel(_ label: String) -> (widthIn: Double, heightIn: Double)? {
        let separators = CharacterSet(charactersIn: "x×X")
        let halves = label.components(separatedBy: separators)
        guard halves.count == 2, let w = parseLength(halves[0]), let h = parseLength(halves[1]) else { return nil }
        return (w, h)
    }

    /// "35 5/8" or "35" or "5/8" (a trailing "in" or quote mark is ignored).
    public static func parseLength(_ text: String) -> Double? {
        let cleaned = text.replacingOccurrences(of: "in", with: "").replacingOccurrences(of: "\"", with: "")
            .trimmingCharacters(in: .whitespaces)
        guard !cleaned.isEmpty else { return nil }
        var total = 0.0
        for piece in cleaned.split(separator: " ") {
            if piece.contains("/") {
                let f = piece.split(separator: "/")
                guard f.count == 2, let n = Double(f[0]), let d = Double(f[1]), d != 0 else { return nil }
                total += n / d
            } else if let v = Double(piece) {
                total += v
            } else {
                return nil
            }
        }
        return total
    }

    // MARK: Accuracy

    /// An uncertainty rounded UP to the next eighth, at least 1/8: the honest figure to print.
    public static func roundedUpUncertainty(_ inches: Double) -> Double {
        guard inches.isFinite, inches > 0 else { return 0.125 }
        // A hair over an eighth from float noise (0.12500000001) stays 1/8
        return Double(max(1, Int((inches * 8 - 1e-6).rounded(.up)))) / 8
    }

    /// "about 1/8 inch", "about 1 inch", "about 1 1/2 inches".
    public static func accuracy(_ inches: Double) -> String {
        let u = roundedUpUncertainty(inches)
        return "about \(text(u)) \(u <= 1 ? "inch" : "inches")"
    }

    /// "about 1/8 in": the short form on a list row.
    public static func accuracyShort(_ inches: Double) -> String {
        "about \(text(roundedUpUncertainty(inches))) in"
    }

    /// "about ±1 in": a plus-or-minus is only ever written after "about".
    public static func plusMinus(_ inches: Double) -> String {
        "about ±\(text(roundedUpUncertainty(inches))) in"
    }

    /// "about ±1 in each": for a list of sizes that all share one uncertainty (the room scan).
    public static func plusMinusEach(_ inches: Double) -> String {
        plusMinus(inches) + " each"
    }

    /// "About 1/4 to 1/2 inch" (a method's typical range, in a tag).
    public static func accuracyRange(lowIn: Double, highIn: Double) -> String {
        let lo = roundedUpUncertainty(lowIn), hi = roundedUpUncertainty(highIn)
        if lo == hi { return "About \(text(lo)) \(lo <= 1 ? "inch" : "inches")" }
        return "About \(text(lo)) to \(text(hi)) \(hi <= 1 ? "inch" : "inches")"
    }

    // MARK: Spoken (VoiceOver)

    /// "35 and 5 eighths", "35 and a half", "36", "a quarter".
    public static func spoken(_ inches: Double) -> String {
        let p = parts(inches)
        guard p.hasFraction else { return "\(p.whole)" }
        let fraction: String
        switch (p.numerator, p.denominator) {
        case (1, 2): fraction = "a half"
        case (1, 4): fraction = "a quarter"
        case (3, 4): fraction = "three quarters"
        case (1, 8): fraction = "an eighth"
        default: fraction = "\(p.numerator) eighths"
        }
        return p.whole == 0 ? fraction : "\(p.whole) and \(fraction)"
    }

    /// "35 and 5 eighths by 59 and 5 eighths inches".
    public static func spokenSize(widthIn: Double, heightIn: Double) -> String {
        "\(spoken(widthIn)) by \(spoken(heightIn)) inches"
    }

    /// "about 1 eighth of an inch" for VoiceOver.
    public static func spokenAccuracy(_ inches: Double) -> String {
        let u = roundedUpUncertainty(inches)
        let s = spoken(u)
        return "about \(s) \(u <= 1 ? (u == 1 ? "inch" : "of an inch") : "inches")"
    }

    // MARK: Pieces

    private static func partsFromEighths(_ eighths: Int) -> Parts {
        let whole = eighths / 8
        var num = eighths % 8
        guard num != 0 else { return Parts(whole: whole, numerator: 0, denominator: 1) }
        var den = 8
        while num % 2 == 0 {
            num /= 2
            den /= 2
        }
        return Parts(whole: whole, numerator: num, denominator: den)
    }
}
