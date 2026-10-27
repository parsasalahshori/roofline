import SwiftUI

// Shared by the booking, measuring and contact screens

/// A screen's heading as the header of the list's first section: a title and an optional line under it, set like a Settings
/// page's intro (not capitals, no secondary colour on the title).
struct HiListHeading: View {
    let title: String
    var subtitle: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.title2.weight(.bold)).foregroundStyle(Theme.ink)
                .accessibilityAddTraits(.isHeader)
            if let subtitle = subtitle {
                Text(subtitle).font(.subheadline).foregroundStyle(Theme.ink2)
            }
        }
        .textCase(nil)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, 6)
    }
}

/// A small label in a capsule ("Most picked", "About 1/4 inch · best"): plain text on a quiet fill, or (prominent) the accent
/// with white text, which clears 4.5:1 on the #CC2F23 fill. Status words use the darker text variants.
struct CapsuleLabel: View {
    enum Kind { case plain, ok }
    let text: String
    var kind: Kind = .plain
    var prominent = false

    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundStyle(foreground)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(background, in: Capsule())
    }

    private var foreground: Color {
        if prominent { return Theme.onRed }
        return kind == .ok ? Theme.okText : Theme.ink2
    }

    private var background: Color {
        if prominent { return Theme.buttonFill }
        return kind == .ok ? Theme.okTint : Color(.tertiarySystemFill)
    }
}
