import Foundation

// The window visualizer's collection: the kinds of window a homeowner can try on their own photo, the grids, the glass, and how each
// kind is quoted. The geometry that draws them is in WindowLayout.swift; the drawing and the photo warp are in the app.

/// A kind of window in the gallery. Plain industry names (the company's own product names are not used).
public enum VisualWindowType: String, Codable, CaseIterable, Sendable, Identifiable {
    case doubleHung, singleHung, slider2, slider3, casement, casementPair, awning, hopper, picture, pictureCasements
    case bay, bow, garden, arch, halfRound, circle, specialty

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .doubleHung: return "Double-hung"
        case .singleHung: return "Single-hung"
        case .slider2: return "2-lite slider"
        case .slider3: return "3-lite slider"
        case .casement: return "Casement"
        case .casementPair: return "Casement pair"
        case .awning: return "Awning"
        case .hopper: return "Hopper"
        case .picture: return "Picture"
        case .pictureCasements: return "Picture + casements"
        case .bay: return "Bay"
        case .bow: return "Bow"
        case .garden: return "Garden"
        case .arch: return "Arch top"
        case .halfRound: return "Half-round"
        case .circle: return "Circle"
        case .specialty: return "Specialty shape"
        }
    }

    /// One line under the picture.
    public var summary: String {
        switch self {
        case .doubleHung: return "Both sashes slide up and down, and tilt in to clean."
        case .singleHung: return "The bottom sash slides up; the top stays fixed."
        case .slider2: return "Two panes side by side; one slides across."
        case .slider3: return "The two end panes slide past a fixed middle."
        case .casement: return "One sash swings out on side hinges with a crank."
        case .casementPair: return "Two sashes swing out from the middle, each with a crank."
        case .awning: return "Hinged at the top, so it cranks out at the bottom."
        case .hopper: return "Hinged at the bottom, so it tilts in at the top."
        case .picture: return "Fixed glass that doesn't open, for the biggest view."
        case .pictureCasements: return "A fixed middle with a casement that opens on each side."
        case .bay: return "Three angled panels that reach out from the wall."
        case .bow: return "Five panels in a gentle curve out from the wall."
        case .garden: return "A glass box that sticks out, with a shelf inside."
        case .arch: return "A round top on a straight-sided window."
        case .halfRound: return "A half circle of fixed glass, often over another window."
        case .circle: return "A round window of fixed glass."
        case .specialty: return "Shown as an octagon. Other shapes are priced at your visit."
        }
    }

    /// The one of the server's nine style keys that stands for this kind, or nil when none does (the kind is then quoted at the
    /// visit, under the catalog's "bay, bow or odd shape" tile).
    public var styleKey: String? {
        switch self {
        case .doubleHung: return "double-hung"
        case .singleHung: return "single-hung"
        case .slider2: return "slider-2"
        case .slider3: return "slider-3"
        case .casement, .casementPair: return "casement"
        case .awning: return "awning"
        case .picture: return "picture"
        case .arch, .halfRound: return "arch"
        case .circle: return "circle"
        case .hopper, .pictureCasements, .bay, .bow, .garden, .specialty: return nil
        }
    }

    /// True when the window is a hung window (the top grid only goes in the upper sash).
    public var isHung: Bool { self == .doubleHung || self == .singleHung }

    /// The kind a style the window already has stands for (where the gallery starts), nil for a key it does not know.
    public static func from(styleKey key: String?) -> VisualWindowType? {
        switch key {
        case "double-hung": return .doubleHung
        case "single-hung": return .singleHung
        case "slider-2": return .slider2
        case "slider-3": return .slider3
        case "casement": return .casement
        case "awning": return .awning
        case "picture": return .picture
        case "arch": return .arch
        case "circle": return .circle
        default: return nil
        }
    }

    /// The kinds shown together, in the order of the gallery.
    public static let gallery: [VisualWindowType] = allCases
}

/// Muntins (grid bars) between the glass.
public enum VisualGrid: String, Codable, CaseIterable, Sendable, Identifiable {
    case none, colonial, prairie, diamond, queenAnne, topOnly

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .none: return "No grid"
        case .colonial: return "Colonial"
        case .prairie: return "Prairie"
        case .diamond: return "Diamond"
        case .queenAnne: return "Queen Anne"
        case .topOnly: return "Top only"
        }
    }

    public var summary: String {
        switch self {
        case .none: return "Clear glass, nothing across it."
        case .colonial: return "Even squares, like 6 over 6."
        case .prairie: return "A border of small panes round the edge."
        case .diamond: return "A lattice of diamonds."
        case .queenAnne: return "Small panes along the top."
        case .topOnly: return "Colonial squares in the upper part only."
        }
    }
}

public enum VisualGlass: String, Codable, CaseIterable, Sendable, Identifiable {
    case clear, lowE, frosted

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .clear: return "Clear"
        case .lowE: return "Low-E"
        case .frosted: return "Frosted"
        }
    }

    public var summary: String {
        switch self {
        case .clear: return "Plain glass: the view as it is."
        case .lowE: return "Energy-saving coating, with a faint tint."
        case .frosted: return "Obscure glass for privacy, like a bathroom."
        }
    }
}

/// What the homeowner chose to see for one window. The frame color is the window's own colour (HomeownerProgress.colors), kept apart
/// because the style screen already carries it.
public struct WindowVisualLook: Codable, Equatable, Sendable {
    public var type: VisualWindowType
    public var grid: VisualGrid
    public var glass: VisualGlass
    /// Panes show a soft sky instead of the photo's own view (it hides the old window's bars and blinds).
    public var cleanGlass: Bool

    public init(type: VisualWindowType = .doubleHung, grid: VisualGrid = .none, glass: VisualGlass = .clear, cleanGlass: Bool = false) {
        self.type = type
        self.grid = grid
        self.glass = glass
        self.cleanGlass = cleanGlass
    }

    private enum Keys: String, CodingKey { case type, grid, glass, cleanGlass }

    // Lenient: a look written by another build still reads
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        type = (try? c.decodeIfPresent(VisualWindowType.self, forKey: .type)) ?? .doubleHung
        grid = (try? c.decodeIfPresent(VisualGrid.self, forKey: .grid)) ?? .none
        glass = (try? c.decodeIfPresent(VisualGlass.self, forKey: .glass)) ?? .clear
        cleanGlass = (try? c.decodeIfPresent(Bool.self, forKey: .cleanGlass)) ?? false
    }

    /// "Double-hung, white, colonial grid, low-E glass" (the colour's label as the brand words it; the grid and glass only when they are not plain).
    public func summary(colorLabel: String?) -> String {
        var parts = [type.title]
        if let c = colorLabel, !c.isEmpty { parts.append(c.lowercased()) }
        if grid != .none { parts.append(grid == .topOnly ? "top-only grid" : "\(grid.title.lowercased()) grid") }
        if glass != .clear { parts.append("\(glass.title.lowercased()) glass") }
        return parts.joined(separator: ", ")
    }
}

/// How a kind of window is quoted through the existing contract (a style key the catalog offers, nothing more is sent).
public struct VisualStyleMapping: Equatable, Sendable {
    /// The key the existing flow sends as the window's `style`.
    public var key: String
    /// The catalog's own words for the choice ("Opens up and down").
    public var optionLabel: String
    /// True: the window is counted but priced by the company at the visit.
    public var atVisit: Bool
    /// True: the key is the kind's own style (else it is the offered tile that holds it, or the "odd shape" tile).
    public var exact: Bool

    /// One line for the screen: what happens to the quote when this window is used.
    public var quoteLine: String {
        if atVisit { return "Quoted at your visit" }
        return "Quoted as \(optionLabel.lowercased())"
    }
}

public enum VisualCatalog {
    /// The offered style that stands for `type`: the type's own style when the catalog lists it, else the offered tile that holds
    /// it (single-hung under "opens up and down"), else the catalog's "at visit" tile (hopper, bay, bow, garden, the combo and odd shapes).
    /// With no catalog at all the four plain tiles stand in.
    public static func mapping(for type: VisualWindowType, offered: [HomeownerStyleOption]) -> VisualStyleMapping {
        let options = offered.isEmpty ? HomeownerStyleOption.plain : offered
        func make(_ o: HomeownerStyleOption, exact: Bool) -> VisualStyleMapping {
            VisualStyleMapping(key: o.key, optionLabel: o.label, atVisit: o.atVisit, exact: exact)
        }
        if let wanted = type.styleKey {
            if let o = options.first(where: { $0.key == wanted }) { return make(o, exact: true) }
            if let k = StyleGuess.offeredKey(for: wanted, offered: options.map(\.key)), let o = options.first(where: { $0.key == k }) { return make(o, exact: false) }
        }
        if let o = options.first(where: { $0.atVisit }) { return make(o, exact: false) }
        // A catalog with no "at visit" tile: the closest plain choice (the picture window never opens, like most of these)
        let o = options.first(where: { $0.key == "picture" }) ?? options[0]
        return make(o, exact: false)
    }

    /// Where the gallery starts for a window: the kind its style already stands for, else the first the catalog offers, else the double-hung.
    public static func startingType(styleKey: String?, offered: [HomeownerStyleOption]) -> VisualWindowType {
        if let t = VisualWindowType.from(styleKey: styleKey) { return t }
        if let k = styleKey, let o = offered.first(where: { $0.key == k }) {
            if o.atVisit { return .bay }
            if let t = VisualWindowType.from(styleKey: o.key) { return t }
        }
        return .doubleHung
    }
}
