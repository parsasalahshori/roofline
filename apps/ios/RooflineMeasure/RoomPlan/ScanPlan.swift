import Foundation

/// The shape of a scanned room, as plain numbers (metres, on the floor plane): its walls, and where the windows and doors are
/// in them. Enough to draw the room from above or from a corner; no RoomPlan types, so it can be drawn in the simulator.
struct ScanPlan: Equatable {
    struct Segment: Equatable {
        var ax: Double
        var ay: Double
        var bx: Double
        var by: Double

        var length: Double { ((bx - ax) * (bx - ax) + (by - ay) * (by - ay)).squareRoot() }
        var mid: (x: Double, y: Double) { ((ax + bx) / 2, (ay + by) / 2) }
    }

    struct Opening: Equatable, Identifiable {
        var id: UUID
        var isDoor: Bool
        var segment: Segment
        /// Height of the bottom and the top above the floor, metres.
        var sill: Double
        var head: Double
    }

    var walls: [Segment]
    var openings: [Opening]
    /// How tall the walls are, metres.
    var wallHeight: Double

    /// A plain four-wall room (4.32 m by 3.56 m, about 14 ft 2 in by 11 ft 8 in) with the windows of the mockup, for previews:
    /// two on the long wall, one and a door on the short one.
    static var sample: ScanPlan {
        let w = 3.56, d = 4.32, h = 2.4
        let walls = [
            Segment(ax: 0, ay: 0, bx: w, by: 0), Segment(ax: w, ay: 0, bx: w, by: d),
            Segment(ax: w, ay: d, bx: 0, by: d), Segment(ax: 0, ay: d, bx: 0, by: 0),
        ]
        let a = Opening(id: UUID(), isDoor: false, segment: Segment(ax: 0, ay: 0.8, bx: 0, by: 1.72), sill: 0.8, head: 2.0)
        let b = Opening(id: UUID(), isDoor: false, segment: Segment(ax: 0, ay: 2.4, bx: 0, by: 3.32), sill: 0.8, head: 2.0)
        let c = Opening(id: UUID(), isDoor: false, segment: Segment(ax: 0.7, ay: 0, bx: 1.92, by: 0), sill: 0.9, head: 1.8)
        let door = Opening(id: UUID(), isDoor: true, segment: Segment(ax: 2.4, ay: 0, bx: 3.1, by: 0), sill: 0, head: 2.05)
        return ScanPlan(walls: walls, openings: [a, b, c, door], wallHeight: h)
    }

    // MARK: Turning the room to show it

    /// The same room moved by `f` (every end of every wall and opening).
    func mapped(_ f: (Double, Double) -> (Double, Double)) -> ScanPlan {
        func seg(_ s: Segment) -> Segment {
            let a = f(s.ax, s.ay), b = f(s.bx, s.by)
            return Segment(ax: a.0, ay: a.1, bx: b.0, by: b.1)
        }
        return ScanPlan(walls: walls.map(seg), openings: openings.map { o in
            Opening(id: o.id, isDoor: o.isDoor, segment: seg(o.segment), sill: o.sill, head: o.head)
        }, wallHeight: wallHeight)
    }

    /// Turned by `radians` about the middle, then moved so the room's corner is at (0, 0).
    func rotated(_ radians: Double) -> ScanPlan {
        let xs = walls.flatMap { [$0.ax, $0.bx] }, ys = walls.flatMap { [$0.ay, $0.by] }
        guard let x0 = xs.min(), let x1 = xs.max(), let y0 = ys.min(), let y1 = ys.max() else { return self }
        let cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
        let c = cos(radians), s = sin(radians)
        let turned = mapped { x, y in (cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c) }
        let nx = turned.walls.flatMap { [$0.ax, $0.bx] }.min() ?? 0, ny = turned.walls.flatMap { [$0.ay, $0.by] }.min() ?? 0
        return turned.mapped { x, y in (x - nx, y - ny) }
    }

    /// Turned so the longest wall runs along y (the left wall of the 3D view), at the corner that puts the most windows on
    /// the two walls the 3D view draws (the left one and the right one), so none is hidden behind the room.
    func forDrawing() -> ScanPlan {
        guard let longest = walls.max(by: { $0.length < $1.length }), longest.length > 0.01 else { return self }
        let phi = atan2(longest.by - longest.ay, longest.bx - longest.ax)
        let base = rotated(.pi / 2 - phi)
        var best = (plan: base, seen: base.windowsOnBackWalls)
        for k in 1..<4 {
            let turned = base.rotated(Double(k) * .pi / 2)
            if turned.windowsOnBackWalls > best.seen { best = (turned, turned.windowsOnBackWalls) }
        }
        return best.plan
    }

    /// Windows lying on the walls at x = 0 or y = 0 (the ones the 3D view draws).
    var windowsOnBackWalls: Int { openings.filter { !$0.isDoor && onBackWall($0) }.count }

    func onBackWall(_ o: Opening) -> Bool {
        let tolerance = 0.3
        let onX = abs(o.segment.ax) < tolerance && abs(o.segment.bx) < tolerance
        let onY = abs(o.segment.ay) < tolerance && abs(o.segment.by) < tolerance
        return onX || onY
    }

    /// The room's overall size along x and along y, metres.
    var extent: (x: Double, y: Double) {
        let xs = walls.flatMap { [$0.ax, $0.bx] }, ys = walls.flatMap { [$0.ay, $0.by] }
        guard let x0 = xs.min(), let x1 = xs.max(), let y0 = ys.min(), let y1 = ys.max() else { return (0, 0) }
        return (x1 - x0, y1 - y0)
    }
}

/// Feet and inches as a homeowner says them: "14 ft 2 in".
enum FeetInches {
    static func text(metres: Double) -> String {
        let totalIn = Int((metres * 39.37007874).rounded())
        let ft = totalIn / 12, inch = totalIn % 12
        return inch == 0 ? "\(ft) ft" : "\(ft) ft \(inch) in"
    }
}
