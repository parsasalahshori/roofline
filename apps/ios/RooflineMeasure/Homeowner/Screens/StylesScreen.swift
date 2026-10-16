import RooflineCore
import SwiftUI

/// 09 Style (ios-hw-09): one window at a time, "Window 1 of 7": which style, and (when the server takes one) which color.
/// The shape of the window suggests the likeliest style. A window left without a style takes that suggestion.
struct StylesScreen: View {
    @Environment(HomeownerStore.self) private var store
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var picked: String?
    @State private var color: String?
    @State private var working = false

    private var rows: [WindowRow] { store.windowRows }
    private var index: Int { min(max(store.styleIndex, 0), max(rows.count - 1, 0)) }
    private var row: WindowRow? { rows.indices.contains(index) ? rows[index] : nil }
    private var isLast: Bool { index >= rows.count - 1 }
    private var suggestion: StyleGuess.Suggestion? { row.flatMap { store.suggestedStyle(for: $0) } }

    var body: some View {
        VStack(spacing: 0) {
            WCNavBar(title: "Window \(index + 1) of \(rows.count)", onBack: back) {
                NavTextButton(title: "Skip") { advance(setting: nil) }
            }
            if let row = row {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        WCHeadline(text: "Pick a style")
                        windowCard(row).padding(.top, 14)
                        GroupHeader(text: "Style").padding(.top, 18)
                        // Three tiles across; with large text one, so the names are not cut
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: typeSize.isAccessibilitySize ? 1 : 3), spacing: 8) {
                            ForEach(store.styles) { style in
                                StyleTile(style: style, selected: picked == style.key) {
                                    picked = style.key
                                    Haptics.tap()
                                }
                            }
                        }
                        if store.features.windowColor { colorRow.padding(.top, 20) }
                        HStack(alignment: .top, spacing: 10) {
                            IconView(icon: .check, size: 16, weight: 2).foregroundStyle(Theme.ok).padding(.top, 1)
                            Text(store.brand.glassNote).wc(13, relativeTo: .footnote).foregroundStyle(Theme.ink3).fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(.top, 14)
                        .padding(.horizontal, 4)
                        .accessibilityElement(children: .combine)
                        WCScrollFooter()
                    }
                    .padding(.horizontal, Theme.gutter)
                    .padding(.bottom, 24)
                }
            } else {
                Spacer()
            }
        }
        .wcFooter {
            WCPrimaryButton(title: nextTitle, isLoading: working, isEnabled: picked != nil) { advance(setting: picked) }
            WCSecondaryButton(title: "Use this style for all \(rows.count)", isEnabled: picked != nil && rows.count > 1) { applyToAll() }
        }
        .wcScreenChrome()
        .onAppear { load() }
        .onChange(of: store.styleIndex) { _, _ in load() }
    }

    private func windowCard(_ row: WindowRow) -> some View {
        HStack(alignment: .top, spacing: 12) {
            IconView(icon: .win, size: 22).foregroundStyle(Theme.ink3).padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                Text(row.title).wc(17, .semibold, relativeTo: .headline).foregroundStyle(Theme.ink)
                if let w = row.widthIn, let h = row.heightIn {
                    StyleSizeLine(widthIn: w, heightIn: h, hint: suggestion?.hint)
                        .accessibilityLabel("\(SizeWording.spokenSize(widthIn: w, heightIn: h)). \(suggestion?.hint ?? "")")
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .wcCard()
        .accessibilityElement(children: .combine)
    }

    private var colorRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            GroupHeader(text: "Color")
            HStack(alignment: .top, spacing: 6) {
                ForEach(store.brand.windowColors) { c in
                    Button {
                        color = c.key
                        Haptics.tap()
                    } label: {
                        VStack(spacing: 6) {
                            Circle().fill(Color(hex: c.hex)).frame(width: 40, height: 40)
                                .overlay(Circle().strokeBorder(Color.black.opacity(0.15), lineWidth: 1))
                                .overlay { if color == c.key { Circle().strokeBorder(Theme.blue, lineWidth: 2).padding(-4) } }
                                .padding(4)
                            Text(Self.display(c.label)).wc(12, color == c.key ? .semibold : .regular, relativeTo: .caption)
                                .foregroundStyle(color == c.key ? Theme.ink : Theme.ink2)
                                .multilineTextAlignment(.center).lineLimit(2).minimumScaleFactor(0.8)
                        }
                        .frame(maxWidth: .infinity)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(c.label)
                    .accessibilityAddTraits(color == c.key ? .isSelected : [])
                }
            }
        }
    }

    /// The two long names break across lines in the mockup ("Sand-stone", "Earth-tone").
    static func display(_ label: String) -> String {
        switch label {
        case "Sandstone": return "Sand-\nstone"
        case "Earthtone": return "Earth-\ntone"
        default: return label
        }
    }

    private var nextTitle: String {
        guard !isLast else { return "See my quote" }
        let next = rows[index + 1]
        return "Next: window \(index + 2) · \(next.room.isEmpty ? next.title : next.room)"
    }

    /// Opens a window: its own style, else the suggestion.
    private func load() {
        guard let row = row else { return }
        picked = row.style ?? suggestion?.keys.first
        color = store.color(for: row.id) ?? (store.features.windowColor ? store.brand.windowColors.first?.key : nil)
    }

    private func back() {
        if index > 0 { store.styleIndex = index - 1 } else { store.pop() }
    }

    /// Saves this window's pick (nil: leave it for the end) and goes to the next, or on to the quote.
    private func advance(setting key: String?) {
        guard let row = row else { return }
        working = true
        Task {
            if let key = key {
                await store.setStyle(key, for: row.id)
                if store.features.windowColor, let c = color { store.setColor(c, for: row.id) }
            }
            if isLast {
                await store.finishStyles()
            } else {
                store.styleIndex = index + 1
            }
            working = false
        }
    }

    private func applyToAll() {
        guard let key = picked else { return }
        working = true
        Task {
            await store.setStyleForAll(key)
            if store.features.windowColor, let c = color { for r in rows { store.setColor(c, for: r.id) } }
            await store.finishStyles()
            working = false
        }
    }
}

/// "Picture (does not open)" is a name and a hint; "Slider, 2 panes" too: the tile sets the name big and the hint small.
enum StyleLabel {
    static func split(_ label: String) -> (title: String, detail: String?) {
        if let open = label.firstIndex(of: "("), let close = label.lastIndex(of: ")"), open < close {
            let title = label[..<open].trimmingCharacters(in: .whitespaces)
            let detail = label[label.index(after: open)..<close].trimmingCharacters(in: .whitespaces)
            return (title, detail.isEmpty ? nil : detail)
        }
        if let comma = label.firstIndex(of: ",") {
            let title = label[..<comma].trimmingCharacters(in: .whitespaces)
            let detail = label[label.index(after: comma)...].trimmingCharacters(in: .whitespaces)
            return (title, detail.isEmpty ? nil : detail)
        }
        return (label, nil)
    }
}

/// "71 1/4 x 59 3/8 in, wide, so most homes use a slider or picture": the size with its stacked fractions, then the hint; it
/// grows with Dynamic Type like the rest.
private struct StyleSizeLine: View {
    let widthIn: Double
    let heightIn: Double
    let hint: String?
    @ScaledMetric(relativeTo: .subheadline) private var size: CGFloat = 15

    var body: some View {
        var line = SizeFormat.pair(widthIn, heightIn, size: size, weight: .regular, color: Theme.ink3, unit: true)
        if let hint = hint {
            var tail = AttributedString(" \u{00B7} \(hint)")
            tail.font = .system(size: size - 1)
            tail.foregroundColor = Theme.ink3
            line += tail
        }
        return Text(line).fixedSize(horizontal: false, vertical: true)
    }
}

private struct StyleTile: View {
    let style: HomeownerStyleOption
    let selected: Bool
    let action: () -> Void

    var body: some View {
        let parts = StyleLabel.split(style.label)
        Button(action: action) {
            VStack(spacing: 4) {
                StyleGlyph(key: style.key, width: 44)
                    .foregroundStyle(selected ? Theme.blue : Theme.ink)
                    .padding(.bottom, 2)
                Text(parts.title).wc(14, selected ? .semibold : .medium, relativeTo: .footnote)
                    .foregroundStyle(selected ? Theme.blue : Theme.ink)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .minimumScaleFactor(0.85)
                    .fixedSize(horizontal: false, vertical: true)
                Text(parts.detail ?? " ").wc(11, relativeTo: .caption2)
                    .foregroundStyle(Theme.ink3)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .opacity(parts.detail == nil ? 0 : 1)
            }
            .padding(.horizontal, 4)
            .padding(.top, 9)
            .padding(.bottom, 8)
            .frame(maxWidth: .infinity, minHeight: 100)
            .wcCard(selected: selected, radius: 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(style.label)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
