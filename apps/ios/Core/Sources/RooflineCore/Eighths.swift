import Foundation

/// Inches the way a window installer reads a tape: whole inches and eighths ("35 7/8").
public enum Eighths {
    /// Nearest eighth: 35.87 -> "35 7/8", 36.0 -> "36", 0.25 -> "1/4". Negative values get a leading "-".
    public static func format(_ inches: Double) -> String {
        guard inches.isFinite else { return "—" }
        let sign = inches < 0 ? "-" : ""
        let eighths = Int((abs(inches) * 8).rounded())
        return sign + fromEighths(eighths)
    }

    /// An uncertainty, rounded UP to the next eighth (at least 1/8): an honest ±, never smaller than measured.
    public static func formatUncertainty(_ inches: Double) -> String {
        guard inches.isFinite, inches > 0 else { return "1/8" }
        // A hair over an eighth from float noise (0.12500000001) stays 1/8
        let eighths = max(1, Int((inches * 8 - 1e-6).rounded(.up)))
        return fromEighths(eighths)
    }

    /// "35 7/8 ± 1/4" (no ± when the uncertainty is unknown).
    public static func withPlusMinus(_ inches: Double, _ uncertainty: Double?) -> String {
        guard let u = uncertainty else { return format(inches) }
        return "\(format(inches)) ± \(formatUncertainty(u))"
    }

    /// "35 7/8 × 59 1/2 in".
    public static func size(widthIn: Double, heightIn: Double) -> String {
        "\(format(widthIn)) × \(format(heightIn)) in"
    }

    /// Rounded to the nearest eighth, as a number (what an order sheet would carry).
    public static func rounded(_ inches: Double) -> Double {
        (inches * 8).rounded() / 8
    }

    private static func fromEighths(_ eighths: Int) -> String {
        let whole = eighths / 8
        var num = eighths % 8
        guard num != 0 else { return "\(whole)" }
        var den = 8
        while num % 2 == 0 {
            num /= 2
            den /= 2
        }
        return whole == 0 ? "\(num)/\(den)" : "\(whole) \(num)/\(den)"
    }
}
