#if DEBUG
import RooflineCore
import SwiftUI
import UIKit

// DEBUG only: the guided scan's screens in the simulator, which has no camera or ARKit. A made-up window (35 5/8 x 59 5/8 in) on a wall 2 m
// away is drawn in perspective from any camera position, so the sample photos have real parallax and real edges: the scan screens run over
// them, and the result screen runs the REAL marks pipeline (project, snap, triangulate, gates) on them.
// `-debugOpen guided-hud | guided-closeup | guided-result | guided-result-check | guided-aim | guided-working`.

enum DebugScanScene {
    /// A 960 x 720 lens, as the real one scaled down (the upright photos are 720 x 960).
    static let lens = CameraIntrinsics(fx: 700, fy: 700, cx: 480, cy: 360, width: 960, height: 720)
    static let wallZ = -2.0
    static let widthM = 35.625 / inchesPerMetre
    static let heightM = 59.625 / inchesPerMetre
    static let left = -0.45
    static let top = 2.2
    static let wall = Plane(point: Vec3(0, 0, wallZ), normal: Vec3(0, 0, 1))!

    /// TL, TR, BR, BL.
    static var corners: [Vec3] {
        [Vec3(left, top, wallZ), Vec3(left + widthM, top, wallZ), Vec3(left + widthM, top - heightM, wallZ), Vec3(left, top - heightM, wallZ)]
    }

    static var centre: Vec3 { Vec3(left + widthM / 2, top - heightM / 2, wallZ) }

    /// The camera of an upright phone at `eye` looking at `target`.
    static func camera(at eye: Vec3, look target: Vec3) -> Mat4 {
        let f = (target - eye).normalized ?? Vec3(0, 0, -1)
        let upIn = Vec3.up - f * Vec3.up.dot(f)
        let u = upIn.normalized ?? Vec3(0, 1, 0)
        let r = f.cross(u)
        // The native image's +x is the upright photo's down and its +y is the upright photo's right (ARKit, back camera, phone upright)
        return Mat4.rigid(right: -u, up: r, back: -f, origin: eye)
    }

    static func view(at eye: Vec3, look target: Vec3) -> FrozenView {
        FrozenView(cameraTransform: camera(at: eye, look: target), intrinsics: lens, wall: wall, depth: nil, photoWidthPx: 720, photoHeightPx: 960)
    }

    static func shot(_ id: String, _ kind: ScanFrameKind = .regular, corner: Int? = nil, at eye: Vec3, look target: Vec3? = nil) -> ScanShot {
        let v = view(at: eye, look: target ?? centre)
        let data = render(v).jpegData(compressionQuality: 0.88) ?? Data()
        return ScanShot(id: id, kind: kind, corner: corner, nativeJPEG: data, uprightJPEG: data, nativeWidth: 960, nativeHeight: 720, view: v)
    }

    /// Six regular photos along a sweep and a close-up of each corner.
    static func fullScan() -> [ScanShot] {
        var out: [ScanShot] = []
        let xs = [-0.55, -0.33, -0.11, 0.11, 0.33, 0.55]
        for (i, x) in xs.enumerated() { out.append(shot("f\(i + 1)", at: Vec3(x, 1.45, 0.1), look: centre)) }
        for (c, p) in corners.enumerated() {
            let eye = Vec3(p.x + (c % 2 == 0 ? 0.08 : -0.08), p.y + (c < 2 ? -0.05 : 0.05), wallZ + 0.7)
            out.append(shot("f\(7 + c)", .closeup, corner: c, at: eye, look: p))
        }
        return out
    }

    static func render(_ v: FrozenView) -> UIImage {
        let size = CGSize(width: v.photoWidthPx, height: v.photoHeightPx)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            let g = ctx.cgContext
            func px(_ p: Vec3) -> CGPoint {
                let q = v.photoPixel(ofWorld: p) ?? Vec2(-1e5, -1e5)
                return CGPoint(x: q.x, y: q.y)
            }
            func fill(_ pts: [Vec3], _ color: UIColor) {
                guard let first = pts.first else { return }
                g.beginPath()
                g.move(to: px(first))
                for p in pts.dropFirst() { g.addLine(to: px(p)) }
                g.closePath()
                color.setFill()
                g.fillPath()
            }
            func rect(_ x0: Double, _ x1: Double, _ y0: Double, _ y1: Double) -> [Vec3] {
                [Vec3(x0, y1, wallZ), Vec3(x1, y1, wallZ), Vec3(x1, y0, wallZ), Vec3(x0, y0, wallZ)]
            }
            let x0 = left, x1 = left + widthM, y1 = top, y0 = top - heightM
            // the wall, lighter toward the middle
            UIColor(rgb: 0xD6CEBE).setFill()
            g.fill(CGRect(origin: .zero, size: size))
            let space = CGColorSpaceCreateDeviceRGB()
            if let grad = CGGradient(colorsSpace: space, colors: [UIColor(rgb: 0xE4DDCF).cgColor, UIColor(rgb: 0xC8BFAE).cgColor] as CFArray, locations: [0, 1]) {
                g.drawRadialGradient(grad, startCenter: CGPoint(x: size.width / 2, y: size.height * 0.45), startRadius: 0, endCenter: CGPoint(x: size.width / 2, y: size.height * 0.45), endRadius: size.height * 0.7, options: [.drawsAfterEndLocation])
            }
            // the casing round the opening (7 cm), and the sill under it
            fill(rect(x0 - 0.07, x1 + 0.07, y0 - 0.07, y1 + 0.07), UIColor(rgb: 0xAEA595))
            fill(rect(x0 - 0.11, x1 + 0.11, y0 - 0.115, y0 - 0.06), UIColor(rgb: 0xEFEBE2))
            // the window's frame (white), its glass, and a mullion
            fill(rect(x0, x1, y0, y1), UIColor(rgb: 0xF7F5EE))
            let inset = 0.06
            fill(rect(x0 + inset, x1 - inset, y0 + inset, y1 - inset), UIColor(rgb: 0x9DB6D3))
            fill(rect(x0 + inset, x1 - inset, y0 + inset, (y0 + y1) / 2 - 0.5 * inset), UIColor(rgb: 0xC9D9EA))
            fill(rect(x0 + inset, x1 - inset, (y0 + y1) / 2 - 0.5 * inset, (y0 + y1) / 2 + 0.5 * inset), UIColor(rgb: 0xF7F5EE))
        }
    }
}

/// The guided scan's screens over the drawn window.
struct DebugGuidedSample: View {
    let mode: String
    let session: MeasureSession
    @Environment(HomeownerStore.self) private var store
    @State private var model = GuidedScanModel()
    @State private var made = false

    var body: some View {
        switch mode {
        case "guided-result", "guided-result-check":
            ScanResultView(model: model, title: "WINDOW \(session.number)", onUse: {}, onAgain: {}, onClose: { store.measureSession = nil })
                .task {
                    guard !made else { return }
                    made = true
                    await model.debugResult(check: mode == "guided-result-check")
                }
        case "guided-working":
            ZStack {
                backdrop(at: Vec3(0, 1.45, 0.1), look: DebugScanScene.centre)
                ScanWorkingOverlay(photos: 10)
            }
        case "guided-aim":
            ZStack {
                backdrop(at: Vec3(0, 1.45, 0.3), look: DebugScanScene.centre)
                ScanAimOverlay(title: "WINDOW \(session.number)", ready: true, depth: true, onClose: {}, onStart: {}, onSinglePhoto: {})
            }
        case "guided-closeup":
            closeup
        default:
            sweep
        }
    }

    private func backdrop(at eye: Vec3, look: Vec3) -> some View {
        // (an overlay, so the picture's own size does not widen the screen: the real camera view has the screen's size)
        Color.black.ignoresSafeArea()
            .overlay { Image(uiImage: DebugScanScene.render(DebugScanScene.view(at: eye, look: look))).resizable().scaledToFill() }
            .clipped().ignoresSafeArea().accessibilityHidden(true)
    }

    /// Sweeping, three photos in, and the walk is too fast.
    private var sweep: some View {
        let eye = Vec3(-0.2, 1.45, 0.1)
        let first = DebugScanScene.shot("f1", at: Vec3(-0.55, 1.45, 0.1))
        var ui = ScanUiState(running: true, step: nil, shotCount: 3, interrupted: false, haveWall: true)
        ui.step = ScanStep(phase: .sweep, coach: ScanCoach(.tooFast), regularKept: 3, closeupsKept: [false, false, false, false], closeupsDone: 0, canFinishSweep: true)
        return ZStack {
            backdrop(at: eye, look: DebugScanScene.centre)
            ScanCaptureOverlay(ui: ui, shots: [first], finding: false, corners: DebugScanScene.corners, title: "WINDOW \(session.number)", onClose: {}, onRedo: {}, onShutter: {},
                               onNext: {}, onSkip: {}, onStop: {})
        }
    }

    /// The first close-up: the top-left corner is off to one side, so the screen says to centre it. The state comes from the real guide.
    private var closeup: some View {
        let corners = DebugScanScene.corners
        let eye = Vec3(corners[0].x + 0.30, corners[0].y - 0.20, DebugScanScene.wallZ + 0.65)
        let look = Vec3(corners[0].x + 0.30, corners[0].y - 0.20, DebugScanScene.wallZ)
        let first = DebugScanScene.shot("f1", at: Vec3(-0.55, 1.45, 0.1))
        var guide = ScanGuide()
        var t = 0.0
        // three photos by hand, then on to the close-ups
        for x in [-0.55, -0.3, 0.0] {
            t += 0.5
            let o = ScanObservation(time: t, cameraTransform: DebugScanScene.camera(at: Vec3(x, 1.45, 0.1), look: DebugScanScene.centre), intrinsics: DebugScanScene.lens, windowCornersM: corners)
            _ = guide.update(o)
            _ = guide.manualKeep(o)
        }
        _ = guide.finishSweep(at: t)
        var step: ScanStep?
        for _ in 0..<60 {
            t += 1.0 / 30
            step = guide.update(ScanObservation(time: t, cameraTransform: DebugScanScene.camera(at: eye, look: look), intrinsics: DebugScanScene.lens, meanLuma: 120, sharpness: 100, windowCornersM: corners))
        }
        let ui = ScanUiState(running: true, step: step, shotCount: 3, interrupted: false, haveWall: true)
        return ZStack {
            backdrop(at: eye, look: look)
            ScanCaptureOverlay(ui: ui, shots: [first], finding: false, corners: corners, title: "WINDOW \(session.number)", onClose: {}, onRedo: {}, onShutter: {},
                               onNext: {}, onSkip: {}, onStop: {})
        }
    }
}

extension GuidedScanModel {
    /// Runs the real marks pipeline on the drawn scan and shows the result. `check`: the scan is not good enough for the gates (the second
    /// photo's marks are thrown off), so the amber "we'll check this one" state shows.
    func debugResult(check: Bool) async {
        let shots = DebugScanScene.fullScan()
        let estimate = DebugScanScene.corners.enumerated().map { i, p in p + Vec3(i % 2 == 0 ? -0.012 : 0.012, i < 2 ? 0.012 : -0.012, 0) }
        debugLoad(shots: shots, estimate: estimate, check: check)
    }
}
#endif
