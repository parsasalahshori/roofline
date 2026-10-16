import RooflineCore
import SwiftUI

/// 11 Quote (ios-hw-11): "7 windows, your price": Good, Better and Best for the windows measured (and an estimate for any
/// not measured yet), what every window includes, and the honest line that a rep re-measures before anything is built.
struct QuoteScreen: View {
    @Environment(HomeownerStore.self) private var store

    private var quote: HomeownerQuote? { store.quote }

    var body: some View {
        VStack(spacing: 0) {
            WCNavBar(title: "Your quote", onBack: { store.pop() }) {
                if quote != nil {
                    ShareLink(item: shareText) {
                        IconView(icon: .upload, size: 22).foregroundStyle(Theme.blue).frame(width: Theme.minTap, height: Theme.minTap)
                    }
                    .accessibilityLabel("Share your quote")
                }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let q = quote, !q.tiers.isEmpty {
                        WCHeadline(text: "\(q.windowCount) window\(q.windowCount == 1 ? "" : "s"), your price",
                                   subtitle: "\(q.measuredCount) measured by you · \(q.estimatedCount) estimated. Installed, old windows hauled away.")
                            .padding(.bottom, 4)
                        ForEach(q.tiers) { tier in
                            TierCard(tier: tier, windowCount: q.windowCount, selected: store.selectedTier == tier.key) { store.selectTier(tier.key) }
                        }
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(store.brand.includes, id: \.self) { line in
                                HStack(alignment: .top, spacing: 10) {
                                    IconView(icon: .check, size: 18, weight: 2).foregroundStyle(Theme.ok).padding(.top, 1)
                                    Text(line).wc(15, relativeTo: .subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
                                }
                                .accessibilityElement(children: .combine)
                            }
                        }
                        .padding(.top, 6).padding(.horizontal, 4)
                        InfoPanel(icon: .ruler, text: honestLine).padding(.top, 2)
                        if q.estimatedCount > 0 {
                            InfoPanel(icon: .info, text: "\(q.estimatedCount) window\(q.estimatedCount == 1 ? " isn't" : "s aren't") measured yet, so \(q.estimatedCount == 1 ? "it is" : "they are") priced from your home's size. Measuring them makes your price exact.",
                                      tint: Theme.warnTint, iconColor: Theme.warn)
                        }
                    } else if store.loadingQuote {
                        WCHeadline(text: "Working out your price")
                        HStack(spacing: 12) {
                            ProgressView()
                            Text(store.unsentCount > 0 ? "Sending your windows first…" : "One moment…").wc(15, relativeTo: .subheadline).foregroundStyle(Theme.ink2)
                        }
                        .padding(.top, 8)
                    } else {
                        WCHeadline(text: "We couldn't price your windows yet",
                                   subtitle: store.offline ? "You're offline. Your windows are saved on this phone and send when you're back." : "Something got in the way. Try again in a moment.")
                        WCSecondaryButton(title: "Try again", icon: .refresh) { Task { await store.prepareQuote() } }.padding(.top, 8)
                    }
                }
                .padding(.horizontal, Theme.gutter)
                .padding(.bottom, 24)
            }
            .refreshable { await store.prepareQuote() }
        }
        .wcFooter {
            WCPrimaryButton(title: "Book my confirmation visit", isEnabled: quote?.tiers.isEmpty == false) { store.bookFromQuote() }
            FinePrint(text: store.brand.quoteFootnote)
        }
        .wcScreenChrome()
        .task {
            if store.quote == nil { await store.prepareQuote() }
        }
    }

    /// "This is your price if the sizes hold. ... Window 1 needs a check."
    private var honestLine: String {
        var s = "This is your price if the sizes hold. At a free visit a \(store.brand.name) rep re-measures every window before we build."
        let checks = store.windowRows.filter { $0.flagged }.map { $0.number }
        switch checks.count {
        case 0: break
        case 1: s += " Window \(checks[0]) needs a check."
        case 2: s += " Windows \(checks[0]) and \(checks[1]) need a check."
        default: s += " \(checks.count) windows need a check."
        }
        return s
    }

    private var shareText: String {
        guard let q = quote, let t = q.tier(store.selectedTier) ?? q.tiers.first else { return store.brand.name }
        return "\(store.brand.name) quote for \(store.address): \(q.windowCount) windows, \(t.label), \(Money.dollars(t.total)). A rep re-measures every window before anything is built."
    }
}

private struct TierCard: View {
    @Environment(HomeownerStore.self) private var store
    let tier: HomeownerTier
    let windowCount: Int
    let selected: Bool
    let action: () -> Void

    private var badge: String? { store.brand.tiers[tier.key]?.badge }

    private var detail: String {
        let fromServer = [tier.name, tier.detail].compactMap { $0 }.filter { !$0.isEmpty }
        if !fromServer.isEmpty { return fromServer.joined(separator: ". ") }
        return store.brand.tiers[tier.key]?.summary ?? ""
    }

    private var perWindow: String {
        guard windowCount > 0 else { return "" }
        return "\(Money.dollars(tier.total / Double(windowCount))) / window"
    }

    var body: some View {
        Button(action: {
            Haptics.tap()
            action()
        }) {
            HStack(alignment: .top, spacing: 14) {
                WCRadio(isOn: selected, size: 24).padding(.top, 2)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text(tier.label).wc(20, .semibold, relativeTo: .headline).foregroundStyle(Theme.ink)
                        if let b = badge {
                            Text(b).wc(13, .semibold, relativeTo: .footnote).foregroundStyle(.white)
                                .padding(.horizontal, 8).padding(.vertical, 3)
                                .background(Theme.blue, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                        }
                    }
                    Text(detail).wc(15, relativeTo: .subheadline).foregroundStyle(Theme.ink3).fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                VStack(alignment: .trailing, spacing: 2) {
                    Text(Money.dollars(tier.total)).wcHeading(21, .heavy, relativeTo: .title3).foregroundStyle(Theme.ink).minimumScaleFactor(0.7).lineLimit(1)
                    Text(perWindow).wc(14, relativeTo: .footnote).foregroundStyle(Theme.ink3).lineLimit(1)
                }
            }
            .padding(14)
            .wcCard(selected: selected, radius: 16)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(tier.label)\(badge.map { ", \($0)" } ?? ""). \(detail). \(Money.dollars(tier.total)) in all, \(perWindow).")
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}
