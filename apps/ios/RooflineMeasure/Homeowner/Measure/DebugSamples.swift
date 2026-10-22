#if DEBUG
import RooflineCore
import SwiftUI
import UIKit

// DEBUG only: what the measuring screens show in the simulator, which has no camera, AR or RoomPlan. A synthetic window photo
// with a bank card on the glass (its corners are known, so tests can check them), the AR screen's controls over it, the frozen photo
// to mark the corners on, and a scanned room. `-debugOpen <name>` opens one of them (see HomeownerDebug).

/// A drawn window (35 5/8 x 59 5/8 in, the mockup's window) in any picture size, with a bank card on the lower sash.
struct SampleScene {
    static let widthIn = 35.625
    static let heightIn = 59.625

    let size: CGSize
    /// The glass opening ("inside of the frame"): TL, TR, BR, BL, in the picture's own pixels.
    let frameCorners: [CGPoint]
    /// The bank card: TL, TR, BR, BL, as drawn (it lies a little crooked).
    let cardCorners: [CGPoint]

    /// The standard 3:4 phone photo (3024 x 4032 px).
    static let photo = SampleScene(size: CGSize(width: 3024, height: 4032), windowShare: 0.60)

    /// The photo's corners as the card screens take them.
    static var frameCorners: [CGPoint] { photo.frameCorners }
    static var cardCorners: [CGPoint] { photo.cardCorners }

    static func render(withCard: Bool) -> UIImage { photo.image(withCard: withCard) }

    init(size: CGSize, windowShare: CGFloat) {
        self.size = size
        let w = size.width * windowShare
        let h = w * CGFloat(Self.heightIn / Self.widthIn)
        let x0 = (size.width - w) / 2
        let y0 = (size.height - h) / 2 - size.height * 0.015
        frameCorners = [CGPoint(x: x0, y: y0), CGPoint(x: x0 + w, y: y0), CGPoint(x: x0 + w, y: y0 + h), CGPoint(x: x0, y: y0 + h)]
        // A bank card is 3.370 x 2.125 in: its share of the window's width on the picture
        let cw = w * CGFloat(3.370 / Self.widthIn)
        let ch = cw * CGFloat(2.125 / 3.370)
        let centre = CGPoint(x: x0 + w * 0.17, y: y0 + h * 0.90)
        let a = -3.0 * Double.pi / 180
        func rot(_ dx: CGFloat, _ dy: CGFloat) -> CGPoint {
            CGPoint(x: centre.x + dx * CGFloat(cos(a)) - dy * CGFloat(sin(a)), y: centre.y + dx * CGFloat(sin(a)) + dy * CGFloat(cos(a)))
        }
        cardCorners = [rot(-cw / 2, -ch / 2), rot(cw / 2, -ch / 2), rot(cw / 2, ch / 2), rot(-cw / 2, ch / 2)]
    }

    func image(withCard: Bool) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            let g = ctx.cgContext
            let space = CGColorSpaceCreateDeviceRGB()
            func color(_ hex: UInt32, _ a: CGFloat = 1) -> UIColor { UIColor(rgb: hex, alpha: a) }
            // The wall: warm, lighter in the middle
            color(0xC9C1B2).setFill()
            g.fill(CGRect(origin: .zero, size: size))
            let wall = CGGradient(colorsSpace: space, colors: [color(0xE9E4DA).cgColor, color(0xB6AE9F).cgColor] as CFArray, locations: [0, 1])!
            g.drawRadialGradient(wall, startCenter: CGPoint(x: size.width / 2, y: size.height * 0.4), startRadius: 0,
                                 endCenter: CGPoint(x: size.width / 2, y: size.height * 0.4), endRadius: size.height * 0.75, options: [.drawsAfterEndLocation])
            let tl = frameCorners[0], br = frameCorners[2]
            let w = br.x - tl.x, h = br.y - tl.y
            // The trim round the opening
            let trim = w * 0.075
            let outer = CGRect(x: tl.x - trim, y: tl.y - trim, width: w + 2 * trim, height: h + 2 * trim)
            g.saveGState()
            g.setShadow(offset: CGSize(width: 0, height: size.height * 0.004), blur: size.height * 0.01, color: UIColor.black.withAlphaComponent(0.25).cgColor)
            color(0xF3F0E9).setFill()
            g.fill(outer)
            g.restoreGState()
            color(0xE2DED3).setFill()
            g.fill(CGRect(x: tl.x - w * 0.03, y: tl.y - w * 0.03, width: w + w * 0.06, height: h + w * 0.06))
            // The glass: a gradient of sky to garden, split by the meeting rail
            let rail = h * 0.022
            let split = tl.y + h * 0.46
            let upper = CGRect(x: tl.x, y: tl.y, width: w, height: split - tl.y - rail / 2)
            let lower = CGRect(x: tl.x, y: split + rail / 2, width: w, height: br.y - split - rail / 2)
            let glass = CGGradient(colorsSpace: space, colors: [color(0xA3B8C6).cgColor, color(0x5F7684).cgColor, color(0x3C4D59).cgColor] as CFArray, locations: [0, 0.65, 1])!
            for pane in [upper, lower] {
                g.saveGState()
                g.clip(to: pane)
                g.drawLinearGradient(glass, start: CGPoint(x: pane.midX, y: pane.minY), end: CGPoint(x: pane.midX, y: pane.maxY), options: [])
                g.restoreGState()
            }
            color(0xEDE9DF).setFill()
            g.fill(CGRect(x: tl.x - w * 0.03, y: split - rail / 2, width: w + w * 0.06, height: rail))
            // A pull on the lower sash
            color(0xD8D3C6).setFill()
            g.fill(CGRect(x: tl.x + w * 0.42, y: split + rail, width: w * 0.16, height: rail * 0.5))
            // The sill
            color(0xEFEBE2).setFill()
            g.fill(CGRect(x: outer.minX - trim * 0.6, y: outer.maxY - trim * 0.1, width: outer.width + trim * 1.2, height: trim * 0.7))
            if withCard { drawCard(g, space) }
        }
    }

    private func drawCard(_ g: CGContext, _ space: CGColorSpace) {
        let c = cardCorners
        let path = CGMutablePath()
        path.move(to: c[0]); path.addLine(to: c[1]); path.addLine(to: c[2]); path.addLine(to: c[3]); path.closeSubpath()
        g.saveGState()
        g.setShadow(offset: CGSize(width: 2, height: 4), blur: 8, color: UIColor.black.withAlphaComponent(0.35).cgColor)
        g.addPath(path)
        g.clip()
        let gradient = CGGradient(colorsSpace: space, colors: [UIColor(rgb: 0x2D5AA0).cgColor, UIColor(rgb: 0x1C3E78).cgColor] as CFArray, locations: [0, 1])!
        g.drawLinearGradient(gradient, start: c[0], end: c[2], options: [])
        g.restoreGState()
        // The chip and a stripe, in the card's own frame
        let cw = hypot(c[1].x - c[0].x, c[1].y - c[0].y), ch = hypot(c[3].x - c[0].x, c[3].y - c[0].y)
        let ux = (c[1].x - c[0].x) / cw, uy = (c[1].y - c[0].y) / cw
        let vx = (c[3].x - c[0].x) / ch, vy = (c[3].y - c[0].y) / ch
        func at(_ s: CGFloat, _ t: CGFloat) -> CGPoint { CGPoint(x: c[0].x + ux * cw * s + vx * ch * t, y: c[0].y + uy * cw * s + vy * ch * t) }
        func quad(_ s0: CGFloat, _ t0: CGFloat, _ s1: CGFloat, _ t1: CGFloat, _ hex: UInt32) {
            let p = CGMutablePath()
            p.move(to: at(s0, t0)); p.addLine(to: at(s1, t0)); p.addLine(to: at(s1, t1)); p.addLine(to: at(s0, t1)); p.closeSubpath()
            g.addPath(p)
            g.setFillColor(UIColor(rgb: hex).cgColor)
            g.fillPath()
        }
        quad(0.10, 0.22, 0.26, 0.46, 0xE3C26B)
        quad(0.10, 0.66, 0.58, 0.74, 0x7E9AC8)
    }
}

// MARK: - A frozen frame of the sample window

/// The sample window as a frozen camera frame would hold it: photographed square-on from the distance that makes the drawn window 35 5/8 x
/// 59 5/8 in, with no depth sensor (the simulator has none). The corners of the drawing are therefore known in the world too.
enum SampleFrozen {
    static let photoSize = CGSize(width: 1440, height: 1920)

    static func scene() -> SampleScene { SampleScene(size: photoSize, windowShare: 0.6) }

    static func capture(_ scene: SampleScene) -> FrozenCapture {
        let lens = CameraIntrinsics(fx: 1400, fy: 1400, cx: 960, cy: 720, width: 1920, height: 1440)
        let widthPx = Double(scene.frameCorners[1].x - scene.frameCorners[0].x)
        // The wall's distance that puts a window of this width across that many pixels
        let distance = SampleScene.widthIn / inchesPerMetre * lens.fx / widthPx
        let camera = Mat4.rigid(right: Vec3(0, -1, 0), up: Vec3(1, 0, 0), back: Vec3(0, 0, 1), origin: Vec3(0, 1.5, 0))
        let wall = Plane(point: Vec3(0, 0, -distance), normal: Vec3(0, 0, 1))!
        let view = FrozenView(cameraTransform: camera, intrinsics: lens, wall: wall, depth: nil,
                              photoWidthPx: Double(scene.size.width), photoHeightPx: Double(scene.size.height))
        let jpeg = scene.image(withCard: false).jpegData(compressionQuality: 0.85) ?? Data()
        return FrozenCapture(view: view, jpeg: jpeg, widthPx: Int(scene.size.width), heightPx: Int(scene.size.height), epoch: 0, trackingLostCount: 0, restartsForTracking: 0)
    }

    /// The corners a shaky hand leaves: the top ones on the frame, the bottom-right a little off, the bottom-left far outside it.
    static func shaky(_ scene: SampleScene) -> [CGPoint] {
        let f = scene.frameCorners
        let pxPerIn = (f[1].x - f[0].x) / CGFloat(SampleScene.widthIn)
        return [f[0], f[1], CGPoint(x: f[2].x + 0.4 * pxPerIn, y: f[2].y + 0.3 * pxPerIn), CGPoint(x: f[3].x - 1.6 * pxPerIn, y: f[3].y + 1.4 * pxPerIn)]
    }
}

// MARK: - The AR screen, over a drawn window

/// The measuring screens as they look on a phone: the capture screen with a drawn window where the camera would be, and the frozen-photo
/// editor over the same drawn photo (`-debugOpen hud`, `freeze`, `freeze-skew`, `freeze-two`).
struct DebugCaptureSample: View {
    let mode: String
    let session: MeasureSession
    @State private var backdrop: UIImage?
    @State private var scene: SampleScene?

    var body: some View {
        if mode.hasPrefix("freeze") { freeze } else { hud }
    }

    private var hud: some View {
        ZStack {
            // The picture fills the screen, under the status bar and the home indicator, as the camera does
            GeometryReader { geo in
                Group {
                    if let image = backdrop {
                        Image(uiImage: image).resizable().frame(width: geo.size.width, height: geo.size.height).accessibilityHidden(true)
                    } else {
                        Color.black
                    }
                }
                .task(id: geo.size) {
                    let s = SampleScene(size: geo.size, windowShare: 0.62)
                    scene = s
                    backdrop = s.image(withCard: false)
                }
            }
            .ignoresSafeArea()
            ArCaptureHud(model: model, onClose: { }, onCapture: { }, onHow: { })
            if mode == "hud-howto" { ArHowTo { } }
        }
    }

    private var model: ArCaptureModel {
        var m = ArCaptureModel()
        m.title = "WINDOW \(session.number) OF 7"
        m.deviceChip = "Depth sensor on"
        m.phase = .ready
        m.hint = ArCaptureModel.readyHint(photosTaken: 0)
        return m
    }

    @ViewBuilder private var freeze: some View {
        let s = SampleFrozen.scene()
        let capture = SampleFrozen.capture(s)
        let title = "WINDOW \(session.number) OF 7"
        switch mode {
        case "freeze-skew":
            FreezeFrameEditor(capture: capture, earlier: [], title: title, start: (SampleFrozen.shaky(s), .editing),
                              onClose: { }, onRetake: { }, onAddAnother: { _ in }, onUse: { _ in })
        case "freeze-two":
            FreezeFrameEditor(capture: capture, earlier: Self.earlierPhoto(capture, s), title: title, start: (s.frameCorners, .editing),
                              onClose: { }, onRetake: { }, onAddAnother: { _ in }, onUse: { _ in })
        default:
            // The whole pipeline: the phone looks for the window in the still, and each corner snaps onto the frame's corner
            FreezeFrameEditor(capture: capture, earlier: [], title: title,
                              onClose: { }, onRetake: { }, onAddAnother: { _ in }, onUse: { _ in })
        }
    }

    /// The answer of an earlier photo of the same window, a little different.
    private static func earlierPhoto(_ capture: FrozenCapture, _ s: SampleScene) -> [FrozenResult] {
        let nudge = s.frameCorners.enumerated().map { i, p in Vec2(Double(p.x) + (i == 1 || i == 2 ? 5 : -2), Double(p.y) + (i < 2 ? -3 : 4)) }
        return FrozenMeasure.measure(view: capture.view, photoPx: nudge).map { [$0] } ?? []
    }
}

// MARK: - A scanned room

/// 07b over a sample room: three windows, as the mockup lists them.
struct DebugScanSample: View {
    @Environment(HomeownerStore.self) private var store
    let session: MeasureSession

    var body: some View {
        let plan = ScanPlan.sample
        let windows = plan.openings.filter { !$0.isDoor }
        let sizes: [(Double, Double)] = [(36, 60), (36, 59), (48, 36)]
        let rows = windows.enumerated().map { i, o in
            ScanReviewRow(id: o.id, letter: String(UnicodeScalar(UInt8(65 + i))), name: ["Front, left", "Front, right", "Side"][i], room: session.room, included: true,
                          widthM: sizes[i].0 / inchesPerMetre, heightM: sizes[i].1 / inchesPerMetre, confidence: .high,
                          styleKey: i < 2 ? "double-hung" : "slider-2")
        }
        return RoomScanReview(room: session.room, seconds: 41, plan: plan, rows: rows, onAdd: { _ in store.measureSession = nil }, onCorners: { store.measureSession = nil }, onCancel: { store.measureSession = nil })
    }
}

// MARK: - Opening a screen from a launch argument

/// What the card photo screen starts with (`-debugOpen card3` and so on).
struct DebugCardSeed {
    var step: CardPhotoFlow.Step
    var cardCount: Int
    var windowCount: Int
    /// The window's fourth corner tapped inside the other three (not a four-sided shape): the screen says what to fix.
    /// (Corners tapped across each other are put in order by the app and size fine.)
    var dart = false
    /// The photo opens with NO corners and the phone looks for the card and the window itself (`-debugOpen cardauto`, `windowauto`).
    var auto = false
    /// With `auto`: go on to the window step once the phone has looked (`windowauto`).
    var thenWindow = false
}

extension HomeownerStore {
    /// `-debugOpen`: opens a measuring screen over the method screen, so the screens that need a camera can be looked at.
    func openDebug(_ name: String) {
        let room = path.compactMap { r -> String? in if case .method(let room) = r { return room } else { return nil } }.last ?? "Bedroom 1"
        switch name {
        case "hud", "hud-howto", "freeze", "freeze-skew", "freeze-two":
            method = .corners
            measureSession = MeasureSession(method: .corners, room: room, number: 4)
        case "label":
            method = .corners
            measureSession = MeasureSession(method: .corners, room: room, number: 4)
            pending = Self.sampleWindow(room: room)
        case "scan", "scan-review":
            method = .roomScan
            measureSession = MeasureSession(method: .roomScan, room: room, number: 4)
        case "needs-iphone":
            method = .corners
            measureSession = MeasureSession(method: .corners, room: room, number: 4)
        case "needs-pro":
            method = .roomScan
            measureSession = MeasureSession(method: .roomScan, room: room, number: 4)
        case "card", "card0":
            debugCardSeed = DebugCardSeed(step: .intro, cardCount: 0, windowCount: 0)
            startCard(room)
        case "card3":
            debugCardSeed = DebugCardSeed(step: .card, cardCount: 3, windowCount: 0)
            startCard(room)
        case "card4":
            debugCardSeed = DebugCardSeed(step: .card, cardCount: 4, windowCount: 0)
            startCard(room)
        case "window2":
            debugCardSeed = DebugCardSeed(step: .window, cardCount: 4, windowCount: 2)
            startCard(room)
        case "window4":
            debugCardSeed = DebugCardSeed(step: .window, cardCount: 4, windowCount: 4)
            startCard(room)
        case "cardauto":
            debugCardSeed = DebugCardSeed(step: .card, cardCount: 0, windowCount: 0, auto: true)
            startCard(room)
        case "windowauto":
            debugCardSeed = DebugCardSeed(step: .card, cardCount: 0, windowCount: 0, auto: true, thenWindow: true)
            startCard(room)
        case "windowdart":
            debugCardSeed = DebugCardSeed(step: .window, cardCount: 4, windowCount: 4, dart: true)
            startCard(room)
        default: break
        }
    }

    private func startCard(_ room: String) {
        method = .card
        measureSession = MeasureSession(method: .card, room: room, number: 4)
    }

    /// A finished measure, as the label sheet shows it (35 5/8 x 59 5/8 in, depth sensor).
    static func sampleWindow(room: String) -> PendingWindow {
        let w = SampleScene.widthIn / inchesPerMetre, h = SampleScene.heightIn / inchesPerMetre
        let points = [Vec3(0, h, -2), Vec3(w, h, -2), Vec3(w, 0, -2), Vec3(0, 0, -2)]
        let scale = WindowPhotoScale.ar(ArScale(pointsM: points, trackingLostCount: 0, device: .arkitLidar, cornerSpreadM: [0.001, 0.001, 0.001, 0.001]))
        let input = PhotoWindowInput(id: "sample-window", uploadId: nil, label: nil, windowKey: nil, corners: nil, scale: scale, room: room, style: nil)
        return PendingWindow(id: input.id, scale: scale, corners: nil, jpeg: nil, imageWidthPx: 0, imageHeightPx: 0, preview: LocalWindowPreview.of(input, imageWidthPx: 0, imageHeightPx: 0),
                             room: room, name: "", number: 4, replacing: nil)
    }
}
#endif
