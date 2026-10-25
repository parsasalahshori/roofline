import ARKit
import CoreImage
import RooflineCore
import UIKit

/// The one photo kept with an AR window: ARFrame.capturedImage turned upright (the phone is used in portrait), as a
/// JPEG with no orientation tag (EXIF orientation 1: the server refuses HEIC and reads orientation), and the four
/// corners projected into that JPEG's pixels.
enum FrameCapture {
    struct Shot {
        var jpeg: Data
        var widthPx: Int
        var heightPx: Int
        /// TL, TR, BR, BL in the JPEG's pixels, clamped inside it.
        var corners: [Vec2]
        /// Every corner was inside the photo and in front of the camera (else they were clamped).
        var allInView: Bool
    }

    /// One CIContext for the whole app's frame work (the JPEG and the loupe); thread-safe.
    static let context = CIContext(options: [.useSoftwareRenderer: false])

    /// The upright portrait JPEG of a captured frame. Native capturedImage is landscape (sensor orientation); the
    /// back camera held upright needs it turned 90° clockwise (`.right`).
    static func uprightJPEG(_ pixelBuffer: CVPixelBuffer, quality: CGFloat = 0.9) -> (Data, Int, Int)? {
        let image = CIImage(cvPixelBuffer: pixelBuffer).oriented(.right)
        // Checked: CIContext.jpegRepresentation of an `.oriented(.right)` CVPixelBuffer image writes rotated pixels and
        // no Orientation tag (no EXIF/TIFF orientation; ImageIO reads it as 1), tried with a 640x480 buffer -> 480x640.
        let options: [CIImageRepresentationOption: Any] = [
            CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): quality,
        ]
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let data = context.jpegRepresentation(of: image, colorSpace: space, options: options) else { return nil }
        return (data, Int(image.extent.width), Int(image.extent.height))
    }

    /// The camera's own landscape image as a JPEG with no orientation tag: what a scan uploads (the server's frames are the native image).
    static func nativeJPEG(_ pixelBuffer: CVPixelBuffer, quality: CGFloat = 0.85) -> (Data, Int, Int)? {
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        let options: [CIImageRepresentationOption: Any] = [
            CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): quality,
        ]
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let data = context.jpegRepresentation(of: image, colorSpace: space, options: options) else { return nil }
        return (data, Int(image.extent.width), Int(image.extent.height))
    }

    /// The four world points in the upright JPEG's pixels.
    static func projectCorners(_ points: [Vec3], camera: ARCamera) -> (corners: [Vec2], allInView: Bool) {
        let native = camera.imageResolution // landscape, e.g. 1920 x 1440
        let portrait = CGSize(width: native.height, height: native.width)
        let camT = Mat4(camera.transform)
        let k = CameraIntrinsics(camera)
        var out: [Vec2] = []
        var inView = true
        for p in points {
            // Primary: ARKit's own projection into a portrait viewport the size of the upright photo (same aspect as
            // the turned image, so no crop).
            // Checked (ARCamera.h): viewportSize is the "viewport (or image) size", origin top-left. With the same aspect
            // as the turned image there is no crop. ON DEVICE: the pinhole cross-check below logs any disagreement.
            let cg = camera.projectPoint(p.simd, orientation: .portrait, viewportSize: portrait)
            var px = Vec2(Double(cg.x), Double(cg.y))
            // Cross-check with the pinhole model (RooflineCore, checked on the Mac); trust it when they disagree
            if let n = ImageMapping.project(p, cameraTransform: camT, intrinsics: k) {
                let q = ImageMapping.nativeToPortrait(n, nativeWidth: k.width, nativeHeight: k.height)
                if abs(q.x - px.x) > 3 || abs(q.y - px.y) > 3 {
                    #if DEBUG
                    print("[FrameCapture] projectPoint \(px) vs pinhole \(q): using the pinhole value")
                    #endif
                    px = q
                }
            } else {
                inView = false // behind the camera
            }
            if !ImageMapping.isInside(px, width: Double(portrait.width), height: Double(portrait.height)) { inView = false }
            out.append(ImageMapping.clamp(px, width: Double(portrait.width), height: Double(portrait.height)))
        }
        return (out, inView)
    }

    static func shot(frame: ARFrame, points: [Vec3]) -> Shot? {
        guard let encoded = uprightJPEG(frame.capturedImage) else { return nil }
        let (jpeg, w, h) = encoded
        let (corners, inView) = projectCorners(points, camera: frame.camera)
        // If the JPEG came out at another size than the camera reported (it should not), follow it
        let native = frame.camera.imageResolution
        let scaled = ImageMapping.rescale(corners, from: (Double(native.height), Double(native.width)), to: (Double(w), Double(h)))
        return Shot(jpeg: jpeg, widthPx: w, heightPx: h, corners: scaled, allInView: inView)
    }
}

/// LiDAR depth points around a pixel of the frame (world space), the high-confidence ones only.
enum DepthSampler {
    /// Points within `radiusM` (metres on the surface, `CornerCapture.depthRadiusM` = 2 cm by default) of the native-image
    /// point `center` (0...1 of the image), one depth pixel apart, from the temporally smoothed depth when the phone gives
    /// it (else the raw scene depth). Only `ARConfidenceLevel.high` pixels count. Empty without scene depth.
    static func points(frame: ARFrame, center: CGPoint, radiusM: Double = CornerCapture.depthRadiusM) -> [Vec3] {
        guard let depth = frame.smoothedSceneDepth ?? frame.sceneDepth else { return [] }
        let map = depth.depthMap
        let conf = depth.confidenceMap
        CVPixelBufferLockBaseAddress(map, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(map, .readOnly) }
        if let c = conf { CVPixelBufferLockBaseAddress(c, .readOnly) }
        defer { if let c = conf { CVPixelBufferUnlockBaseAddress(c, .readOnly) } }
        let w = CVPixelBufferGetWidth(map), h = CVPixelBufferGetHeight(map)
        guard let base = CVPixelBufferGetBaseAddress(map), w > 0, h > 0 else { return [] }
        let rowBytes = CVPixelBufferGetBytesPerRow(map)
        // Checked (ARDepthData.h): depthMap is per-pixel depth in metres; ARConfidenceLevel is Low 0, Medium 1, High 2.
        // The formats (DepthFloat32, OneComponent8) are checked at run time rather than assumed.
        guard CVPixelBufferGetPixelFormatType(map) == kCVPixelFormatType_DepthFloat32 else { return [] }
        let conf8 = conf.flatMap { CVPixelBufferGetPixelFormatType($0) == kCVPixelFormatType_OneComponent8 ? $0 : nil }
        let confBase = conf8.flatMap { CVPixelBufferGetBaseAddress($0) }
        let confRow = conf8.map { CVPixelBufferGetBytesPerRow($0) } ?? 0
        let k = CameraIntrinsics(frame.camera).scaled(toWidth: Double(w), height: Double(h))
        let camT = Mat4(frame.camera.transform)
        let cx = Int(center.x * CGFloat(w)), cy = Int(center.y * CGFloat(h))
        guard cx >= 0, cy >= 0, cx < w, cy < h else { return [] }
        func depthAt(_ x: Int, _ y: Int) -> Float32 {
            base.advanced(by: y * rowBytes + x * MemoryLayout<Float32>.size).assumingMemoryBound(to: Float32.self).pointee
        }
        // How many depth pixels make radiusM at the reticle's distance (a depth pixel is distance / focal length wide)
        let d0 = depthAt(cx, cy)
        let distance = d0.isFinite && d0 > 0.1 && d0 < 10 ? Double(d0) : 1.5
        let pixelM = distance / max(k.fx, 1)
        let r = max(1, Int((radiusM / pixelM).rounded(.up)))
        var out: [Vec3] = []
        for dy in -r...r {
            for dx in -r...r {
                guard Double(dx * dx + dy * dy).squareRoot() * pixelM <= radiusM + pixelM / 2 else { continue }
                let x = cx + dx, y = cy + dy
                guard x >= 0, y >= 0, x < w, y < h else { continue }
                if let cb = confBase {
                    let level = cb.advanced(by: y * confRow + x).assumingMemoryBound(to: UInt8.self).pointee
                    if level < 2 { continue } // only ARConfidenceLevel.high
                }
                let d = depthAt(x, y)
                guard d.isFinite, d > 0.1, d < 10 else { continue }
                // Pixel centres: +0.5
                out.append(ImageMapping.unproject(Vec2(Double(x) + 0.5, Double(y) + 0.5), depth: Double(d), cameraTransform: camT, intrinsics: k))
            }
        }
        return out
    }
}
