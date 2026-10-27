import RooflineCore
import SwiftUI
import UIKit

/// 11b Your windows are ready: the end of "Customize your windows". A banner (no price: a person calls with the estimate), each
/// window's picture (the "after" image on its own photo) with its look in one line, and "Get my estimate", which goes on to the
/// interest form. A window can be opened again to change it.
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
                    Text("Send your choices to \(store.brand.name) and a person calls you with your estimate.")
                        .font(.subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
                    if store.applyingLooks {
                        HStack(spacing: 12) {
                            ProgressView()
                            Text("Saving your choices…").font(.subheadline).foregroundStyle(Theme.ink2)
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
        .contentMargins(.top, 0, for: .scrollContent)
        .hiNav(title: "Your windows")
        .wcFooter {
            WCPrimaryButton(title: "Get my estimate", isEnabled: !store.applyingLooks) { store.requestCallFromEstimate() }
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

/// The window's "after" picture: its own photo with the window it was customized to drawn in, small (a drawn wall when the photo is not
/// on this phone). Rendered by `ThumbnailRenderer`, the visualizer's own drawing path, from the window's saved look.
private struct ReadyThumbnail: View {
    @Environment(HomeownerStore.self) private var store
    let windowId: String
    @State private var image: UIImage?

    private var spec: ThumbnailSpec { store.thumbnailSpec(for: windowId) }

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
        .task(id: spec) {
            let spec = self.spec
            let source = await store.visualPhoto(for: windowId)
            image = await ThumbnailRenderer.image(for: spec, source: source)
        }
    }
}

/// What a window's thumbnail is drawn from: its saved look (or the kind its style stands for), the frame colour, and its size.
struct ThumbnailSpec: Hashable {
    var windowId: String
    var look: WindowVisualLook
    var colorKey: String
    var colorHex: String
    var widthIn: Double?
    var heightIn: Double?

    func hash(into hasher: inout Hasher) {
        hasher.combine(windowId)
        hasher.combine(look.type)
        hasher.combine(look.grid)
        hasher.combine(look.glass)
        hasher.combine(look.cleanGlass)
        hasher.combine(colorKey)
    }
}

extension HomeownerStore {
    func thumbnailSpec(for windowId: String) -> ThumbnailSpec {
        let key = startingColorKey(for: windowId)
        let row = windowRows.first { $0.id == windowId }
        return ThumbnailSpec(windowId: windowId, look: startingLook(for: windowId), colorKey: key,
                             colorHex: brand.windowColors.first { $0.key == key }?.hex ?? "#F7F7F4", widthIn: row?.widthIn, heightIn: row?.heightIn)
    }
}

/// Draws a window's "after" picture small: the same `VisualizeWorker.prepare` and `WindowCompositor.after` the visualizer uses, once per
/// (window, look, colour), off the main thread, and kept. `lastLook` records the look the newest drawing was made from (for tests).
enum ThumbnailRenderer {
    private static let cache = NSCache<NSString, UIImage>()
    nonisolated(unsafe) static var lastLook: WindowVisualLook?

    static func cacheKey(_ spec: ThumbnailSpec, source: VisualPhotoSource?) -> NSString {
        "\(spec.windowId)|\(spec.look.type.rawValue)|\(spec.look.grid.rawValue)|\(spec.look.glass.rawValue)|\(spec.look.cleanGlass)|\(spec.colorKey)|\(source?.url.lastPathComponent ?? "wall")" as NSString
    }

    static func image(for spec: ThumbnailSpec, source: VisualPhotoSource?) async -> UIImage? {
        let key = cacheKey(spec, source: source)
        if let hit = cache.object(forKey: key) { return hit }
        let made = await Task.detached(priority: .userInitiated) { render(spec, source: source) }.value
        if let made = made { cache.setObject(made, forKey: key) }
        return made
    }

    /// The drawing itself (synchronous): a square, 216 px.
    static func render(_ spec: ThumbnailSpec, source: VisualPhotoSource?) -> UIImage? {
        lastLook = spec.look
        guard let prepared = VisualizeWorker.prepare(source: source, widthIn: spec.widthIn, heightIn: spec.heightIn, aspect: 1),
              let after = prepared.compositor.after(look: spec.look, colorHex: spec.colorHex) else { return nil }
        let side: CGFloat = 216
        let k = max(side / CGFloat(max(after.width, 1)), side / CGFloat(max(after.height, 1)))
        let (w, h) = (CGFloat(after.width) * k, CGFloat(after.height) * k)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { _ in
            UIImage(cgImage: after).draw(in: CGRect(x: (side - w) / 2, y: (side - h) / 2, width: w, height: h))
        }
    }
}
