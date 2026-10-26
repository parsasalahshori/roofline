import RooflineCore
import SwiftUI
import UIKit

/// 11b Your windows are ready: the end of "Customize your windows". A banner with the updated price, each window's picture (the "after"
/// image on its own photo) with its look in one line, and "Get my estimate", which goes on to the interest form. A window can be
/// opened again to change it.
struct ReadyScreen: View {
    @Environment(HomeownerStore.self) private var store

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 10) {
                        FilledSymbol(name: "checkmark.circle.fill", fill: Theme.okText).font(.title2)
                        Text("Your windows are ready").font(.title2.weight(.bold)).foregroundStyle(Theme.ink)
                            .accessibilityAddTraits(.isHeader)
                            .accessibilityIdentifier("ready.title")
                    }
                    if let q = store.quote, !q.tiers.isEmpty {
                        let tier = q.tier(store.selectedTier) ?? q.tiers[0]
                        Text("Estimated price").font(.subheadline).foregroundStyle(Theme.ink2).padding(.top, 4)
                        Text(q.rangeText ?? Money.dollars(tier.total)).font(.largeTitle.weight(.bold)).monospacedDigit().foregroundStyle(Theme.ink)
                            .minimumScaleFactor(0.6).lineLimit(2)
                            .accessibilityIdentifier("ready.range")
                        Text("For \(q.windowCount) window\(q.windowCount == 1 ? "" : "s"), installed, old windows hauled away, with the look you chose.")
                            .font(.subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
                    } else if store.loadingQuote || store.applyingLooks {
                        HStack(spacing: 12) {
                            ProgressView()
                            Text("Updating your estimate…").font(.subheadline).foregroundStyle(Theme.ink2)
                        }
                    }
                }
                .padding(.vertical, 6)
                .accessibilityElement(children: .combine)
            }
            Section {
                ForEach(store.windowRows) { row in
                    Button { store.openVisualizer(row.id, from: .ready) } label: { ReadyRow(row: row) }
                        .buttonStyle(.plain)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("\(row.title), \(row.spokenSize). \(store.lookLine(for: row.id)). Opens this window to change it.")
                        .accessibilityIdentifier("ready.row.\(row.number)")
                }
            } header: {
                Text("\(store.windowRows.count) window\(store.windowRows.count == 1 ? "" : "s")").foregroundStyle(Theme.ink2)
            } footer: {
                Text("Tap a window to change it.").foregroundStyle(Theme.ink2)
            }
            JourneyListFooter()
        }
        .listStyle(.insetGrouped)
        .hiNav(title: nil)
        .wcFooter {
            WCPrimaryButton(title: "Get my estimate", isEnabled: store.quote?.tiers.isEmpty == false) { store.requestCallFromEstimate() }
                .accessibilityIdentifier("ready.getEstimate")
            FinePrint(text: store.brand.quoteFootnote)
        }
        .task {
            if store.quote == nil { await store.prepareQuote() }
        }
    }
}

extension HomeownerStore {
    /// "Casement · Prairie · Black · Low-E": what the window will be, in one line (the starting look for a window nothing was chosen for).
    func lookLine(for windowId: String) -> String {
        let key = startingColorKey(for: windowId)
        return startingLook(for: windowId).oneLine(colorLabel: brand.windowColors.first { $0.key == key }?.label)
    }
}

extension HomeownerQuote {
    /// The lowest and highest level, "$9,800 to $14,300".
    var rangeText: String? {
        let totals = tiers.map { $0.total }
        guard let lo = totals.min(), let hi = totals.max() else { return nil }
        return lo == hi ? Money.dollars(lo) : "\(Money.dollars(lo)) to \(Money.dollars(hi))"
    }
}

private struct ReadyRow: View {
    @Environment(HomeownerStore.self) private var store
    let row: WindowRow

    var body: some View {
        HStack(spacing: 14) {
            ReadyThumbnail(windowId: row.id)
                .frame(width: 72, height: 72)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(row.title).font(.headline).foregroundStyle(Theme.ink)
                    Spacer(minLength: 6)
                    if row.hasSize { Text(row.sizeTextWithUnit).font(.footnote).monospacedDigit().foregroundStyle(Theme.ink2) }
                }
                Text(store.lookLine(for: row.id)).font(.subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
            }
            Image(systemName: "chevron.forward").font(.footnote.weight(.semibold)).foregroundStyle(Theme.decor).accessibilityHidden(true)
        }
        .frame(minHeight: Theme.minTap)
        .contentShape(Rectangle())
    }
}

/// The window's "after" picture: its own photo with the chosen window drawn in, small. Drawn once off the main thread (a drawn wall when the
/// photo is not on this phone).
private struct ReadyThumbnail: View {
    @Environment(HomeownerStore.self) private var store
    let windowId: String
    @State private var image: UIImage?

    private var look: WindowVisualLook { store.startingLook(for: windowId) }
    private var colorKey: String { store.startingColorKey(for: windowId) }

    var body: some View {
        ZStack {
            Color(.secondarySystemBackground)
            if let image = image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                ProgressView()
            }
        }
        .accessibilityHidden(true)
        .task(id: "\(windowId)|\(look.type.rawValue)|\(look.grid.rawValue)|\(look.glass.rawValue)|\(colorKey)") { await draw() }
    }

    private func draw() async {
        let row = store.windowRows.first { $0.id == windowId }
        let source = await store.visualPhoto(for: windowId)
        let look = self.look
        let hex = store.brand.windowColors.first { $0.key == colorKey }?.hex ?? "#F7F7F4"
        let (w, h) = (row?.widthIn, row?.heightIn)
        let made = await Task.detached(priority: .userInitiated) { () -> UIImage? in
            guard let prepared = VisualizeWorker.prepare(source: source, widthIn: w, heightIn: h, aspect: 1),
                  let after = prepared.compositor.after(look: look, colorHex: hex) else { return nil }
            // Small: a row's picture is 72 points
            let side: CGFloat = 216
            let renderer = UIGraphicsImageRenderer(size: CGSize(width: side, height: side))
            return renderer.image { _ in UIImage(cgImage: after).draw(in: Self.fill(CGSize(width: after.width, height: after.height), side: side)) }
        }.value
        if let made = made { image = made }
    }

    /// The picture scaled to cover a square.
    private static func fill(_ size: CGSize, side: CGFloat) -> CGRect {
        let k = max(side / max(size.width, 1), side / max(size.height, 1))
        let (w, h) = (size.width * k, size.height * k)
        return CGRect(x: (side - w) / 2, y: (side - h) / 2, width: w, height: h)
    }
}
