import SwiftUI

/// The Chalk Line icon set: one 24-unit grid, 1.7 stroke, round caps and joins, `currentColor` (REDESIGN.md 5.5). The
/// path data is the mockups' own (design/mockups/src/_icons.svg), so the icons match the approved screens exactly.
enum WCIcon: String, CaseIterable {
    case home, win, roof, gutter, factory, arrow, check, chevLeft, chevRight, pin, lock, lidar, target, cube, plus, alert, ruler
    case upload, calendar, truck, message, undo, close, phone, camera, clock, refresh, info

    fileprivate enum Element {
        case path(String)
        case circle(CGFloat, CGFloat, CGFloat)
        case rect(CGFloat, CGFloat, CGFloat, CGFloat, CGFloat)
    }

    fileprivate var elements: [Element] {
        switch self {
        case .home: return [.path("M3 11 12 4l9 7"), .path("M5.5 9.5V20h13V9.5"), .path("M10 20v-5.5h4V20")]
        case .win: return [.rect(5, 3.5, 14, 17, 1), .path("M5 12h14M12 3.5V12")]
        case .roof: return [.path("M2.5 12.5 12 5l9.5 7.5"), .path("M5 10.5V19h14v-8.5"), .path("M9 19v-4h6v4")]
        case .gutter: return [.path("M3 7h18v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"), .path("M17 12v8")]
        case .factory: return [.path("M3 20V10l5 3V10l5 3V5h4l1 15z"), .path("M3 20h18")]
        case .arrow: return [.path("M5 12h14M13 6l6 6-6 6")]
        case .check: return [.path("m5 12.5 4.5 4.5L19 7.5")]
        case .chevLeft: return [.path("m15 6-6 6 6 6")]
        case .chevRight: return [.path("m9 6 6 6-6 6")]
        case .pin: return [.path("M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"), .circle(12, 10, 2.3)]
        case .lock: return [.rect(5, 10.5, 14, 10, 2), .path("M8 10.5V8a4 4 0 0 1 8 0v2.5")]
        case .lidar: return [.circle(12, 12, 2), .path("M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14")]
        case .target: return [.circle(12, 12, 7), .path("M12 2v4M12 18v4M2 12h4M18 12h4"), .circle(12, 12, 1)]
        case .cube: return [.path("m12 3 8 4.5v9L12 21l-8-4.5v-9z"), .path("m4 7.5 8 4.5 8-4.5M12 12v9")]
        case .plus: return [.path("M12 5v14M5 12h14")]
        case .alert: return [.path("M12 3.5 21.5 20h-19z"), .path("M12 10v4.5M12 17.3v.2")]
        case .ruler: return [.path("M3.5 16.5 16.5 3.5l4 4-13 13z"), .path("M7 13l2 2M9.5 10.5l1.5 1.5M12 8l2 2M14.5 5.5l1.5 1.5")]
        case .upload: return [.path("M12 15V4M7.5 8.5 12 4l4.5 4.5M4 15v5h16v-5")]
        case .calendar: return [.rect(3.5, 5, 17, 15.5, 2), .path("M3.5 10h17M8 3v4M16 3v4"), .path("M7.5 14h2M11 14h2M14.5 14h2M7.5 17h2M11 17h2")]
        case .truck: return [.path("M2.5 6h11v10h-11zM13.5 9.5h4l3 3.5V16h-7"), .circle(7, 17.5, 1.8), .circle(17, 17.5, 1.8)]
        case .message: return [.path("M4 5.5h16v11H9l-5 4z")]
        case .undo: return [.path("M9 14 4 9l5-5"), .path("M4 9h10a6 6 0 0 1 0 12h-3")]
        case .close: return [.path("M6 6l12 12M18 6 6 18")]
        case .phone: return [.path("M5 3.5h3.2l1.6 4.2-2.1 1.3a11 11 0 0 0 5.3 5.3l1.3-2.1 4.2 1.6V17a2.5 2.5 0 0 1-2.7 2.5C9.5 19 4.9 14.4 4.5 6.2A2.5 2.5 0 0 1 5 3.5z")]
        case .camera: return [.path("M4 8h3l1.6-2.5h6.8L17 8h3v11H4z"), .circle(12, 13.2, 3.4)]
        case .clock: return [.circle(12, 12, 8.5), .path("M12 7.5V12l3 2")]
        case .refresh: return [.path("M19.5 12a7.5 7.5 0 1 1-2.2-5.3L20 9.5"), .path("M20 4.5v5h-5")]
        case .info: return [.circle(12, 12, 8.5), .path("M12 11v5M12 8v.2")]
        }
    }

    /// The icon's strokes on a 24 x 24 grid.
    fileprivate var path: Path {
        var p = Path()
        for e in elements {
            switch e {
            case .path(let d): p.addPath(SVGPath.path(d))
            case .circle(let cx, let cy, let r): p.addEllipse(in: CGRect(x: cx - r, y: cy - r, width: 2 * r, height: 2 * r))
            case .rect(let x, let y, let w, let h, let rx): p.addRoundedRect(in: CGRect(x: x, y: y, width: w, height: h), cornerSize: CGSize(width: rx, height: rx))
            }
        }
        return p
    }
}

/// The icon scaled to its frame, in the current foreground colour.
struct WCIconShape: Shape {
    let icon: WCIcon

    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 24
        return icon.path.applying(CGAffineTransform(scaleX: s, y: s).translatedBy(x: 0, y: 0)).offsetBy(dx: rect.minX, dy: rect.minY)
    }
}

/// An icon at 16, 18 or 22 points (the mockups' three sizes).
struct IconView: View {
    let icon: WCIcon
    var size: CGFloat = 18
    /// The mockup's stroke is 1.7 of 24 units.
    var weight: CGFloat = 1.7

    var body: some View {
        WCIconShape(icon: icon)
            .stroke(style: StrokeStyle(lineWidth: weight * size / 24, lineCap: .round, lineJoin: .round))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}
