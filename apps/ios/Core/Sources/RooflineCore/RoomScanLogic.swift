import Foundation

// The pure side of the room scan (Apple's RoomPlan): how a window surface becomes a level rectangle with a size, what a scan
// that stopped early is worth, how long the quick scan must run, and the words the scan screens use. No RoomPlan types, so
// every rule here is checked on a Mac; the app turns a `CapturedRoom.Surface` into a `ScanSurface` and back.

/// How a room scan is run: the whole room, or the quick "one wall" scan (point at the wall with the window, pan, tap Done).
public enum RoomScanMode: String, Sendable, Equatable {
    case wholeRoom, oneWall
}

/// A window surface as RoomPlan reports it, as plain numbers.
public struct ScanSurface: Equatable, Sendable {
    /// `dimensions.x` and `.y`, metres.
    public var widthM: Double
    public var heightM: Double
    /// The surface's centre and axes in the scan's world (local x along the wall, y up, z out of the wall).
    public var transform: Mat4
    /// `polygonCorners` (iOS 17), when RoomPlan gave any.
    public var polygon: [Vec3]
    public var confidence: RoomPlanConfidence

    public init(widthM: Double, heightM: Double, transform: Mat4, polygon: [Vec3] = [], confidence: RoomPlanConfidence) {
        self.widthM = widthM
        self.heightM = heightM
        self.transform = transform
        self.polygon = polygon
        self.confidence = confidence
    }
}

/// The window the scan found, as one level rectangle: what is drawn, shown and sent are all this.
public struct ScanWindowShape: Equatable, Sendable {
    /// Where the size came from.
    public enum Basis: String, Sendable {
        /// RoomPlan's `dimensions`.
        case dimensions
        /// The four `polygonCorners`, which formed a sensible rectangle that agrees with `dimensions`.
        case outline
    }

    public var widthM: Double
    public var heightM: Double
    public var basis: Basis
    /// The centre in the scan's world.
    public var centre: Vec3
    /// TL, TR, BR, BL in the scan's world: top and bottom level (with gravity), seen from the viewer when one was given.
    public var corners: [Vec3]
    /// RoomPlan's confidence, one step lower when its outline and its dimensions disagreed.
    public var confidence: RoomPlanConfidence
    /// The outline was a rectangle but not the size `dimensions` says: the polygon is set aside and the confidence lowered.
    public var outlineDisagreed: Bool

    public var widthIn: Double { widthM * inchesPerMetre }
    public var heightIn: Double { heightM * inchesPerMetre }
}

public enum RoomWindowShape {
    /// Nothing smaller than this is a window (a sensor glitch or a vent is).
    public static let minSideM = 0.1

    /// The outline's size may differ from `dimensions` by this much (the larger of 5 cm and 8%) before the two are said to disagree.
    public static func agreementM(_ side: Double) -> Double { max(0.05, 0.08 * side) }

    /// Each corner of a rectangle must be within this many degrees of square.
    public static let maxCornerOffDeg = 12.0

    /// Opposite sides of the outline must be within this share of each other.
    public static let maxSideDiff = 0.10

    /// The window as a level rectangle. Nil when its size is not believable (a side under 10 cm, or not finite).
    public static func resolve(_ s: ScanSurface, viewer: Vec3? = nil) -> ScanWindowShape? {
        guard s.widthM.isFinite, s.heightM.isFinite, s.widthM >= minSideM, s.heightM >= minSideM else { return nil }
        var w = s.widthM, h = s.heightM
        var centreOffset = Vec2(0, 0)
        var basis = ScanWindowShape.Basis.dimensions
        var confidence = s.confidence
        var disagreed = false
        if let quad = outlineRectangle(s) {
            if abs(quad.widthM - s.widthM) <= agreementM(s.widthM), abs(quad.heightM - s.heightM) <= agreementM(s.heightM) {
                w = quad.widthM
                h = quad.heightM
                centreOffset = quad.centre
                basis = .outline
            } else {
                disagreed = true
                confidence = lowered(confidence)
            }
        }
        let centre = s.transform.transform(Vec3(centreOffset.x, centreOffset.y, 0))
        let raw = levelCorners(centre: centre, transform: s.transform, widthM: w, heightM: h)
        let corners = gravityOrderedCorners(raw, viewer: viewer) ?? raw
        return ScanWindowShape(widthM: w, heightM: h, basis: basis, centre: centre, corners: corners, confidence: confidence, outlineDisagreed: disagreed)
    }

    /// One step less sure.
    public static func lowered(_ c: RoomPlanConfidence) -> RoomPlanConfidence {
        switch c {
        case .high: return .medium
        case .medium, .low: return .low
        }
    }

    // MARK: Level corners

    /// The rectangle's four corners with the top and bottom edges level: the wall's horizontal runs along the width and its
    /// up (gravity, inside the wall) along the height. A surface that lies flat (no wall to be level on) keeps its own axes.
    public static func levelCorners(centre: Vec3, transform: Mat4, widthM: Double, heightM: Double) -> [Vec3] {
        let n = transform.column(2).normalized ?? Vec3(0, 0, 1)
        var along = transform.column(0).normalized ?? Vec3(1, 0, 0)
        var up = transform.column(1).normalized ?? Vec3.up
        if abs(n.dot(Vec3.up)) < 0.9, let u = Vec3.up.cross(n).normalized {
            // up x n runs along the wall; it is turned to the same side as the surface's own x axis
            along = u.dot(along) < 0 ? -u : u
            up = n.cross(along).normalized ?? up
        }
        let hw = widthM / 2, hh = heightM / 2
        return [
            centre - along * hw + up * hh, centre + along * hw + up * hh,
            centre + along * hw - up * hh, centre - along * hw - up * hh,
        ]
    }

    // MARK: The outline (polygonCorners)

    /// A sensible rectangle read from `polygonCorners`, in the surface's own frame (x along the width, y up).
    public struct Outline: Equatable, Sendable {
        public var widthM: Double
        public var heightM: Double
        /// Its middle, relative to the surface's centre.
        public var centre: Vec2
    }

    /// The outline when it is four corners that make a rectangle (square corners, opposite sides alike, no side under 10 cm).
    /// Nil when there are none, or they are some other shape: then `dimensions` is the answer.
    public static func outlineRectangle(_ s: ScanSurface) -> Outline? {
        guard let local = outlineInSurfaceFrame(s.polygon, transform: s.transform, widthM: s.widthM, heightM: s.heightM) else { return nil }
        return rectangle(of: local)
    }

    /// The outline's corners in the surface's frame, whichever frame RoomPlan gave them in: its own (relative to the centre) or the
    /// scan's world. Whichever one puts every corner on the window (within 15% of its size, and flat) is taken; nil when neither does.
    /// ON DEVICE: confirm which frame iOS 17 uses; both are read the same way.
    public static func outlineInSurfaceFrame(_ polygon: [Vec3], transform: Mat4, widthM: Double, heightM: Double) -> [Vec2]? {
        guard polygon.count >= 4, polygon.allSatisfy({ $0.isFinite }) else { return nil }
        let slack = max(0.05, 0.15 * max(widthM, heightM))
        func fits(_ ps: [Vec3]) -> Bool {
            ps.allSatisfy { abs($0.x) <= widthM / 2 + slack && abs($0.y) <= heightM / 2 + slack && abs($0.z) <= 0.1 }
        }
        if fits(polygon) { return polygon.map { Vec2($0.x, $0.y) } }
        let inverse = transform.inverseRigid
        let worldToLocal = polygon.map { inverse.transform($0) }
        if fits(worldToLocal) { return worldToLocal.map { Vec2($0.x, $0.y) } }
        return nil
    }

    private static func rectangle(of raw: [Vec2]) -> Outline? {
        // A closed outline repeats its first corner: that is still four
        var pts: [Vec2] = []
        for p in raw where !pts.contains(where: { hypot($0.x - p.x, $0.y - p.y) < 1e-3 }) { pts.append(p) }
        guard pts.count == 4 else { return nil }
        // Top two (highest y) left to right, then bottom two
        let byHeight = pts.sorted { $0.y > $1.y }
        let top = [byHeight[0], byHeight[1]].sorted { $0.x < $1.x }
        let bottom = [byHeight[2], byHeight[3]].sorted { $0.x < $1.x }
        let ring = [top[0], top[1], bottom[1], bottom[0]]
        func len(_ a: Vec2, _ b: Vec2) -> Double { hypot(a.x - b.x, a.y - b.y) }
        let sides = (0..<4).map { len(ring[$0], ring[($0 + 1) % 4]) }
        guard sides.allSatisfy({ $0 >= minSideM }) else { return nil }
        // Square corners and no bow-tie: every turn the same way, every corner near 90 degrees
        var turns: [Double] = []
        for i in 0..<4 {
            let a = ring[i], b = ring[(i + 1) % 4], c = ring[(i + 2) % 4]
            let abx = b.x - a.x, aby = b.y - a.y, bcx = c.x - b.x, bcy = c.y - b.y
            let cross = abx * bcy - aby * bcx
            let cosv = (abx * bcx + aby * bcy) / (len(a, b) * len(b, c))
            let angle = acos(max(-1, min(1, cosv))) * 180 / .pi
            guard abs(angle - 90) <= maxCornerOffDeg else { return nil }
            turns.append(cross)
        }
        guard turns.allSatisfy({ $0 > 0 }) || turns.allSatisfy({ $0 < 0 }) else { return nil }
        let topLen = sides[0], rightLen = sides[1], bottomLen = sides[2], leftLen = sides[3]
        guard abs(topLen - bottomLen) / max(topLen, bottomLen) <= maxSideDiff, abs(leftLen - rightLen) / max(leftLen, rightLen) <= maxSideDiff else { return nil }
        let cx = pts.map { $0.x }.reduce(0, +) / 4, cy = pts.map { $0.y }.reduce(0, +) / 4
        return Outline(widthM: (topLen + bottomLen) / 2, heightM: (leftLen + rightLen) / 2, centre: Vec2(cx, cy))
    }
}

// MARK: - How a scan ends

/// What to do with a scan that has stopped.
public enum ScanOutcome: Equatable, Sendable {
    /// Go to the review. `fromLive`: the windows are the ones seen while scanning, because the finished room had none or could not be built.
    case review(fromLive: Bool)
    /// The scan worked but there is no window in it: say so kindly and offer the photo method.
    case noWindows
    /// The scan broke.
    case failed
}

public enum ScanFinish {
    /// - `finalWindowCount`: the windows in the room RoomPlan built when the scan stopped; nil when it could not build one.
    /// - `liveWindowCount`: the windows RoomPlan showed while scanning.
    /// - `tooLittle`: the build said it was given too little to go on (a very short scan).
    public static func decide(mode: RoomScanMode, finalWindowCount: Int?, liveWindowCount: Int, tooLittle: Bool = false) -> ScanOutcome {
        if let n = finalWindowCount, n > 0 { return .review(fromLive: false) }
        // Whatever the finished room says, a window RoomPlan showed while scanning beats an empty list
        if liveWindowCount > 0 { return .review(fromLive: true) }
        if finalWindowCount != nil { return .noWindows }
        // The build failed. A short scan of one wall that saw no window is just "no window", not a broken scan
        if mode == .oneWall, tooLittle { return .noWindows }
        return .failed
    }
}

/// How the scan screen behaves while scanning.
public struct ScanProgress: Equatable, Sendable {
    public var mode: RoomScanMode
    public var seconds: Double
    public var windowsFound: Int

    public init(mode: RoomScanMode, seconds: Double = 0, windowsFound: Int = 0) {
        self.mode = mode
        self.seconds = seconds
        self.windowsFound = windowsFound
    }

    /// The quick scan needs a few seconds of looking before "Done" does anything (a tap at once would build nothing); the
    /// whole-room scan has always let the person stop whenever they like.
    public static let quickScanMinSeconds = 3.0

    public var canFinish: Bool { mode == .wholeRoom || seconds >= Self.quickScanMinSeconds }

    public var doneTitle: String { canFinish ? "Done scanning" : "Keep panning…" }

    /// The line over the camera.
    public var hint: String {
        switch mode {
        case .wholeRoom:
            return "Walk slowly around the room. Keep every window in view."
        case .oneWall:
            if windowsFound > 0 { return "Got it. Tap Done, or pan on to catch more." }
            return canFinish ? "Keep panning slowly until the window shows up." : "Point at the wall with the window. Pan slowly."
        }
    }

    /// "2 windows found".
    public var found: String { ScanWording.found(windowsFound) }
}

// MARK: - Words

public enum ScanWording {
    /// "No windows yet", "1 window found", "2 windows found".
    public static func found(_ n: Int) -> String {
        switch n {
        case ...0: return "No windows yet"
        case 1: return "1 window found"
        default: return "\(n) windows found"
        }
    }

    /// RoomPlan's confidence in plain words: it says how sure Apple is, not how many inches.
    public static func confidence(_ c: RoomPlanConfidence) -> String {
        switch c {
        case .high: return "fairly sure"
        case .medium: return "not fully sure"
        case .low: return "not sure"
        }
    }

    /// "Apple's scan · fairly sure": the line under a window's size.
    public static func sourceLine(_ c: RoomPlanConfidence) -> String { "Apple's scan · \(confidence(c))" }

    /// Said once, under the list: the scan is a quote-grade size.
    public static let confirmLine = "Apple's scan. We confirm every size at your visit."

    /// "We found 2 windows", "We found 1 window", "We didn't find a window".
    public static func foundTitle(_ n: Int) -> String {
        n <= 0 ? "We didn't find a window" : "We found \(n) window\(n == 1 ? "" : "s")"
    }

    /// The window's letter for a list: A, B, C … (after Z it starts again).
    public static func letter(_ index: Int) -> String {
        String(UnicodeScalar(UInt8(65 + ((index % 26) + 26) % 26)))
    }
}
