import RooflineCore
import SwiftUI

/// A window drawn as quiet line art from the same layout the photo uses, so a thumbnail and the window in the photo cannot disagree.
/// It follows the text colour (and so light and dark) and takes the accent when it is selected.
struct WindowThumbnail: View {
    let type: VisualWindowType
    var grid: VisualGrid = .none
    /// The line colour.
    var ink: Color = Theme.ink
    var glassTint: Color = Color(.systemBlue)

    /// A size each kind is drawn at (inches): its usual proportions.
    static func nominalSize(_ type: VisualWindowType) -> (w: Double, h: Double) {
        switch type {
        case .doubleHung, .singleHung: return (30, 48)
        case .slider2: return (48, 30)
        case .slider3: return (60, 30)
        case .casement: return (28, 46)
        case .casementPair: return (48, 46)
        case .awning: return (42, 24)
        case .hopper: return (36, 22)
        case .picture: return (40, 40)
        case .pictureCasements: return (60, 40)
        case .bay: return (66, 44)
        case .bow: return (78, 44)
        case .garden: return (48, 40)
        case .arch: return (30, 48)
        case .halfRound: return (48, 24)
        case .circle, .specialty: return (36, 36)
        }
    }

    var body: some View {
        Canvas { context, size in
            let n = Self.nominalSize(type)
            let layout = WindowLayoutBuilder.build(type: type, grid: grid, widthIn: n.w, heightIn: n.h)
            draw(layout, in: &context, size: size)
        }
        .accessibilityHidden(true)
    }

    private func draw(_ layout: WindowLayout, in context: inout GraphicsContext, size: CGSize) {
        let box = layout.bounds
        let bw = box.maxX - box.minX, bh = box.maxY - box.minY
        let pad: CGFloat = 3
        let scale = min((size.width - 2 * pad) / bw, (size.height - 2 * pad) / bh)
        let ox = (size.width - bw * scale) / 2 - box.minX * scale
        let oy = (size.height - bh * scale) / 2 - box.minY * scale
        func pt(_ v: Vec2) -> CGPoint { CGPoint(x: v.x * scale + ox, y: v.y * scale + oy) }
        func path(_ pts: [Vec2], closed: Bool = true) -> Path {
            var p = Path()
            guard let first = pts.first else { return p }
            p.move(to: pt(first))
            for q in pts.dropFirst() { p.addLine(to: pt(q)) }
            if closed { p.closeSubpath() }
            return p
        }
        func face(_ s: WindowShape) -> Path {
            var p = path(s.points)
            if !s.hole.isEmpty { p.addPath(path(s.hole)) }
            return p
        }
        for s in layout.shapes {
            switch s.role {
            case .infill: break
            case .frame:
                let p = face(s)
                context.fill(p, with: .color(ink.opacity(0.14)), style: FillStyle(eoFill: true))
                context.stroke(p, with: .color(ink), lineWidth: 1.3)
            case .sash:
                let p = face(s)
                context.fill(p, with: .color(ink.opacity(0.07)), style: FillStyle(eoFill: true))
                context.stroke(p, with: .color(ink.opacity(0.85)), lineWidth: 0.9)
            case .board:
                let p = path(s.points)
                context.fill(p, with: .color(ink.opacity(0.22)))
                context.stroke(p, with: .color(ink.opacity(0.85)), lineWidth: 0.9)
            case .glass:
                let p = path(s.points)
                context.fill(p, with: .color(glassTint.opacity(0.13)))
            case .muntin:
                context.fill(path(s.points), with: .color(ink.opacity(0.85)))
            case .seam:
                if s.tag != "mitre" { context.stroke(path(s.points, closed: false), with: .color(ink.opacity(0.7)), lineWidth: 0.8) }
            case .hardware:
                context.fill(path(s.points), with: .color(ink.opacity(0.9)))
            }
        }
    }
}
