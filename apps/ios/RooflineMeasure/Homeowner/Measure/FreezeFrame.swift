import CoreGraphics
import RooflineCore
import UIKit

// The pieces of the frozen-photo measuring screen that are not drawing: what the corners on the photo come to (one `FrozenResult`, one
// set of numbers for the plates, the status and what is sent), the corners the phone starts from, and snapping a corner onto the frame's
// corner in the picture. All of it is plain values and CoreGraphics, so it is tested without a camera.

/// What the four corners on the photo come to, with the photos taken before this one in the same window. Made once per change.
struct FreezeEditing {
    /// Where the editor is in finding the window.
    enum Stage: Equatable {
        /// Vision is looking.
        case looking
        /// Vision found nothing believable: the corners start inset and the person drags them.
        case notFound
        /// The corners are the ones the phone found and the person has not touched them.
        case proposed
        case editing
    }

    /// This photo's own answer.
    let current: FrozenResult?
    /// The answer that is shown, drawn and sent: this photo's alone, or the median with the earlier photos.
    let combined: FrozenMeasure.Combined?
    /// The shown window on this photo (its pixels).
    let drawing: FrozenDrawing?
    /// Photos so far, this one included.
    let photos: Int

    init(capture: FrozenCapture, earlier: [FrozenResult], points: [CGPoint]) {
        photos = earlier.count + 1
        let px = points.map { Vec2(Double($0.x), Double($0.y)) }
        guard px.count == 4, let now = FrozenMeasure.measure(view: capture.view, photoPx: px) else {
            current = nil
            combined = nil
            drawing = nil
            return
        }
        current = now
        let c = FrozenMeasure.combine(earlier + [now], viewer: capture.view.viewer, device: capture.view.device)
            ?? FrozenMeasure.Combined(result: now, photos: 1, disagreeIn: 0, disagrees: false)
        combined = c
        drawing = FrozenMeasure.drawing(c.result, view: capture.view)
    }

    /// The straightened outline on the photo.
    var outline: [CGPoint] { drawing?.outline.map { CGPoint(x: $0.x, y: $0.y) } ?? [] }

    /// The width plate on the top side and the height plate on the left side, drawn just inside the outline so they never leave the
    /// photo or sit on a corner. Both show the SAME numbers as `widthText` and `heightText`.
    var plates: [PhotoTapView.Plate] {
        guard let d = drawing, let r = combined?.result else { return [] }
        return [
            PhotoTapView.Plate(id: "width", point: CGPoint(x: d.widthPlate.x, y: d.widthPlate.y), inches: r.widthIn, offset: CGSize(width: 0, height: 26)),
            PhotoTapView.Plate(id: "height", point: CGPoint(x: d.heightPlate.x, y: d.heightPlate.y), inches: r.heightIn, offset: CGSize(width: 50, height: 0)),
        ]
    }

    var widthText: String? { combined?.result.widthText }
    var heightText: String? { combined?.result.heightText }
    var widthIn: Double? { combined?.result.widthIn }
    var heightIn: Double? { combined?.result.heightIn }
    /// The corner (index into the dots, 0 to 3) that clearly looks off the frame in this photo.
    var flaggedHandle: Int? { current?.flaggedHandle }
    var needsCheck: Bool { combined?.result.needsCheck ?? false }
    var canUse: Bool { combined != nil }

    /// The one line under the picture.
    func hint(_ stage: Stage) -> String {
        switch stage {
        case .looking: return FrozenCopy.looking
        case .notFound: return FrozenCopy.notFound
        default: break
        }
        guard let c = combined, let now = current else { return FrozenCopy.notMeasurable }
        if c.disagrees { return FrozenCopy.photosDisagree(inches: c.disagreeIn) }
        if stage == .proposed, now.hint == FrozenCopy.looksRight { return FrozenCopy.foundWindow }
        return now.hint
    }
}

enum FreezeProposal {
    /// The four corners to start from, TL, TR, BR, BL in the photo's pixels: the window Vision finds in the photo, each corner moved onto
    /// the frame's corner in the picture when the picture is clear about it. Nil when nothing believable is found (not a window shape,
    /// or not one on this wall: its sides on the wall must be a window's). Blocking: call it off the main thread.
    static func corners(in image: CGImage, view: FrozenView) -> [CGPoint]? {
        guard let found = WindowRectangleDetector.window(in: image), found.count == 4 else { return nil }
        guard let w = view.worldCorners(photoPx: found), ArAutoCorners.isPlausibleWindow(w.points) else { return nil }
        return found.map { v in
            let p = CGPoint(x: v.x, y: v.y)
            return PhotoSnap.snap(p, in: image) ?? p
        }
    }

    /// Where the corners start when nothing was found: the photo inset on every side.
    static func inset(width: Int, height: Int) -> [CGPoint] {
        ImageMapping.insetCorners(width: Double(width), height: Double(height)).map { CGPoint(x: $0.x, y: $0.y) }
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
        let w = x1 - x0, h = y1 - y0
        guard w >= 24, h >= 24, let crop = image.cropping(to: CGRect(x: x0, y: y0, width: w, height: h)),
              let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w, space: CGColorSpaceCreateDeviceGray(),
                                  bitmapInfo: CGImageAlphaInfo.none.rawValue), let data = ctx.data else { return nil }
        ctx.interpolationQuality = .none
        ctx.draw(crop, in: CGRect(x: 0, y: 0, width: w, height: h))
        let pixels = [UInt8](UnsafeBufferPointer(start: data.assumingMemoryBound(to: UInt8.self), count: w * h))
        return (GrayPatch(width: w, height: h, pixels: pixels), (x0, y0))
    }
}
