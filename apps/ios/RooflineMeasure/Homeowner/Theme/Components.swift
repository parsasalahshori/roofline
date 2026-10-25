import RooflineCore
import SwiftUI

// The building blocks of the homeowner screens, in Apple's own vocabulary (plans/ios-hig-redesign.md): a native navigation
// bar, bordered buttons, a material footer, grouped-list cards, SF Symbols and Dynamic Type text styles. WinChoice red is the
// one accent, set app-wide with `.tint`. One prominent button per screen.

// MARK: - Navigation bar

/// A screen's top bar, native: the system navigation bar with a title, a back button and trailing items. Apply it to the
/// screen's outermost view (inside the navigation stack):
///
///     ScrollView { ... }
///         .hiNav(title: "Your details")
///         .hiNav(title: "Your windows") { NavTextButton(title: "Add") { ... } }
///
/// - `display`: `.inline` (the default, for sub-screens) or `.large` (main step screens; the content must then be a
///   `ScrollView` or `List` at the top of the screen so the large title can collapse).
/// - `wordmark`: the title is the brand name (inline; kept so older calls compile: it is the system's own inline title, because a
///   custom title view does not follow the audit's Dynamic Type check).
/// - `onBack`: what the back button does; nil means `store.pop()` (the same step the swipe-back and the old bar took).
///   `showsBack: false` leaves no back button.
/// The back button is a toolbar button over the hidden system one, so it can run `store.pop()` and its book-keeping, and it looks
/// the same: a chevron, VoiceOver "Back". The swipe-from-the-edge gesture stays on.
struct HiNavModifier<Trailing: View>: ViewModifier {
    @Environment(HomeownerStore.self) private var store: HomeownerStore?
    let title: String?
    let display: NavigationBarItem.TitleDisplayMode
    let wordmark: Bool
    let showsBack: Bool
    let onBack: (() -> Void)?
    let trailing: Trailing

    func body(content: Content) -> some View {
        content
            .navigationTitle(title ?? "")
            .navigationBarTitleDisplayMode(wordmark ? .inline : display)
            .navigationBarBackButtonHidden(true)
            .toolbar {
                if showsBack {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            if let onBack = onBack { onBack() } else { store?.pop() }
                        } label: {
                            Image(systemName: "chevron.backward")
                        }
                        .accessibilityLabel("Back")
                        .accessibilityHint("Goes to the previous step")
                    }
                }
                if Trailing.self != EmptyView.self {
                    ToolbarItem(placement: .topBarTrailing) { trailing }
                }
            }
            .background(SwipeBackEnabler())
    }
}

extension View {
    /// A native navigation bar for this screen (see `HiNavModifier`), with trailing toolbar content ("Skip", "Add", a step caption).
    func hiNav<Trailing: View>(
        title: String?, display: NavigationBarItem.TitleDisplayMode = .inline, wordmark: Bool = false, showsBack: Bool = true,
        onBack: (() -> Void)? = nil, @ViewBuilder trailing: () -> Trailing
    ) -> some View {
        modifier(HiNavModifier(title: title, display: display, wordmark: wordmark, showsBack: showsBack, onBack: onBack, trailing: trailing()))
    }

    /// A native navigation bar for this screen (see `HiNavModifier`).
    func hiNav(
        title: String?, display: NavigationBarItem.TitleDisplayMode = .inline, wordmark: Bool = false, showsBack: Bool = true,
        onBack: (() -> Void)? = nil
    ) -> some View {
        modifier(HiNavModifier(title: title, display: display, wordmark: wordmark, showsBack: showsBack, onBack: onBack, trailing: EmptyView()))
    }
}

/// The earlier bar, kept so the screens not yet converted compile and get the native bar anyway: drop it anywhere in a screen
/// (it draws nothing itself) and the screen's navigation bar takes its title, back button and trailing content. New and converted
/// screens use `.hiNav(...)` on the screen instead. Because it only carries the bar, it must be a direct part of the screen's
/// view hierarchy (not inside a lazy container).
struct WCNavBar<Trailing: View>: View {
    var title: String?
    /// Draw the title as the WinChoice wordmark.
    var wordmark = false
    var onBack: (() -> Void)?
    @ViewBuilder var trailing: Trailing

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .hiNav(title: title, wordmark: wordmark, showsBack: onBack != nil, onBack: onBack) { trailing }
    }
}

extension WCNavBar where Trailing == EmptyView {
    init(title: String?, wordmark: Bool = false, onBack: (() -> Void)?) {
        self.init(title: title, wordmark: wordmark, onBack: onBack) { EmptyView() }
    }
}

/// "Step 2 of 4", small and secondary: the trailing item of the bar on the first screens. Under a title, `StepProgress` draws
/// the same words with a progress bar.
struct StepDots: View {
    let filled: Int
    var total = 4

    var body: some View {
        Text("Step \(filled) of \(total)")
            .font(.footnote)
            .foregroundStyle(Theme.ink2)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Step \(filled) of \(total)")
            .accessibilityAddTraits(.isStaticText)
    }
}

/// How far along, under a screen title: "Step 2 of 4" and a native linear `ProgressView`.
struct StepProgress: View {
    let step: Int
    var total = 4

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Step \(step) of \(total)").font(.footnote).monospacedDigit().foregroundStyle(Theme.ink2)
            ProgressView(value: Double(min(max(step, 0), total)), total: Double(total))
                .progressViewStyle(.linear)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Step \(step) of \(total)")
        .accessibilityAddTraits(.isStaticText)
    }
}

/// A plain text button in the bar ("Skip", "Add"): the system's own toolbar button.
struct NavTextButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(title, action: action)
    }
}

/// The screen title in the content, under an inline bar: title text style, bold, with an optional line under it. (A main step
/// screen uses a large navigation title instead: `.hiNav(title:, display: .large)`.)
struct WCHeadline: View {
    let text: String
    var subtitle: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(text)
                .font(.title.weight(.bold))
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if let subtitle = subtitle {
                Text(subtitle)
                    .font(.body)
                    .foregroundStyle(Theme.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Buttons

/// The one prominent button of a screen: `.borderedProminent`, large, full width, WinChoice red (the #CC2F23 fill that clears
/// 4.5:1 with white text). Loading swaps the label for a spinner. Disabled is the system's dimmed look.
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
                    ProgressView().tint(.white)
                } else {
                    if let icon = icon, iconLeading { Image(systemName: icon.symbol) }
                    Text(title).multilineTextAlignment(.center)
                    if let icon = icon, !iconLeading { Image(systemName: icon.symbol) }
                }
            }
            .fontWeight(.semibold)
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .tint(Theme.buttonFill)
        .disabled(!isEnabled || isLoading)
        .accessibilityLabel(title)
    }
}

/// The quieter button under it: `.bordered`, large, full width, in the neutral label colour (red stays for the one prominent
/// button; red text on a red tint would also fall short of 4.5:1).
struct WCSecondaryButton: View {
    let title: String
    var icon: WCIcon?
    var isEnabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if let icon = icon { Image(systemName: icon.symbol) }
                Text(title).multilineTextAlignment(.center)
            }
            .fontWeight(.semibold)
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
        .tint(Theme.ink)
        .disabled(!isEnabled)
    }
}

// MARK: - Footer

extension View {
    /// The bottom area with the main button(s): `.safeAreaInset(edge: .bottom)` on a bar material, 16 pt gutters, content scrolls
    /// above it. With accessibility text sizes a pinned area would fill the screen, so there it is not pinned: the screen's
    /// scrolling content ends with `WCScrollFooter()`, which draws the same buttons at the full text size.
    func wcFooter<Footer: View>(@ViewBuilder _ footer: () -> Footer) -> some View {
        modifier(WCFooterModifier(footer: footer()))
    }
}

private struct WCFooterModifier<Footer: View>: ViewModifier {
    @Environment(\.dynamicTypeSize) private var typeSize
    let footer: Footer

    func body(content: Content) -> some View {
        if typeSize.isAccessibilitySize {
            content.environment(\.wcFooterView, AnyView(VStack(spacing: 12) { footer }))
        } else {
            content.safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 12) { footer }
                    .padding(.horizontal, Theme.gutter)
                    .padding(.top, 12)
                    .padding(.bottom, 8)
                    .frame(maxWidth: .infinity)
                    .background(Theme.surface)
                    .overlay(alignment: .top) { Divider() }
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
            Text(text).font(.footnote).multilineTextAlignment(.center)
        }
        .foregroundStyle(Theme.ink2)
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Cards and rows

extension View {
    /// A grouped-list card: `secondarySystemGroupedBackground` with continuous 12 pt corners and no border. Selected: the same
    /// card with a 2 pt accent ring. (`radius` is kept so older calls compile; every card uses the system radius.)
    func wcCard(selected: Bool = false, radius: CGFloat = Theme.radius, fill: Color? = nil) -> some View {
        background(fill ?? Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            .overlay {
                if selected {
                    RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).strokeBorder(Theme.red, lineWidth: 2)
                }
            }
    }

    /// A plain panel on the grouped surface (a callout). Pass a tint for a status panel only.
    func wcPanel(_ tint: Color = Theme.surface, radius: CGFloat = Theme.radius) -> some View {
        background(tint, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
    }
}

/// An SF Symbol in a rounded square on a quiet fill (like a Settings row's icon), accent-coloured when selected.
struct IconTile: View {
    let icon: WCIcon
    var size: CGFloat = 44
    var iconSize: CGFloat = 22
    var selected = false
    var tint: Color?
    var foreground: Color?

    var body: some View {
        IconView(icon: icon, size: iconSize)
            .foregroundStyle(foreground ?? (selected ? Theme.red : Theme.ink))
            .frame(width: size, height: size)
            .background(tint ?? Theme.surface2, in: RoundedRectangle(cornerRadius: size / 4, style: .continuous))
    }
}

/// A selection circle, 24 pt: an empty grey circle, or the accent checkmark circle (SF Symbols).
struct WCCheckbox: View {
    let isOn: Bool
    var size: CGFloat = 24

    var body: some View {
        Image(systemName: isOn ? "checkmark.circle.fill" : "circle")
            .font(.system(size: size))
            .foregroundStyle(isOn ? Theme.red : Theme.decor)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// The same circle for a single choice.
struct WCRadio: View {
    let isOn: Bool
    var size: CGFloat = 22

    var body: some View {
        Image(systemName: isOn ? "checkmark.circle.fill" : "circle")
            .font(.system(size: size))
            .foregroundStyle(isOn ? Theme.red : Theme.decor)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// A capsule chip: the room names, "Morning / Afternoon / Evening". Quiet fill; the chosen one is the accent with white text.
struct WCChip: View {
    let title: String
    let isOn: Bool
    var height: CGFloat = 38
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.callout.weight(isOn ? .semibold : .regular))
                .foregroundStyle(isOn ? Theme.onRed : Theme.ink)
                .padding(.horizontal, 14)
                .frame(minHeight: max(height, Theme.minTap - 6))
                .background(isOn ? Theme.buttonFill : Color(.tertiarySystemFill), in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isOn ? [.isSelected] : [])
    }
}

/// A small status tag: words on a tint ("About 1/4 inch · best", "Check"). The text uses the darker status variants so it
/// clears 4.5:1 on its tint.
struct WCTag: View {
    enum Kind { case ok, info, warn, plain, blue }
    let text: String
    var kind: Kind = .plain
    var icon: WCIcon?
    var radius: CGFloat = 5

    private var colors: (Color, Color) {
        switch kind {
        case .ok: return (Theme.okText, Theme.okTint)
        case .info: return (Theme.ink2, Theme.infoTint)
        case .warn: return (Theme.warnText, Theme.warnTint)
        case .blue: return (Theme.red, Theme.blueTint)
        case .plain: return (Theme.ink2, Theme.surface2)
        }
    }

    var body: some View {
        HStack(spacing: 4) {
            if let icon = icon { Image(systemName: icon.symbol).imageScale(.small) }
            Text(text).font(.caption.weight(.semibold))
        }
        .foregroundStyle(colors.0)
        .padding(.horizontal, 7)
        .padding(.vertical, 4)
        .background(colors.1, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
    }
}

/// On a result screen (the window price, the roof's price range): the price is an estimate, and a call to the company gets
/// an exact measurement, done in person. A grouped callout: an info symbol, the words, a bordered call button when the brand
/// has a phone.
struct EstimateCallCard: View {
    @Environment(HomeownerStore.self) private var store
    @Environment(\.openURL) private var openURL
    let service: HomeownerService

    private var line: String {
        let name = store.brand.name
        switch service {
        case .roof: return "For a foolproof measurement, call us. A \(name) expert measures your roof in person, for free."
        case .windows, .gutters: return "For a foolproof measurement, call us. A \(name) expert measures every window in person, for free, before anything is built."
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: WCIcon.info.symbol)
                    .font(.title3)
                    .foregroundStyle(Theme.ink2)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text("This is an estimate").font(.headline).foregroundStyle(.primary)
                        .accessibilityAddTraits(.isHeader)
                    Text(line).font(.subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let url = store.brand.phoneURL, let phone = store.brand.phone {
                WCSecondaryButton(title: "Call \(phone)", icon: .phone) { openURL(url) }
                    .accessibilityLabel("Call \(store.brand.name) at \(phone)")
                    .accessibilityIdentifier("estimate.call")
            }
        }
        .padding(16)
        .wcCard()
        .accessibilityElement(children: .contain)
    }
}

/// A callout: an SF Symbol and a sentence (a bold lead optional) on the grouped surface. Notices are plain, not tinted boxes:
/// `tint` is kept so older calls compile and is ignored; `iconColor` colours the symbol (a status colour for a warning).
struct InfoPanel: View {
    var icon: WCIcon = .info
    var lead: String?
    let text: String
    var tint: Color = Theme.surface
    var iconColor: Color = Theme.ink2
    /// The icon sits in a 40 pt quiet tile (the call-back panel) rather than loose.
    var tile = false
    /// The panel has no padding or background of its own when it sits inside another card.
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
                    .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            } else {
                IconView(icon: icon, size: 18).foregroundStyle(iconColor).padding(.top, 1)
            }
            Text(composed)
                .font(.subheadline)
                .foregroundStyle(Theme.ink2)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(padded ? 16 : 0)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(padded ? Theme.surface : Color.clear, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Fields

/// A labelled text field in the system's look: the label above, the field on the grouped surface (44 pt, continuous corners,
/// no border), a red outline and a line of words when there is an error.
struct WCField: View {
    @Environment(\.dynamicTypeSize) private var typeSize
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

    /// With accessibility text sizes a phone number or an email does not fit on one line, so the value wraps (a field that cuts
    /// its own text short is what the audit calls "may be clipped"). Return still submits: the newline it types is taken out.
    private var wraps: Bool { typeSize.isAccessibilitySize }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.footnote).foregroundStyle(Theme.ink2)
            TextField("", text: $text, prompt: Text(prompt).foregroundColor(Theme.ink3), axis: wraps ? .vertical : .horizontal)
                .lineLimit(wraps ? 1...6 : 1...1)
                .keyboardType(keyboard)
                .textContentType(content)
                .textInputAutocapitalization(capitalization)
                .autocorrectionDisabled(keyboard != .default)
                .submitLabel(submitLabel)
                .onSubmit { onSubmit?() }
                .onChange(of: text) { _, new in
                    if wraps, new.contains("\n") {
                        text = new.replacingOccurrences(of: "\n", with: "")
                        onSubmit?()
                    }
                }
                .font(.body)
                .modifier(MonoIf(on: mono))
                .foregroundStyle(.primary)
                .padding(.horizontal, 12)
                .padding(.vertical, wraps ? 8 : 0)
                .frame(minHeight: Theme.minTap)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay {
                    if error != nil {
                        RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.bad, lineWidth: 1.5)
                    }
                }
                .accessibilityLabel(label)
            if let error = error {
                Text(error).font(.footnote).foregroundStyle(Theme.badText)
                    .accessibilityLabel("\(label): \(error)")
            }
        }
    }
}

private struct MonoIf: ViewModifier {
    let on: Bool
    func body(content: Content) -> some View {
        if on { content.monospacedDigit() } else { content }
    }
}

// MARK: - Scroll edge

extension View {
    /// iOS 26 fades the top of a scroll view under the status bar; a header drawn up there on purpose should not get that fade.
    @ViewBuilder func wcNoTopScrollFade() -> some View {
        if #available(iOS 26.0, *) {
            scrollEdgeEffectHidden(true, for: .top)
        } else {
            self
        }
    }
}

// MARK: - Swipe back

/// The system's swipe-from-the-edge back gesture keeps working with the system back button hidden.
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
    /// The page behind a screen: the grouped-list ground. (The navigation bar comes from `.hiNav` / `WCNavBar`.)
    func wcScreenChrome() -> some View {
        background(Theme.ground.ignoresSafeArea())
    }
}

// MARK: - Grouped rows (the iOS lists of the rooms, windows and rows screens)

/// A section header above a group ("YOUR ROOMS"): footnote, secondary, capitals like a grouped list's.
struct GroupHeader: View {
    let text: String

    var body: some View {
        Text(text.uppercased())
            .font(.footnote)
            .foregroundStyle(Theme.ink2)
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityAddTraits(.isHeader)
    }
}

/// A grouped-list container: rows on `secondarySystemGroupedBackground`, continuous corners; rows inside are separated by a
/// hairline inset from the left.
struct GroupCard<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 0) { content }
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            .clipShape(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
    }
}

/// The hairline between two rows of a group.
struct RowDivider: View {
    var inset: CGFloat = 14

    var body: some View {
        Divider().padding(.leading, inset)
    }
}

/// The caption-sized "fine" line (small grey text) used under tiles and buttons.
struct SmallNote: View {
    let text: String

    var body: some View {
        Text(text).font(.footnote).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
    }
}

/// A bank card drawn small (the card-photo method's icon): a card with a chip. It stands for the real card, so it keeps its drawing.
struct BankCardGlyph: View {
    var width: CGFloat = 32

    var body: some View {
        let h = width * 0.66
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: width * 0.09, style: .continuous)
                .fill(LinearGradient(colors: [Color(light: 0x6B7280, dark: 0x7A808C), Color(light: 0x3C4150, dark: 0x4A505E)], startPoint: .topLeading, endPoint: .bottomTrailing))
            RoundedRectangle(cornerRadius: width * 0.04, style: .continuous)
                .fill(Color(light: 0xE7C477, dark: 0xE7C477))
                .frame(width: width * 0.2, height: width * 0.14)
                .offset(x: width * 0.1, y: h * 0.22)
        }
        .frame(width: width, height: h)
        .accessibilityHidden(true)
    }
}

/// A tab bar in the system's look: a bar material with a hairline on top, an SF Symbol over a caption label, the chosen one in
/// the accent. (My order, Windows, Messages.)
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
        .background(Theme.surface)
        .overlay(alignment: .top) { Divider() }
    }

    private var bar: some View {
        HStack(spacing: 0) {
            ForEach(items) { item in
                Button {
                    selection = item.id
                } label: {
                    VStack(spacing: 2) {
                        Image(systemName: item.icon.symbol).font(.title3).frame(height: 28)
                        Text(item.title).font(.caption2)
                    }
                    .foregroundStyle(selection == item.id ? Theme.red : Theme.ink2)
                    .frame(maxWidth: .infinity, minHeight: 49)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(item.title)
                .accessibilityAddTraits(selection == item.id ? [.isButton, .isSelected] : [.isButton])
            }
        }
        .padding(.top, 4)
    }

    /// Three tabs do not fit side by side at accessibility text sizes: one button at the full size opens the list.
    private var menu: some View {
        let current = items.first { $0.id == selection } ?? items[0]
        return Menu {
            ForEach(items) { item in
                Button {
                    selection = item.id
                } label: {
                    Label(item.title, systemImage: item.id == selection ? "checkmark" : item.icon.symbol)
                }
            }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: current.icon.symbol)
                Text(current.title).font(.headline)
                Image(systemName: "chevron.up.chevron.down").imageScale(.small)
            }
            .foregroundStyle(Theme.red)
            .frame(maxWidth: .infinity, minHeight: 56)
            .padding(.horizontal, Theme.gutter)
            .contentShape(Rectangle())
        }
        .accessibilityLabel("\(current.title). Choose a section")
        .padding(.top, 4)
    }
}

// MARK: - Sizes with stacked fractions

/// A size as the mockups set it: monospaced digits (the system font), the fraction small and stacked ("35 ⁵⁄₈"), never a decimal.
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

/// The rep's picture: the system's person placeholder (like a contact without a photo), no photo needed.
struct RepAvatar: View {
    var size: CGFloat = 44

    var body: some View {
        Image(systemName: "person.crop.circle.fill")
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .foregroundStyle(Color(.systemGray3))
            .accessibilityHidden(true)
    }
}
