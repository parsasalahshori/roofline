import RooflineCore
import SwiftUI

/// 03 Results (ios-hw-03): "Here's your home": the house from above, then one card per service the homeowner picked. Windows are
/// next (blue); the roof is a price range from above; a roof the satellite pictures cannot show says so instead of a price. Roof only: straight on
/// to the contact form.
struct ResultsScreen: View {
    @Environment(HomeownerStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    @State private var reveal = HomeReveal()

    private var includesWindows: Bool { store.services.contains(.windows) }

    /// The roof's outline as a satellite hero: only when the server gave a usable outline and the phone could reach it.
    /// Otherwise (no outline, an old request that came from disk, offline) today's small static card, with no error.
    private var heroGeometry: HomeOutlineGeometry? {
        store.offline ? nil : HomeOutlineGeometry(outline: store.home?.outline)
    }

    /// The reveal plays once per request; coming back to this screen shows the finished picture.
    private var alreadyRevealed: Bool {
        guard let id = store.session?.requestId else { return false }
        return store.revealedRequestId == id
    }

    private var cardsVisible: Bool { heroGeometry == nil || alreadyRevealed || reveal.stage == .done }
    private var revealing: Bool { heroGeometry != nil && !alreadyRevealed && reveal.stage != .done }

    var body: some View {
        VStack(spacing: 0) {
            WCNavBar(title: store.brand.wordmark, wordmark: true, onBack: { store.pop() })
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    WCHeadline(text: "Here's your home")
                    StepProgress(step: 3).padding(.bottom, 4)
                    if let g = heroGeometry { heroCard(g) } else { homeCard }
                    if store.services.contains(.windows) { windowsCard.revealed(cardsVisible, order: 0, reduceMotion: reduceMotion) }
                    if store.services.contains(.roof) { roofCard.revealed(cardsVisible, order: store.services.contains(.windows) ? 1 : 0, reduceMotion: reduceMotion) }
                    // Roof only: this is the result page (windows get theirs on the quote, after measuring)
                    if !includesWindows, store.services.contains(.roof) {
                        EstimateCallCard(service: .roof).revealed(cardsVisible, order: 1, reduceMotion: reduceMotion)
                    }
                    if store.offline {
                        InfoPanel(icon: .info, text: "You're offline. We'll refresh this when you're back.", tint: Theme.warnTint, iconColor: Theme.warn)
                    }
                    WCScrollFooter()
                }
                .padding(.horizontal, Theme.gutter)
                .padding(.bottom, 24)
                // A tap anywhere on the screen skips the reveal to the finished picture (a button still gets its tap too)
                .simultaneousGesture(TapGesture().onEnded { if revealing { reveal.skip() } })
            }
        }
        .wcFooter {
            WCPrimaryButton(title: includesWindows ? "Measure my windows" : "Continue", icon: includesWindows ? nil : .arrow) { store.continueFromResults() }
        }
        .wcScreenChrome()
    }

    // MARK: Cards

    /// The hero: their house from above with the roof drawn round it, the address and the size under it.
    private func heroCard(_ g: HomeOutlineGeometry) -> some View {
        VStack(spacing: 0) {
            GeometryReader { geo in
                if geo.size.width > 40 {
                    HomeHeroMap(geometry: g, size: geo.size, animated: !alreadyRevealed && !reduceMotion && !voiceOver, reveal: reveal) {
                        store.revealedRequestId = store.session?.requestId
                    }
                }
            }
            .frame(height: 250)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("A satellite view of your home with your roof outlined.")
            AdaptiveStack(alignment: .center, spacing: 8) {
                addressText
                    .frame(maxWidth: .infinity, alignment: .leading)
                changeButton
            }
            .padding(.leading, 14).padding(.trailing, 14).padding(.vertical, 6)
        }
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .wcCard(radius: 16)
    }

    /// The street and, under it, "Irvine, CA · 2 floors · about 190 ft of outside wall".
    private var addressText: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(streetLine).wc(17, .semibold, relativeTo: .headline).foregroundStyle(Theme.ink)
            Text(detailLine).wc(14, relativeTo: .subheadline).foregroundStyle(Theme.ink3).fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    /// Back to the address screen to pick another home (the back arrow does the same, but this says what it is for).
    private var changeButton: some View {
        Button("Change") { store.pop() }
            .wc(15, .semibold, relativeTo: .subheadline)
            .foregroundStyle(Theme.blue)
            .frame(minWidth: Theme.minTap, minHeight: Theme.minTap)
            .contentShape(Rectangle())
            .accessibilityLabel("Change address")
    }

    /// Today's small card, for a home with no outline to draw (or a phone that is offline).
    private var homeCard: some View {
        HStack(spacing: 16) {
            RoofThumb(outline: store.home?.outline.map { HomeownerOutlineShape(points: $0.points) })
                .frame(width: 96, height: 70)
            VStack(alignment: .leading, spacing: 0) {
                addressText
                changeButton
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(10)
        .wcCard(radius: 16)
    }

    private var streetLine: String {
        store.address.split(separator: ",").first.map { String($0).trimmingCharacters(in: .whitespaces) } ?? store.address
    }

    /// "Little Rock, AR · 1 floor · about 130 ft of outside wall"
    private var detailLine: String {
        var parts: [String] = []
        let rest = store.address.split(separator: ",").dropFirst().map { $0.trimmingCharacters(in: .whitespaces) }
        if !rest.isEmpty {
            // "Little Rock, AR 72205" shows as "Little Rock, AR"
            var city = rest.joined(separator: ", ")
            if let r = city.range(of: #" \d{5}(-\d{4})?$"#, options: .regularExpression) { city.removeSubrange(r) }
            parts.append(city)
        }
        if let f = store.home?.floorsText { parts.append(f) }
        if let ft = store.progress.perimeterFt ?? store.home?.outline.flatMap({ RoofOutline.perimeterFeet($0) }) { parts.append("about \(ft) ft of outside wall") }
        return parts.joined(separator: " · ")
    }

    private var windowsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                IconTile(icon: .win, size: 34, iconSize: 18, selected: true)
                Text("Windows").wc(17, .semibold, relativeTo: .headline).foregroundStyle(Theme.ink)
                Spacer()
                Text("Next").wc(15, .semibold, relativeTo: .subheadline).foregroundStyle(Theme.blue)
                    .padding(.horizontal, 14).padding(.vertical, 6)
                    .background(Theme.surface, in: Capsule())
            }
            windowsBody
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .wcCard(selected: true, radius: 16)
        .accessibilityElement(children: .combine)
    }

    private var windowsBody: some View {
        var attributed = AttributedString()
        if let e = store.windowEstimate {
            let range = e.low == e.high ? "\(e.low)" : "\(e.low) to \(e.high)"
            attributed += AttributedString("Homes like yours usually have ")
            var strong = AttributedString("\(range) windows")
            strong.inlinePresentationIntent = .stronglyEmphasized
            strong.foregroundColor = Theme.ink
            attributed += strong
            attributed += AttributedString(". Measure them with your iPhone for an exact quote.")
        } else {
            attributed += AttributedString("Measure each window with your iPhone for an exact quote. We'll count as you go.")
        }
        return Text(attributed).wc(15, relativeTo: .subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
    }

    private var roofCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            // The price sits beside the name when it fits, under it when it does not (large text), never cut or squeezed
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) {
                    IconTile(icon: .roof, size: 34, iconSize: 18)
                    Text("Roof").wc(17, .semibold, relativeTo: .headline).foregroundStyle(Theme.ink)
                    Spacer(minLength: 8)
                    roofPrice.fixedSize()
                }
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 12) {
                        IconTile(icon: .roof, size: 34, iconSize: 18)
                        Text("Roof").wc(17, .semibold, relativeTo: .headline).foregroundStyle(Theme.ink)
                    }
                    roofPrice.fixedSize()
                }
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 12) {
                        IconTile(icon: .roof, size: 34, iconSize: 18)
                        Text("Roof").wc(17, .semibold, relativeTo: .headline).foregroundStyle(Theme.ink)
                    }
                    roofPrice.lineLimit(2)
                }
            }
            Text(roofBody).wc(15, relativeTo: .subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .wcCard(radius: 16)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var roofPrice: some View {
        if let r = store.roofEstimate {
            Text(Money.range(r.low, r.high)).wcHeading(20, .heavy, relativeTo: .title3).foregroundStyle(Theme.ink)
        }
    }

    private var roofBody: String {
        if let note = store.roofNote { return note.message }
        guard let r = store.roofEstimate else { return "We price your roof at your free visit." }
        if let sq = r.squares, sq > 0 { return "About \(Self.squares(sq)) squares, measured from above. Exact price at your free visit." }
        return "Measured from above. Exact price at your free visit."
    }

    private static func squares(_ s: Double) -> String { s == s.rounded() ? "\(Int(s))" : String(format: "%.1f", s) }
}

/// Dollars as the mockups write them: "$9,800", and a range "$9,800–12,100".
enum Money {
    static func dollars(_ value: Double) -> String {
        "$" + grouped(value)
    }

    static func grouped(_ value: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.maximumFractionDigits = 0
        f.locale = Locale(identifier: "en_US")
        return f.string(from: NSNumber(value: value.rounded())) ?? "\(Int(value.rounded()))"
    }

    static func range(_ low: Double, _ high: Double) -> String {
        low.rounded() == high.rounded() ? dollars(low) : "\(dollars(low))–\(grouped(high))"
    }
}


/// The cards under the hero come in once it has finished: a short fade and rise, one after the other.
private extension View {
    func revealed(_ visible: Bool, order: Int, reduceMotion: Bool) -> some View {
        opacity(visible ? 1 : 0)
            .offset(y: visible || reduceMotion ? 0 : 14)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.35).delay(Double(order) * 0.09), value: visible)
            .accessibilityHidden(!visible)
    }
}
