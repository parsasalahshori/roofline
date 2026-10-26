import Foundation
import RooflineCore

// "See it in your home": the photo each measured window keeps, what the homeowner chose to see on it, and using that choice.
// What reaches the server is only what the contract carries: the window's style key (and the quote that follows from it). The
// window's color already lives on the phone (HomeownerProgress.colors); grids and glass join it there (HomeownerProgress.visuals),
// because the contract has no field for them.

/// A window's photo on disk with the four corners of the window on it.
struct VisualPhotoSource: Equatable {
    var url: URL
    /// TL, TR, BR, BL in the file's own pixels (`widthPx` x `heightPx`).
    var corners: [Vec2]
    var widthPx: Int
    var heightPx: Int
}

extension HomeownerStore {
    /// Opens the visualizer for a window.
    func openVisualizer(_ windowId: String, from origin: VisualizeOrigin) {
        path.append(.visualize(windowId: windowId, from: origin))
    }

    /// The window's own photo and corners from the outbox (the photo stays there once sent), or nil when it has none on this phone
    /// (a window the server holds from another phone, a room-scan window saved without a photo, corners that cannot carry a window).
    func visualPhoto(for windowId: String) async -> VisualPhotoSource? {
        #if DEBUG
        if let debug = debugVisualPhoto { return debug }
        #endif
        let items = await outbox.items
        guard let item = items.first(where: { $0.id == windowId }), let name = item.jpegFileName,
              let corners = item.window.corners, corners.count == 4, item.imageWidthPx > 0, item.imageHeightPx > 0 else { return nil }
        let url = await outbox.directory.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return VisualPhotoSource(url: url, corners: corners, widthPx: item.imageWidthPx, heightPx: item.imageHeightPx)
    }

    /// Where the gallery starts for a window: what it chose before, else the kind its style stands for, else the double-hung.
    func startingLook(for windowId: String) -> WindowVisualLook {
        if let saved = progress.visuals[windowId] { return saved }
        let row = windowRows.first { $0.id == windowId }
        return WindowVisualLook(type: VisualCatalog.startingType(styleKey: row?.style, offered: styles))
    }

    /// The frame colour the window shows: the one picked for it, else the first of the brand's.
    func startingColorKey(for windowId: String) -> String {
        if let c = progress.colors[windowId], brand.windowColors.contains(where: { $0.key == c }) { return c }
        return brand.windowColors.first?.key ?? "white"
    }

    /// How a kind of window is quoted: the style key the existing flow sends (one the catalog offers) and whether it is priced at the visit.
    func styleMapping(for type: VisualWindowType) -> VisualStyleMapping {
        VisualCatalog.mapping(for: type, offered: styles)
    }

    /// "Use this window": the look and colour are kept on the phone, and the window's style becomes the key its kind is quoted under.
    func useVisual(_ look: WindowVisualLook, colorKey: String, for windowId: String) async {
        progress.visuals[windowId] = look
        progress.colors[windowId] = colorKey
        saveProgress()
        await setStyle(styleMapping(for: look.type).key, for: windowId)
    }

    /// "Apply to all windows": the same kind, grid, glass and colour for every window. A window's photo is its own: only the choice is shared.
    func useVisualForAll(_ look: WindowVisualLook, colorKey: String) async {
        for row in windowRows {
            progress.visuals[row.id] = look
            progress.colors[row.id] = colorKey
        }
        saveProgress()
        await setStyleForAll(styleMapping(for: look.type).key)
    }
}
