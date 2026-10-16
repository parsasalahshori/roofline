import Foundation

/// The live "Width / Height" in the measuring screen (07): from the corners placed so far and where the crosshair is.
/// Corners are tapped in any order, so an edge is a WIDTH when it runs more across than up (by gravity: world +Y is up)
/// and a HEIGHT otherwise; the first of each kind is shown. With all four corners placed the finished size takes over
/// (the same math the server runs), so the numbers never jump at the end.
public struct LiveReadout: Equatable, Sendable {
    public var widthIn: Double?
    public var heightIn: Double?
    /// Corners placed, 0 to 4.
    public var placed: Int

    public init(widthIn: Double? = nil, heightIn: Double? = nil, placed: Int = 0) {
        self.widthIn = widthIn
        self.heightIn = heightIn
        self.placed = placed
    }

    /// `corners`: the placed corners in tap order, world metres. `aim`: where the crosshair meets the wall (the live edge).
    public static func from(corners: [Vec3], aim: Vec3?, device: ArDevice? = nil) -> LiveReadout {
        let n = min(corners.count, 4)
        if n == 4, let size = sizeFromArPoints(Array(corners.prefix(4)), device: device) {
            return LiveReadout(widthIn: size.widthIn, heightIn: size.heightIn, placed: 4)
        }
        var edges: [(Vec3, Vec3)] = []
        if n >= 2 { for i in 1..<n { edges.append((corners[i - 1], corners[i])) } }
        if n == 4 { edges.append((corners[3], corners[0])) }
        if n >= 1, n < 4, let a = aim { edges.append((corners[n - 1], a)) }
        var width: Double?
        var height: Double?
        for (a, b) in edges {
            let d = b - a
            let across = (d.x * d.x + d.z * d.z).squareRoot()
            let inches = d.length * inchesPerMetre
            if abs(d.y) > across {
                if height == nil { height = inches }
            } else if width == nil {
                width = inches
            }
        }
        return LiveReadout(widthIn: width, heightIn: height, placed: n)
    }
}
