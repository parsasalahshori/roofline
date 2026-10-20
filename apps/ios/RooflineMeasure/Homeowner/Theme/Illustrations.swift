import CoreLocation
import MapKit
import SwiftUI

// The pictures of the homeowner screens: the stylized map, the house from above, the window styles. Drawn in SwiftUI from
// the mockups' own shapes (design/mockups/src) so they scale, follow Dark Mode and need no image files.

// MARK: - Map

/// The address screen's map (ios-hw-02): a quiet block map with the street's name and a red pin on the home. Shown while there
/// is no real map tile to show (no coordinate yet, offline, previews); with a coordinate the screen uses MapKit.
struct StyledMap: View {
    var streetName = "Ridgeway Dr"
    var showPin = true

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width, h = geo.size.height
            let sx = w / 358, sy = h / 240
            ZStack(alignment: .topLeading) {
                Theme.mapGround
                // Streets (white bands between the blocks)
                Group {
                    Rectangle().frame(width: 12 * sx, height: h).offset(x: 84 * sx)
                    Rectangle().frame(width: 12 * sx, height: h).offset(x: 254 * sx)
                    Rectangle().frame(width: w, height: 12 * sy).offset(y: 64 * sy)
                    Rectangle().frame(width: w, height: 12 * sy).offset(y: 174 * sy)
                }
                .foregroundStyle(Theme.mapStreet)
                // The home's lot
                RoundedRectangle(cornerRadius: 4 * sx).fill(Theme.mapLot)
                    .frame(width: 130 * sx, height: 70 * sy).offset(x: 110 * sx, y: 90 * sy)
                // (No street name drawn: it is decoration, the address card under the map says it, and the accessibility audit
                // could not read it over the map's blocks.)
                // The house
                Rectangle().fill(Theme.surface).frame(width: 58 * sx, height: 42 * sy)
                    .overlay(Rectangle().strokeBorder(Theme.ink, lineWidth: 2))
                    .offset(x: 149 * sx, y: 101 * sy)
                if showPin {
                    MapPin().frame(width: 30 * sx, height: 38 * sy).offset(x: 164 * sx, y: 96 * sy)
                }
            }
            .frame(width: w, height: h, alignment: .topLeading)
            .clipped()
        }
        .accessibilityHidden(true)
    }
}

/// A red map pin with a white dot (the mockup's marker).
struct MapPin: View {
    var body: some View {
        GeometryReader { g in
            let w = g.size.width, h = g.size.height
            ZStack {
                Path { p in
                    p.move(to: CGPoint(x: w / 2, y: h))
                    p.addCurve(to: CGPoint(x: 0, y: h * 0.38), control1: CGPoint(x: w * 0.12, y: h * 0.72), control2: CGPoint(x: 0, y: h * 0.58))
                    p.addArc(center: CGPoint(x: w / 2, y: h * 0.38), radius: w / 2, startAngle: .degrees(180), endAngle: .degrees(0), clockwise: false)
                    p.addCurve(to: CGPoint(x: w / 2, y: h), control1: CGPoint(x: w, y: h * 0.58), control2: CGPoint(x: w * 0.88, y: h * 0.72))
                }
                .fill(Theme.red)
                Circle().fill(Color.white).frame(width: w * 0.36, height: w * 0.36).position(x: w / 2, y: h * 0.38)
            }
        }
    }
}

extension Theme {
    static let mapGround = Color(light: 0xE9EBE8, dark: 0x1B2530)
    static let mapStreet = Color(light: 0xFFFFFF, dark: 0x2A3646)
    static let mapLot = Color(light: 0xE0E3DE, dark: 0x233040)
}

/// A real map (MapKit) of the picked address with a red pin. Not interactive: it is a confirmation, not a map screen.
struct AddressMap: View {
    let coordinate: CLLocationCoordinate2D

    var body: some View {
        Map(initialPosition: .region(MKCoordinateRegion(center: coordinate, latitudinalMeters: 140, longitudinalMeters: 140)), interactionModes: []) {
            Annotation("", coordinate: coordinate, anchor: .bottom) {
                MapPin().frame(width: 30, height: 38)
            }
        }
        .mapStyle(.standard(pointsOfInterest: .excludingAll))
        .accessibilityHidden(true)
    }
}

// MARK: - The home from above

/// The roof as a small picture (ios-hw-03): dark ground, the roof's shape in grey with a tape-yellow edge and hip lines.
/// With the server's outline it is that outline; without, a plain hip roof.
struct RoofThumb: View {
    var outline: HomeownerOutlineShape?

    var body: some View {
        Canvas { ctx, size in
            let ground = Path(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: 10)
            ctx.fill(ground, with: .color(Color(light: 0x4A5A44, dark: 0x38452F)))
            let roof = outline?.path(in: CGRect(x: size.width * 0.17, y: size.height * 0.17, width: size.width * 0.66, height: size.height * 0.66))
                ?? Path(CGRect(x: size.width * 0.18, y: size.height * 0.22, width: size.width * 0.64, height: size.height * 0.56))
            ctx.fill(roof, with: .color(Color(white: 0.5, opacity: 0.85)))
            ctx.stroke(roof, with: .color(Theme.tape), lineWidth: 1.6)
            // Hip lines from each corner toward the ridge
            let b = roof.boundingRect
            var hips = Path()
            let ridgeL = CGPoint(x: b.minX + b.width * 0.32, y: b.midY), ridgeR = CGPoint(x: b.maxX - b.width * 0.32, y: b.midY)
            hips.move(to: CGPoint(x: b.minX, y: b.minY)); hips.addLine(to: ridgeL)
            hips.move(to: CGPoint(x: b.minX, y: b.maxY)); hips.addLine(to: ridgeL)
            hips.move(to: CGPoint(x: b.maxX, y: b.minY)); hips.addLine(to: ridgeR)
            hips.move(to: CGPoint(x: b.maxX, y: b.maxY)); hips.addLine(to: ridgeR)
            hips.move(to: ridgeL); hips.addLine(to: ridgeR)
            ctx.stroke(hips, with: .color(Color(white: 0.3, opacity: 0.8)), lineWidth: 1)
        }
        .accessibilityHidden(true)
    }
}

/// A closed outline of points given as (longitude, latitude), fitted into a rectangle (north up).
struct HomeownerOutlineShape {
    var points: [(lon: Double, lat: Double)]

    func path(in rect: CGRect) -> Path? {
        guard points.count >= 3 else { return nil }
        let lons = points.map { $0.lon }, lats = points.map { $0.lat }
        guard let minLon = lons.min(), let maxLon = lons.max(), let minLat = lats.min(), let maxLat = lats.max(), maxLon > minLon, maxLat > minLat else { return nil }
        // Longitude degrees are shorter than latitude degrees away from the equator
        let k = cos(((minLat + maxLat) / 2) * .pi / 180)
        let spanX = (maxLon - minLon) * k, spanY = maxLat - minLat
        let scale = min(rect.width / spanX, rect.height / spanY)
        let ox = rect.midX - spanX * scale / 2, oy = rect.midY - spanY * scale / 2
        var p = Path()
        for (i, pt) in points.enumerated() {
            let x = ox + (pt.lon - minLon) * k * scale
            let y = oy + (maxLat - pt.lat) * scale
            if i == 0 { p.move(to: CGPoint(x: x, y: y)) } else { p.addLine(to: CGPoint(x: x, y: y)) }
        }
        p.closeSubpath()
        return p
    }
}

// MARK: - Window styles

/// The line drawing of each window style (ios-hw-09), 48 x 52 units, in the current foreground colour.
struct StyleGlyph: View {
    let key: String
    var width: CGFloat = 48

    private struct Part {
        var d: String
        var line: CGFloat
        var dashed = false
    }

    private var parts: [Part] {
        switch key {
        case "double-hung":
            return [Part(d: "M6 3h36v46H6z", line: 2), Part(d: "M6 26h36", line: 2), Part(d: "M24 10v10M21 13l3-3 3 3M24 32v10M21 39l3 3 3-3", line: 1.5)]
        case "single-hung":
            return [Part(d: "M6 3h36v46H6z", line: 2), Part(d: "M6 26h36", line: 2), Part(d: "M24 32v10M21 35l3-3 3 3", line: 1.5)]
        case "slider-2":
            return [Part(d: "M3 8h42v36H3z", line: 2), Part(d: "M24 8v36", line: 2), Part(d: "M9 26h10M12 23l-3 3 3 3M29 26h10M36 23l3 3-3 3", line: 1.5)]
        case "slider-3":
            return [Part(d: "M3 8h42v36H3z", line: 2), Part(d: "M17 8v36M31 8v36", line: 2), Part(d: "M5 26h10M8 23l-3 3 3 3M33 26h10M40 23l3 3-3 3", line: 1.5)]
        case "picture":
            return [Part(d: "M3 8h42v36H3z", line: 2)]
        case "casement":
            return [Part(d: "M6 3h36v46H6z", line: 2), Part(d: "M42 3 6 26l36 23", line: 1.3, dashed: true)]
        case "awning":
            return [Part(d: "M6 3h36v46H6z", line: 2), Part(d: "M6 3 24 49 42 3", line: 1.3, dashed: true)]
        case "arch":
            return [Part(d: "M6 49V22a18 18 0 0 1 36 0v27z", line: 2), Part(d: "M6 28h36", line: 1.5)]
        case "circle":
            return [Part(d: "M45 26a21 21 0 1 1-42 0 21 21 0 1 1 42 0z", line: 2), Part(d: "M24 5v42M3 26h42", line: 1.5)]
        default:
            // A style the app has no drawing for: a plain frame
            return [Part(d: "M6 3h36v46H6z", line: 2)]
        }
    }

    var body: some View {
        let scale = width / 48
        ZStack {
            ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
                SVGPath.path(part.d).applying(CGAffineTransform(scaleX: scale, y: scale))
                    .stroke(style: StrokeStyle(lineWidth: part.line * scale, lineCap: .butt, lineJoin: .miter, dash: part.dashed ? [3 * scale, 2 * scale] : []))
            }
        }
        .frame(width: 48 * scale, height: 52 * scale, alignment: .topLeading)
        .accessibilityHidden(true)
    }
}
