import RooflineCore
import SwiftUI

/// 09 Style (ios-hw-09): one window at a time, "Window 1 of 7": which style, and (when the server takes one) which color.
/// The shape of the window suggests the likeliest style. A window left without a style takes that suggestion.
struct StylesScreen: View {
    @Environment(HomeownerStore.self) private var store
    @State private var picked: String?
    @State private var color: String?
    @State private var working = false

    private var rows: [WindowRow] { store.windowRows }
    private var index: Int { min(max(store.styleIndex, 0), max(rows.count - 1, 0)) }
    private var row: WindowRow? { rows.indices.contains(index) ? rows[index] : nil }
    private var isLast: Bool { index >= rows.count - 1 }
    private var suggestion: StyleGuess.Suggestion? { row.flatMap { store.suggestedStyle(for: $0) } }

    var body: some View {
        Group {
            if let row = row {
                List {
                    Section {
                        windowRow(row)
                    }
                    Section {
                        ForEach(store.styles) { style in
                            StyleRow(style: style, selected: picked == style.key) {
                                picked = style.key
                                Haptics.tap()
                            }
                        }
                    } header: {
                        Text("Pick a style").foregroundStyle(Theme.ink2)
                    } footer: {
                        if !store.features.windowColor { glassNote }
                    }
                    if store.features.windowColor {
                        Section {
                            colorRow
                        } header: {
                            Text("Color").foregroundStyle(Theme.ink2)
                        } footer: {
                            glassNote
                        }
                    }
                    JourneyListFooter()
                }
                .listStyle(.insetGrouped)
            } else {
                Color.clear
            }
        }
        .hiNav(title: "Window \(index + 1) of \(rows.count)", onBack: back) {
            NavTextButton(title: "Skip") { advance(setting: nil) }
        }
        .wcFooter {
            WCPrimaryButton(title: nextTitle, isLoading: working, isEnabled: picked != nil) { advance(setting: picked) }
            WCSecondaryButton(title: "Use this style for all \(rows.count)", isEnabled: picked != nil && rows.count > 1) { applyToAll() }
        }
        .onAppear { load() }
        .onChange(of: store.styleIndex) { _, _ in load() }
    }

    /// The window being styled: its name and size, with the likeliest style said under it.
    private func windowRow(_ row: WindowRow) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: WCIcon.win.symbol)
                .symbolRenderingMode(.hierarchical)
                .font(.title2)
                .foregroundStyle(Theme.red)
                .frame(width: 32)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(row.title).font(.headline).foregroundStyle(Theme.ink)
                if let w = row.widthIn, let h = row.heightIn {
                    StyleSizeLine(widthIn: w, heightIn: h, hint: suggestion?.hint)
                        .accessibilityLabel("\(SizeWording.spokenSize(widthIn: w, heightIn: h)). \(suggestion?.hint ?? "")")
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    private var glassNote: some View {
        Label {
            Text(store.brand.glassNote).fixedSize(horizontal: false, vertical: true)
        } icon: {
            FilledSymbol(name: "checkmark.circle.fill", fill: Theme.okText)
        }
        .font(.footnote)
        .foregroundStyle(Theme.ink2)
        .padding(.top, 4)
        .accessibilityElement(children: .combine)
    }

    /// The colours as swatches in one row: the chosen one has an accent ring.
    private var colorRow: some View {
        HStack(alignment: .top, spacing: 6) {
            ForEach(store.brand.windowColors) { c in
                Button {
                    color = c.key
                    Haptics.tap()
                } label: {
                    VStack(spacing: 6) {
                        Circle().fill(Color(hex: c.hex)).frame(width: 40, height: 40)
                            .overlay(Circle().strokeBorder(Color.black.opacity(0.15), lineWidth: 1))
                            .overlay { if color == c.key { Circle().strokeBorder(Theme.red, lineWidth: 2).padding(-4) } }
                            .padding(4)
                        Text(Self.display(c.label)).font(.caption.weight(color == c.key ? .semibold : .regular))
                            .foregroundStyle(color == c.key ? Theme.ink : Theme.ink2)
                            .multilineTextAlignment(.center).lineLimit(2).minimumScaleFactor(0.8)
                    }
                    .frame(maxWidth: .infinity)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(c.label)
                .accessibilityAddTraits(color == c.key ? .isSelected : [])
            }
        }
        .padding(.vertical, 4)
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
        var line = SizeFormat.pair(widthIn, heightIn, size: size, weight: .regular, color: Theme.ink2, unit: true)
        if let hint = hint {
            var tail = AttributedString(" \u{00B7} \(hint)")
            tail.font = .system(size: size - 1)
            tail.foregroundColor = Theme.ink2
            line += tail
        }
        return Text(line).fixedSize(horizontal: false, vertical: true)
    }
}

/// A style as a row: its drawing, the name and a hint, and a checkmark on the chosen one.
private struct StyleRow: View {
    let style: HomeownerStyleOption
    let selected: Bool
    let action: () -> Void

    var body: some View {
        let parts = StyleLabel.split(style.label)
        Button(action: action) {
            HStack(spacing: 14) {
                StyleGlyph(key: style.key, width: 44)
                    .foregroundStyle(selected ? Theme.red : Theme.ink)
                    .frame(width: 52)
                VStack(alignment: .leading, spacing: 2) {
                    Text(parts.title).font(.body.weight(selected ? .semibold : .regular)).foregroundStyle(Theme.ink)
                    if let detail = parts.detail ?? style.hint {
                        Text(detail).font(.subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if selected {
                    Image(systemName: WCIcon.check.symbol)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Theme.red)
                        .accessibilityHidden(true)
                }
            }
            .padding(.vertical, 2)
            .frame(minHeight: Theme.minTap)
            .contentShape(Rectangle())
        }
        .accessibilityLabel(style.label)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
