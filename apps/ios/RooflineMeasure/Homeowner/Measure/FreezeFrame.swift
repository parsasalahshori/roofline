import CoreGraphics
import RooflineCore
import UIKit

// The pieces of the frozen-photo measuring screen that are not drawing: the window as a rectangle on the frame's plane (its corners ARE the
// dots), what it measures, where the phone starts it from (the depth sensor first, Vision second), and snapping a dragged corner onto the
// frame's corner in the picture. All of it is plain values and CoreGraphics, so it is tested without a camera.

/// The window's own frame found inside one opening: only good for that rectangle (a drag makes it stale, and it is dropped).
struct FreezeFrameFound: Equatable {
    let opening: FrozenRect
    let found: WindowFrameFinder.Found
}

/// What the rectangle on the photo comes to, with the photos taken before this one in the same window. Made once per change.
struct FreezeEditing {
    /// Where the editor is in finding the window.
    enum Stage: Equatable {
        /// Looking in the depth map and the photo.
        case looking
        /// The photo is with the AI window finder on the server: the rectangle starts inset and can be dragged meanwhile.
        case findingWindow
        /// Nothing believable was found: the rectangle starts inset and the person drags it.
        case notFound
        /// The rectangle is what the depth sensor found and the person has not touched it.
        case proposedByDepth
        /// The rectangle is what Vision found in the photo and the person has not touched it.
        case proposedByPhoto
        /// The rectangle is what the AI found (alone, or the same window as the depth sensor's) and the person has not touched it.
        case proposedByAI
        case editing
    }

    let rect: FrozenRect?
    /// This photo's rectangle, sized: what is drawn, shown and sent.
    let sent: FrozenResult?
    /// How the earlier photos of this window agree with this one (nil with no earlier photo).
    let agreement: FrozenMeasure.Combined?
    /// The eight handles on the photo (its pixels): the four corners TL, TR, BR, BL, then the middles of the top, right, bottom, left sides.
    let handles: [CGPoint]
    /// The rectangle on the photo (its pixels): exactly through the four corner handles.
    let drawing: FrozenDrawing?
    /// Photos so far, this one included.
    let photos: Int
    /// The window's own frame inside the rectangle (what it is, only when it was found for THIS rectangle) and its size.
    let windowOutline: [CGPoint]
    let windowSize: WindowFrameSize?

    init(capture: FrozenCapture, earlier: [FrozenResult], rect: FrozenRect?, frame: FreezeFrameFound? = nil) {
        self.rect = rect
        photos = earlier.count + 1
        guard let rect = rect, let now = FrozenMeasure.measure(rect: rect, view: capture.view) else {
            sent = nil
            agreement = nil
            handles = rect?.handlePhotoPoints(view: capture.view)?.map { CGPoint(x: $0.x, y: $0.y) } ?? []
            drawing = nil
            windowOutline = []
            windowSize = nil
            return
        }
        if let f = frame, f.opening == rect {
            let px = f.found.rect.cornersM.compactMap { capture.view.photoPixel(ofWorld: $0) }
            windowOutline = px.count == 4 ? px.map { CGPoint(x: $0.x, y: $0.y) } : []
            windowSize = windowOutline.isEmpty ? nil : f.found.size(inOpening: now)
        } else {
            windowOutline = []
            windowSize = nil
        }
        handles = rect.handlePhotoPoints(view: capture.view)?.map { CGPoint(x: $0.x, y: $0.y) } ?? []
        let agree = earlier.isEmpty ? nil : FrozenMeasure.combine(earlier + [now], viewer: capture.view.viewer, device: capture.view.device)
        agreement = agree
        // Photos that disagree are a window to check; the window is still this photo's rectangle, the one drawn
        let result = agree?.disagrees == true ? FrozenMeasure.withDoubt(now, device: capture.view.device) : now
        sent = result
        drawing = FrozenMeasure.drawing(result, view: capture.view)
    }

    /// The straightened outline on the photo.
    var outline: [CGPoint] { drawing?.outline.map { CGPoint(x: $0.x, y: $0.y) } ?? [] }

    /// The width plate on the top side and the height plate on the left side, drawn just inside the outline so they never leave the
    /// photo or sit on a corner. Both show the SAME numbers as `widthText` and `heightText`.
    var plates: [PhotoTapView.Plate] {
        guard let d = drawing, let r = sent else { return [] }
        return [
            PhotoTapView.Plate(id: "width", point: CGPoint(x: d.widthPlate.x, y: d.widthPlate.y), inches: r.widthIn, offset: CGSize(width: 0, height: 30)),
            PhotoTapView.Plate(id: "height", point: CGPoint(x: d.heightPlate.x, y: d.heightPlate.y), inches: r.heightIn, offset: CGSize(width: 52, height: 0)),
        ]
    }

    var widthText: String? { sent?.widthText }
    var heightText: String? { sent?.heightText }
    var widthIn: Double? { sent?.widthIn }
    var heightIn: Double? { sent?.heightIn }
    /// Only photos that do not agree make a check: a rectangle cannot disagree with itself.
    var needsCheck: Bool { sent?.needsCheck ?? false }
    var photosDisagree: Bool { agreement?.disagrees ?? false }
    var canUse: Bool { sent != nil }
    /// "Looks like a standard 24 × 36 window": a suggestion on the screen only; the measured size is what is sent and priced. A window's
    /// nominal size is its frame's, so it goes by the window's own size when that was found, else by the opening's.
    var standardSize: StandardWindowSize? {
        if let s = windowSize { return StandardWindowSizes.suggestion(widthIn: s.widthIn, heightIn: s.heightIn) }
        guard let w = sent?.widthIn, let h = sent?.heightIn else { return nil }
        return StandardWindowSizes.suggestion(widthIn: w, heightIn: h)
    }

    /// The one line under the picture.
    func hint(_ stage: Stage) -> String {
        switch stage {
        case .looking: return FrozenCopy.looking
        case .findingWindow: return FrozenCopy.findingWindow
        case .notFound: return FrozenCopy.notFound
        default: break
        }
        guard sent != nil else { return FrozenCopy.notMeasurable }
        if let a = agreement, a.disagrees { return FrozenCopy.photosDisagree(inches: a.disagreeIn) }
        switch stage {
        case .proposedByDepth: return FrozenCopy.foundByDepth
        case .proposedByPhoto, .proposedByAI: return FrozenCopy.foundWindow
        default: return FrozenCopy.editing
        }
    }
}

enum FreezeProposal {
    enum Source: Equatable {
        case depth
        case photo
    }

    /// The depth sensor's opening: where the wall isn't, around the middle of the picture, each side then set onto the edge in the photo.
    /// Nil without depth or when it shows no window. Blocking: call it off the main thread.
    static func depth(in image: CGImage, view: FrozenView) -> OpeningFinder.Found? {
        guard view.depth != nil else { return nil }
        return OpeningFinder.find(view: view, reticle: Vec2(view.photoWidthPx / 2, view.photoHeightPx / 2), photo: { x, y, w, h in PhotoSnap.gray(image, x: x, y: y, width: w, height: h) })
    }

    /// Vision's rectangle that holds the middle of the picture, when it is a whole window and not a sash (Vision cannot tell a sash from a
    /// window; the depth can), each corner set onto the frame's corner in the picture when that is clear. Blocking: call it off the main thread.
    static func vision(in image: CGImage, view: FrozenView) -> FrozenRect? {
        let reticle = Vec2(view.photoWidthPx / 2, view.photoHeightPx / 2)
        guard let quad = WindowRectangleDetector.window(in: image, aimedAt: reticle), quad.count == 4 else { return nil }
        let snapped = quad.map { v -> Vec2 in
            let p = CGPoint(x: v.x, y: v.y)
            return PhotoSnap.snap(p, in: image).map { Vec2(Double($0.x), Double($0.y)) } ?? v
        }
        guard let r = FrozenRect.fromPhoto(corners: snapped, view: view), OpeningFinder.isPlausible(r, fromDepth: false) else { return nil }
        return r
    }

    /// The window to start from, in the order of trust (`WindowProposal`): the AI's window (its quad when that fits well, else its box) with each
    /// side set onto the frame's edge in the photo; the depth sensor's opening when it is the same window; else the depth opening alone;
    /// else Vision. Nil when none finds one. Blocking: call it off the main thread.
    static func resolve(in image: CGImage, view: FrozenView, ai: WindowDetection?, depth: OpeningFinder.Found?) -> WindowProposal.Result? {
        WindowProposal.choose(view: view, ai: ai, depth: depth, photo: { x, y, w, h in PhotoSnap.gray(image, x: x, y: y, width: w, height: h) },
                              vision: { vision(in: image, view: view) })
    }

    /// The window to start from with no AI answer: the depth sensor's opening, else Vision's rectangle. Nil when neither finds one.
    /// Blocking: call it off the main thread.
    static func rect(in image: CGImage, view: FrozenView) -> (rect: FrozenRect, source: Source)? {
        if let found = depth(in: image, view: view) { return (found.rect, .depth) }
        return vision(in: image, view: view).map { ($0, .photo) }
    }

    /// Where the rectangle starts when nothing was found: the photo inset on every side.
    static func inset(view: FrozenView) -> FrozenRect? {
        let corners = ImageMapping.insetCorners(width: view.photoWidthPx, height: view.photoHeightPx)
        return FrozenRect.fromPhoto(corners: corners, view: view)
    }
}

enum PhotoSnap {
    /// Where a corner let go at `p` (photo pixels) should land: on the crossing of the strongest upright and level edges of the picture
    /// near it (`CornerSnap`), or nil when the picture is not clear about one within about 25 px of a 1440 px photo.
    static func snap(_ p: CGPoint, in image: CGImage) -> CGPoint? {
        let radius = CornerSnap.radius(forPhotoWidth: Double(image.width))
        guard let (patch, origin) = patch(around: p, half: CornerSnap.halfSize(forRadius: radius), in: image),
              let s = CornerSnap.snap(corner: Vec2(Double(p.x) - Double(origin.x), Double(p.y) - Double(origin.y)), in: patch, radius: radius) else { return nil }
        guard s.movedPx >= 0.25 else { return nil }
        return CGPoint(x: s.point.x + Double(origin.x), y: s.point.y + Double(origin.y))
    }

    /// A square of the photo in grey around `p`, cut at the photo's edges, and its top-left pixel in the photo.
    static func patch(around p: CGPoint, half: Int, in image: CGImage) -> (GrayPatch, origin: (x: Int, y: Int))? {
        let cx = Int(p.x.rounded()), cy = Int(p.y.rounded())
        let x0 = max(0, cx - half), y0 = max(0, cy - half)
        let x1 = min(image.width, cx + half + 1), y1 = min(image.height, cy + half + 1)
        guard x1 - x0 >= 24, y1 - y0 >= 24, let patch = gray(image, x: x0, y: y0, width: x1 - x0, height: y1 - y0) else { return nil }
        return (patch, (x0, y0))
    }

    /// The photo's pixels in a rectangle (already inside it) in grey.
    static func gray(_ image: CGImage, x: Int, y: Int, width w: Int, height h: Int) -> GrayPatch? {
        guard x >= 0, y >= 0, w > 0, h > 0, x + w <= image.width, y + h <= image.height,
              let crop = image.cropping(to: CGRect(x: x, y: y, width: w, height: h)),
              let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w, space: CGColorSpaceCreateDeviceGray(),
                                  bitmapInfo: CGImageAlphaInfo.none.rawValue), let data = ctx.data else { return nil }
        ctx.interpolationQuality = .none
        ctx.draw(crop, in: CGRect(x: 0, y: 0, width: w, height: h))
        return GrayPatch(width: w, height: h, pixels: [UInt8](UnsafeBufferPointer(start: data.assumingMemoryBound(to: UInt8.self), count: w * h)))
    }
}
