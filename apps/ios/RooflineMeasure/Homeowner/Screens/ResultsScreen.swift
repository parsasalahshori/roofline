import RooflineCore
import SwiftUI

/// 03 Results (ios-hw-03): "Here's your home": the address, then what comes next (measuring the windows).
struct ResultsScreen: View {
    @Environment(HomeownerStore.self) private var store

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                StepProgress(step: 2)
                homeCard
                windowsCard
                if store.offline {
                    InfoPanel(icon: .info, text: "You're offline. We'll refresh this when you're back.").wcPanel()
                }
                WCScrollFooter()
            }
            .padding(.horizontal, Theme.gutter)
            .padding(.bottom, 24)
        }
        .background(Theme.ground.ignoresSafeArea())
        .hiNav(title: "Here's your home", display: .large)
        .wcFooter {
            WCPrimaryButton(title: "Measure my windows") { store.continueFromResults() }
        }
    }

    // MARK: Cards

    /// The street and, under it, "Irvine, CA · 2 floors · about 190 ft of outside wall".
    private var addressText: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(streetLine).font(.headline).foregroundStyle(Theme.ink)
            Text(detailLine).font(.subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    /// Back to the address screen to pick another home (the back arrow does the same, but this says what it is for).
    private var changeButton: some View {
        Button("Change") { store.pop() }
            .frame(minWidth: Theme.minTap, minHeight: Theme.minTap)
            .contentShape(Rectangle())
            .accessibilityLabel("Change address")
    }

    /// The home: a house symbol, the address and the size under it, and Change.
    private var homeCard: some View {
        HStack(spacing: 16) {
            Image(systemName: "house.fill")
                .font(.title2)
                .foregroundStyle(Theme.red)
                .frame(width: 56, height: 56)
                .background(Theme.red.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 0) {
                addressText
                changeButton
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(12)
        .wcCard()
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
        if let ft = store.progress.perimeterFt ?? store.home?.outline.flatMap({ HomeFootprint.perimeterFeet($0) }) { parts.append("about \(ft) ft of outside wall") }
        return parts.joined(separator: " · ")
    }

    private var windowsCard: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: WCIcon.win.symbol)
                .symbolRenderingMode(.hierarchical)
                .font(.title2)
                .foregroundStyle(Theme.red)
                .frame(width: 32)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text("Windows").font(.headline).foregroundStyle(Theme.ink)
                    Spacer(minLength: 8)
                    Text("Next").font(.subheadline).foregroundStyle(Theme.ink2)
                    Image(systemName: WCIcon.chevRight.symbol).font(.footnote.weight(.semibold)).foregroundStyle(Theme.decor).accessibilityHidden(true)
                }
                windowsBody
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .wcCard()
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
        return Text(attributed).font(.subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
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
