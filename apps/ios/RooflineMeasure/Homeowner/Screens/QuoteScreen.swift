import RooflineCore
import SwiftUI

/// 11 Quote (ios-hw-11): "7 windows, your price": Good, Better and Best for the windows measured (and an estimate for any
/// not measured yet), what every window includes, and the honest line that a rep re-measures before anything is built.
/// A native grouped list: the estimate-and-call card first, the three levels as selectable rows with a checkmark, the rest as
/// section rows and footers. Share is a plain toolbar `ShareLink`.
struct QuoteScreen: View {
    @Environment(HomeownerStore.self) private var store
    @Environment(\.dynamicTypeSize) private var typeSize

    private var quote: HomeownerQuote? { store.quote }

    var body: some View {
        List {
            if let q = quote, !q.tiers.isEmpty {
                loaded(q)
            } else if store.loadingQuote {
                Section {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text(store.unsentCount > 0 ? "Sending your windows first…" : "One moment…").font(.subheadline).foregroundStyle(Theme.ink2)
                    }
                } header: {
                    HiListHeading(title: "Working out your price")
                }
            } else {
                Section {
                    Button { Task { await store.prepareQuote() } } label: {
                        Label("Try again", systemImage: WCIcon.refresh.symbol)
                    }
                } header: {
                    HiListHeading(title: "We couldn't price your windows yet",
                                  subtitle: store.offline ? "You're offline. Your windows are saved on this phone and send when you're back." : "Something got in the way. Try again in a moment.")
                }
            }
            // With accessibility text sizes the footer's buttons are not pinned: they end the list
            if typeSize.isAccessibilitySize {
                Section { WCScrollFooter() }
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await store.prepareQuote() }
        .wcFooter {
            WCPrimaryButton(title: "Book my confirmation visit", isEnabled: quote?.tiers.isEmpty == false) { store.bookFromQuote() }
            FinePrint(text: store.brand.quoteFootnote + " A rep re-measures every window before anything is built.")
        }
        .hiNav(title: "Your quote", display: .large)
        .toolbar {
            if quote != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: shareText) { Image(systemName: WCIcon.upload.symbol) }
                        .accessibilityLabel("Share your quote")
                }
            }
        }
        .task {
            if store.quote == nil { await store.prepareQuote() }
        }
    }

    // MARK: Sections

    @ViewBuilder private func loaded(_ q: HomeownerQuote) -> some View {
        // The owner's requirement: it is an estimate, and a call gets an exact measurement. First, and prominent.
        Section {
            EstimateCallCard(service: .windows)
                // the card's own height at any text size (a list row would otherwise clip its title to one line at the large sizes)
                .fixedSize(horizontal: false, vertical: true)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
        } header: {
            HiListHeading(title: "\(q.windowCount) window\(q.windowCount == 1 ? "" : "s"), your price",
                          subtitle: "\(q.measuredCount) measured by you · \(q.estimatedCount) estimated. Installed, old windows hauled away.")
        }
        offerAndTrustSection
        Section {
            ForEach(q.tiers) { tier in
                TierRow(tier: tier, windowCount: q.windowCount, selected: store.selectedTier == tier.key) { store.selectTier(tier.key) }
            }
        } footer: {
            if q.atVisitCount > 0 {
                Text("\(q.atVisitCount) window\(q.atVisitCount == 1 ? " is a bay, bow or odd shape, so it isn't" : "s are bays, bows or odd shapes, so they aren't") in these prices. We price \(q.atVisitCount == 1 ? "it" : "them") at your visit.")
                    .foregroundStyle(Theme.ink2)
                    .accessibilityIdentifier("at-visit-note")
            }
        }
        Section {
            ForEach(includedLines, id: \.self) { line in
                Label {
                    Text(line).foregroundStyle(Theme.ink2)
                } icon: {
                    Image(systemName: WCIcon.check.symbol).fontWeight(.semibold).foregroundStyle(Theme.okText)
                }
            }
        } header: {
            if !includedLines.isEmpty { Text("Every window includes").foregroundStyle(Theme.ink2) }
        } footer: {
            Text("Colors and grids are chosen at your visit.").foregroundStyle(Theme.ink2)
        }
        windowsSection
        if let financing = store.company.catalog.financing { financingSection(financing) }
        Section {
            Label {
                Text(honestLine).font(.subheadline).foregroundStyle(Theme.ink2)
            } icon: {
                Image(systemName: WCIcon.ruler.symbol).foregroundStyle(Theme.ink2)
            }
            if q.estimatedCount > 0 {
                Label {
                    Text("\(q.estimatedCount) window\(q.estimatedCount == 1 ? " isn't" : "s aren't") measured yet, so \(q.estimatedCount == 1 ? "it is" : "they are") priced from your home's size. Measuring them makes your price exact.")
                        .font(.subheadline).foregroundStyle(Theme.ink2)
                } icon: {
                    Image(systemName: WCIcon.alert.symbol).foregroundStyle(Theme.warn)
                }
            }
        }
    }

    /// "See it in your home": each window with what was chosen for it (kept on the phone), a way to try a new one on its own photo.
    @ViewBuilder private var windowsSection: some View {
        let rows = store.windowRows
        if !rows.isEmpty {
            Section {
                ForEach(rows) { row in
                    Button { store.openVisualizer(row.id, from: .quote) } label: {
                        HStack(spacing: 12) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(row.title).font(.body).foregroundStyle(Theme.ink)
                                Text(visualLine(row)).font(.subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
                            }
                            Spacer(minLength: 8)
                            Image(systemName: "photo.on.rectangle").foregroundStyle(Theme.red).accessibilityHidden(true)
                            Image(systemName: "chevron.forward").font(.footnote.weight(.semibold)).foregroundStyle(Theme.decor).accessibilityHidden(true)
                        }
                        .frame(minHeight: Theme.minTap)
                        .contentShape(Rectangle())
                    }
                    .accessibilityHint("Shows new windows on your own photo")
                }
            } header: {
                Text("See it in your home").foregroundStyle(Theme.ink2)
            } footer: {
                Text("Try other kinds, grids, colors and glass on your own photos.").foregroundStyle(Theme.ink2)
            }
        }
    }

    /// What a window shows under its name: the look chosen for it, else "Try a new window".
    private func visualLine(_ row: WindowRow) -> String {
        guard let look = row.look else { return "Try a new window" }
        let label = store.brand.windowColors.first { $0.key == row.colorKey }?.label
        return look.summary(colorLabel: label)
    }

    /// What every window includes: the company's own list, else the brand file's.
    private var includedLines: [String] {
        store.company.catalog.included.isEmpty ? store.brand.includes : store.company.catalog.included
    }

    /// The company's offer (with its terms link) and "4.9 from 2,400+ homeowners" with up to three short badges, when it entered them:
    /// plain rows of one section.
    @ViewBuilder private var offerAndTrustSection: some View {
        let offer = store.company.catalog.offer
        let trust = store.company.trust
        let hasTrust = trust?.rating != nil || !(trust?.badges.isEmpty ?? true)
        if offer != nil || hasTrust {
            Section {
                if let offer = offer {
                    Label {
                        Text(offer.title).foregroundStyle(Theme.ink)
                    } icon: {
                        Image(systemName: "tag").foregroundStyle(Theme.ink2)
                    }
                    .accessibilityIdentifier("offer-banner")
                    if let url = offer.termsUrl.flatMap(URL.init(string:)) {
                        Link("Offer terms", destination: url)
                    }
                }
                if hasTrust {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            if let rating = trust?.rating {
                                Text(rating.line).foregroundStyle(Theme.ink)
                            }
                            if let badges = trust?.badges, !badges.isEmpty {
                                Text(badges.joined(separator: " · ")).font(.footnote).foregroundStyle(Theme.ink2)
                            }
                        }
                    } icon: {
                        Image(systemName: trust?.rating != nil ? "star.fill" : "checkmark.seal.fill").foregroundStyle(Color(.systemYellow))
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("trust-strip")
                }
            }
            // room before the levels, so a screen height never leaves just their top edge showing above the pinned button
            .listSectionSpacing(.custom(50))
        }
    }

    private func financingSection(_ f: HomeownerFinancing) -> some View {
        Section {
            Label {
                Text(f.text).font(.subheadline).foregroundStyle(Theme.ink2)
            } icon: {
                Image(systemName: "creditcard").foregroundStyle(Theme.ink2)
            }
            .accessibilityIdentifier("financing-line")
            if let url = f.url.flatMap(URL.init(string:)) {
                Link("Financing details", destination: url)
            }
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

/// One level (Good, Better, Best) as a selectable list row: the company's name for it and its one line, the price and the price per
/// window, and a checkmark on the one chosen.
private struct TierRow: View {
    @Environment(HomeownerStore.self) private var store
    @Environment(\.dynamicTypeSize) private var typeSize
    let tier: HomeownerTier
    let windowCount: Int
    let selected: Bool
    let action: () -> Void

    private var badge: String? { store.brand.tiers[tier.key]?.badge }

    /// "Good", "Better" or "Best", shown small above the company's own name for the level ("Replenish"); nil when they are the same.
    private var rank: String? {
        tier.label.caseInsensitiveCompare(tier.key) == .orderedSame ? nil : tier.key.capitalized
    }

    private var detail: String {
        // The company's one line ("Lifetime warranty") leads
        if !tier.note.isEmpty { return tier.note }
        let fromServer = [tier.name, tier.detail].compactMap { $0 }.filter { !$0.isEmpty }
        if !fromServer.isEmpty { return fromServer.joined(separator: ". ") }
        return store.brand.tiers[tier.key]?.summary ?? ""
    }

    private var perWindow: String {
        guard windowCount > 0 else { return "" }
        return "\(Money.dollars(tier.total / Double(windowCount))) / window"
    }

    private var titleBlock: some View {
        VStack(alignment: .leading, spacing: 3) {
            if let rank = rank {
                Text(rank).font(.caption.weight(.semibold)).foregroundStyle(Theme.ink2).textCase(.uppercase)
            }
            AdaptiveStack(spacing: 8) {
                Text(tier.label).font(.headline).foregroundStyle(Theme.ink)
                if let b = badge { CapsuleLabel(text: b) }
            }
            Text(detail).font(.subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
        }
    }

    private var priceLine: some View {
        Text(Money.dollars(tier.total)).font(.title3.weight(.semibold)).monospacedDigit().foregroundStyle(Theme.ink).minimumScaleFactor(0.7).lineLimit(1)
    }

    private var perWindowLine: some View {
        Text(perWindow).font(.footnote).foregroundStyle(Theme.ink2).lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
    }

    var body: some View {
        Button(action: {
            Haptics.tap()
            action()
        }) {
            HStack(alignment: .top, spacing: 12) {
                if typeSize.isAccessibilitySize {
                    // Large text: the price goes under the name and the words, at the full width
                    VStack(alignment: .leading, spacing: 8) {
                        titleBlock
                        VStack(alignment: .leading, spacing: 2) { priceLine; perWindowLine }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    titleBlock.frame(maxWidth: .infinity, alignment: .leading)
                    VStack(alignment: .trailing, spacing: 2) { priceLine; perWindowLine }
                }
                Image(systemName: "checkmark")
                    .fontWeight(.semibold)
                    .foregroundStyle(Theme.red)
                    .opacity(selected ? 1 : 0)
                    .frame(width: 22, alignment: .trailing)
                    .padding(.top, 2)
                    .accessibilityHidden(true)
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(rank.map { "\($0), " } ?? "")\(tier.label)\(badge.map { ", \($0)" } ?? ""). \(detail). \(Money.dollars(tier.total)) in all, \(perWindow).")
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

// MARK: - Shared by the quote, booking and measuring screens

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
