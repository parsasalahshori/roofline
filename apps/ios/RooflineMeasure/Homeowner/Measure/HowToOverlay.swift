import SwiftUI

/// "How?": a short list of numbered steps, shown the first time a measuring screen opens and again from its small "How?" button.
/// A native sheet over the camera (about four fifths high, or large; dark like the camera's own screens): a picture, the steps as list rows, one button.
/// The callers keep placing it like an overlay (`if showHowTo { ArHowTo { ... } }`); it presents itself and calls `onDone` when it goes
/// away, by "Got it" or by a swipe down.
struct HowToOverlay: View {
    let title: String
    let steps: [String]
    let art: Tip.Art
    let onDone: () -> Void
    @State private var presented = true

    var body: some View {
        Color.clear
            .sheet(isPresented: $presented, onDismiss: onDone) {
                HowToSheet(title: title, steps: steps, art: art) { presented = false }
            }
    }
}

private struct HowToSheet: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let title: String
    let steps: [String]
    let art: Tip.Art
    let onDone: () -> Void

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TipArt(art: art)
                        .frame(width: 129, height: 99)
                        .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .frame(maxWidth: .infinity)
                        .listRowBackground(Color.clear)
                        .accessibilityHidden(true)
                }
                Section {
                    ForEach(Array(steps.enumerated()), id: \.offset) { i, text in
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            Text("\(i + 1)").font(.subheadline.weight(.bold)).monospacedDigit().foregroundStyle(Theme.tapeInk)
                                .frame(width: 26, height: 26).background(Circle().fill(Theme.tape))
                                .accessibilityHidden(true)
                            Text(text).font(.body).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("Step \(i + 1). \(text)")
                    }
                }
                if typeSize.isAccessibilitySize {
                    Section { WCPrimaryButton(title: "Got it", action: onDone) }
                        .listRowBackground(Color.clear)
                }
            }
            .listStyle(.insetGrouped)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if !typeSize.isAccessibilitySize {
                    WCPrimaryButton(title: "Got it", action: onDone)
                        .padding(.horizontal, Theme.gutter)
                        .padding(.top, 12)
                        .padding(.bottom, 8)
                        .background(.bar)
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.fraction(0.8), .large])
        .presentationDragIndicator(.visible)
        .preferredColorScheme(.dark)
    }
}

/// Whether a how-to has been seen (UserDefaults), one flag per measuring screen.
enum HowToSeen {
    static func key(_ name: String) -> String { "winchoice.howto.\(name)" }
    static func isSeen(_ name: String) -> Bool { UserDefaults.standard.bool(forKey: key(name)) }
    static func markSeen(_ name: String) { UserDefaults.standard.set(true, forKey: key(name)) }
}

/// The small "How?" button of a measuring screen: an SF Symbol and a word on a material capsule.
struct HowButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: WCIcon.info.symbol)
                Text("How?").font(.subheadline.weight(.semibold))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 14)
            .frame(minHeight: Theme.minTap)
            .hudCapsule()
        }
        .accessibilityLabel("How to measure")
    }
}
