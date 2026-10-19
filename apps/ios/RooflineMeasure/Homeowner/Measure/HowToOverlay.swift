import SwiftUI

/// "How?": a short card of numbered steps over the camera, shown the first time a measuring screen opens and again from its
/// small "How?" button. Plain words, one picture, one button.
struct HowToOverlay: View {
    let title: String
    let steps: [String]
    let art: Tip.Art
    let onDone: () -> Void

    var body: some View {
        ZStack {
            Color.black.opacity(0.72).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 14) {
                Text(title).wcHeading(22, .heavy, relativeTo: .title2).foregroundStyle(Theme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                TipArt(art: art)
                    .frame(width: 129, height: 99)
                    .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .frame(maxWidth: .infinity)
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(steps.enumerated()), id: \.offset) { i, text in
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text("\(i + 1)").wcMono(15, .bold, relativeTo: .subheadline).foregroundStyle(Theme.tapeInk)
                                .frame(width: 26, height: 26).background(Circle().fill(Theme.tape))
                            Text(text).wc(17, relativeTo: .body).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("Step \(i + 1). \(text)")
                    }
                }
                WCPrimaryButton(title: "Got it", action: onDone).padding(.top, 4)
            }
            .padding(20)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .padding(.horizontal, 20)
            .environment(\.colorScheme, .light)
        }
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        .accessibilityAddTraits(.isModal)
    }
}

/// Whether a how-to has been seen (UserDefaults), one flag per measuring screen.
enum HowToSeen {
    static func key(_ name: String) -> String { "winchoice.howto.\(name)" }
    static func isSeen(_ name: String) -> Bool { UserDefaults.standard.bool(forKey: key(name)) }
    static func markSeen(_ name: String) { UserDefaults.standard.set(true, forKey: key(name)) }
}

/// The small "How?" button of a measuring screen.
struct HowButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                IconView(icon: .info, size: 16, weight: 2)
                Text("How?").wc(15, .semibold, relativeTo: .subheadline)
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .background(Capsule().fill(Color(white: 0.12, opacity: 0.75)))
        }
        .accessibilityLabel("How to measure")
    }
}
