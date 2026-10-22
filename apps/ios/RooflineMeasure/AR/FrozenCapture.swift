import ARKit
import RooflineCore

/// One frozen camera frame: the upright photo, and everything ARKit knew at that instant that turns a point on the photo into a point on
/// the wall (see `FrozenView` in RooflineCore). Plain values: no ARFrame, no pixel buffer is kept.
struct FrozenCapture: Identifiable {
    let id = UUID()
    var view: FrozenView
    /// The upright JPEG (orientation 1) and its size in pixels.
    var jpeg: Data
    var widthPx: Int
    var heightPx: Int
    /// Which tracking session it was taken in: photos of one window combine only within one (the world can shift after a loss).
    var epoch: Int
    var trackingLostCount: Int
    var restartsForTracking: Int
}

extension FrozenDepth {
    /// The frame's LiDAR depth (smoothed when the phone gives it) and its confidence, copied out into plain arrays. Nil without scene
    /// depth, or in a format other than the documented one.
    init?(frame: ARFrame) {
        guard let data = frame.smoothedSceneDepth ?? frame.sceneDepth else { return nil }
        let map = data.depthMap
        // Checked (ARDepthData.h): depthMap is per-pixel depth in metres (DepthFloat32); confidence is ARConfidenceLevel in OneComponent8
        // (low 0, medium 1, high 2). The formats are checked at run time rather than assumed.
        guard CVPixelBufferGetPixelFormatType(map) == kCVPixelFormatType_DepthFloat32 else { return nil }
        CVPixelBufferLockBaseAddress(map, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(map, .readOnly) }
        let w = CVPixelBufferGetWidth(map), h = CVPixelBufferGetHeight(map)
        guard w > 0, h > 0, let base = CVPixelBufferGetBaseAddress(map) else { return nil }
        let rowBytes = CVPixelBufferGetBytesPerRow(map)
        var depth = [Float](repeating: 0, count: w * h)
        for y in 0..<h {
            let row = base.advanced(by: y * rowBytes).assumingMemoryBound(to: Float32.self)
            for x in 0..<w { depth[y * w + x] = row[x] }
        }
        var confidence: [UInt8] = []
        if let c = data.confidenceMap, CVPixelBufferGetPixelFormatType(c) == kCVPixelFormatType_OneComponent8,
           CVPixelBufferGetWidth(c) == w, CVPixelBufferGetHeight(c) == h {
            CVPixelBufferLockBaseAddress(c, .readOnly)
            defer { CVPixelBufferUnlockBaseAddress(c, .readOnly) }
            if let cb = CVPixelBufferGetBaseAddress(c) {
                let cRow = CVPixelBufferGetBytesPerRow(c)
                confidence = [UInt8](repeating: 0, count: w * h)
                for y in 0..<h {
                    let row = cb.advanced(by: y * cRow).assumingMemoryBound(to: UInt8.self)
                    for x in 0..<w { confidence[y * w + x] = row[x] }
                }
            }
        }
        self.init(width: w, height: h, depthM: depth, confidence: confidence)
    }
}
