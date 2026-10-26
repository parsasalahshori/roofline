import RooflineCore
import SwiftUI

/// 11 Your estimate: what the homeowner's windows come to, at the end of measuring. A price range with Good, Better and Best, the
/// windows listed with their sizes (each opens "See it in your home" on its own photo), and two buttons: "Have WinChoice call me"
/// (the interest form) and "See new windows in your home". A native grouped list; Share is a plain toolbar `ShareLink`.
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
                    HiListHeading(title: "Working out your estimate")
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
            WCPrimaryButton(title: "Have WinChoice call me", isEnabled: quote?.tiers.isEmpty == false) { store.requestCallFromEstimate() }
                .accessibilityIdentifier("estimate.callMe")
            WCSecondaryButton(title: "See new windows in your home", icon: .win, isEnabled: store.windowRows.first != nil) { store.openVisualizerForFirstWindow(from: .quote) }
                .accessibilityIdentifier("estimate.visualize")
            FinePrint(text: store.brand.quoteFootnote)
        }
        .hiNav(title: "Your estimate", display: .large)
        .toolbar {
            if quote != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: shareText) { Image(systemName: WCIcon.upload.symbol) }
                        .accessibilityLabel("Share your estimate")
                }
            }
        }
        .task {
            if store.quote == nil { await store.prepareQuote() }
        }
    }

    // MARK: Sections

    /// The lowest and highest level, "$9,800 to $14,300".
    private func range(_ q: HomeownerQuote) -> String? {
        let totals = q.tiers.map { $0.total }
        guard let lo = totals.min(), let hi = totals.max() else { return nil }
        return lo == hi ? Money.dollars(lo) : "\(Money.dollars(lo)) to \(Money.dollars(hi))"
    }

    @ViewBuilder private func loaded(_ q: HomeownerQuote) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text("Estimated price").font(.subheadline).foregroundStyle(Theme.ink2)
                if let r = range(q) {
                    Text(r).font(.largeTitle.weight(.bold)).monospacedDigit().foregroundStyle(Theme.ink)
                        .minimumScaleFactor(0.6).lineLimit(2)
                        .accessibilityIdentifier("estimate.range")
                }
                Text("For \(q.windowCount) window\(q.windowCount == 1 ? "" : "s"), installed, old windows hauled away. This is your estimate.")
                    .font(.subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, 6)
            .accessibilityElement(children: .combine)
        }
        Section {
            ForEach(q.tiers) { tier in
                TierRow(tier: tier, windowCount: q.windowCount, selected: store.selectedTier == tier.key) { store.selectTier(tier.key) }
            }
        } footer: {
            if q.atVisitCount > 0 {
                Text("\(q.atVisitCount) window\(q.atVisitCount == 1 ? " is a bay, bow or odd shape, so it isn't" : "s are bays, bows or odd shapes, so they aren't") in these prices. WinChoice will price \(q.atVisitCount == 1 ? "it" : "them") when they call.")
                    .foregroundStyle(Theme.ink2)
                    .accessibilityIdentifier("at-visit-note")
            }
        }
        windowsSection(q)
        offerAndTrustSection
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
        }
        if let financing = store.company.catalog.financing { financingSection(financing) }
        if q.estimatedCount > 0 {
            Section {
                Label {
                    Text("\(q.estimatedCount) window\(q.estimatedCount == 1 ? " isn't" : "s aren't") measured yet, so \(q.estimatedCount == 1 ? "it is" : "they are") priced from your home's size. Measuring them makes your estimate exact.")
                        .font(.subheadline).foregroundStyle(Theme.ink2)
                } icon: {
                    Image(systemName: WCIcon.info.symbol).foregroundStyle(Theme.ink2)
                }
            }
        }
    }

    /// The windows, compactly: name and size. Each opens "See it in your home" on its own photo.
    @ViewBuilder private func windowsSection(_ q: HomeownerQuote) -> some View {
        let rows = store.windowRows
        if !rows.isEmpty {
            Section {
                ForEach(rows) { row in
                    Button { store.openVisualizer(row.id, from: .quote) } label: {
                        HStack(spacing: 12) {
                            Text(row.title).font(.body).foregroundStyle(Theme.ink).frame(maxWidth: .infinity, alignment: .leading)
                            if row.hasSize { Text(row.sizeTextWithUnit).font(.subheadline).monospacedDigit().foregroundStyle(Theme.ink2) }
                            Image(systemName: "chevron.forward").font(.footnote.weight(.semibold)).foregroundStyle(Theme.decor).accessibilityHidden(true)
                        }
                        .frame(minHeight: Theme.minTap)
                        .contentShape(Rectangle())
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(row.title), \(row.spokenSize)")
                    .accessibilityHint("Shows new windows on your own photo")
                }
            } header: {
                Text("\(rows.count) window\(rows.count == 1 ? "" : "s")").foregroundStyle(Theme.ink2)
            } footer: {
                Text("Tap a window to try other kinds, grids, colors and glass on your own photo.").foregroundStyle(Theme.ink2)
            }
        }
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

    private var shareText: String {
        guard let q = quote, let t = q.tier(store.selectedTier) ?? q.tiers.first else { return store.brand.name }
        return "\(store.brand.name) estimate for \(store.address): \(q.windowCount) windows, \(t.label), \(Money.dollars(t.total))."
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
