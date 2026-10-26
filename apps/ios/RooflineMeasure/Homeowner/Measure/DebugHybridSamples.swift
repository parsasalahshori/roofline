#if DEBUG
import RooflineCore
import SwiftUI
import UIKit

// DEBUG only: the room-scan hybrid's screens in the simulator, which has no camera, ARKit or RoomPlan. The drawn window of `DebugScanScene` stands
// in for the room: the pan photos are drawn from six places, the close-ups from each corner, and Measure and check runs the REAL marks pipeline on
// them, starting from "Apple's" window (the true one, a little too big and off to one side).
// `-debugScenario method -debugCaps lidar -debugOpen hybrid-pan | hybrid-list | hybrid-closeup | hybrid-results` (and `hybrid-list3`, `hybrid-results3`: three windows,
// so every row is clear of the pinned footer, for the accessibility audit).

enum DebugHybridScene {
    /// The pan photo as the camera hands it over: LANDSCAPE (the drawn upright picture turned a quarter anticlockwise), so the app's own
    /// quarter turn clockwise gives the upright photo back.
    static func native(of upright: UIImage) -> Data? {
        let size = CGSize(width: upright.size.height, height: upright.size.width)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: size, format: format).jpegData(withCompressionQuality: 0.88) { ctx in
            ctx.cgContext.translateBy(x: 0, y: size.height)
            ctx.cgContext.rotate(by: -.pi / 2)
            upright.draw(at: .zero)
        }
    }

    /// Pan photos along a sweep, 22 cm apart, 2 m from the wall.
    static func panFrames(_ n: Int = 6) -> [PanFrame] {
        (0..<n).compactMap { i in
            let x = -0.55 + 0.22 * Double(i)
            let view = DebugScanScene.view(at: Vec3(x, 1.45, 0.1), look: DebugScanScene.centre)
            guard let data = native(of: DebugScanScene.render(view)) else { return nil }
            return PanFrame(id: i, time: Double(i) * 0.7, nativeJPEG: data, nativeWidth: 960, nativeHeight: 720, cameraTransform: view.cameraTransform, intrinsics: DebugScanScene.lens,
                            depth: nil, sharpness: 100)
        }
    }

    /// Apple's window: the true one, `grow` metres too big on each side and `shift` to the right.
    static func appleCorners(grow: Double = 0.014, shift: Double = 0.01) -> [Vec3] {
        // TL, TR, BR, BL: the left corners go left and the right ones right when it is too big
        DebugScanScene.corners.enumerated().map { i, p in p + Vec3((i == 0 || i == 3 ? -grow : grow) + shift, i < 2 ? grow : -grow, 0) }
    }

    static func found(_ id: UUID = UUID(), corners: [Vec3], withPhoto: Bool) -> HybridFound {
        let w = corners[0].distance(to: corners[1]), h = corners[0].distance(to: corners[3])
        var photo: ScanPhoto?
        var shot: (jpeg: Data, widthPx: Int, heightPx: Int, corners: [Vec2])?
        if withPhoto {
            let view = DebugScanScene.view(at: Vec3(0, 1.45, 0.1), look: DebugScanScene.centre)
            let image = DebugScanScene.render(view)
            let px = corners.compactMap { view.photoPixel(ofWorld: $0) }
            if px.count == 4, let jpeg = image.jpegData(compressionQuality: 0.88) {
                let thumb = image.preparingThumbnail(of: CGSize(width: 420, height: 560)) ?? image
                photo = ScanPhoto(image: thumb, outline: px.map { CGPoint(x: $0.x / view.photoWidthPx, y: $0.y / view.photoHeightPx) })
                shot = (jpeg, 720, 960, px)
            }
        }
        return HybridFound(appleId: id, corners: corners, widthM: w, heightM: h, confidence: .high, photo: photo, appleShot: shot)
    }

    /// Windows A and B on the drawn wall (the same window, as far as the pipeline can tell) and C on a wall no photo saw.
    @MainActor static func model(room: String, windows count: Int = 4) -> RoomHybridModel {
        let m = RoomHybridModel(room: room)
        let apple = appleCorners()
        let elsewhere = DebugScanScene.corners.map { Vec3($0.x + 3, $0.y - 0.5, $0.z + 3) }.enumerated().map { i, p in
            // a smaller window on a side wall, seen by no photo
            Vec3(p.x + (i % 2 == 0 ? 0.25 : -0.25), p.y + (i < 2 ? -0.2 : 0.2), p.z)
        }
        let all = [found(corners: apple, withPhoto: true), found(corners: appleCorners(grow: -0.012, shift: -0.008), withPhoto: true), found(corners: elsewhere, withPhoto: false),
                   found(corners: appleCorners(grow: 0.02, shift: -0.01), withPhoto: true)]
        m.panBuilt(Array(all.prefix(count)), frames: panFrames())
        return m
    }

    /// The four close-ups of the drawn scan, numbered as the camera numbers them.
    static func closeups(_ corners: [Int] = [0, 1, 2, 3]) -> [ScanShot] {
        let pts = DebugScanScene.corners
        return corners.map { c in
            let p = pts[c]
            let eye = Vec3(p.x + (c % 2 == 0 ? 0.08 : -0.08), p.y + (c < 2 ? -0.05 : 0.05), DebugScanScene.wallZ + 0.7)
            return DebugScanScene.shot("c\(c)", .closeup, corner: c, at: eye, look: p)
        }
    }
}

/// The hybrid's screens over drawn photos.
struct DebugHybridSample: View {
    let mode: String
    let session: MeasureSession
    @State private var model: RoomHybridModel?

    var body: some View {
        Group {
            if mode == "hybrid-pan" {
                pan
            } else if let model = model {
                HybridFlowView(model: model, session: session)
            } else {
                Color.black.ignoresSafeArea()
            }
        }
        .task { await prepare() }
    }

    private func prepare() async {
        guard mode != "hybrid-pan", model == nil else { return }
        let short = mode.hasSuffix("3")
        let m = DebugHybridScene.model(room: session.room, windows: short ? 3 : 4)
        let a = m.flow.items[0].id, b = m.flow.items[1].id, d = m.flow.items[short ? 2 : 3].id
        switch mode {
        case "hybrid-list", "hybrid-list3":
            m.debugCloseups(a, DebugHybridScene.closeups())
            m.debugCloseups(b, DebugHybridScene.closeups([0, 1]))
            m.setSkipped(d, true)
        case "hybrid-closeup":
            m.debugCloseups(a, DebugHybridScene.closeups())
            _ = m.openCloseups(b)
            m.debugCloseup = closeupSample()
        case "hybrid-results", "hybrid-results3":
            m.debugCloseups(a, DebugHybridScene.closeups())
            m.debugCloseups(b, DebugHybridScene.closeups())
            m.setSkipped(d, true)
        default:
            break
        }
        model = m
        if mode.hasPrefix("hybrid-results") {
            await m.measureAndCheck()
            // Window B: one of its marks is far off, so the gates fail and the amber state shows
            if let scan = m.window(b)?.scan, let mark = scan.draft?.usedMarks.first(where: { $0.corner == 1 && $0.frameId != "f1" }) {
                scan.moveMark(shotId: mark.frameId, corner: 1, toNative: Vec2(mark.x + 40, mark.y - 30))
                m.window(b)?.setScan(scan)
                m.refreshOutcome(b)
            }
        }
    }

    /// The first close-up of window B: the top-left corner is off to one side, so the screen says to centre it. The state comes from the real guide.
    private func closeupSample() -> RoomHybridModel.DebugCloseup {
        let corners = DebugScanScene.corners
        let eye = Vec3(corners[0].x + 0.30, corners[0].y - 0.20, DebugScanScene.wallZ + 0.65)
        let look = Vec3(corners[0].x + 0.30, corners[0].y - 0.20, DebugScanScene.wallZ)
        var guide = ScanGuide(startAtCloseups: true)
        var t = 0.0
        var step: ScanStep?
        for _ in 0..<45 {
            t += 1.0 / 30
            step = guide.update(ScanObservation(time: t, cameraTransform: DebugScanScene.camera(at: eye, look: look), intrinsics: DebugScanScene.lens, meanLuma: 120, sharpness: 100, windowCornersM: corners))
        }
        let ui = ScanUiState(running: true, step: step, shotCount: 0, interrupted: false, haveWall: true)
        let backdrop = Color.black.ignoresSafeArea()
            .overlay { Image(uiImage: DebugScanScene.render(DebugScanScene.view(at: eye, look: look))).resizable().scaledToFill() }
            .clipped().ignoresSafeArea().accessibilityHidden(true)
        return RoomHybridModel.DebugCloseup(backdrop: AnyView(backdrop), ui: ui, shots: [])
    }

    /// The pan: Apple's capture view would be behind; two windows found so far.
    private var pan: some View {
        let eye = Vec3(-0.1, 1.45, 0.1)
        return ZStack {
            Color.black.ignoresSafeArea()
                .overlay { Image(uiImage: DebugScanScene.render(DebugScanScene.view(at: eye, look: DebugScanScene.centre))).resizable().scaledToFill() }
                .clipped().ignoresSafeArea().accessibilityHidden(true)
            ScanHud(room: session.room, progress: ScanProgress(mode: .panForCloseups, seconds: 9, windowsFound: 2),
                    windows: [RoomScanner.LiveWindow(id: UUID(), letter: "A", widthIn: 36.4, heightIn: 60.3, confidence: .high),
                              RoomScanner.LiveWindow(id: UUID(), letter: "B", widthIn: 24.1, heightIn: 36.0, confidence: .medium)],
                    onCancel: {}, onDone: {}, detail: HybridWording.panPhotos(11))
        }
    }
}
#endif
