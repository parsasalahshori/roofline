import CoreImage
import Foundation
import ImageIO
import Metal
import RooflineCore
import SwiftUI
import UIKit

/// Puts a new window on the homeowner's own photo: draws it flat in inches (`WindowPainter`), warps that onto the window's four
/// corners with a perspective transform, and lays it over the photo. The frame, sashes and bars go on opaque, replacing the old
/// ones; the panes show the photo's own view through them (or a soft sky when "clean glass" is on).
///
/// Everything that does not change between two taps is made once here: the photo as a Core Image picture, the homography, the room's
/// light, the layouts. A tap redraws the two flat layers (about 1 to 1.5 million pixels each) and one GPU composite of the part of the
/// photo on screen.
final class WindowCompositor: @unchecked Sendable {
    /// One shared Core Image context, blending in sRGB so it matches the flat drawing.
    private static let ciContext: CIContext = {
        let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
        let options: [CIContextOption: Any] = [.workingColorSpace: srgb, .outputColorSpace: srgb, .cacheIntermediates: false]
        // On the GPU where there is one (every iPhone; the simulator's own Metal too)
        if let device = MTLCreateSystemDefaultDevice() { return CIContext(mtlDevice: device, options: options) }
        return CIContext(options: options)
    }()

    let photoWidth: Int
    let photoHeight: Int
    /// Corners in the working photo's own pixels, top-left origin: TL, TR, BR, BL.
    let quad: [Vec2]
    let widthIn: Double
    let heightIn: Double
    /// The part of the photo that is drawn (pixels, top-left origin).
    let viewport: CGRect
    let ambient: WindowAmbient
    let pixelsPerInch: Double
    /// The glass layer is drawn and warped at this share of the frame's resolution.
    static let glassScale = 0.5

    private let photo: CGImage
    private let homography: Homography
    private var layouts: [String: WindowLayout] = [:]
    private var frameCache: (key: String, layer: WarpedLayer)?
    private var glassCache: (key: String, layer: WarpedLayer)?
    private let cropped: CGImage?
    /// Where the last `after` spent its time, milliseconds (drawing the flat layers, warping them, putting them on the photo).
    private(set) var lastStages = (paint: 0.0, warp: 0.0, compose: 0.0)

    /// Nil when the corners cannot carry a window (they are not a convex quad inside the picture).
    init?(photo: CGImage, quad: [Vec2], widthIn: Double, heightIn: Double, viewport: CGRect? = nil) {
        let w = photo.width, h = photo.height
        guard WindowQuad.isUsable(quad, imageWidth: Double(w), imageHeight: Double(h)), widthIn > 0, heightIn > 0,
              let hom = Homography.rect(width: min(max(widthIn, 14), 150), height: min(max(heightIn, 14), 150), to: quad) else { return nil }
        self.photo = photo
        photoWidth = w
        photoHeight = h
        self.quad = quad
        let cw = min(max(widthIn, 14), 150), ch = min(max(heightIn, 14), 150)
        self.widthIn = cw
        self.heightIn = ch
        homography = hom
        let view = (viewport ?? CGRect(x: 0, y: 0, width: w, height: h)).intersection(CGRect(x: 0, y: 0, width: w, height: h)).integral
        self.viewport = view
        cropped = photo.cropping(to: view)
        ambient = Self.measureAmbient(photo: photo, quad: quad)
        func d(_ a: Vec2, _ b: Vec2) -> Double { hypot(a.x - b.x, a.y - b.y) }
        let perInchW = max(d(quad[0], quad[1]), d(quad[3], quad[2])) / cw
        let perInchH = max(d(quad[0], quad[3]), d(quad[1], quad[2])) / ch
        pixelsPerInch = min(max(max(perInchW, perInchH) * 1.1, 6), 80)
    }

    /// The photo as it was, in the same crop as `after` (the "before" side of the compare).
    func before() -> CGImage? { cropped }

    /// The window drawn in place. Nil only when the photo cannot be warped (a degenerate corner).
    /// The frame and the glass are drawn and warped separately and each is kept (as a small picture of just the warped window) while its
    /// own choices stand, so a new colour redraws only the frame and a new glass only the glass; putting them over the photo is then
    /// three plain draws.
    func after(look: WindowVisualLook, colorHex: String) -> CGImage? {
        guard let cropped = cropped else { return nil }
        let layoutKey = "\(look.type.rawValue)/\(look.grid.rawValue)"
        let layout: WindowLayout
        if let l = layouts[layoutKey] { layout = l } else {
            layout = WindowLayoutBuilder.build(type: look.type, grid: look.grid, widthIn: widthIn, heightIn: heightIn)
            layouts[layoutKey] = layout
        }
        guard let canvas = WindowPainter.canvas(for: layout, pixelsPerInch: pixelsPerInch), let corners = canvasCorners(canvas) else { return nil }
        let frameKey = "\(layoutKey)/\(colorHex)"
        let glassKey = "\(look.type.rawValue)/\(look.glass.rawValue)/\(look.cleanGlass)"
        var stages = (paint: 0.0, warp: 0.0, compose: 0.0)
        func now() -> Double { CFAbsoluteTimeGetCurrent() * 1000 }
        let frame: WarpedLayer
        if let c = frameCache, c.key == frameKey { frame = c.layer } else {
            let t0 = now()
            guard let painted = WindowPainter.paintFrame(layout: layout, canvas: canvas, frameColor: RGBf(hex: colorHex), ambient: ambient, pixelsPerInch: pixelsPerInch) else { return nil }
            let t1 = now()
            guard let warped = warp(painted, corners) else { return nil }
            stages.paint += t1 - t0
            stages.warp += now() - t1
            frame = warped
            frameCache = (frameKey, warped)
        }
        let glass: WarpedLayer
        if let c = glassCache, c.key == glassKey { glass = c.layer } else {
            // Glass is soft (a gradient, a tint, shade, glare): half the resolution looks the same and costs a quarter
            let t0 = now()
            let gppi = pixelsPerInch * Self.glassScale
            guard let gcanvas = WindowPainter.canvas(for: layout, pixelsPerInch: gppi),
                  let painted = WindowPainter.paintGlass(layout: layout, canvas: gcanvas, look: look, ambient: ambient, pixelsPerInch: gppi) else { return nil }
            let t1 = now()
            guard let warped = warp(painted, corners, scale: Self.glassScale) else { return nil }
            stages.paint += t1 - t0
            stages.warp += now() - t1
            glass = warped
            glassCache = (glassKey, warped)
        }
        let t2 = now()
        defer { stages.compose = now() - t2; lastStages = stages }
        let w = cropped.width, h = cropped.height
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.interpolationQuality = .high
        ctx.draw(cropped, in: CGRect(x: 0, y: 0, width: w, height: h))
        // The layers sit where Core Image put them, in coordinates from the bottom-left of the photo; the picture is the viewport's part of it
        let originX = viewport.minX, originY = CGFloat(photoHeight) - viewport.maxY
        for layer in [glass, frame] {
            ctx.draw(layer.image, in: CGRect(x: layer.rect.minX - originX, y: layer.rect.minY - originY, width: layer.rect.width, height: layer.rect.height))
        }
        return ctx.makeImage()
    }

    /// Where a point of the canonical rectangle (inches) falls in the working photo.
    func photoPoint(_ p: Vec2) -> Vec2? { homography.map(p) }

    /// The canvas's four corners in Core Image's coordinates (bottom-left origin), TL, TR, BR, BL.
    private func canvasCorners(_ l: WindowCanvas) -> [CGPoint]? {
        let inches = [Vec2(l.minX, l.minY), Vec2(l.maxX, l.minY), Vec2(l.maxX, l.maxY), Vec2(l.minX, l.maxY)]
        var out: [CGPoint] = []
        for p in inches {
            guard let q = homography.map(p), q.x.isFinite, q.y.isFinite else { return nil }
            out.append(CGPoint(x: q.x, y: Double(photoHeight) - q.y))
        }
        return out
    }

    /// A layer warped onto the photo: a picture of just the window, and the rectangle it covers (Core Image's coordinates, from the
    /// photo's bottom-left).
    struct WarpedLayer {
        var image: CGImage
        var rect: CGRect
    }

    /// Warps a flat layer onto the four corners and reads back only the part that lands inside the viewport.
    private func warp(_ layer: CGImage, _ c: [CGPoint], scale: CGFloat = 1) -> WarpedLayer? {
        let warped = CIImage(cgImage: layer).applyingFilter("CIPerspectiveTransform", parameters: [
            "inputTopLeft": CIVector(cgPoint: c[0]),
            "inputTopRight": CIVector(cgPoint: c[1]),
            "inputBottomRight": CIVector(cgPoint: c[2]),
            "inputBottomLeft": CIVector(cgPoint: c[3]),
        ])
        let view = CGRect(x: viewport.minX, y: CGFloat(photoHeight) - viewport.maxY, width: viewport.width, height: viewport.height)
        let rect = warped.extent.intersection(view).integral
        guard !rect.isNull, rect.width >= 1, rect.height >= 1 else { return nil }
        // Rendered at `scale` of the photo's pixels; it is drawn back over `rect`
        let small = scale == 1 ? warped : warped.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let from = CGRect(x: rect.minX * scale, y: rect.minY * scale, width: rect.width * scale, height: rect.height * scale).integral
        guard let image = Self.ciContext.createCGImage(small, from: from, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)) else { return nil }
        return WarpedLayer(image: image, rect: rect)
    }

    // MARK: The room's light

    /// Looks at the wall just outside the window (trimmed of the brightest and darkest fifth, so a lamp or a shadow does not decide):
    /// how bright a white frame would look there, how warm, and the wall's own colour for filling round a shape.
    static func measureAmbient(photo: CGImage, quad: [Vec2]) -> WindowAmbient {
        let sw = 240
        let sh = max(Int((Double(sw) * Double(photo.height) / Double(photo.width)).rounded()), 8)
        guard let ctx = CGContext(data: nil, width: sw, height: sh, bitsPerComponent: 8, bytesPerRow: sw * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue), quad.count == 4 else { return .neutral }
        ctx.interpolationQuality = .medium
        ctx.draw(photo, in: CGRect(x: 0, y: 0, width: sw, height: sh))
        guard let data = ctx.data else { return .neutral }
        let px = data.bindMemory(to: UInt8.self, capacity: sw * sh * 4)
        let sx = Double(sw) / Double(photo.width), sy = Double(sh) / Double(photo.height)
        let cx = quad.map(\.x).reduce(0, +) / 4, cy = quad.map(\.y).reduce(0, +) / 4
        func d(_ a: Vec2, _ b: Vec2) -> Double { hypot(a.x - b.x, a.y - b.y) }
        let size = (d(quad[0], quad[1]) + d(quad[3], quad[2]) + d(quad[0], quad[3]) + d(quad[1], quad[2])) / 4
        let off = max(size * 0.20, 8)
        var samples: [RGBf] = []
        var perSide: [[RGBf]] = [[], [], [], []]
        for e in 0..<4 {
            let a = quad[e], b = quad[(e + 1) % 4]
            let ex = b.x - a.x, ey = b.y - a.y, len = max(hypot(ex, ey), 1e-9)
            var nx = ey / len, ny = -ex / len
            // Away from the middle
            if nx * ((a.x + b.x) / 2 - cx) + ny * ((a.y + b.y) / 2 - cy) < 0 { nx = -nx; ny = -ny }
            for k in 0..<24 {
                let t = 0.08 + 0.84 * Double(k) / 23
                let x = (a.x + ex * t + nx * off) * sx, y = (a.y + ey * t + ny * off) * sy
                guard x >= 0, y >= 0, x < Double(sw - 1), y < Double(sh - 1) else { continue }
                let i = (Int(y) * sw + Int(x)) * 4
                let c = RGBf(Double(px[i]) / 255, Double(px[i + 1]) / 255, Double(px[i + 2]) / 255)
                samples.append(c)
                perSide[e].append(c)
            }
        }
        guard samples.count >= 12 else { return .neutral }
        samples.sort { $0.luma < $1.luma }
        let lo = samples.count / 5, hi = samples.count - samples.count / 5
        let mid = Array(samples[lo..<hi])
        let n = Double(mid.count)
        let wall = RGBf(mid.map(\.r).reduce(0, +) / n, mid.map(\.g).reduce(0, +) / n, mid.map(\.b).reduce(0, +) / n)
        // Each side's own wall (trimmed the same way), the whole wall's where a side has too few samples
        func trimmedMean(_ list: [RGBf]) -> RGBf? {
            guard list.count >= 6 else { return nil }
            let sorted = list.sorted { $0.luma < $1.luma }
            let a = sorted.count / 5, z = sorted.count - sorted.count / 5
            let m = Array(sorted[a..<z]), k = Double(m.count)
            return RGBf(m.map(\.r).reduce(0, +) / k, m.map(\.g).reduce(0, +) / k, m.map(\.b).reduce(0, +) / k)
        }
        let sides = perSide.map { trimmedMean($0) ?? wall }
        let l = max(wall.luma, 0.02)
        func cl(_ v: Double) -> Double { min(max(v, 0.85), 1.15) }
        let warm = RGBf(cl(wall.r / l), cl(wall.g / l), cl(wall.b / l))
        let tint = RGBf(1, 1, 1).mixed(warm, 0.35)
        return WindowAmbient(light: min(max(wall.luma * 1.6, 0.42), 1), tint: tint, wall: wall, sides: sides)
    }
}

/// A photo ready for the visualizer: decoded at the size the screen needs, its corners moved to that size.
struct VisualizerPhoto {
    var image: CGImage
    var quad: [Vec2]
    var viewport: CGRect

    /// Decodes `data` (a JPEG) so that the part of it the viewer shows is about `viewportPixels` wide (900...3000 px on the long side,
    /// never bigger than the photo), and scales `corners` (in the JPEG's own pixels, `widthPx` x `heightPx`) to match.
    /// `fullFrame` shows the whole photo (the export). Nil when the data is not an image or the corners cannot carry a window.
    static func make(jpeg data: Data, corners: [Vec2], widthPx: Int, heightPx: Int, aspect: Double, viewportPixels: Double = 1200, fullFrame: Bool = false) -> VisualizerPhoto? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let pw = props[kCGImagePropertyPixelWidth] as? Int, let ph = props[kCGImagePropertyPixelHeight] as? Int, pw > 0, ph > 0 else { return nil }
        // The corners are in the stored picture's pixels; follow it if the file is another size
        let cw = widthPx > 0 ? widthPx : pw, ch = heightPx > 0 ? heightPx : ph
        let scaledIn = corners.map { Vec2($0.x * Double(pw) / Double(cw), $0.y * Double(ph) / Double(ch)) }
        guard WindowQuad.isUsable(scaledIn, imageWidth: Double(pw), imageHeight: Double(ph)) else { return nil }
        let v = fullFrame ? (x: 0.0, y: 0.0, width: Double(pw), height: Double(ph)) : WindowQuad.viewport(quad: scaledIn, imageWidth: Double(pw), imageHeight: Double(ph), aspect: aspect)
        let long = Double(max(pw, ph))
        let k = viewportPixels / max(v.width, 1)
        let maxPixel = Int(min(max(long * k, 900), 3000, long).rounded())
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: max(maxPixel, 300),
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let kx = Double(image.width) / Double(pw), ky = Double(image.height) / Double(ph)
        let quad = scaledIn.map { Vec2($0.x * kx, $0.y * ky) }
        let rect = CGRect(x: v.x * kx, y: v.y * ky, width: v.width * kx, height: v.height * ky).integral
        return VisualizerPhoto(image: image, quad: quad, viewport: rect)
    }
}
