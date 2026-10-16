import Foundation

/// The size of a window saved on the phone, before the server has sized it: the same math the server runs (the AR port,
/// the room scan's own width and height, the card homography), so the list and the label sheet can show a number at once
/// and the server's answer, when it comes, is a refinement and not a surprise.
public struct WindowPreview: Equatable, Sendable {
    public var widthIn: Double
    public var heightIn: Double
    /// About 1 sigma, inches (the larger of width and height).
    public var uncertaintyIn: Double?
    public var needsCheck: Bool
    /// Why it needs a check, in plain words.
    public var reasons: [String]

    /// A size that is worth showing: one the phone is not wildly unsure about. A card photo taken far from the glass can come
    /// out at "about 20 inches" of doubt; a number with that much doubt is noise, so the screens say the size comes after
    /// upload (the server's own answer) instead of printing it.
    public static let showableUncertaintyIn = 4.0

    public var isShowable: Bool { (uncertaintyIn ?? 0) <= Self.showableUncertaintyIn }

    public init(widthIn: Double, heightIn: Double, uncertaintyIn: Double?, needsCheck: Bool, reasons: [String] = []) {
        self.widthIn = widthIn
        self.heightIn = heightIn
        self.uncertaintyIn = uncertaintyIn
        self.needsCheck = needsCheck
        self.reasons = reasons
    }
}

public enum LocalWindowPreview {
    /// Nil when the window cannot be sized on the phone (the size comes after upload).
    public static func of(_ w: PhotoWindowInput, imageWidthPx: Int, imageHeightPx: Int) -> WindowPreview? {
        switch w.scale {
        case .ar(let s):
            guard let size = sizeFromArPoints(s.pointsM, device: s.device ?? .arkit, cornerSpreadM: s.cornerSpreadM) else { return nil }
            return WindowPreview(widthIn: size.widthIn, heightIn: size.heightIn, uncertaintyIn: max(size.uncertaintyWidthIn, size.uncertaintyHeightIn),
                                 needsCheck: size.quality == .check, reasons: size.reasons)
        case .roomplan(let s):
            let u = RoomPlanLimits.uncertaintyIn(s.confidence)
            return WindowPreview(widthIn: s.widthM * inchesPerMetre, heightIn: s.heightM * inchesPerMetre, uncertaintyIn: u,
                                 needsCheck: s.confidence == .low, reasons: s.confidence == .low ? ["The scan was not sure about this window."] : [])
        case .card(let c):
            guard let corners = w.corners, imageWidthPx > 0, imageHeightPx > 0,
                  let size = CardSizing.size(cardCorners: c.cardCorners, windowCorners: corners, imageWidthPx: Double(imageWidthPx), imageHeightPx: Double(imageHeightPx)) else { return nil }
            return WindowPreview(widthIn: size.widthIn, heightIn: size.heightIn, uncertaintyIn: max(size.uncertaintyWidthIn, size.uncertaintyHeightIn),
                                 needsCheck: size.quality == .check, reasons: size.reasons)
        case .other:
            return nil
        }
    }
}

/// How a window was measured, in the words of the list ("Depth sensor · about 1/8 in").
public enum MethodLabel {
    public static func list(_ scale: WindowPhotoScale) -> String {
        switch scale {
        case .ar(let s): return s.device == .arkitLidar ? "Depth sensor" : "Phone camera"
        case .roomplan: return "Room scan"
        case .card: return "Card photo"
        case .other: return "Measured"
        }
    }

    /// "Depth sensor · about 1/8 in" ("Room scan · about ±1 in" for the scan, whose ± is the same for every window).
    public static func listLine(_ scale: WindowPhotoScale, uncertaintyIn: Double?) -> String {
        let name = list(scale)
        guard let u = uncertaintyIn else { return name }
        if case .roomplan = scale { return "\(name) · \(SizeWording.plusMinus(u))" }
        return "\(name) · \(SizeWording.accuracyShort(u))"
    }
}
