import RooflineCore
import SwiftUI

/// 01b What to measure: windows or roof, one per request. A tap on a row goes straight on to the address.
struct ServiceScreen: View {
    @Environment(HomeownerStore.self) private var store

    var body: some View {
        List {
            Section {
                ForEach(store.offeredServices, id: \.self) { service in
                    ServiceChoice(service: service) { store.chooseService(service) }
                }
            } header: {
                JourneyHeader {
                    JourneyLead("Pick one. You can measure the other one after.")
                    StepProgress(step: 1)
                }
            }
            JourneyListFooter()
        }
        .listStyle(.insetGrouped)
        .hiNav(title: "What to measure", display: .large)
    }
}

/// The lines under a large title (a lead sentence and, on the first steps, the progress bar): the header of the list's first
/// section, pulled out to the title's own left edge and with its capital letters turned off. Shared by the journey screens that
/// are lists.
struct JourneyHeader<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .textCase(nil)
            .padding(.horizontal, -16)
            .padding(.bottom, 6)
    }
}

/// A lead sentence for `JourneyHeader`: body text in the secondary colour, or a heading when `heading` is set.
struct JourneyLead: View {
    let text: String
    var heading = false

    init(_ text: String, heading: Bool = false) {
        self.text = text
        self.heading = heading
    }

    var body: some View {
        Text(text)
            .font(heading ? Font.title3.weight(.semibold) : Font.body)
            .foregroundStyle(heading ? Theme.ink : Theme.ink2)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(heading ? .isHeader : [])
    }
}

/// A filled-shape SF Symbol (`checkmark.circle.fill`, `3.circle.fill`, `plus.circle.fill`) as a solid shape with a glyph cut out of it:
/// a palette of two plain colours rather than the hierarchical look, whose shape is only half-strength (the accessibility audit
/// reads the glyph against that pale shape and calls it low contrast). `fill` is the shape, `glyph` the mark on it (white in the
/// light appearance, black in the dark one, so it reads on the lighter dark-mode colours too).
struct FilledSymbol: View {
    let name: String
    let fill: Color
    var glyph = Color(light: 0xFFFFFF, dark: 0x000000)

    var body: some View {
        Image(systemName: name)
            .symbolRenderingMode(.palette)
            .foregroundStyle(glyph, fill)
            .accessibilityHidden(true)
    }
}

/// The last section of a screen's `List`: the screen's footer buttons, when the text is too large to pin them (see `WCScrollFooter`).
/// At ordinary sizes it draws nothing. Shared by the journey screens that are lists.
struct JourneyListFooter: View {
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        if typeSize.isAccessibilitySize {
            Section {
                WCScrollFooter()
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
        }
    }
}

/// One row per service, like a Settings row: a symbol, the title, one line, a chevron. The whole row is the button.
struct ServiceChoice: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let service: HomeownerService
    let action: () -> Void

    private var icon: WCIcon {
        switch service {
        case .windows: return .win
        case .roof: return .roof
        case .gutters: return .gutter // never listed: gutters are not offered to homeowners
        }
    }

    private var title: String {
        switch service {
        case .windows: return "Windows"
        case .roof: return "Roof"
        case .gutters: return "Gutters"
        }
    }

    private var line: String {
        switch service {
        case .windows: return "Measure each window with your iPhone and get your price."
        case .roof: return "We measure your roof from above and show you a price range."
        case .gutters: return "Priced at your free visit."
        }
    }

    var body: some View {
        Button(action: {
            Haptics.tap()
            action()
        }) {
            // At accessibility text sizes the symbol sits above the words (side by side they would get a narrow column)
            AdaptiveStack(alignment: .center, spacing: 14) {
                Image(systemName: icon.symbol)
                    .symbolRenderingMode(.hierarchical)
                    .font(.title2)
                    .foregroundStyle(Theme.red)
                    .frame(width: 36)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.headline).foregroundStyle(Theme.ink)
                    Text(line).font(.subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if !typeSize.isAccessibilitySize {
                    Image(systemName: WCIcon.chevRight.symbol)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Theme.decor)
                        .accessibilityHidden(true)
                }
            }
            .padding(.vertical, 8)
            .frame(minHeight: Theme.minTap)
            .contentShape(Rectangle())
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title). \(line)")
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("service.\(service.rawValue)")
    }
}
