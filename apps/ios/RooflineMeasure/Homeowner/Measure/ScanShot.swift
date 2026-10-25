import CoreGraphics
import Foundation
import ImageIO
import RooflineCore

/// One photo of a guided scan, as the phone keeps it: the NATIVE landscape JPEG that is uploaded, the upright copy the corner finders and the
/// screens work on, and everything that turns its pixels into points on the wall. Plain values (no ARFrame).
struct ScanShot: Identifiable {
    /// The frame id the server sees ("f1", "f2", ...).
    let id: String
    var kind: ScanFrameKind
    /// The corner a close-up is of (0 TL, 1 TR, 2 BR, 3 BL).
    var corner: Int?
    var nativeJPEG: Data
    var uprightJPEG: Data
    var nativeWidth: Int
    var nativeHeight: Int
    /// The camera, its lens, the wall and (regular photos on a LiDAR phone) the depth; `photoWidthPx` x `photoHeightPx` are the upright copy's size.
    var view: FrozenView

    /// The maths' view of this photo (the JPEG uploaded is the lens' own size, so marks need no scaling).
    var frame: ScanFrame {
        ScanFrame(frameId: id, kind: kind, corner: corner, imageWidth: nativeWidth, imageHeight: nativeHeight, cameraTransform: view.cameraTransform, intrinsics: view.intrinsics)
    }

    /// The upright copy as a `FrozenCapture` (for the single-photo editor).
    var capture: FrozenCapture {
        FrozenCapture(view: view, jpeg: uprightJPEG, widthPx: Int(view.photoWidthPx), heightPx: Int(view.photoHeightPx), epoch: 0, trackingLostCount: 0, restartsForTracking: 0)
    }

    var label: String {
        kind == .closeup ? "Close-up, \(ScanCorner.names[corner ?? 0]) corner" : "Photo \(id.dropFirst())"
    }
}

/// The upright pictures of a scan decoded once and kept, for the corner finders and the screens. Thread-safe.
final class ScanImages: @unchecked Sendable {
    private let lock = NSLock()
    private var cache: [String: CGImage] = [:]

    func image(_ shot: ScanShot) -> CGImage? {
        lock.lock()
        if let hit = cache[shot.id] { lock.unlock(); return hit }
        lock.unlock()
        guard let src = CGImageSourceCreateWithData(shot.uprightJPEG as CFData, nil), let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
        lock.lock()
        cache[shot.id] = image
        lock.unlock()
        return image
    }

    func forget() {
        lock.lock()
        cache = [:]
        lock.unlock()
    }
}
