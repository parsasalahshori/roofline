import Foundation

// One answer for one frozen photo. The four corners the person left on the photo become four points on the wall (`FrozenView`), then
// the same finishing every window gets (`CornerCapture.finish`: ordered by gravity, fitted to a level rectangle), then the server's own
// sizing (`sizeFromArPoints`) of that rectangle. EVERYTHING the screen says (the plates on the outline, the size in the status card, the
// size in the label sheet) and everything that is sent comes from this one `FrozenResult`, so two numbers for the same side cannot happen.

public struct FrozenResult: Equatable, Sendable {
    /// The four points exactly where the corners were left (on the frame's plane), in the order the screen holds them.
    public var handlePointsM: [Vec3]
    /// The finished window: ordered, with the rectangle fitted to it (see `RectangleFit`).
    public var finished: FinishedCorners
    /// The size of the rectangle that is drawn and sent: the number every label shows.
    public var size: ArSize
    /// How far the camera was from the window, metres (zero when unknown).
    public var distanceM: Double

    public var widthIn: Double { size.widthIn }
    public var heightIn: Double { size.heightIn }
    public var widthText: String { Eighths.format(widthIn) }
    public var heightText: String { Eighths.format(heightIn) }

    /// What is drawn, sent and sized: the fitted rectangle (TL, TR, BR, BL), never the corners as placed.
    public var windowPointsM: [Vec3] { finished.windowPointsM }
    /// The spreads that go with `windowPointsM`.
    public var windowSpreadM: [Double] { finished.windowSpreadM }

    /// The corners as placed disagree with the rectangle.
    public var disagrees: Bool { finished.fit?.disagrees ?? false }
    /// The corner (index into `handlePointsM`) that clearly looks off the frame, or nil: not disagreeing, or no single corner to blame.
    public var flaggedHandle: Int? {
        guard let i = finished.flaggedCorner, finished.tapIndex.indices.contains(i) else { return nil }
        return finished.tapIndex[i]
    }

    /// The window is not an order-grade measure yet: the server's own check, or a corner that did not line up.
    public var needsCheck: Bool { size.quality == .check || windowSpreadM.contains { $0 >= FitLimits.checkSpreadM } }

    /// The one line under the picture.
    public var hint: String {
        if let h = flaggedHandle { return FrozenCopy.offCorner(handle: h) }
        if disagrees { return FrozenCopy.checkCorners }
        return FrozenCopy.looksRight
    }

    public init(handlePointsM: [Vec3], finished: FinishedCorners, size: ArSize, distanceM: Double) {
        self.handlePointsM = handlePointsM
        self.finished = finished
        self.size = size
        self.distanceM = distanceM
    }
}

public enum FrozenCopy {
    public static let cornerNames = ["top-left", "top-right", "bottom-right", "bottom-left"]
    public static let looksRight = "Check the yellow outline follows the frame, then tap Use this size."
    public static let checkCorners = "Check the corners. Drag each dot onto the corner of the frame."
    public static func offCorner(handle: Int) -> String { "Corner \(handle + 1) looks off the frame. Drag it onto the corner." }
    public static let notMeasurable = "These corners do not make a window on a wall. Drag them onto the frame."
    public static let looking = "Looking for your window..."
    public static let notFound = "We couldn't find the window on its own. Drag the four dots onto the corners of the frame."
    public static let foundWindow = "We found your window. Drag any dot that is off, then tap Use this size."
    /// Photos of one window that differ by more than the limit at some corner.
    public static func photosDisagree(inches: Double) -> String {
        "Your photos differ by \(Eighths.format(inches)) in. Check the corners, or take this photo again."
    }
}

/// Where the outline and its two plates go on the photo (its pixels), for a result.
public struct FrozenDrawing: Equatable, Sendable {
    /// The fitted rectangle, TL, TR, BR, BL.
    public var outline: [Vec2]
    /// Where the width plate sits (the middle of the top side) and the height plate (the middle of the left side).
    public var widthPlate: Vec2
    public var heightPlate: Vec2
}

public enum FrozenMeasure {
    /// The result for four corners on the photo (`photoPx`, any order). Nil when the corners do not make a window on this wall
    /// (a ray misses the wall, the corners are in a line, or there is no "up" in their plane).
    public static func measure(view: FrozenView, photoPx: [Vec2]) -> FrozenResult? {
        guard let w = view.worldCorners(photoPx: photoPx) else { return nil }
        let distance = Vec3.mean(w.points).map { $0.distance(to: view.viewer) } ?? 0
        return result(rawM: w.points, spreadM: w.spreadM, wall: w.plane, viewer: view.viewer, device: view.device, distanceM: distance)
    }

    /// The finished result for four points on a plane. The one place a `FrozenResult` is made.
    public static func result(rawM: [Vec3], spreadM: [Double], wall: Plane?, viewer: Vec3, device: ArDevice, distanceM: Double = 0) -> FrozenResult? {
        guard let finished = CornerCapture.finish(raw: rawM, spreadM: spreadM, wall: wall, viewer: viewer), finished.fit != nil,
              let size = sizeFromArPoints(finished.windowPointsM, device: device, cornerSpreadM: finished.windowSpreadM) else { return nil }
        return FrozenResult(handlePointsM: rawM, finished: finished, size: size, distanceM: distanceM)
    }

    /// The rectangle and its plates on the photo. Nil when a corner is behind the camera.
    public static func drawing(_ r: FrozenResult, view: FrozenView) -> FrozenDrawing? {
        let p = r.windowPointsM
        guard p.count == 4 else { return nil }
        let px = p.compactMap { view.photoPixel(ofWorld: $0) }
        guard px.count == 4 else { return nil }
        func mid(_ a: Vec2, _ b: Vec2) -> Vec2 { Vec2((a.x + b.x) / 2, (a.y + b.y) / 2) }
        return FrozenDrawing(outline: px, widthPlate: mid(px[0], px[1]), heightPlate: mid(px[0], px[3]))
    }

    // MARK: Several photos of one window

    /// Photos of one window taken from the same tracking session, combined.
    public struct Combined: Equatable, Sendable {
        public var result: FrozenResult
        public var photos: Int
        /// The furthest any photo's corner is from the combined one, inches.
        public var disagreeIn: Double
        /// The photos do not agree (see `maxDisagreeIn`): the window is marked 'check' and the person is told.
        public var disagrees: Bool

        public init(result: FrozenResult, photos: Int, disagreeIn: Double, disagrees: Bool) {
            self.result = result
            self.photos = photos
            self.disagreeIn = disagreeIn
            self.disagrees = disagrees
        }
    }

    /// Photos of one window may differ by this much, at any corner (inches), and still be taken as agreeing.
    public static let maxDisagreeIn = 0.75

    /// The window from several photos of it: each corner is the MEDIAN of that corner over the photos (the middle one of three; the mean
    /// of two), fitted to a rectangle again, so one bad photo cannot drag the answer. A corner's spread is at least how much the photos
    /// disagreed there. The photos must share a tracking session (one world): the caller starts again when tracking restarts.
    public static func combine(_ results: [FrozenResult], viewer: Vec3, device: ArDevice) -> Combined? {
        guard let first = results.first else { return nil }
        if results.count == 1 { return Combined(result: first, photos: 1, disagreeIn: 0, disagrees: false) }
        guard results.allSatisfy({ $0.windowPointsM.count == 4 }) else { return nil }
        var medians: [Vec3] = []
        var spreads: [Double] = []
        var worstIn = 0.0
        for i in 0..<4 {
            let ps = results.map { $0.windowPointsM[i] }
            guard let mx = median(ps.map { $0.x }), let my = median(ps.map { $0.y }), let mz = median(ps.map { $0.z }) else { return nil }
            let m = Vec3(mx, my, mz)
            medians.append(m)
            let off = ps.map { $0.distance(to: m) }
            worstIn = max(worstIn, (off.max() ?? 0) * inchesPerMetre)
            let own = results.map { $0.windowSpreadM[i] }.max() ?? 0
            let rms = (off.reduce(0) { $0 + $1 * $1 } / Double(max(off.count - 1, 1))).squareRoot()
            spreads.append(max(own, rms))
        }
        let wall = Plane.fit(medians)?.facing(viewer)
        guard let combined = result(rawM: medians, spreadM: spreads, wall: wall, viewer: viewer, device: device,
                                    distanceM: results.map { $0.distanceM }.max() ?? 0) else { return nil }
        let disagrees = worstIn > maxDisagreeIn
        // Photos that disagree are a window to check, whatever each looked like alone
        var out = combined
        if disagrees {
            out.finished.cornerSpreadM = out.finished.cornerSpreadM.map { max($0, FitLimits.checkSpreadM) }
            if let size = sizeFromArPoints(out.finished.windowPointsM, device: device, cornerSpreadM: out.finished.windowSpreadM) { out.size = size }
        }
        return Combined(result: out, photos: results.count, disagreeIn: worstIn, disagrees: disagrees)
    }
}
