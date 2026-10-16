import RooflineCore
import SwiftUI

/// 03 Results (ios-hw-03): "Here's your home": the house from above, then one card per service the homeowner picked. Windows are
/// next (blue); the roof is a price range from above; gutters are priced at the free visit. Roof or gutters only: straight on
/// to the contact form.
struct ResultsScreen: View {
    @Environment(HomeownerStore.self) private var store

    private var includesWindows: Bool { store.services.contains(.windows) }

    var body: some View {
        VStack(spacing: 0) {
            WCNavBar(title: store.brand.wordmark, wordmark: true, onBack: { store.pop() }) { StepDots(filled: 2) }
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    WCHeadline(text: "Here's your home").padding(.bottom, 4)
                    homeCard
                    if store.services.contains(.windows) { windowsCard }
                    if store.services.contains(.roof) { roofCard }
                    if store.services.contains(.gutters) { guttersCard }
                    if store.offline {
                        InfoPanel(icon: .info, text: "You're offline. We'll refresh this when you're back.", tint: Theme.warnTint, iconColor: Theme.warn)
                    }
                    WCScrollFooter()
                }
                .padding(.horizontal, Theme.gutter)
                .padding(.bottom, 24)
            }
        }
        .wcFooter {
            WCPrimaryButton(title: includesWindows ? "Measure my windows" : "Continue", icon: includesWindows ? nil : .arrow) { store.continueFromResults() }
        }
        .wcScreenChrome()
    }

    // MARK: Cards

    private var homeCard: some View {
        HStack(spacing: 16) {
            RoofThumb(outline: store.home?.outline.map { HomeownerOutlineShape(points: $0.points) })
                .frame(width: 96, height: 70)
            VStack(alignment: .leading, spacing: 3) {
                Text(streetLine).wc(17, .semibold, relativeTo: .headline).foregroundStyle(Theme.ink)
                Text(detailLine).wc(14, relativeTo: .subheadline).foregroundStyle(Theme.ink3).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(10)
        .wcCard(radius: 16)
        .accessibilityElement(children: .combine)
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
        guard let r = store.roofEstimate else { return "We price your roof at your free visit." }
        if let sq = r.squares, sq > 0 { return "About \(Self.squares(sq)) squares, measured from above. Exact price at your free visit." }
        return "Measured from above. Exact price at your free visit."
    }

    private static func squares(_ s: Double) -> String { s == s.rounded() ? "\(Int(s))" : String(format: "%.1f", s) }

    private var guttersCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                IconTile(icon: .gutter, size: 34, iconSize: 18)
                Text("Gutters").wc(17, .semibold, relativeTo: .headline).foregroundStyle(Theme.ink)
                Spacer()
                Text("Priced at your free visit").wc(14, .medium, relativeTo: .footnote).foregroundStyle(Theme.ink2)
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .background(Theme.surface2, in: Capsule())
            }
            Text("Add them now and we measure them at the same visit.").wc(15, relativeTo: .subheadline).foregroundStyle(Theme.ink2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .wcCard(radius: 16)
        .accessibilityElement(children: .combine)
    }
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
