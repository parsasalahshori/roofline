import SwiftUI
import UIKit

/// The homeowner app follows Apple's Human Interface Guidelines (plans/ios-hig-redesign.md): system colours, the system font
/// at Dynamic Type text styles, SF Symbols, native bars and controls. WinChoice red is the one accent (primary buttons,
/// selected states, key links); everything else is a semantic system colour that adapts to light and dark by itself.
///
/// The token names below are kept from the earlier "Chalk Line" look so every screen compiles; each now points at a system colour.
/// New code should prefer these tokens (or `.primary`, `Color(.systemGroupedBackground)`). For secondary text use `Theme.ink2`, not
/// `.secondary` (see ink2).
enum Theme {
    // MARK: Colours

    /// The page behind grouped content (Settings' grey in light, black in dark).
    static let ground = Color(.systemGroupedBackground)
    /// A card or grouped row sitting on the ground (white in light, dark grey in dark).
    static let surface = Color(.secondarySystemGroupedBackground)
    /// Something quiet inside a card (an icon tile, a plain tag).
    static let surface2 = Color(.tertiarySystemGroupedBackground)
    static let sunken = Color(.systemFill)
    static let raised = Color(.secondarySystemGroupedBackground)

    /// Text: label, and one secondary level. The secondary is the system's secondary label made opaque and a step darker (lighter in
    /// dark mode): `secondaryLabel` itself is 3.4:1 on white and the accessibility audit asks for 4.5:1 on small text, so it is not
    /// used for words. `tertiaryLabel` is for placeholders and decoration only (`Theme.decor`).
    static let ink = Color(.label)
    static let ink2 = Color(light: 0x626268, dark: 0xAEAEB2)
    static let ink3 = ink2
    /// Decoration only (chevrons, empty selection circles, placeholders): never body text.
    static let decor = Color(.tertiaryLabel)

    /// Hairlines and outlines.
    static let line = Color(.separator)
    static let line2 = Color(.opaqueSeparator)

    /// The accent: WinChoice red, as text, icons, selection, the app-wide tint and the fill behind white button text. The brand's
    /// #ED3A2B is 4.0:1 against white and 3.7:1 on the grouped grey, short of the 4.5:1 small text needs (the accessibility audit
    /// flags it: the old "Contrast nearly passed" on the quote screen). #DB3425 clears 4.5:1 only barely (4.6:1) and small white
    /// labels on it still came out "nearly passed"; #CC2F23 is 5.3:1 with white and 4.7:1 on the grey, so red text, links and white
    /// labels on red all pass on every ground. In dark mode the brand's own lighter red reads on black.
    static let red = Color(light: 0xCC2F23, dark: Color.parse(Brand.current.colors.redDark))
    /// The fill behind white text (buttons, selected chips, badges). The same #CC2F23 in both appearances, because the lighter
    /// dark-mode red is too light for white text.
    static let buttonFill = Color(light: 0xCC2F23, dark: 0xCC2F23)
    static let onRed = Color.white
    static let redTint = red.opacity(0.12)

    /// Earlier "blue" slot (selection, links, "you picked this"): now the accent. The tint is a neutral system grey (systemGray6, 4.7:1 for accent text on it).
    static let blue = red
    static let blueTint = Color(.systemGray6)

    /// Retired: the navy hero is gone. Kept only so old references compile; both are neutral system colours.
    static let navy = Color(.secondarySystemGroupedBackground)
    static let heroText = ink2
    /// A dark scrim for chips and covers over maps and photos.
    static let scrim = Color.black

    /// Status colours, always with an icon and a word.
    static let ok = Color(.systemGreen)
    static let okTint = Color(.systemGreen).opacity(0.15)
    static let warn = Color(.systemOrange)
    static let warnTint = Color(.systemOrange).opacity(0.15)
    static let info = ink2
    static let infoTint = Color(.tertiarySystemFill)
    static let bad = Color(.systemRed)
    /// The same three as TEXT: the system greens, oranges and reds are 2 to 3.6:1 on white, so in light mode these are the system
    /// colour darkened until the words clear 4.5:1 (also on their own 15 % tints). In dark mode the system colour already does.
    static let okText = textVariant(.systemGreen, darkenedTo: 0.6)
    static let warnText = textVariant(.systemOrange, darkenedTo: 0.6)
    static let badText = textVariant(.systemRed, darkenedTo: 0.8)

    private static func textVariant(_ base: UIColor, darkenedTo factor: CGFloat) -> Color {
        Color(UIColor { traits in
            let c = base.resolvedColor(with: traits)
            guard traits.userInterfaceStyle != .dark else { return c }
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
            c.getRed(&r, green: &g, blue: &b, alpha: &a)
            return UIColor(red: r * factor, green: g * factor, blue: b * factor, alpha: a)
        })
    }

    /// Measuring guides only (the corners, the sides, the magnifier's dashes): a high-visibility yellow.
    static let tape = Color(.systemYellow)
    static let tapeInk = Color.black

    // MARK: Shape

    /// Continuous corners of cards and grouped rows.
    static let radius: CGFloat = 12
    static let gutter: CGFloat = 16
    /// The large control height and the minimum tap target.
    static let buttonHeight: CGFloat = 50
    static let secondaryButtonHeight: CGFloat = 44
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

extension Font.TextStyle {
    /// The Dynamic Type text style whose default size is closest to a size taken from the earlier mockups.
    static func nearest(toSize size: CGFloat) -> Font.TextStyle {
        switch size {
        case 31...: return .largeTitle
        case 25..<31: return .title
        case 21..<25: return .title2
        case 18.5..<21: return .title3
        case 16.5..<18.5: return .body
        case 15.5..<16.5: return .callout
        case 14..<15.5: return .subheadline
        case 12.5..<14: return .footnote
        case 11.5..<12.5: return .caption
        default: return .caption2
        }
    }
}

/// The system font at a Dynamic Type text style. `size` only picks the style when none is given; it never fixes a point size,
/// so the text always follows the reader's text-size setting.
struct SystemTextStyle: ViewModifier {
    let style: Font.TextStyle
    let weight: Font.Weight
    let monospacedDigits: Bool

    func body(content: Content) -> some View {
        let base = Font.system(style, design: .default, weight: weight)
        content.font(monospacedDigits ? base.monospacedDigit() : base)
    }
}

extension View {
    /// Body text and labels: the system font at a text style (`relativeTo`, or the one nearest `size`).
    func wc(_ size: CGFloat, _ weight: Font.Weight = .regular, relativeTo style: Font.TextStyle? = nil) -> some View {
        modifier(SystemTextStyle(style: style ?? .nearest(toSize: size), weight: weight, monospacedDigits: false))
    }

    /// Headings: the system font, bold by default, at a title text style.
    func wcHeading(_ size: CGFloat, _ weight: Font.Weight = .bold, relativeTo style: Font.TextStyle? = nil) -> some View {
        modifier(SystemTextStyle(style: style ?? .nearest(toSize: size), weight: weight, monospacedDigits: false))
    }

    /// Sizes, times and counts: the system font with monospaced digits.
    func wcMono(_ size: CGFloat, _ weight: Font.Weight = .medium, relativeTo style: Font.TextStyle? = nil) -> some View {
        modifier(SystemTextStyle(style: style ?? .nearest(toSize: size), weight: weight, monospacedDigits: true))
    }

    /// The "WinChoice" wordmark: plain text in SF Pro, black weight.
    func wcWordmark(_ style: Font.TextStyle = .title3) -> some View {
        modifier(SystemTextStyle(style: style, weight: .black, monospacedDigits: false))
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
