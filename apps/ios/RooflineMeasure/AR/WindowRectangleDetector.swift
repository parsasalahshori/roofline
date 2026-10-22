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
/// so the callers never trust one shape on its own: the photo flow shows what it found for the person to drag into place, and the
/// AR side waits for the same outline twice in a row.
enum WindowRectangleDetector {
    /// The longest side of the copy of a photo that Vision looks at: the finder does not need 12 megapixels to see a window frame.
    static let photoSide: CGFloat = 1600
    /// The longest side of the copy of a camera frame that Vision looks at (the frame is looked at about three times a second).
    static let liveSide: CGFloat = 1280

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

    // MARK: A camera frame

    /// The window outline in the live camera image, in the NATIVE (landscape) image's pixels, TL, TR, BR, BL as the person holding the
    /// phone upright sees them; nil when none is believable. `reticle` is where the camera is aimed, 0...1 of the native image from its
    /// top-left: only the window that holds it counts. Blocking: call it off the main thread (and off the AR session's queue).
    static func window(inCameraImage pixelBuffer: CVPixelBuffer, reticle: CGPoint) -> [Vec2]? {
        let nativeW = Double(CVPixelBufferGetWidth(pixelBuffer)), nativeH = Double(CVPixelBufferGetHeight(pixelBuffer))
        guard nativeW > 0, nativeH > 0 else { return nil }
        // The phone is held upright: the sensor's landscape image turned a quarter clockwise (as FrameCapture does for the photo),
        // made small, then looked at the way a photo is
        let k = min(1, liveSide / CGFloat(max(nativeW, nativeH)))
        let upright = CIImage(cvPixelBuffer: pixelBuffer).oriented(.right).transformed(by: CGAffineTransform(scaleX: k, y: k))
        guard let image = FrameCapture.context.createCGImage(upright, from: upright.extent) else { return nil }
        let sw = Double(image.width), sh = Double(image.height)
        let candidates = quads(in: image, requests: [makeRequest(minimumSize: 0.15, minimumAspect: 0.2)])
        // The reticle in the upright small image (the native image's top-left is the upright image's top-right)
        let aim = ImageMapping.nativeToPortrait(Vec2(Double(reticle.x) * nativeW, Double(reticle.y) * nativeH), nativeWidth: nativeW, nativeHeight: nativeH)
        let scale = sw / nativeH
        guard let picked = AutoCorners.pickWindow(candidates, imageWidth: sw, imageHeight: sh, aimedAt: Vec2(aim.x * scale, aim.y * scale)) else { return nil }
        return picked.corners.map { c in
            ImageMapping.portraitToNative(Vec2(c.x / scale, c.y / scale), nativeWidth: nativeW, nativeHeight: nativeH)
        }
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
