import Foundation

/// What a measure screen needs: where to save, and which window it is.
struct MeasureContext: Identifiable, Hashable {
    var measurementId: String
    var address: String
    /// The window this photo belongs to (shared by every photo of it).
    var windowKey: String
    var label: String
    /// Measuring a window that is already on the list (another pass), not a new one.
    var again: Bool

    var id: String { "\(measurementId)/\(windowKey)/\(again)" }
}
