import RooflineCore
import SwiftUI


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
