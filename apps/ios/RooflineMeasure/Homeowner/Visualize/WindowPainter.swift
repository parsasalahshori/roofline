import CoreGraphics
import SwiftUI
import Foundation
import RooflineCore
import UIKit

/// A colour in 0...1 sRGB, with the few operations the painter needs.
struct RGBf: Equatable {
    var r: Double, g: Double, b: Double

    init(_ r: Double, _ g: Double, _ b: Double) { self.r = r; self.g = g; self.b = b }

    init(hex: String) {
        let v = Color.parse(hex)
        self.init(Double((v >> 16) & 255) / 255, Double((v >> 8) & 255) / 255, Double(v & 255) / 255)
    }

    var luma: Double { 0.2126 * r + 0.7152 * g + 0.0722 * b }

    func scaled(_ k: Double) -> RGBf { RGBf(min(max(r * k, 0), 1), min(max(g * k, 0), 1), min(max(b * k, 0), 1)) }
    func times(_ o: RGBf) -> RGBf { RGBf(min(r * o.r, 1), min(g * o.g, 1), min(b * o.b, 1)) }
    func mixed(_ o: RGBf, _ t: Double) -> RGBf { RGBf(r + (o.r - r) * t, g + (o.g - g) * t, b + (o.b - b) * t) }
    func cg(_ a: Double = 1) -> CGColor { CGColor(srgbRed: r, green: g, blue: b, alpha: a) }
}

/// What the room's light does to the new window: how bright its frame looks, how warm, and the colour of the wall round it.
struct WindowAmbient: Equatable {
    /// 0.42...1: how bright a white frame looks in this photo.
    var light = 1.0
    /// A gentle multiplier per channel (a warm room tints white frames a little warm).
    var tint = RGBf(1, 1, 1)
    var wall = RGBf(0.86, 0.84, 0.80)
    /// The wall's colour just outside each side of the window (top, right, bottom, left), for filling a shape that leaves corners bare.
    var sides: [RGBf] = []

    static let neutral = WindowAmbient()
}

/// The pixel grid the flat layers share: the inches it covers on the canonical rectangle's axes, and its size.
struct WindowCanvas: Equatable {
    var minX: Double, minY: Double, maxX: Double, maxY: Double
    var widthPx: Int, heightPx: Int
}

/// Draws a `WindowLayout` with Core Graphics, in inches (y down), onto transparent bitmaps: one for the frame, one for the glass.
enum WindowPainter {
    /// Room round the window for its shadow, inches.
    static let shadowMargin = 3.4

    static func canvas(for layout: WindowLayout, pixelsPerInch ppi: Double) -> WindowCanvas? {
        let box = layout.bounds
        let minX = box.minX - shadowMargin, minY = box.minY - shadowMargin
        let maxX = box.maxX + shadowMargin, maxY = box.maxY + shadowMargin
        let w = Int(ceil((maxX - minX) * ppi)), h = Int(ceil((maxY - minY) * ppi))
        guard w > 8, h > 8, w <= 4096, h <= 4096 else { return nil }
        return WindowCanvas(minX: minX, minY: minY, maxX: maxX, maxY: maxY, widthPx: w, heightPx: h)
    }

    /// Frame, sashes, bars, hardware, the wall filler and the soft shadow on the wall (premultiplied RGBA).
    static func paintFrame(layout: WindowLayout, canvas: WindowCanvas, frameColor: RGBf, ambient: WindowAmbient, pixelsPerInch ppi: Double) -> CGImage? {
        guard let ctx = context(canvas, ppi) else { return nil }
        let color = frameColor.times(ambient.tint).scaled(ambient.light)
        paintFrameLayer(ctx, layout, color: color, ambient: ambient, ppi: ppi)
        return ctx.makeImage()
    }

    /// Glass: tint, sky, frosting, glare, the shade the frame casts on it.
    static func paintGlass(layout: WindowLayout, canvas: WindowCanvas, look: WindowVisualLook, ambient: WindowAmbient, pixelsPerInch ppi: Double) -> CGImage? {
        guard let ctx = context(canvas, ppi) else { return nil }
        paintGlassLayer(ctx, layout, look: look, ambient: ambient, ppi: ppi)
        return ctx.makeImage()
    }

    /// A bitmap with the canvas's inches as its user space (y down).
    private static func context(_ c: WindowCanvas, _ ppi: Double) -> CGContext? {
        guard let ctx = CGContext(data: nil, width: c.widthPx, height: c.heightPx, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.translateBy(x: 0, y: CGFloat(c.heightPx))
        ctx.scaleBy(x: 1, y: -1)
        ctx.scaleBy(x: CGFloat(ppi), y: CGFloat(ppi))
        ctx.translateBy(x: CGFloat(-c.minX), y: CGFloat(-c.minY))
        ctx.setLineJoin(.miter)
        ctx.setLineCap(.butt)
        return ctx
    }

    // MARK: Paths

    private static func path(_ pts: [Vec2], closed: Bool = true) -> CGPath {
        let p = CGMutablePath()
        guard let first = pts.first else { return p }
        p.move(to: CGPoint(x: first.x, y: first.y))
        for q in pts.dropFirst() { p.addLine(to: CGPoint(x: q.x, y: q.y)) }
        if closed { p.closeSubpath() }
        return p
    }

    /// A polygon with its hole as one even-odd path.
    private static func facePath(_ s: WindowShape) -> CGPath {
        let p = CGMutablePath()
        p.addPath(path(s.points))
        if !s.hole.isEmpty { p.addPath(path(s.hole)) }
        return p
    }

    // MARK: Frame layer

    private static func paintFrameLayer(_ ctx: CGContext, _ layout: WindowLayout, color: RGBf, ambient: WindowAmbient, ppi: Double) {
        let inch = 1.0 / ppi   // one device pixel in inches
        // 1) The wall filler where the window does not fill the opening (arches, circles, odd shapes)
        for s in layout.shapes(.infill) {
            ctx.saveGState()
            ctx.addPath(path(s.points))
            ctx.clip()
            let b = WindowGeometry.box(s.points)
            let space = CGColorSpace(name: CGColorSpace.sRGB)
            if ambient.sides.count == 4 {
                // Left to right, then top to bottom over it at half strength: each edge takes on the wall beside it
                let h = CGGradient(colorsSpace: space, colors: [ambient.sides[3].cg(), ambient.sides[1].cg()] as CFArray, locations: [0, 1])!
                ctx.drawLinearGradient(h, start: CGPoint(x: b.minX, y: 0), end: CGPoint(x: b.maxX, y: 0), options: [])
                let v = CGGradient(colorsSpace: space, colors: [ambient.sides[0].cg(0.6), ambient.sides[2].cg(0.6)] as CFArray, locations: [0, 1])!
                ctx.drawLinearGradient(v, start: CGPoint(x: 0, y: b.minY), end: CGPoint(x: 0, y: b.maxY), options: [])
            } else {
                ctx.setFillColor(ambient.wall.cg())
                ctx.fill(CGRect(x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY))
            }
            // The new frame stands proud of it: cut its place out
            ctx.setBlendMode(.clear)
            ctx.addPath(path(s.hole))
            ctx.fillPath()
            ctx.restoreGState()
        }
        // 2) The soft shadow it throws on the wall: the silhouette, shadowed, then its opening cleared again
        if let frame = layout.shapes(.frame).first {
            ctx.saveGState()
            let blur = 1.5 * ppi
            ctx.setShadow(offset: CGSize(width: 0.25 * ppi, height: -0.55 * ppi), blur: CGFloat(blur), color: CGColor(gray: 0, alpha: 0.42))
            ctx.setFillColor(color.cg())
            ctx.addPath(path(frame.points))
            ctx.fillPath()
            ctx.restoreGState()
            ctx.saveGState()
            ctx.setBlendMode(.clear)
            ctx.addPath(path(frame.hole))
            ctx.fillPath()
            ctx.restoreGState()
        }
        // 3) The faces
        for s in layout.shapes {
            switch s.role {
            case .frame: face(ctx, s, color: color, lift: 1.0, inch: inch)
            case .sash: face(ctx, s, color: color, lift: 1.0, inch: inch)
            case .board:
                let lift = s.tag == "head" ? 0.86 : (s.tag == "seat" || s.tag == "shelf" ? 1.04 : 0.95)
                face(ctx, s, color: color, lift: lift, inch: inch)
            case .muntin: muntin(ctx, s, color: color, inch: inch)
            case .seam: seam(ctx, s, inch: inch)
            case .hardware: hardware(ctx, s, color: color, inch: inch)
            case .infill, .glass: break
            }
        }
    }

    /// A vinyl face: a faint gradient across it, a lit edge top and left and a shaded one bottom and right (the same trick turns a
    /// hole's edges the right way round), and a fine dark line where it meets its neighbours.
    private static func face(_ ctx: CGContext, _ s: WindowShape, color: RGBf, lift: Double, inch: Double) {
        let p = facePath(s)
        let b = WindowGeometry.box(s.points)
        ctx.saveGState()
        ctx.addPath(p)
        ctx.clip(using: .evenOdd)
        let base = color.scaled(lift)
        let g = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [base.scaled(1.06).cg(), base.scaled(0.93).cg()] as CFArray, locations: [0, 1])!
        ctx.drawLinearGradient(g, start: CGPoint(x: b.minX, y: b.minY), end: CGPoint(x: b.maxX, y: b.maxY), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
        // Lit and shaded edges
        let d = max(0.07, inch * 1.4)
        ctx.setLineWidth(CGFloat(d * 1.6))
        ctx.saveGState()
        ctx.translateBy(x: CGFloat(d), y: CGFloat(d))
        ctx.setStrokeColor(CGColor(gray: 1, alpha: 0.30))
        ctx.addPath(p)
        ctx.strokePath()
        ctx.restoreGState()
        ctx.saveGState()
        ctx.translateBy(x: CGFloat(-d), y: CGFloat(-d))
        ctx.setStrokeColor(CGColor(gray: 0, alpha: 0.16))
        ctx.addPath(p)
        ctx.strokePath()
        ctx.restoreGState()
        ctx.restoreGState()
        // The joint line
        ctx.saveGState()
        ctx.setLineWidth(CGFloat(max(0.05, inch * 1.2)))
        ctx.setStrokeColor(CGColor(gray: 0, alpha: 0.42))
        ctx.addPath(p)
        ctx.strokePath()
        ctx.restoreGState()
    }

    private static func muntin(_ ctx: CGContext, _ s: WindowShape, color: RGBf, inch: Double) {
        let p = path(s.points)
        ctx.saveGState()
        ctx.addPath(p)
        ctx.setFillColor(color.scaled(1.0).cg())
        ctx.fillPath()
        ctx.addPath(p)
        ctx.setLineWidth(CGFloat(max(0.04, inch)))
        ctx.setStrokeColor(CGColor(gray: 0, alpha: 0.34))
        ctx.strokePath()
        // A lit edge
        ctx.translateBy(x: CGFloat(-0.05), y: CGFloat(-0.05))
        ctx.addPath(p)
        ctx.setStrokeColor(CGColor(gray: 1, alpha: 0.22))
        ctx.setLineWidth(CGFloat(max(0.04, inch)))
        ctx.strokePath()
        ctx.restoreGState()
    }

    private static func seam(_ ctx: CGContext, _ s: WindowShape, inch: Double) {
        guard s.points.count >= 2 else { return }
        let p = path(s.points, closed: false)
        ctx.saveGState()
        ctx.addPath(p)
        ctx.setLineWidth(CGFloat(max(0.06, inch * 1.3)))
        ctx.setStrokeColor(CGColor(gray: 0, alpha: s.tag == "mitre" ? 0.30 : 0.46))
        ctx.strokePath()
        if s.tag != "mitre" {
            ctx.translateBy(x: CGFloat(0.05), y: CGFloat(0.07))
            ctx.addPath(p)
            ctx.setLineWidth(CGFloat(max(0.05, inch)))
            ctx.setStrokeColor(CGColor(gray: 1, alpha: 0.24))
            ctx.strokePath()
        }
        ctx.restoreGState()
    }

    private static func hardware(_ ctx: CGContext, _ s: WindowShape, color: RGBf, inch: Double) {
        let p = path(s.points)
        // Hardware is a little lighter than the frame so it reads on a dark one, and darker on a white one
        let tone = color.luma > 0.55 ? color.scaled(0.80) : color.scaled(1.55).mixed(RGBf(0.55, 0.55, 0.55), 0.35)
        ctx.saveGState()
        ctx.addPath(p)
        ctx.setFillColor(tone.cg())
        ctx.fillPath()
        ctx.addPath(p)
        ctx.setLineWidth(CGFloat(max(0.05, inch * 1.2)))
        ctx.setStrokeColor(CGColor(gray: 0, alpha: 0.5))
        ctx.strokePath()
        ctx.restoreGState()
    }

    // MARK: Glass layer

    private static func paintGlassLayer(_ ctx: CGContext, _ layout: WindowLayout, look: WindowVisualLook, ambient: WindowAmbient, ppi: Double) {
        let panes = layout.glass
        guard !panes.isEmpty else { return }
        let all = CGMutablePath()
        for g in panes { all.addPath(path(g.points)) }
        let box = layout.bounds
        let frosted = look.glass == .frosted
        let sky = look.cleanGlass && !frosted
        let tinted = look.glass == .lowE

        // The glass itself
        for g in panes {
            let b = WindowGeometry.box(g.points)
            ctx.saveGState()
            ctx.addPath(path(g.points))
            ctx.clip()
            if frosted {
                // Obscure glass: pale, the view a soft glow behind it
                let top = RGBf(0.95, 0.97, 0.98), bottom = RGBf(0.85, 0.89, 0.92)
                let grad = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [top.cg(0.93), bottom.cg(0.93)] as CFArray, locations: [0, 1])!
                ctx.drawLinearGradient(grad, start: CGPoint(x: 0, y: b.minY), end: CGPoint(x: 0, y: b.maxY), options: [])
                // A fine pebble: a few thousand faint dots, the same every time
                var seed: UInt64 = 0x9E3779B97F4A7C15
                func next() -> Double { seed = seed &* 6364136223846793005 &+ 1442695040888963407; return Double(seed >> 33) / Double(1 << 31) }
                let n = Int(min(2600, (b.maxX - b.minX) * (b.maxY - b.minY) * 1.2))
                for _ in 0..<n {
                    let x = b.minX + next() * (b.maxX - b.minX), y = b.minY + next() * (b.maxY - b.minY)
                    ctx.setFillColor(CGColor(gray: next() > 0.5 ? 1 : 0.6, alpha: 0.10))
                    ctx.fillEllipse(in: CGRect(x: x, y: y, width: 0.32, height: 0.32))
                }
            } else if sky {
                // A soft outdoors: sky, a pale horizon, the far ground
                let rows = box.maxY - box.minY
                let top = RGBf(0.58, 0.75, 0.91), mid = RGBf(0.86, 0.92, 0.96), low = RGBf(0.58, 0.65, 0.57)
                let grad = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [top.cg(), mid.cg(), mid.scaled(0.97).cg(), low.cg()] as CFArray, locations: [0, 0.55, 0.72, 1])!
                ctx.drawLinearGradient(grad, start: CGPoint(x: 0, y: box.minY), end: CGPoint(x: 0, y: box.minY + rows), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
            }
            if tinted {
                ctx.setFillColor(CGColor(srgbRed: 0.36, green: 0.62, blue: 0.62, alpha: sky ? 0.10 : 0.12))
                ctx.fill(CGRect(x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY))
            }
            ctx.restoreGState()
        }

        // Glare: two soft diagonal bands across all the panes together
        if !frosted {
            ctx.saveGState()
            ctx.addPath(all)
            ctx.clip()
            let w = box.maxX - box.minX, h = box.maxY - box.minY
            let reach = max(w, h)
            for (offset, width, alpha) in [(0.18, 0.16, 0.20), (0.46, 0.06, 0.12)] {
                let cx = box.minX + w * offset
                let p = CGMutablePath()
                p.move(to: CGPoint(x: cx - reach * width, y: box.minY - 4))
                p.addLine(to: CGPoint(x: cx + reach * width, y: box.minY - 4))
                p.addLine(to: CGPoint(x: cx + reach * width - h * 0.55, y: box.maxY + 4))
                p.addLine(to: CGPoint(x: cx - reach * width - h * 0.55, y: box.maxY + 4))
                p.closeSubpath()
                ctx.saveGState()
                ctx.addPath(p)
                ctx.clip()
                let grad = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [CGColor(gray: 1, alpha: 0), CGColor(gray: 1, alpha: alpha), CGColor(gray: 1, alpha: 0)] as CFArray, locations: [0, 0.5, 1])!
                ctx.drawLinearGradient(grad, start: CGPoint(x: cx - reach * width, y: 0), end: CGPoint(x: cx + reach * width, y: 0), options: [])
                ctx.restoreGState()
            }
            ctx.restoreGState()
        }

        // The shade the frame and sashes throw on the glass: an inner shadow along every pane's edge
        for g in panes {
            let b = WindowGeometry.box(g.points)
            ctx.saveGState()
            ctx.addPath(path(g.points))
            ctx.clip()
            let outer = CGMutablePath()
            outer.addRect(CGRect(x: b.minX - 10, y: b.minY - 10, width: b.maxX - b.minX + 20, height: b.maxY - b.minY + 20))
            outer.addPath(path(g.points))
            ctx.setShadow(offset: CGSize(width: 0.2 * ppi, height: -0.35 * ppi), blur: CGFloat(0.7 * ppi), color: CGColor(gray: 0, alpha: frosted ? 0.28 : 0.42))
            ctx.setFillColor(CGColor(gray: 0, alpha: 1))
            ctx.addPath(outer)
            ctx.fillPath(using: .evenOdd)
            ctx.restoreGState()
        }
    }
}
