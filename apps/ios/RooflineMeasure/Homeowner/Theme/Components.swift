import RooflineCore
import SwiftUI

// The building blocks of the homeowner screens, from the mockups' own CSS (_wc.css, _hw.css, _ios.css): 54 pt main
// button with 14 pt radius, hairline cards, blue selection, step dots, grouped rows. One red main button per screen.

// MARK: - Navigation bar

/// The top row of the mockups (.wnav): a blue back chevron, the title (the WinChoice wordmark or a few words), and
/// whatever belongs at the right (step dots, "Skip", "Add", a share icon). Drawn by hand so it looks the same on every
/// version of iOS; the back swipe still works (see SwipeBack).
struct WCNavBar<Trailing: View>: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    var title: String?
    /// Draw the title as the WinChoice wordmark (expanded, heavy).
    var wordmark = false
    var onBack: (() -> Void)?
    @ViewBuilder var trailing: Trailing

    private var back: some View {
        Group {
            if let onBack = onBack {
                Button(action: onBack) {
                    IconView(icon: .chevLeft, size: 22, weight: 2)
                        .foregroundStyle(Theme.blue)
                        .frame(width: Theme.minTap, height: Theme.minTap, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Back")
                .accessibilityHint("Goes to the previous step")
            } else {
                Color.clear.frame(width: 1, height: Theme.minTap)
            }
        }
    }

    private func titleText(lines: Int?) -> some View {
        Group {
            if let title = title {
                Group {
                    if wordmark {
                        Text(title).wcHeading(16, .heavy, relativeTo: .headline)
                    } else {
                        Text(title).wc(16, .semibold, relativeTo: .headline)
                    }
                }
                .foregroundStyle(Theme.ink)
                .lineLimit(lines)
                .minimumScaleFactor(wordmark ? 0.5 : 0.7)
                .accessibilityAddTraits(.isHeader)
            }
        }
    }

    var body: some View {
        if typeSize.isAccessibilitySize {
            // Large text: the buttons on one row, the title under them at the full size
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    back
                    Spacer(minLength: 4)
                    trailing.frame(minHeight: Theme.minTap)
                }
                titleText(lines: wordmark ? 1 : nil)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.bottom, 4)
            }
            .padding(.horizontal, Theme.gutter)
        } else {
            HStack(spacing: 8) {
                back
                Spacer(minLength: 4)
                titleText(lines: 1)
                Spacer(minLength: 4)
                trailing
                    .frame(minHeight: Theme.minTap)
            }
            .padding(.horizontal, Theme.gutter)
            .frame(minHeight: 44)
        }
    }
}

extension WCNavBar where Trailing == EmptyView {
    init(title: String?, wordmark: Bool = false, onBack: (() -> Void)?) {
        self.init(title: title, wordmark: wordmark, onBack: onBack) { EmptyView() }
    }
}

/// The four little bars at the top right of the first screens: how far along (REDESIGN.md 8.2).
struct StepDots: View {
    let filled: Int
    var total = 4

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<total, id: \.self) { i in
                Capsule().fill(i < filled ? Theme.ink : Theme.line2).frame(width: 18, height: 4)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Step \(filled) of \(total)")
        .accessibilityAddTraits(.isStaticText)
    }
}

/// A plain text button at the right of the bar ("Skip", "Add").
struct NavTextButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title).wc(16, .medium, relativeTo: .body).foregroundStyle(Theme.blue)
                .frame(minWidth: Theme.minTap, minHeight: Theme.minTap, alignment: .trailing)
                .contentShape(Rectangle())
        }
    }
}

/// The big screen title under the bar (.wh): 26 pt, expanded, heavy.
struct WCHeadline: View {
    let text: String
    var subtitle: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(text)
                .wcHeading(26, .heavy, relativeTo: .title)
                .foregroundStyle(Theme.ink)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if let subtitle = subtitle {
                Text(subtitle)
                    .wc(15, relativeTo: .subheadline)
                    .foregroundStyle(Theme.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Buttons

/// The one main button of a screen (.wcta): WinChoice red, 54 pt, 14 pt radius. Disabled is half strength.
struct WCPrimaryButton: View {
    let title: String
    var icon: WCIcon?
    var iconLeading = false
    var isLoading = false
    var isEnabled = true
    let action: () -> Void

    var body: some View {
        Button(action: {
            Haptics.tap()
            action()
        }) {
            HStack(spacing: 8) {
                if isLoading {
                    ProgressView().tint(Theme.onRed)
                } else {
                    if let icon = icon, iconLeading { IconView(icon: icon, size: 16, weight: 2) }
                    Text(title).wc(18, .bold, relativeTo: .headline).multilineTextAlignment(.center)
                    if let icon = icon, !iconLeading { IconView(icon: icon, size: 16, weight: 2) }
                }
            }
            .foregroundStyle(Theme.onRed)
            .frame(maxWidth: .infinity, minHeight: Theme.buttonHeight)
            .padding(.horizontal, 12)
            .background(Theme.red, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            .opacity(isEnabled ? 1 : 0.5)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleStyle())
        .disabled(!isEnabled || isLoading)
        .accessibilityLabel(title)
    }
}

/// The quiet button under it (.wcta2): white, blue text, hairline.
struct WCSecondaryButton: View {
    let title: String
    var icon: WCIcon?
    var isEnabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if let icon = icon { IconView(icon: icon, size: 16, weight: 1.9) }
                Text(title).wc(17, .semibold, relativeTo: .headline).multilineTextAlignment(.center)
            }
            .foregroundStyle(Theme.blue)
            .frame(maxWidth: .infinity, minHeight: Theme.secondaryButtonHeight)
            .padding(.horizontal, 12)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).strokeBorder(Theme.line2, lineWidth: 1))
            .opacity(isEnabled ? 1 : 0.5)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleStyle())
        .disabled(!isEnabled)
    }
}

struct PressScaleStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .opacity(configuration.isPressed ? 0.92 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

// MARK: - Footer

extension View {
    /// The bottom area with the main button(s): the page's ground colour, 16 pt gutters, content scrolls above it. With
    /// accessibility text sizes a pinned area would fill the screen, so there it is not pinned: the screen's scrolling content
    /// ends with `WCScrollFooter()`, which draws the same buttons at the full text size.
    func wcFooter<Footer: View>(@ViewBuilder _ footer: () -> Footer) -> some View {
        modifier(WCFooterModifier(footer: footer()))
    }
}

private struct WCFooterModifier<Footer: View>: ViewModifier {
    @Environment(\.dynamicTypeSize) private var typeSize
    let footer: Footer

    func body(content: Content) -> some View {
        if typeSize.isAccessibilitySize {
            content.environment(\.wcFooterView, AnyView(VStack(spacing: 10) { footer }))
        } else {
            content.safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 10) { footer }
                    .padding(.horizontal, Theme.gutter)
                    .padding(.top, 10)
                    .padding(.bottom, 8)
                    .frame(maxWidth: .infinity)
                    .background(Theme.ground)
            }
        }
    }
}

private struct WCFooterViewKey: EnvironmentKey {
    static let defaultValue: AnyView? = nil
}

extension EnvironmentValues {
    /// The screen's footer, handed down so the scrolling content can end with it at accessibility text sizes.
    fileprivate var wcFooterView: AnyView? {
        get { self[WCFooterViewKey.self] }
        set { self[WCFooterViewKey.self] = newValue }
    }
}

/// The last thing in a screen's scrolling content: the screen's `wcFooter` buttons, when the text is too large to pin them.
struct WCScrollFooter: View {
    @Environment(\.wcFooterView) private var footer

    var body: some View {
        if let footer = footer {
            footer.padding(.top, 20).padding(.bottom, 8)
        }
    }
}

/// One line of small print under a button ("We only call about this request.").
struct FinePrint: View {
    let text: String
    var icon: WCIcon?

    var body: some View {
        HStack(spacing: 6) {
            if let icon = icon { IconView(icon: icon, size: 16) }
            Text(text).wc(13, relativeTo: .footnote).multilineTextAlignment(.center)
        }
        .foregroundStyle(Theme.ink3)
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Cards and rows

extension View {
    /// A white card with a hairline (box-shadow: inset 0 0 0 1px --line); selected: a 2 pt blue ring on a blue tint.
    func wcCard(selected: Bool = false, radius: CGFloat = Theme.radius, fill: Color? = nil) -> some View {
        background(selected ? Theme.blueTint : (fill ?? Theme.surface), in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(selected ? Theme.blue : Theme.line, lineWidth: selected ? 2 : 1))
    }

    /// A tinted panel without a border (the blue "why" and note boxes).
    func wcPanel(_ tint: Color = Theme.blueTint, radius: CGFloat = Theme.radius) -> some View {
        background(tint, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
    }
}

/// An icon in a 34 to 48 pt rounded square (.ic), on the quiet surface, or white when selected.
struct IconTile: View {
    let icon: WCIcon
    var size: CGFloat = 44
    var iconSize: CGFloat = 22
    var selected = false
    var tint: Color?
    var foreground: Color?

    var body: some View {
        IconView(icon: icon, size: iconSize)
            .foregroundStyle(foreground ?? (selected ? Theme.blue : Theme.ink))
            .frame(width: size, height: size)
            .background(tint ?? (selected ? Theme.surface : Theme.surface2), in: RoundedRectangle(cornerRadius: size / 4, style: .continuous))
    }
}

/// A rounded checkbox, 24 pt (.rd): empty with a 2 pt grey ring, or blue with a white check.
struct WCCheckbox: View {
    let isOn: Bool
    var size: CGFloat = 24

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.29, style: .continuous)
                .fill(isOn ? Theme.blue : Color.clear)
            RoundedRectangle(cornerRadius: size * 0.29, style: .continuous)
                .strokeBorder(isOn ? Color.clear : Theme.line2, lineWidth: 2)
            if isOn { IconView(icon: .check, size: size * 0.66, weight: 2.4).foregroundStyle(Color.white) }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// A radio dot, 22 pt: a grey ring, or a blue disc with a white centre.
struct WCRadio: View {
    let isOn: Bool
    var size: CGFloat = 22

    var body: some View {
        ZStack {
            Circle().strokeBorder(isOn ? Theme.blue : Theme.line2, lineWidth: 2)
            if isOn {
                Circle().fill(Theme.blue)
                Circle().fill(Theme.surface).frame(width: size * 0.32, height: size * 0.32)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// A pill chip (38 pt): the room names, "Morning / Afternoon / Evening".
struct WCChip: View {
    let title: String
    let isOn: Bool
    var height: CGFloat = 38
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .wc(15, isOn ? .semibold : .medium, relativeTo: .callout)
                .foregroundStyle(isOn ? Theme.blue : Theme.ink)
                .padding(.horizontal, 14)
                .frame(minHeight: max(height, Theme.minTap - 6))
                .background(isOn ? Theme.blueTint : Theme.surface, in: Capsule())
                .overlay(Capsule().strokeBorder(isOn ? Theme.blue : Theme.line2, lineWidth: isOn ? 2 : 1))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isOn ? [.isSelected] : [])
    }
}

/// A small status tag: icon-less words on a tint ("About 1/4 inch · best", "Check").
struct WCTag: View {
    enum Kind { case ok, info, warn, plain, blue }
    let text: String
    var kind: Kind = .plain
    var icon: WCIcon?
    var radius: CGFloat = 5

    private var colors: (Color, Color) {
        switch kind {
        case .ok: return (Theme.ok, Theme.okTint)
        case .info: return (Theme.info, Theme.infoTint)
        case .warn: return (Theme.warn, Theme.warnTint)
        case .blue: return (Theme.blue, Theme.blueTint)
        case .plain: return (Theme.ink2, Theme.surface2)
        }
    }

    var body: some View {
        HStack(spacing: 4) {
            if let icon = icon { IconView(icon: icon, size: 13, weight: 1.9) }
            Text(text).wc(12, .semibold, relativeTo: .caption)
        }
        .foregroundStyle(colors.0)
        .padding(.horizontal, 7)
        .padding(.vertical, 4)
        .background(colors.1, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
    }
}

/// The blue "why" and note panels: an icon, a sentence (a bold lead optional).
struct InfoPanel: View {
    var icon: WCIcon = .info
    var lead: String?
    let text: String
    var tint: Color = Theme.blueTint
    var iconColor: Color = Theme.blue
    /// The icon sits in a white 40 pt tile (the call-back panel) rather than loose.
    var tile = false
    /// The panel has no padding of its own when it sits inside another card.
    var padded = true

    private var composed: AttributedString {
        var out = AttributedString()
        if let lead = lead {
            var l = AttributedString(lead + " ")
            l.inlinePresentationIntent = .stronglyEmphasized
            l.foregroundColor = Theme.ink
            out += l
        }
        out += AttributedString(text)
        return out
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            if tile {
                IconView(icon: icon, size: 20).foregroundStyle(iconColor)
                    .frame(width: 40, height: 40)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            } else {
                IconView(icon: icon, size: 18).foregroundStyle(iconColor).padding(.top, 1)
            }
            Text(composed)
                .wc(14, relativeTo: .subheadline)
                .foregroundStyle(Theme.ink2)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(padded ? 14 : 0)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(padded ? tint : Color.clear, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Fields

/// A labelled text field (46 to 48 pt, 12 pt radius, hairline).
struct WCField: View {
    let label: String
    @Binding var text: String
    var prompt = ""
    var keyboard: UIKeyboardType = .default
    var content: UITextContentType?
    var capitalization: TextInputAutocapitalization = .sentences
    var mono = false
    var error: String?
    var submitLabel: SubmitLabel = .next
    var onSubmit: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).wc(13, .semibold, relativeTo: .footnote).foregroundStyle(Theme.ink2)
            TextField("", text: $text, prompt: Text(prompt).foregroundColor(Theme.ink3))
                .keyboardType(keyboard)
                .textContentType(content)
                .textInputAutocapitalization(capitalization)
                .autocorrectionDisabled(keyboard != .default)
                .submitLabel(submitLabel)
                .onSubmit { onSubmit?() }
                .wc(16, relativeTo: .body)
                .modifier(MonoIf(on: mono))
                .foregroundStyle(Theme.ink)
                .padding(.horizontal, 12)
                .frame(minHeight: 46)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(error == nil ? Theme.line2 : Theme.bad, lineWidth: error == nil ? 1 : 1.5))
                .accessibilityLabel(label)
            if let error = error {
                Text(error).wc(12, .medium, relativeTo: .caption).foregroundStyle(Theme.bad)
                    .accessibilityLabel("\(label): \(error)")
            }
        }
    }
}

private struct MonoIf: ViewModifier {
    let on: Bool
    func body(content: Content) -> some View {
        if on { content.font(.system(size: 16, design: .monospaced)) } else { content }
    }
}

// MARK: - Scroll edge

extension View {
    /// iOS 26 fades the top of a scroll view under the status bar; a hero that is drawn up there on purpose (the navy welcome)
    /// should not get that fade.
    @ViewBuilder func wcNoTopScrollFade() -> some View {
        if #available(iOS 26.0, *) {
            scrollEdgeEffectHidden(true, for: .top)
        } else {
            self
        }
    }
}

// MARK: - Swipe back

/// The system's swipe-from-the-edge back gesture keeps working with the hidden navigation bar.
struct SwipeBackEnabler: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> UIViewController { Holder() }
    func updateUIViewController(_ vc: UIViewController, context: Context) {}

    final class Holder: UIViewController {
        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            navigationController?.interactivePopGestureRecognizer?.isEnabled = (navigationController?.viewControllers.count ?? 0) > 1
            navigationController?.interactivePopGestureRecognizer?.delegate = nil
        }
    }
}

extension View {
    func wcScreenChrome() -> some View {
        self
            .background(Theme.ground.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
            .navigationBarBackButtonHidden(true)
            .background(SwipeBackEnabler())
    }
}

// MARK: - Grouped rows (the iOS lists of the rooms, windows and rows screens)

/// A small caps heading above a group ("YOUR ROOMS").
struct GroupHeader: View {
    let text: String

    var body: some View {
        Text(text.uppercased())
            .wc(13, .semibold, relativeTo: .footnote)
            .tracking(0.3)
            .foregroundStyle(Theme.ink3)
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityAddTraits(.isHeader)
    }
}

/// A white rounded group; rows inside are separated by a hairline inset from the left.
struct GroupCard<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 0) { content }
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

/// The hairline between two rows of a group.
struct RowDivider: View {
    var inset: CGFloat = 14

    var body: some View {
        Rectangle().fill(Theme.line).frame(height: 1).padding(.leading, inset)
    }
}

/// The caption-sized "fine" line (small grey text) used under tiles and buttons.
struct SmallNote: View {
    let text: String

    var body: some View {
        Text(text).wc(15, relativeTo: .subheadline).foregroundStyle(Theme.ink3).fixedSize(horizontal: false, vertical: true)
    }
}

/// A bank card drawn small (the card-photo method's icon): blue card, gold chip.
struct BankCardGlyph: View {
    var width: CGFloat = 32

    var body: some View {
        let h = width * 0.66
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: width * 0.09, style: .continuous)
                .fill(LinearGradient(colors: [Color(light: 0x2B5FA8, dark: 0x3A70BA), Color(light: 0x16345F, dark: 0x1D4478)], startPoint: .topLeading, endPoint: .bottomTrailing))
            RoundedRectangle(cornerRadius: width * 0.04, style: .continuous)
                .fill(Color(light: 0xE7C477, dark: 0xE7C477))
                .frame(width: width * 0.2, height: width * 0.14)
                .offset(x: width * 0.1, y: h * 0.22)
        }
        .frame(width: width, height: h)
        .accessibilityHidden(true)
    }
}

/// A tab bar like the mockup's (My order, Windows, Messages): hairline on top, icon over a 12 pt label, the chosen one blue.
struct WCTabBar: View {
    struct Item: Identifiable {
        var id: String
        var title: String
        var icon: WCIcon
    }

    @Environment(\.dynamicTypeSize) private var typeSize
    let items: [Item]
    @Binding var selection: String

    var body: some View {
        Group {
            if typeSize.isAccessibilitySize {
                menu
            } else {
                bar
            }
        }
        .background(Theme.surface.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1) }
    }

    private var bar: some View {
        HStack(spacing: 0) {
            ForEach(items) { item in
                Button {
                    selection = item.id
                } label: {
                    VStack(spacing: 4) {
                        IconView(icon: item.icon, size: 24, weight: 2.1)
                        Text(item.title).wc(12, .medium, relativeTo: .caption)
                    }
                    .foregroundStyle(selection == item.id ? Theme.blue : Theme.ink3)
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(item.title)
                .accessibilityAddTraits(selection == item.id ? [.isButton, .isSelected] : [.isButton])
            }
        }
        .padding(.top, 8)
        .padding(.bottom, 2)
    }

    /// Three tabs do not fit side by side at accessibility text sizes: one button at the full size opens the list.
    private var menu: some View {
        let current = items.first { $0.id == selection } ?? items[0]
        return Menu {
            ForEach(items) { item in
                Button {
                    selection = item.id
                } label: {
                    Label(item.title, systemImage: item.id == selection ? "checkmark" : "circle")
                }
            }
        } label: {
            HStack(spacing: 10) {
                IconView(icon: current.icon, size: 24)
                Text(current.title).wc(17, .semibold, relativeTo: .headline)
                Image(systemName: "chevron.up.chevron.down").imageScale(.small)
            }
            .foregroundStyle(Theme.blue)
            .frame(maxWidth: .infinity, minHeight: 56)
            .padding(.horizontal, Theme.gutter)
            .contentShape(Rectangle())
        }
        .accessibilityLabel("\(current.title). Choose a section")
        .padding(.top, 4)
    }
}

// MARK: - Sizes with stacked fractions

/// A size as the mockups set it: monospaced digits, the fraction small and stacked ("35 ⁵⁄₈"), never a decimal.
enum SizeFormat {
    /// A length: the whole number in `size` points, the fraction (numerator raised, denominator lowered) smaller.
    static func attributed(_ inches: Double, size: CGFloat, weight: Font.Weight = .semibold, color: Color? = nil) -> AttributedString {
        let p = SizeWording.parts(inches)
        var out = AttributedString("\(p.whole)")
        out.font = .system(size: size, weight: weight, design: .monospaced)
        if let c = color { out.foregroundColor = c }
        guard p.hasFraction else { return out }
        let small = size * 0.58
        var num = AttributedString("\(p.numerator)")
        num.font = .system(size: small, weight: weight, design: .monospaced)
        num.baselineOffset = size * 0.34
        var slash = AttributedString("/")
        slash.font = .system(size: small, weight: .regular, design: .monospaced)
        slash.baselineOffset = size * 0.06
        var den = AttributedString("\(p.denominator)")
        den.font = .system(size: small, weight: weight, design: .monospaced)
        den.baselineOffset = -size * 0.1
        for var piece in [num, slash, den] {
            if let c = color { piece.foregroundColor = c }
            out += piece
        }
        return out
    }

    /// "35 ⁵⁄₈ × 59 ⁵⁄₈", optionally followed by " in".
    static func pair(_ widthIn: Double, _ heightIn: Double, size: CGFloat, weight: Font.Weight = .semibold, color: Color? = nil, unit: Bool = false) -> AttributedString {
        var out = attributed(widthIn, size: size, weight: weight, color: color)
        var times = AttributedString("\u{2005}×\u{2005}")
        times.font = .system(size: size * 0.78, weight: .regular)
        if let c = color { times.foregroundColor = c }
        out += times
        out += attributed(heightIn, size: size, weight: weight, color: color)
        if unit {
            var u = AttributedString(" in")
            u.font = .system(size: size * 0.8, weight: weight, design: .monospaced)
            if let c = color { u.foregroundColor = c }
            out += u
        }
        return out
    }
}

/// A size on screen: Dynamic Type scales it, VoiceOver reads it in words ("35 and 5 eighths by 59 and 5 eighths inches").
struct SizeText: View {
    let widthIn: Double
    let heightIn: Double
    var size: CGFloat = 20
    var weight: Font.Weight = .semibold
    var unit = false
    var color: Color = Theme.ink
    @ScaledMetric private var scaled: CGFloat
    @Environment(\.dynamicTypeSize) private var typeSize

    init(widthIn: Double, heightIn: Double, size: CGFloat = 20, weight: Font.Weight = .semibold, unit: Bool = false, color: Color = Theme.ink, relativeTo style: Font.TextStyle = .title3) {
        self.widthIn = widthIn
        self.heightIn = heightIn
        self.size = size
        self.weight = weight
        self.unit = unit
        self.color = color
        _scaled = ScaledMetric(wrappedValue: size, relativeTo: style)
    }

    var body: some View {
        Text(SizeFormat.pair(widthIn, heightIn, size: scaled, weight: weight, color: color, unit: unit))
            // One line that shrinks a little at ordinary sizes; with large text it wraps instead (the width, then the height)
            .lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
            .minimumScaleFactor(typeSize.isAccessibilitySize ? 1 : 0.7)
            .accessibilityLabel(SizeWording.spokenSize(widthIn: widthIn, heightIn: heightIn))
    }
}

// MARK: - Layout helpers

/// Side by side at ordinary text sizes, stacked at the accessibility sizes (where two things in a row no longer fit and the
/// words would be cut short). Keep `Spacer`s out of the content; give the flexible child `.frame(maxWidth: .infinity, alignment: .leading)`.
struct AdaptiveStack<Content: View>: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    var alignment: VerticalAlignment = .center
    var stackedAlignment: HorizontalAlignment = .leading
    var spacing: CGFloat?
    @ViewBuilder var content: Content

    var body: some View {
        if typeSize.isAccessibilitySize {
            VStack(alignment: stackedAlignment, spacing: spacing) { content }
        } else {
            HStack(alignment: alignment, spacing: spacing) { content }
        }
    }
}

/// Chips that wrap onto the next line (the room chips of the label sheet).
struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, widest: CGFloat = 0
        for sub in subviews {
            let s = sub.sizeThatFits(.unspecified)
            if x > 0, x + s.width > maxWidth {
                y += rowHeight + lineSpacing
                x = 0
                rowHeight = 0
            }
            x += s.width + spacing
            rowHeight = max(rowHeight, s.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: proposal.width ?? widest, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for sub in subviews {
            let s = sub.sizeThatFits(.unspecified)
            if x > bounds.minX, x + s.width > bounds.maxX {
                y += rowHeight + lineSpacing
                x = bounds.minX
                rowHeight = 0
            }
            sub.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
            x += s.width + spacing
            rowHeight = max(rowHeight, s.height)
        }
    }
}

/// The rep's picture: a plain person on a pale disc (the mockup's avatar), no photo needed.
struct RepAvatar: View {
    var size: CGFloat = 44

    var body: some View {
        Canvas { ctx, s in
            let k = s.width / 44
            ctx.fill(Path(ellipseIn: CGRect(origin: .zero, size: s)), with: .color(Color(light: 0xD7DFE6, dark: 0x2A3A4D)))
            var body = Path()
            body.addEllipse(in: CGRect(x: 6 * k, y: 28 * k, width: 32 * k, height: 30 * k))
            ctx.clip(to: Path(ellipseIn: CGRect(origin: .zero, size: s)))
            ctx.fill(body, with: .color(Theme.blue))
            ctx.fill(Path(ellipseIn: CGRect(x: 14 * k, y: 10 * k, width: 16 * k, height: 16 * k)), with: .color(Color(light: 0xD9AE86, dark: 0xC99A72)))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
