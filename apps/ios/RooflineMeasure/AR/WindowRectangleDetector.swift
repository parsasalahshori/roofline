import CoreGraphics
import CoreImage
import CoreVideo
import RooflineCore
import UIKit
import Vision

/// Apple Vision's rectangle finder, as the shapes `AutoCorners` chooses between. Vision does the looking; every decision (which shape
/// is the window, which is the card, whether it is believable) is `AutoCorners`, checked on a Mac. Apple frameworks only, on the
/// phone, no network.
///
/// Vision's rectangle detector is a little unsteady (the same picture can give a different set of shapes from one run to the next),
/// so the callers never trust one shape on its own: they show what it found for the person to drag into place.
enum WindowRectangleDetector {
    /// The longest side of the copy of a photo that Vision looks at: the finder does not need 12 megapixels to see a window frame.
    static let photoSide: CGFloat = 1600
    // MARK: A photo

    /// The window and the card in an upright photo, each only when found with good confidence, in the photo's own pixels. Blocking
    /// (tens of milliseconds): call it off the main thread.
    static func propose(in photo: CGImage) -> AutoCornerProposal {
        let width = photo.width, height = photo.height
        guard width > 0, height > 0 else { return AutoCornerProposal() }
        let k = min(1, photoSide / CGFloat(max(width, height)))
        let small = k < 1 ? scaled(photo, by: k) ?? photo : photo
        let sw = Double(small.width), sh = Double(small.height)
        let candidates = quads(in: small, requests: [makeRequest(minimumSize: 0.15, minimumAspect: 0.2), makeRequest(minimumSize: 0.015, minimumAspect: 0.4)])
        var proposal = AutoCorners.propose(candidates, imageWidth: sw, imageHeight: sh)
        // Back to the photo's pixels
        let back = Double(width) / sw
        func up(_ q: PickedQuad) -> PickedQuad { PickedQuad(corners: q.corners.map { Vec2($0.x * back, $0.y * back) }, confidence: q.confidence) }
        proposal.window = proposal.window.map(up)
        proposal.card = proposal.card.map(up)
        // The card is small: a second look at a full-size crop around it puts its corners to the pixel
        if let card = proposal.card, k < 1, let better = refinedCard(card, in: photo) { proposal.card = better }
        return proposal
    }

    /// Vision looks again at the photo's own pixels around the card (twice its size) and finds it more exactly.
    private static func refinedCard(_ card: PickedQuad, in photo: CGImage) -> PickedQuad? {
        let xs = card.corners.map { $0.x }, ys = card.corners.map { $0.y }
        guard let x0 = xs.min(), let x1 = xs.max(), let y0 = ys.min(), let y1 = ys.max() else { return nil }
        let padX = (x1 - x0) * 0.6, padY = (y1 - y0) * 0.6
        let bounds = CGRect(x: 0, y: 0, width: photo.width, height: photo.height)
        let region = CGRect(x: x0 - padX, y: y0 - padY, width: x1 - x0 + 2 * padX, height: y1 - y0 + 2 * padY).integral.intersection(bounds)
        guard region.width > 20, region.height > 20, let crop = photo.cropping(to: region) else { return nil }
        let found = quads(in: crop, requests: [makeRequest(minimumSize: 0.2, minimumAspect: 0.4)])
            .map { QuadCandidate(corners: $0.corners.map { Vec2($0.x + Double(region.minX), $0.y + Double(region.minY)) }, confidence: $0.confidence) }
        return AutoCorners.refineCard(first: card, candidates: found)
    }

    // MARK: A frozen frame

    /// The window frame in an upright photo (a frozen camera frame), TL, TR, BR, BL in the photo's own pixels, when one is believable;
    /// nil otherwise. The largest believable outline wins, the casing round a window is stepped past (`AutoCorners.pickWindow`). Blocking
    /// (tens of milliseconds): call it off the main thread.
    static func window(in photo: CGImage) -> [Vec2]? {
        let width = photo.width, height = photo.height
        guard width > 0, height > 0 else { return nil }
        let k = min(1, photoSide / CGFloat(max(width, height)))
        let small = k < 1 ? scaled(photo, by: k) ?? photo : photo
        let sw = Double(small.width), sh = Double(small.height)
        let candidates = quads(in: small, requests: [makeRequest(minimumSize: 0.15, minimumAspect: 0.2)])
        guard let picked = AutoCorners.pickWindow(candidates, imageWidth: sw, imageHeight: sh) else { return nil }
        let back = Double(width) / sw
        return picked.corners.map { Vec2($0.x * back, $0.y * back) }
    }

    // MARK: Vision

    private static func makeRequest(minimumSize: Float, minimumAspect: Float) -> VNDetectRectanglesRequest {
        let r = VNDetectRectanglesRequest()
        r.minimumAspectRatio = minimumAspect
        r.maximumAspectRatio = 1
        // How far a corner may be from a right angle (degrees): the perspective of a window seen from the side stays inside it
        r.quadratureTolerance = 30
        r.minimumSize = minimumSize
        r.minimumConfidence = 0.4
        // All of them: the picker chooses
        r.maximumObservations = 0
        return r
    }

    /// Every shape the requests find in the image, in its pixels (y down).
    private static func quads(in image: CGImage, requests: [VNDetectRectanglesRequest]) -> [QuadCandidate] {
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        do { try handler.perform(requests) } catch { return [] }
        let w = Double(image.width), h = Double(image.height)
        return requests.flatMap { $0.results ?? [] }.map { o in
            // Vision's points are 0...1 from the BOTTOM-left
            func p(_ q: CGPoint) -> Vec2 { Vec2(Double(q.x) * w, (1 - Double(q.y)) * h) }
            return QuadCandidate(corners: [p(o.topLeft), p(o.topRight), p(o.bottomRight), p(o.bottomLeft)], confidence: Double(o.confidence))
        }
    }

    private static func scaled(_ image: CGImage, by k: CGFloat) -> CGImage? {
        let w = max(1, Int((CGFloat(image.width) * k).rounded())), h = max(1, Int((CGFloat(image.height) * k).rounded()))
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.interpolationQuality = .medium
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        return ctx.makeImage()
    }
}
