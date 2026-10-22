import Foundation

// The window as a RECTANGLE the person edits. The four corner dots ARE the rectangle: it lives on the frame's plane as four edges (left,
// right, top, bottom, in metres along the plane's own right and up axes, level with gravity), its corners are projected onto the photo and
// drawn as the dots, and the outline goes exactly through them. Dragging a corner moves the two edges that meet there, so the corners next
// to it follow; dragging the middle handle of a side moves that one side. What is drawn is what is measured is what is sent: nothing is
// fitted, averaged or re-derived after the finger lets go (except the plane, see `rebased`).

public struct FrozenRect: Equatable, Sendable {
    /// The handles of the editor, in the order the screen holds them: the four corners TL, TR, BR, BL, then the middle of the top, right,
    /// bottom and left sides.
    public enum Handle: Int, CaseIterable, Sendable {
        case topLeft, topRight, bottomRight, bottomLeft, top, right, bottom, left

        public var isCorner: Bool { rawValue < 4 }
    }

    /// The frame's plane (turned toward the camera).
    public var plane: Plane
    /// The plane's axes: across (to the right, as the person sees it) and up (gravity's up inside the plane).
    public var rightAxis: Vec3
    public var upAxis: Vec3
    /// The edges, metres from `plane.point` along `rightAxis` (left, right) and `upAxis` (top, bottom).
    public var left: Double
    public var right: Double
    public var top: Double
    public var bottom: Double

    /// No side may be shorter than this (metres, 4 in): the handles never cross.
    public static let minSideM = 0.1

    /// Nil for a plane with no "up" in it (a floor, a skylight).
    public init?(plane: Plane, viewer: Vec3, left: Double, right: Double, top: Double, bottom: Double) {
        let p = plane.facing(viewer)
        let upIn = Vec3.up - p.normal * Vec3.up.dot(p.normal)
        guard let up = upIn.normalized, upIn.length > 0.25, [left, right, top, bottom].allSatisfy({ $0.isFinite }) else { return nil }
        self.plane = p
        self.upAxis = up
        self.rightAxis = up.cross(p.normal)
        self.left = min(left, right)
        self.right = max(left, right)
        self.top = max(top, bottom)
        self.bottom = min(top, bottom)
    }

    public var widthM: Double { right - left }
    public var heightM: Double { top - bottom }

    public func point(s: Double, t: Double) -> Vec3 { plane.point + rightAxis * s + upAxis * t }

    /// A world point as (s, t) on the plane (it is projected onto the plane first).
    public func coords(of p: Vec3) -> (s: Double, t: Double) {
        let d = p - plane.point
        return (d.dot(rightAxis), d.dot(upAxis))
    }

    /// TL, TR, BR, BL in the world.
    public var cornersM: [Vec3] { [point(s: left, t: top), point(s: right, t: top), point(s: right, t: bottom), point(s: left, t: bottom)] }

    /// The eight handles in the world: corners, then the middles of the top, right, bottom and left sides.
    public var handlesM: [Vec3] {
        let ms = (left + right) / 2, mt = (top + bottom) / 2
        return cornersM + [point(s: ms, t: top), point(s: right, t: mt), point(s: ms, t: bottom), point(s: left, t: mt)]
    }

    /// The rectangle through points on `plane` (any order, at least two distinct): the left side is the mean of the two leftmost, and so on.
    public static func bounding(of points: [Vec3], plane: Plane, viewer: Vec3) -> FrozenRect? {
        guard points.count >= 2, var r = FrozenRect(plane: plane, viewer: viewer, left: 0, right: 1, top: 1, bottom: 0) else { return nil }
        let c = points.map { r.coords(of: $0) }
        let ss = c.map { $0.s }.sorted(), ts = c.map { $0.t }.sorted()
        func mean2(_ v: ArraySlice<Double>) -> Double { v.reduce(0, +) / Double(max(v.count, 1)) }
        let k = min(2, ss.count)
        r.left = mean2(ss.prefix(k))
        r.right = mean2(ss.suffix(k))
        r.bottom = mean2(ts.prefix(k))
        r.top = mean2(ts.suffix(k))
        return r.right - r.left > 1e-4 && r.top - r.bottom > 1e-4 ? r : nil
    }

    // MARK: On the photo

    /// The eight handles on the photo (its pixels); nil when one is behind the camera.
    public func handlePhotoPoints(view: FrozenView) -> [Vec2]? {
        let px = handlesM.compactMap { view.photoPixel(ofWorld: $0) }
        return px.count == 8 ? px : nil
    }

    /// The point on the plane that a photo pixel looks at, as (s, t); nil when the ray never meets the plane.
    public func coords(ofPhoto p: Vec2, view: FrozenView) -> (s: Double, t: Double)? {
        guard let ray = ImageMapping.ray(throughNativePixel: view.nativePixel(fromPhoto: p), cameraTransform: view.cameraTransform, intrinsics: view.intrinsics),
              let hit = plane.intersect(rayOrigin: ray.origin, direction: ray.direction) else { return nil }
        return coords(of: hit)
    }

    /// The rectangle after a handle is dragged to a photo pixel: a corner moves its two edges onto where the pixel looks on the plane, a
    /// side handle moves its one edge. The sides never get shorter than `minSideM`. Unchanged when the pixel looks past the plane.
    public func moved(_ handle: Handle, toPhoto p: Vec2, view: FrozenView) -> FrozenRect {
        guard let c = coords(ofPhoto: p, view: view) else { return self }
        var r = self
        func setLeft() { r.left = min(c.s, r.right - Self.minSideM) }
        func setRight() { r.right = max(c.s, r.left + Self.minSideM) }
        func setTop() { r.top = max(c.t, r.bottom + Self.minSideM) }
        func setBottom() { r.bottom = min(c.t, r.top - Self.minSideM) }
        switch handle {
        case .topLeft: setLeft(); setTop()
        case .topRight: setRight(); setTop()
        case .bottomRight: setRight(); setBottom()
        case .bottomLeft: setLeft(); setBottom()
        case .top: setTop()
        case .right: setRight()
        case .bottom: setBottom()
        case .left: setLeft()
        }
        return r
    }

    /// The rectangle on a new plane: the same four corners as seen on the photo, looked at on `newPlane` (and fitted: a plane turned a
    /// little makes them a hair off a rectangle). Unchanged when a ray misses.
    public func onPlane(_ newPlane: Plane, view: FrozenView) -> FrozenRect {
        guard let px = handlePhotoPoints(view: view)?.prefix(4), px.count == 4,
              let moved = FrozenRect(plane: newPlane, viewer: view.viewer, left: 0, right: 1, top: 1, bottom: 0) else { return self }
        var hits: [Vec3] = []
        for p in px {
            guard let ray = ImageMapping.ray(throughNativePixel: view.nativePixel(fromPhoto: p), cameraTransform: view.cameraTransform, intrinsics: view.intrinsics),
                  let hit = moved.plane.intersect(rayOrigin: ray.origin, direction: ray.direction) else { return self }
            hits.append(hit)
        }
        return Self.bounding(of: hits, plane: moved.plane, viewer: view.viewer) ?? self
    }

    /// A plane moved less than this (metres) or turned less than this (degrees) is the same plane: the corners do not jump for nothing.
    public static let planeChangeM = 0.003
    public static let planeChangeDeg = 0.3

    /// After the corners have been moved, the depth round them says more exactly where the frame's face is: the plane is looked for again
    /// at the four corners, and the rectangle is kept on the new plane as seen in the photo. The corners move by a pixel or two at most; a
    /// plane that has not really changed leaves everything where it is.
    public func rebased(view: FrozenView) -> FrozenRect {
        guard let px = handlePhotoPoints(view: view)?.prefix(4), px.count == 4 else { return self }
        let fresh = view.framePlane(photoPx: Array(px)).facing(view.viewer)
        let moved = abs(fresh.signedDistance(plane.point)) > Self.planeChangeM
        let turned = acos(max(-1, min(1, fresh.normal.dot(plane.normal)))) * 180 / .pi > Self.planeChangeDeg
        guard moved || turned else { return self }
        return onPlane(fresh, view: view)
    }

    /// The rectangle through four corners on the photo (any order), on the frame's plane found at them. Nil when a ray misses the plane.
    public static func fromPhoto(corners: [Vec2], view: FrozenView) -> FrozenRect? {
        guard let w = view.worldCorners(photoPx: corners) else { return nil }
        return bounding(of: w.points, plane: w.plane, viewer: view.viewer)
    }
}
