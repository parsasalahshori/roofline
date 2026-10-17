import SwiftUI
import UIKit

/// Roofline's "Chalk Line" design, WinChoice in the brand slot (REDESIGN.md sections 5, 7, 8; the mockups in
/// ~/RooflineWork/design/mockups/ios-hw-*.html). Semantic colours, light and dark, from the mockups' own tokens:
/// - RED (#ED3A2B) is the one main action on a screen;
/// - NAVY is the welcome hero and ink;
/// - BLUE (#155EAB) is selection, links, and "you picked this";
/// - tape yellow is only for measuring guides; green, amber and red-brick are status, always with an icon and a word.
/// Headings are the system font at `.width(.expanded)` (Archivo's role); sizes are monospaced digits (SF Mono's role).
enum Theme {
    // MARK: Colours

    /// The company's own colours (Brand/WinChoice/WinChoice.json): the brand slot and the ink. Everything else in the look
    /// (grounds, lines, status colours, the measuring tape) is Roofline's and the same for every company.
    private static let brand = Brand.current.colors

    static let ground = Color(light: 0xF3F5F8, dark: 0x08111D)
    static let surface = Color(light: 0xFFFFFF, dark: 0x0F1A28)
    static let surface2 = Color(light: 0xF6F7F5, dark: 0x142132)
    static let sunken = Color(light: 0xE6E9E6, dark: 0x0C121A)
    static let raised = Color(light: 0xFFFFFF, dark: 0x1A2431)

    static let ink = Color(light: Color.parse(brand.navy), dark: 0xE7ECF3)
    static let ink2 = Color(light: 0x3B4A5E, dark: 0xA9B6C6)
    /// The quiet text. A touch darker than the mockups' #66748A / #7F8C9D so small text clears 4.5:1 on every tint and surface
    /// (Apple's accessibility audit flagged the original as nearly passing).
    static let ink3 = Color(light: 0x5B687D, dark: 0x8A97A8)

    static let line = Color(light: 0xDCE0DF, dark: 0x203045)
    static let line2 = Color(light: 0xC5CBCB, dark: 0x2C3F57)

    /// The brand slot: WinChoice red. The one main button of a screen.
    static let red = Color(light: Color.parse(brand.red), dark: Color.parse(brand.redDark))
    static let onRed = Color.white
    static let redTint = Color(light: 0xFDE8E6, dark: 0x3A1512)

    /// Selection, links, "you picked this".
    static let blue = Color(light: Color.parse(brand.blue), dark: Color.parse(brand.blueDark))
    static let blueTint = Color(light: 0xE6EEF8, dark: 0x132A47)

    /// The welcome hero, in both appearances.
    static let navy = Color(light: Color.parse(brand.navyDeep), dark: Color.parse(brand.navyDeep))
    static let heroText = Color(light: 0xC3CFDE, dark: 0xC3CFDE)

    static let ok = Color(light: 0x157545, dark: 0x48C27F)
    static let okTint = Color(light: 0xE2F2E8, dark: 0x0F2A1C)
    static let warn = Color(light: 0x985800, dark: 0xF0A63A)
    static let warnTint = Color(light: 0xFCEFD9, dark: 0x33230A)
    static let info = Color(light: 0x2563C9, dark: 0x6FA2FF)
    static let infoTint = Color(light: 0xE3ECFA, dark: 0x11223F)
    static let bad = Color(light: 0xC8352A, dark: 0xFF6F61)

    /// Measuring guides only (the corners, the sides, the magnifier's dashes).
    static let tape = Color(light: 0xFFC21F, dark: 0xFFCB3D)
    static let tapeInk = Color(light: 0x1A1405, dark: 0x1A1405)

    // MARK: Shape

    /// 14 pt: cards and buttons on the homeowner screens.
    static let radius: CGFloat = 14
    static let gutter: CGFloat = 16
    /// The main button's height (52 to 54 in the mockups) and the minimum tap target.
    static let buttonHeight: CGFloat = 54
    static let secondaryButtonHeight: CGFloat = 50
    static let minTap: CGFloat = 44
}

extension Color {
    /// A colour that follows the light and dark appearance.
    init(light: UInt32, dark: UInt32) {
        self.init(UIColor { traits in
            UIColor(rgb: traits.userInterfaceStyle == .dark ? dark : light)
        })
    }

    init(hex: String) {
        self.init(UIColor(rgb: Color.parse(hex)))
    }

    static func parse(_ hex: String) -> UInt32 {
        let h = hex.trimmingCharacters(in: CharacterSet(charactersIn: "# "))
        return UInt32(h, radix: 16) ?? 0
    }
}

extension UIColor {
    convenience init(rgb: UInt32, alpha: CGFloat = 1) {
        self.init(red: CGFloat((rgb >> 16) & 255) / 255, green: CGFloat((rgb >> 8) & 255) / 255, blue: CGFloat(rgb & 255) / 255, alpha: alpha)
    }
}

// MARK: - Type

/// A font that grows with Dynamic Type from the mockup's size: `size` is what the mockup shows at the default setting.
struct ScaledFont: ViewModifier {
    @ScaledMetric private var size: CGFloat
    private let weight: Font.Weight
    private let design: Font.Design
    private let expanded: Bool

    init(size: CGFloat, weight: Font.Weight, design: Font.Design, expanded: Bool, relativeTo style: Font.TextStyle) {
        _size = ScaledMetric(wrappedValue: size, relativeTo: style)
        self.weight = weight
        self.design = design
        self.expanded = expanded
    }

    func body(content: Content) -> some View {
        content.font(Font.wc(size, weight, design: design, expanded: expanded))
    }
}

extension Font {
    /// A fixed-size WinChoice font. Prefer `View.wc(...)` (it scales with Dynamic Type).
    static func wc(_ size: CGFloat, _ weight: Font.Weight = .regular, design: Font.Design = .default, expanded: Bool = false) -> Font {
        let base = Font.system(size: size, weight: weight, design: design)
        return expanded ? base.width(.expanded) : base
    }
}

extension View {
    /// Body text and labels (the system font).
    func wc(_ size: CGFloat, _ weight: Font.Weight = .regular, relativeTo style: Font.TextStyle = .body) -> some View {
        modifier(ScaledFont(size: size, weight: weight, design: .default, expanded: false, relativeTo: style))
    }

    /// Headings: the system font, expanded, heavy (Archivo at width 125 in the mockups).
    func wcHeading(_ size: CGFloat, _ weight: Font.Weight = .heavy, relativeTo style: Font.TextStyle = .title) -> some View {
        modifier(ScaledFont(size: size, weight: weight, design: .default, expanded: true, relativeTo: style))
    }

    /// Sizes, times and counts: monospaced digits (SF Mono).
    func wcMono(_ size: CGFloat, _ weight: Font.Weight = .medium, relativeTo style: Font.TextStyle = .body) -> some View {
        modifier(ScaledFont(size: size, weight: weight, design: .monospaced, expanded: false, relativeTo: style))
    }
}

// MARK: - Haptics

enum Haptics {
    static func tap() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    static func success() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    static func warning() {
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }
}
