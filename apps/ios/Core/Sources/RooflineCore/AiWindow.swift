import Foundation

// The AI window finder's answer, and what the phone does with it. The server (OWLv2, then SAM 2, on the company's own machine) is sent the
// frozen photo and says where windows are in it, as boxes (fractions of the photo's width and height) and, for the window the person
// aimed at, a QUAD: the four corners of the window cut out of the photo, with how good the fit is. Neither is a measurement: it is where to
// START the rectangle. The phone takes the quad when it is a good fit (else the box the person aimed at, the photo's middle), turns its
// four corners into a level rectangle on the frame's plane, and sets each side onto the real frame line in the photo (a wider search than
// the depth path, since a box or a mask is rougher). Order of trust: the AI quad or box; the depth sensor's opening only when it agrees with
// it (it is then the better measured of the two); Vision only when neither exists. Plain values and maths, checked on a Mac.

/// One window the detector saw, in fractions (0 ... 1) of the photo from its top-left, with the model's own score (low in absolute terms:
/// a clear window is 0.25 to 0.5; only compared between boxes of one photo).
public struct DetectedBox: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var w: Double
    public var h: Double
    public var confidence: Double

    public init(x: Double, y: Double, w: Double, h: Double, confidence: Double) {
        self.x = x
        self.y = y
        self.w = w
        self.h = h
        self.confidence = confidence
    }

    public var area: Double { w * h }

    public func contains(_ p: Vec2) -> Bool { p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h }

    /// A box with real numbers, a size of at least `AiWindow.minSide` and inside the photo (a little slack for rounding).
    public var isUsable: Bool {
        [x, y, w, h, confidence].allSatisfy { $0.isFinite } && w >= AiWindow.minSide && h >= AiWindow.minSide && x >= -0.01 && y >= -0.01 && x + w <= 1.01 && y + h <= 1.01
    }

    /// The box's corners TL, TR, BR, BL in the photo's pixels.
    public func corners(photoWidthPx: Double, photoHeightPx: Double) -> [Vec2] {
        [Vec2(x * photoWidthPx, y * photoHeightPx), Vec2((x + w) * photoWidthPx, y * photoHeightPx),
         Vec2((x + w) * photoWidthPx, (y + h) * photoHeightPx), Vec2(x * photoWidthPx, (y + h) * photoHeightPx)]
    }
}

/// The window's four corners the server cut out of the photo (SAM 2) and fitted with straight lines: fractions of the photo from its
/// top-left, TL, TR, BR, BL, and how good the fit is.
public struct DetectedQuad: Codable, Equatable, Sendable {
    public var corners: [[Double]]
    /// 0 ... 1: how much of the quad the mask fills, how smooth its contour is round the lines, how much of each side it runs along.
    public var quality: Double
    public var fill: Double?
    public var residual: Double?
    public var maskScore: Double?

    public init(corners: [[Double]], quality: Double, fill: Double? = nil, residual: Double? = nil, maskScore: Double? = nil) {
        self.corners = corners
        self.quality = quality
        self.fill = fill
        self.residual = residual
        self.maskScore = maskScore
    }

    /// The corners in the photo's pixels, TL, TR, BR, BL; nil unless there are four finite points inside the photo.
    public func photoCorners(photoWidthPx: Double, photoHeightPx: Double) -> [Vec2]? {
        guard corners.count == 4, corners.allSatisfy({ $0.count == 2 && $0[0].isFinite && $0[1].isFinite && $0[0] >= -0.01 && $0[0] <= 1.01 && $0[1] >= -0.01 && $0[1] <= 1.01 }) else { return nil }
        return corners.map { Vec2($0[0] * photoWidthPx, $0[1] * photoHeightPx) }
    }
}

/// POST /requests/:id/detect-windows, as much of it as the phone uses. Everything but `boxes` may be missing: a server that does not
/// cut windows out (WINDOW_SEGMENTER off) has no `quad`.
public struct WindowDetection: Codable, Equatable, Sendable {
    public var boxes: [DetectedBox]
    /// The box the server says the person aimed at (the phone picks its own the same way and does not need it).
    public var picked: DetectedBox?
    public var quad: DetectedQuad?
    /// The server's own time, milliseconds.
    public var ms: Int?

    public init(boxes: [DetectedBox], picked: DetectedBox? = nil, quad: DetectedQuad? = nil, ms: Int? = nil) {
        self.boxes = boxes
        self.picked = picked
        self.quad = quad
        self.ms = ms
    }

    private enum Keys: String, CodingKey { case boxes, picked, quad, ms }

    /// A part that is not in the shape the phone knows is left out, not a reason to drop the rest.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        boxes = (try? c.decode([DetectedBox].self, forKey: .boxes)) ?? []
        picked = try? c.decodeIfPresent(DetectedBox.self, forKey: .picked)
        quad = try? c.decodeIfPresent(DetectedQuad.self, forKey: .quad)
        ms = try? c.decodeIfPresent(Int.self, forKey: .ms)
    }
}

/// What the app asked the server and what came back, for the debug dump and the replay.
public struct AiAttempt: Codable, Equatable, Sendable {
    /// ok, or why not: offline, off (503 detector_unavailable), failed, timeout, no-server, error.
    public var status: String
    public var detection: WindowDetection?
    /// The phone's own wait, milliseconds.
    public var ms: Int

    public init(status: String, detection: WindowDetection?, ms: Int) {
        self.status = status
        self.detection = detection
        self.ms = ms
    }
}

public enum AiWindow {
    /// A box shorter than this share of the photo on either side is not a window.
    public static let minSide = 0.05
    /// A box that scores at least this share of the best box that holds the middle of the photo may win by being larger (a window that holds
    /// its own sash: the sash's box is inside the window's).
    public static let nestedScoreShare = 0.7
    /// A box counts as the person's when it holds this point of the photo (the capture circle), as fractions.
    public static let aim = Vec2(0.5, 0.5)
    /// The depth sensor's opening and the AI box are the same window when their outlines on the photo overlap by more than this (IoU).
    public static let agreeIoU = 0.6
    /// The quad is used as the start only when its fit is at least this good (the server's `quality`); below that the box is.
    public static let minQuadQuality = 0.7
    /// The AI box is rough: each side is set onto an edge in the photo within this distance (metres), up to this many photo pixels.
    public static let refineRadiusM = 0.06
    public static let refineMaxRadiusPx = 140.0

    /// The window the person aimed at: among the boxes that hold `aim`, the one with the best score; when boxes nest, the LARGEST that holds
    /// `aim` and scores at least `nestedScoreShare` of that best one. Nil when no box holds the aim.
    public static func pick(_ boxes: [DetectedBox], aim: Vec2 = AiWindow.aim) -> DetectedBox? {
        let held = boxes.filter { $0.isUsable && $0.contains(aim) }
        guard let best = held.map({ $0.confidence }).max() else { return nil }
        return held.filter { $0.confidence >= best * nestedScoreShare }.max { $0.area < $1.area }
    }

    /// The level rectangle a box starts: its four corners looked at on the frame's plane (found by the depth round them, else the wall's).
    /// Nil when a corner's ray misses the plane or the rectangle is not a believable window.
    public static func rect(from box: DetectedBox, view: FrozenView) -> FrozenRect? {
        guard let r = FrozenRect.fromPhoto(corners: box.corners(photoWidthPx: view.photoWidthPx, photoHeightPx: view.photoHeightPx), view: view),
              OpeningFinder.isPlausible(r, fromDepth: false) else { return nil }
        return r
    }

    /// The level rectangle a quad starts: its four corners looked at on the frame's plane. Nil when its fit is not good enough, a corner's ray
    /// misses the plane or the rectangle is not a believable window.
    public static func rect(from quad: DetectedQuad, view: FrozenView) -> FrozenRect? {
        guard quad.quality >= minQuadQuality, let corners = quad.photoCorners(photoWidthPx: view.photoWidthPx, photoHeightPx: view.photoHeightPx),
              let r = FrozenRect.fromPhoto(corners: corners, view: view), OpeningFinder.isPlausible(r, fromDepth: false) else { return nil }
        return r
    }

    /// The middle of a quad as fractions of the photo; nil when it has no four corners.
    public static func centre(of quad: DetectedQuad) -> Vec2? {
        guard quad.corners.count == 4, quad.corners.allSatisfy({ $0.count == 2 }) else { return nil }
        return Vec2(quad.corners.map { $0[0] }.reduce(0, +) / 4, quad.corners.map { $0[1] }.reduce(0, +) / 4)
    }

    /// A rectangle's outline on the photo as its bounding box (x0, y0, x1, y1), pixels; nil when a corner is behind the camera.
    public static func photoBounds(_ r: FrozenRect, view: FrozenView) -> (x0: Double, y0: Double, x1: Double, y1: Double)? {
        let px = r.cornersM.compactMap { view.photoPixel(ofWorld: $0) }
        guard px.count == 4 else { return nil }
        return (px.map { $0.x }.min()!, px.map { $0.y }.min()!, px.map { $0.x }.max()!, px.map { $0.y }.max()!)
    }

    /// How much two rectangles overlap on the photo: intersection over union of their outlines' bounding boxes. 0 when either is off the photo.
    public static func photoIoU(_ a: FrozenRect, _ b: FrozenRect, view: FrozenView) -> Double {
        guard let p = photoBounds(a, view: view), let q = photoBounds(b, view: view) else { return 0 }
        let w = min(p.x1, q.x1) - max(p.x0, q.x0), h = min(p.y1, q.y1) - max(p.y0, q.y0)
        guard w > 0, h > 0 else { return 0 }
        let inter = w * h
        let union = (p.x1 - p.x0) * (p.y1 - p.y0) + (q.x1 - q.x0) * (q.y1 - q.y0) - inter
        return union > 0 ? inter / union : 0
    }
}

/// Where the rectangle the editor starts from came from.
public enum ProposalSource: String, Codable, Equatable, Sendable {
    /// The AI's window quad (SAM 2), each side set onto the frame line in the photo.
    case aiQuad = "ai-quad"
    /// The AI's box (no good quad), each side set onto the frame line in the photo.
    case ai
    /// The AI's window and the depth sensor's opening agree: the depth sensor's (refined) rectangle.
    case aiDepth = "ai+depth"
    /// The depth sensor's opening alone (no AI box).
    case depth
    /// Apple Vision's rectangle alone (no AI box, no depth opening).
    case vision
    /// Nothing found: the rectangle starts inset.
    case none
}

public enum WindowProposal {
    public struct Result: Equatable, Sendable {
        public var rect: FrozenRect
        public var source: ProposalSource
        /// The box it came from (the AI sources only).
        public var box: DetectedBox?
        /// For left, right, top and bottom: the side was moved onto an edge in the photo.
        public var refined: [Bool]
    }

    /// The window to start from, in the order of trust (see the top of this file). `ai`: the server's answer (nil when it gave none).
    /// `depth`: what `OpeningFinder.find` made (already set onto the photo's edges). `vision`: asked only when there is neither an AI
    /// rectangle nor a depth opening. `photo` sets the AI rectangle's sides onto edges; without it, or where the picture is not clear, a
    /// side stays where the quad or box put it.
    public static func choose(view: FrozenView, ai: WindowDetection?, depth: OpeningFinder.Found?, photo: OpeningFinder.PatchSource?,
                              vision: () -> FrozenRect?) -> Result? {
        let box = ai.flatMap { AiWindow.pick($0.boxes) }
        // The quad when it fits well and sits on the box the person aimed at (or no box was found: the server only cuts out one it picked)
        var start: (rect: FrozenRect, source: ProposalSource)?
        if let quad = ai?.quad, let r = AiWindow.rect(from: quad, view: view), box == nil || AiWindow.centre(of: quad).map({ box!.contains($0) }) == true {
            start = (r, .aiQuad)
        } else if let box = box, let r = AiWindow.rect(from: box, view: view) {
            start = (r, .ai)
        }
        if let (raw, source) = start {
            // The depth sensor measures the edges better than a box: when it found the same window, it is the one used
            if let found = depth, AiWindow.photoIoU(found.rect, raw, view: view) > AiWindow.agreeIoU {
                return Result(rect: found.rect, source: .aiDepth, box: box, refined: found.refined)
            }
            guard let photo = photo else { return Result(rect: raw, source: source, box: box, refined: [false, false, false, false]) }
            let r = OpeningFinder.refineSides(raw, view: view, photo: photo, radiusM: AiWindow.refineRadiusM, maxRadiusPx: AiWindow.refineMaxRadiusPx)
            return Result(rect: r.rect.rebased(view: view), source: source, box: box, refined: r.refined)
        }
        if let found = depth { return Result(rect: found.rect, source: .depth, box: nil, refined: found.refined) }
        if let v = vision() { return Result(rect: v, source: .vision, box: nil, refined: [false, false, false, false]) }
        return nil
    }
}
