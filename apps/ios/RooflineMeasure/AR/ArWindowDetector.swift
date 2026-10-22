import CoreVideo
import RooflineCore
import UIKit

/// One look at the live camera image for a window outline, on its own queue: the AR session's frame queue never waits for Vision. It
/// takes what the look needs out of the frame (the camera image, the depth buffers, the camera's pose) as plain values and buffers, so
/// the ARFrame itself is gone when its callback returns; the buffers are held for the few tens of milliseconds the look takes.
final class ArWindowDetector {
    struct Input {
        var pixelBuffer: CVPixelBuffer
        var depthMap: CVPixelBuffer?
        var confidenceMap: CVPixelBuffer?
        var cameraTransform: Mat4
        /// The camera's, for the native (landscape) camera image.
        var intrinsics: CameraIntrinsics
        /// Where the camera is aimed: 0...1 of the native image from its top-left.
        var reticle: CGPoint
    }

    struct Output {
        /// The outline: TL, TR, BR, BL in the native image's pixels.
        var nativeQuad: [Vec2]
        var cameraTransform: Mat4
        var intrinsics: CameraIntrinsics
        /// High-confidence depth points around each corner (empty without a depth sensor), for the wall check and the frame's plane.
        var depthPoints: [[Vec3]]
    }

    private let queue = DispatchQueue(label: "com.winchoice.ar.detect", qos: .utility)

    /// Looks, then calls `completion` on the detector's queue with the outline or nil.
    func look(_ input: Input, completion: @escaping (Output?) -> Void) {
        queue.async { completion(Self.run(input)) }
    }

    static func run(_ input: Input) -> Output? {
        guard let quad = WindowRectangleDetector.window(inCameraImage: input.pixelBuffer, reticle: input.reticle), quad.count == 4 else { return nil }
        let w = input.intrinsics.width, h = input.intrinsics.height
        var depth: [[Vec3]] = []
        for c in quad {
            if let map = input.depthMap {
                let centre = CGPoint(x: c.x / w, y: c.y / h)
                depth.append(DepthSampler.points(depthMap: map, confidenceMap: input.confidenceMap, cameraTransform: input.cameraTransform,
                                                 intrinsics: input.intrinsics, center: centre))
            } else {
                depth.append([])
            }
        }
        return Output(nativeQuad: quad, cameraTransform: input.cameraTransform, intrinsics: input.intrinsics, depthPoints: depth)
    }
}
