import CoreGraphics
import Foundation
import Observation
import RooflineCore
import UIKit

/// What "See it in your home" holds while it is open: the choice (kind, grid, glass, clean glass, colour), the photo, and the two
/// pictures it shows. A tap changes the choice and asks for a new "after"; the drawing happens on a background queue and only the
/// newest request is drawn, so quick taps never pile up.
@MainActor @Observable
final class VisualizeModel {
    enum Phase: Equatable { case loading, ready }

    var phase: Phase = .loading
    var look = WindowVisualLook()
    var colorKey = "white"
    var before: UIImage?
    var after: UIImage?
    /// True: the window has no usable photo here, so the pictures show a drawn wall.
    var drawnWall = false
    /// How long the last "after" took to draw, milliseconds.
    var renderMs: Double?
    /// The opening, inches, as drawn.
    var widthIn = 36.0
    var heightIn = 48.0

    @ObservationIgnored private let worker = VisualizeWorker()
    @ObservationIgnored private var colors: [Brand.WindowColor] = []
    @ObservationIgnored private(set) var source: VisualPhotoSource?
    @ObservationIgnored private var started = false

    /// The picture area's shape when nothing says otherwise (the screen passes its own).
    nonisolated static let pictureAspect = 1.0

    var colorHex: String { colors.first { $0.key == colorKey }?.hex ?? "#F7F7F4" }
    var colorLabel: String? { colors.first { $0.key == colorKey }?.label }

    /// `aspect`: the picture area's width over its height, so the part of the photo drawn fits it exactly.
    func start(store: HomeownerStore, windowId: String, aspect: Double = VisualizeModel.pictureAspect) async {
        guard !started else { return }
        started = true
        colors = store.brand.windowColors
        look = store.startingLook(for: windowId)
        colorKey = store.startingColorKey(for: windowId)
        #if DEBUG
        if let d = store.debugVisualLook { look = d.look; colorKey = d.color }
        #endif
        let row = store.windowRows.first { $0.id == windowId }
        let source = await store.visualPhoto(for: windowId)
        self.source = source
        var w = row?.widthIn, h = row?.heightIn
        #if DEBUG
        if let d = store.debugVisualWindowIn { w = d.w; h = d.h }
        #endif
        let (width, height) = (w, h)
        let made = await Task.detached(priority: .userInitiated) { VisualizeWorker.prepare(source: source, widthIn: width, heightIn: height, aspect: aspect) }.value
        guard let prepared = made else {
            phase = .ready
            return
        }
        widthIn = prepared.widthIn
        heightIn = prepared.heightIn
        drawnWall = prepared.drawnWall
        before = UIImage(cgImage: prepared.before)
        worker.setCompositor(prepared.compositor)
        phase = .ready
        render()
    }

    // MARK: Choices

    func set(type: VisualWindowType) { guard look.type != type else { return }; look.type = type; render() }
    func set(grid: VisualGrid) { guard look.grid != grid else { return }; look.grid = grid; render() }
    func set(glass: VisualGlass) { guard look.glass != glass else { return }; look.glass = glass; render() }
    func set(cleanGlass: Bool) { guard look.cleanGlass != cleanGlass else { return }; look.cleanGlass = cleanGlass; render() }
    func set(colorKey key: String) { guard colorKey != key else { return }; colorKey = key; render() }

    /// Asks for a new "after" with the current choices.
    func render() {
        let look = self.look, hex = colorHex
        worker.render(look: look, colorHex: hex) { [weak self] image, ms in
            guard let self = self else { return }
            // The answer of a request that is no longer the current choice is not shown
            guard self.look == look, self.colorHex == hex else { return }
            if let image = image { self.after = UIImage(cgImage: image) }
            self.renderMs = ms
        }
    }

    /// The whole photo with the window on it, for sharing: a JPEG up to 2400 px.
    nonisolated static func exportJPEG(source: VisualPhotoSource?, widthIn: Double?, heightIn: Double?, look: WindowVisualLook, colorHex: String) -> Data? {
        let photo: VisualizerPhoto
        var w = widthIn, h = heightIn
        if let s = source, let data = try? Data(contentsOf: s.url),
           let p = VisualizerPhoto.make(jpeg: data, corners: s.corners, widthPx: s.widthPx, heightPx: s.heightPx, aspect: pictureAspect, viewportPixels: 2400, fullFrame: true) {
            photo = p
        } else if let wall = DrawnWall.make(windowAspect: (widthIn ?? 36) / max(heightIn ?? 48, 1)) {
            photo = wall
        } else { return nil }
        if w == nil || h == nil { w = 36; h = 36 / max(WindowQuad.aspect(photo.quad), 0.1) }
        guard let c = WindowCompositor(photo: photo.image, quad: photo.quad, widthIn: w ?? 36, heightIn: h ?? 48, viewport: nil),
              let image = c.after(look: look, colorHex: colorHex) else { return nil }
        return UIImage(cgImage: image).jpegData(compressionQuality: 0.9)
    }
}

/// The pictures prepared off the main thread.
struct PreparedVisual: @unchecked Sendable {
    var compositor: WindowCompositor
    var before: CGImage
    var drawnWall: Bool
    var widthIn: Double
    var heightIn: Double
}

/// Draws on one background queue; of the requests that wait, only the last is drawn.
final class VisualizeWorker: @unchecked Sendable {
    private let queue = DispatchQueue(label: "com.premjeetech.winchoice.visualize", qos: .userInitiated)
    private let lock = NSLock()
    private var latest = 0
    private var compositor: WindowCompositor?

    func setCompositor(_ c: WindowCompositor) {
        queue.async { self.compositor = c }
    }

    func render(look: WindowVisualLook, colorHex: String, completion: @escaping @MainActor (CGImage?, Double) -> Void) {
        lock.lock()
        latest += 1
        let id = latest
        lock.unlock()
        queue.async { [self] in
            lock.lock()
            let stale = id != latest
            lock.unlock()
            guard !stale, let compositor = compositor else { return }
            let t0 = CFAbsoluteTimeGetCurrent()
            let image = compositor.after(look: look, colorHex: colorHex)
            let ms = (CFAbsoluteTimeGetCurrent() - t0) * 1000
            DispatchQueue.main.async { MainActor.assumeIsolated { completion(image, ms) } }
        }
    }

    /// Decodes the photo and builds the compositor, or draws a wall when the window has no usable photo.
    static func prepare(source: VisualPhotoSource?, widthIn: Double?, heightIn: Double?, aspect: Double) -> PreparedVisual? {
        var photo: VisualizerPhoto?
        var drawn = false
        if let s = source, let data = try? Data(contentsOf: s.url) {
            photo = VisualizerPhoto.make(jpeg: data, corners: s.corners, widthPx: s.widthPx, heightPx: s.heightPx, aspect: aspect)
        }
        if photo == nil {
            photo = DrawnWall.make(windowAspect: (widthIn ?? 36) / max(heightIn ?? 48, 1))
            drawn = true
        }
        guard let p = photo else { return nil }
        var w = widthIn ?? 0, h = heightIn ?? 0
        // A window the phone has not sized yet: 36 in wide, as tall as the picture's proportions say
        if w < 1 || h < 1 { w = 36; h = 36 / max(WindowQuad.aspect(p.quad), 0.1) }
        w = min(max(w, 14), 150)
        h = min(max(h, 14), 150)
        guard let c = WindowCompositor(photo: p.image, quad: p.quad, widthIn: w, heightIn: h, viewport: p.viewport), let before = c.before() else { return nil }
        return PreparedVisual(compositor: c, before: before, drawnWall: drawn, widthIn: w, heightIn: h)
    }
}

/// A wall with an old plain window, for a window with no photo on this phone: the gallery still works, on a drawn wall.
enum DrawnWall {
    static func make(windowAspect: Double) -> VisualizerPhoto? {
        let size = CGSize(width: 1200, height: 1044)
        let h = size.height * 0.56
        let w = min(h * min(max(windowAspect, 0.4), 2.2), size.width * 0.58)
        let rect = CGRect(x: (size.width - w) / 2, y: size.height * 0.20, width: w, height: min(h, w / max(windowAspect, 0.4)) )
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let image = UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            let g = ctx.cgContext
            let space = CGColorSpace(name: CGColorSpace.sRGB)!
            let wall = CGGradient(colorsSpace: space, colors: [UIColor(rgb: 0xDDD7CB).cgColor, UIColor(rgb: 0xC9C1B3).cgColor] as CFArray, locations: [0, 1])!
            g.drawLinearGradient(wall, start: .zero, end: CGPoint(x: size.width * 0.25, y: size.height), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
            // The floor line
            UIColor(rgb: 0xB5AC9C).setFill()
            g.fill(CGRect(x: 0, y: size.height * 0.90, width: size.width, height: size.height * 0.10))
            UIColor(rgb: 0xF1EEE7).setFill()
            g.fill(CGRect(x: 0, y: size.height * 0.885, width: size.width, height: size.height * 0.02))
            // An old plain window: white trim, a pale sky, one meeting rail
            let trim = rect.insetBy(dx: -rect.width * 0.07, dy: -rect.width * 0.07)
            g.saveGState()
            g.setShadow(offset: CGSize(width: 0, height: 4), blur: 10, color: UIColor.black.withAlphaComponent(0.25).cgColor)
            UIColor(rgb: 0xF3F0E9).setFill()
            g.fill(trim)
            g.restoreGState()
            let sky = CGGradient(colorsSpace: space, colors: [UIColor(rgb: 0xB9D2E4).cgColor, UIColor(rgb: 0xE4EDF3).cgColor] as CFArray, locations: [0, 1])!
            g.saveGState()
            g.clip(to: rect)
            g.drawLinearGradient(sky, start: CGPoint(x: 0, y: rect.minY), end: CGPoint(x: 0, y: rect.maxY), options: [])
            g.restoreGState()
            UIColor(rgb: 0xE9E5DB).setFill()
            g.fill(CGRect(x: rect.minX, y: rect.midY - rect.height * 0.012, width: rect.width, height: rect.height * 0.024))
        }
        guard let cg = image.cgImage else { return nil }
        let quad = [Vec2(rect.minX, rect.minY), Vec2(rect.maxX, rect.minY), Vec2(rect.maxX, rect.maxY), Vec2(rect.minX, rect.maxY)]
        return VisualizerPhoto(image: cg, quad: quad, viewport: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
    }
}
