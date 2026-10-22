import CoreLocation
import MapKit
import RooflineCore
import SwiftUI

/// The pure geometry behind the results screen's "finding your home" animation: the roof's ring of longitude/latitude points,
/// the satellite framing that puts the house in the middle of a hero of a given size, and the points along the ring that the
/// stroke is drawn to. No views here, so it is checked on its own (`HomeOutlineGeometryTests`).
struct HomeOutlineGeometry: Equatable {
    struct Vertex: Equatable {
        var lat: Double
        var lon: Double
        var coordinate: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: lat, longitude: lon) }
    }

    /// Where the camera looks: the visible ground (in metres) around a centre, north up.
    struct Framing: Equatable {
        var centerLat: Double
        var centerLon: Double
        var groundWidth: Double
        var groundHeight: Double

        /// The same centre with `factor` times the ground (a factor under 1 is closer in).
        func scaled(by factor: Double) -> Framing {
            Framing(centerLat: centerLat, centerLon: centerLon, groundWidth: groundWidth * factor, groundHeight: groundHeight * factor)
        }

        var region: MKCoordinateRegion {
            MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: centerLat, longitude: centerLon), latitudinalMeters: groundHeight, longitudinalMeters: groundWidth)
        }
    }

    /// The corners in order, open (the first point is not repeated at the end).
    let ring: [Vertex]

    /// The ground a house with its outline has to be at least this big (m) to be drawn: anything smaller is a bad measurement.
    static let smallestSide = 3.0
    static let metresPerDegree = 111_320.0

    /// The outline the server sent, or nil when there is nothing sensible to draw (fewer than 3 distinct corners, a point that is not
    /// a coordinate, a sliver): the results screen then keeps today's static card.
    init?(outline: HomeownerOutline?) {
        guard let outline = outline else { return nil }
        self.init(points: outline.points.map { (lon: $0.lon, lat: $0.lat) })
    }

    init?(points: [(lon: Double, lat: Double)]) {
        var ring: [Vertex] = []
        for p in points {
            guard p.lat.isFinite, p.lon.isFinite, abs(p.lat) <= 85, abs(p.lon) <= 180 else { return nil }
            let v = Vertex(lat: p.lat, lon: p.lon)
            // A repeated neighbour (and a ring that is closed by repeating its first corner) adds no edge
            if let last = ring.last, last == v { continue }
            ring.append(v)
        }
        if ring.count > 1, ring.first == ring.last { ring.removeLast() }
        guard ring.count >= 3 else { return nil }
        self.ring = ring
        guard widthMeters >= Self.smallestSide || heightMeters >= Self.smallestSide, perimeterMeters >= 4 * Self.smallestSide else { return nil }
    }

    // MARK: Size and place

    private var minLat: Double { ring.map(\.lat).min() ?? 0 }
    private var maxLat: Double { ring.map(\.lat).max() ?? 0 }
    private var minLon: Double { ring.map(\.lon).min() ?? 0 }
    private var maxLon: Double { ring.map(\.lon).max() ?? 0 }

    /// The middle of the ring's bounding box (what the camera centres on).
    var centerLat: Double { (minLat + maxLat) / 2 }
    var centerLon: Double { (minLon + maxLon) / 2 }

    private var metresPerDegreeLon: Double { Self.metresPerDegree * cos(centerLat * .pi / 180) }
    var widthMeters: Double { (maxLon - minLon) * metresPerDegreeLon }
    var heightMeters: Double { (maxLat - minLat) * Self.metresPerDegree }

    /// Length around, in metres.
    var perimeterMeters: Double {
        var total = 0.0
        for i in ring.indices { total += edgeMeters(i) }
        return total
    }

    private func edgeMeters(_ i: Int) -> Double {
        let a = ring[i], b = ring[(i + 1) % ring.count]
        let dx = (b.lon - a.lon) * metresPerDegreeLon, dy = (b.lat - a.lat) * Self.metresPerDegree
        return (dx * dx + dy * dy).squareRoot()
    }

    /// Where along the stroke (0...1) each corner is reached, so a dot can appear as the line gets to it.
    var vertexFractions: [Double] {
        let total = perimeterMeters
        guard total > 0 else { return ring.map { _ in 0 } }
        var run = 0.0
        var out: [Double] = []
        for i in ring.indices {
            out.append(run / total)
            run += edgeMeters(i)
        }
        return out
    }

    // MARK: Framing

    /// How much of the hero the house may fill: all of it fits inside these fractions, centred, with room for the chip and the legal label.
    static let fillWidth = 0.54
    static let fillHeight = 0.62
    /// Never closer than this many metres of ground in the picture's height (the imagery gets soft), never further than that.
    static let closestGround = 38.0
    static let furthestGround = 170.0

    /// The camera that puts the house in the middle of a hero this big.
    func framing(for size: CGSize) -> Framing {
        let w = max(Double(size.width), 1), h = max(Double(size.height), 1)
        let metresPerPoint = max(widthMeters / (w * Self.fillWidth), heightMeters / (h * Self.fillHeight))
        let groundHeight = min(max(metresPerPoint * h, Self.closestGround), Self.furthestGround)
        return Framing(centerLat: centerLat, centerLon: centerLon, groundWidth: groundHeight * w / h, groundHeight: groundHeight)
    }

    /// The same view from further out and off to one side: what the map starts on before it settles on the house.
    static func wide(from tight: Framing) -> Framing {
        let zoom = 3.4
        return Framing(centerLat: tight.centerLat + tight.groundHeight * zoom * 0.26 / metresPerDegree,
                       centerLon: tight.centerLon - tight.groundWidth * zoom * 0.22 / (metresPerDegree * cos(tight.centerLat * .pi / 180)),
                       groundWidth: tight.groundWidth * zoom, groundHeight: tight.groundHeight * zoom)
    }

    /// The ring's corners in the hero's own points for a camera, worked out from the framing alone (the map is flat and north up).
    /// The drawn outline uses the map's own answer; this is what that answer is checked against.
    func expectedPoints(in framing: Framing, size: CGSize) -> [CGPoint] {
        let perDegLon = Self.metresPerDegree * cos(framing.centerLat * .pi / 180)
        return ring.map { v in
            let east = (v.lon - framing.centerLon) * perDegLon, north = (v.lat - framing.centerLat) * Self.metresPerDegree
            return CGPoint(x: size.width / 2 + CGFloat(east / framing.groundWidth) * size.width,
                           y: size.height / 2 - CGFloat(north / framing.groundHeight) * size.height)
        }
    }

    /// Where the map actually put the corners, and how big the house came out against what the framing asked for.
    struct Placement: Equatable {
        var points: [CGPoint]
        /// 1 = as asked, 0.65 = the map is showing about 1.5 times more ground than the framing says.
        var scale: Double
    }

    /// The map's corners (`measured`) read against the framing's (`expected`), or nil when they cannot be right: another number of
    /// points, a point that is not a number, the house nowhere near the middle, or a size so far off that the camera is still on its
    /// way. The map's own answer is what gets drawn; `scale` tells how far its zoom is from the one asked for.
    func placement(of measured: [CGPoint], expected: [CGPoint], in size: CGSize) -> Placement? {
        guard measured.count == expected.count, measured.count == ring.count else { return nil }
        guard measured.allSatisfy({ $0.x.isFinite && $0.y.isFinite }) else { return nil }
        func box(_ pts: [CGPoint]) -> (w: CGFloat, h: CGFloat, mid: CGPoint) {
            let xs = pts.map(\.x), ys = pts.map(\.y)
            let minX = xs.min() ?? 0, maxX = xs.max() ?? 0, minY = ys.min() ?? 0, maxY = ys.max() ?? 0
            return (maxX - minX, maxY - minY, CGPoint(x: (minX + maxX) / 2, y: (minY + maxY) / 2))
        }
        let m = box(measured), e = box(expected)
        guard e.w + e.h > 0, m.w + m.h > 0 else { return nil }
        guard hypot(m.mid.x - e.mid.x, m.mid.y - e.mid.y) <= size.width * 0.12 else { return nil }
        let scale = Double((m.w + m.h) / (e.w + e.h))
        guard scale >= 0.4, scale <= 2.5 else { return nil }
        return Placement(points: measured, scale: scale)
    }

    // MARK: Along the stroke

    /// The point `fraction` of the way round the closed outline `points` (0 and 1 are the first corner).
    static func point(at fraction: Double, along points: [CGPoint]) -> CGPoint? {
        guard points.count >= 2 else { return points.first }
        let f = min(max(fraction, 0), 1)
        var lengths: [CGFloat] = []
        for i in points.indices {
            let a = points[i], b = points[(i + 1) % points.count]
            lengths.append(hypot(b.x - a.x, b.y - a.y))
        }
        let total = lengths.reduce(0, +)
        guard total > 0 else { return points[0] }
        var remaining = CGFloat(f) * total
        for i in points.indices {
            if remaining <= lengths[i] || i == points.count - 1 {
                let a = points[i], b = points[(i + 1) % points.count]
                let t = lengths[i] > 0 ? min(max(remaining / lengths[i], 0), 1) : 0
                return CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
            }
            remaining -= lengths[i]
        }
        return points[0]
    }
}
