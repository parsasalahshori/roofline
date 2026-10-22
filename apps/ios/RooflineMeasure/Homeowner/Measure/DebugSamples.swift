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
/// 59 5/8 in, with a synthetic depth map (the simulator has no depth sensor): the glass 10 cm behind the wall, the wall at the wall's depth.
/// With `clutter`, the owner's real window: blinds hung over the top of the opening, a lamp standing in front of the lower-left corner, a
/// valance above and a picture on the wall beside it, in the photo and in the depth map.
enum SampleFrozen {
    static let photoSize = CGSize(width: 1440, height: 1920)

    static func scene(clutter: Bool = false) -> SampleScene { SampleScene(size: photoSize, windowShare: clutter ? 0.5 : 0.6) }

    /// A rectangle on a plane parallel to the wall, `offset` metres in front of it (+) or behind it (-), in the wall's x and y (metres).
    private struct Patch {
        var x0: Double, x1: Double, y0: Double, y1: Double
        var offset: Double
        func contains(_ x: Double, _ y: Double) -> Bool { x >= x0 && x <= x1 && y >= y0 && y <= y1 }
    }

    private static let lens = CameraIntrinsics(fx: 1400, fy: 1400, cx: 960, cy: 720, width: 1920, height: 1440)

    /// The frozen frame, and the opening's four corners (TL, TR, BR, BL) in the world.
    static func capture(_ scene: SampleScene, clutter: Bool = false) -> (capture: FrozenCapture, opening: [Vec3]) {
        let widthPx = Double(scene.frameCorners[1].x - scene.frameCorners[0].x)
        // The wall's distance that puts a window of this width across that many pixels
        let distance = SampleScene.widthIn / inchesPerMetre * lens.fx / widthPx
        let camera = Mat4.rigid(right: Vec3(0, -1, 0), up: Vec3(1, 0, 0), back: Vec3(0, 0, 1), origin: Vec3(0, 1.5, 0))
        let wall = Plane(point: Vec3(0, 0, -distance), normal: Vec3(0, 0, 1))!
        let bare = FrozenView(cameraTransform: camera, intrinsics: lens, wall: wall, depth: nil, photoWidthPx: Double(scene.size.width), photoHeightPx: Double(scene.size.height))
        let opening = bare.worldCorners(photoPx: scene.frameCorners.map { Vec2(Double($0.x), Double($0.y)) })?.points ?? []
        let (x0, x1) = (opening.map { $0.x }.min() ?? 0, opening.map { $0.x }.max() ?? 0), (y0, y1) = (opening.map { $0.y }.min() ?? 0, opening.map { $0.y }.max() ?? 0)
        var patches: [Patch] = []
        var blinds: Patch?
        if clutter {
            blinds = Patch(x0: x0, x1: x1, y0: y1 - 0.30, y1: y1, offset: -0.05)
            patches = [Patch(x0: x0 - 0.12, x1: x0 + 0.08, y0: y0 - 0.05, y1: y0 + 0.38, offset: 0.35),
                       Patch(x0: x0 - 0.08, x1: x1 + 0.08, y0: y1 + 0.14, y1: y1 + 0.30, offset: 0.12),
                       Patch(x0: x1 + 0.10, x1: x1 + 0.33, y0: y0 + 0.45, y1: y0 + 0.95, offset: 0.03)]
        }
        let depth = depthMap(camera: camera, wall: wall, distance: distance, opening: Patch(x0: x0, x1: x1, y0: y0, y1: y1, offset: 0), blinds: blinds, front: patches)
        let view = FrozenView(cameraTransform: camera, intrinsics: lens, wall: wall, depth: depth, photoWidthPx: Double(scene.size.width), photoHeightPx: Double(scene.size.height))
        var image = scene.image(withCard: false)
        if clutter { image = draw(clutter: patches, blinds: blinds, over: image, view: view, wallZ: -distance) }
        let jpeg = image.jpegData(compressionQuality: 0.85) ?? Data()
        let frozen = FrozenCapture(view: view, jpeg: jpeg, widthPx: Int(scene.size.width), heightPx: Int(scene.size.height), epoch: 0, trackingLostCount: 0, restartsForTracking: 0)
        return (frozen, opening)
    }

    /// The depth map the camera would read (256 x 192, metres along its view direction): the wall, the glass behind the opening, blinds
    /// hung inside it, and what stands in front.
    private static func depthMap(camera: Mat4, wall: Plane, distance: Double, opening: Patch, blinds: Patch?, front: [Patch]) -> FrozenDepth {
        let (w, h) = (256, 192)
        let k = lens.scaled(toWidth: Double(w), height: Double(h))
        let inverse = camera.inverseRigid
        let wallZ = -distance
        var d = [Float](repeating: 0, count: w * h)
        func hit(_ o: Vec3, _ dir: Vec3, _ offset: Double) -> (x: Double, y: Double, t: Double)? {
            guard abs(dir.z) > 1e-9 else { return nil }
            let t = (wallZ + offset - o.z) / dir.z
            return t > 0 ? (o.x + dir.x * t, o.y + dir.y * t, t) : nil
        }
        for y in 0..<h {
            for x in 0..<w {
                guard let r = ImageMapping.ray(throughNativePixel: Vec2(Double(x) + 0.5, Double(y) + 0.5), cameraTransform: camera, intrinsics: k) else { continue }
                var nearest: Double?
                func take(_ t: Double) { if nearest == nil || t < nearest! { nearest = t } }
                for p in front { if let q = hit(r.origin, r.direction, p.offset), p.contains(q.x, q.y) { take(q.t) } }
                if let q = hit(r.origin, r.direction, 0) {
                    if opening.contains(q.x, q.y) {
                        if let b = blinds, let bq = hit(r.origin, r.direction, b.offset), b.contains(bq.x, bq.y) {
                            take(bq.t)
                        } else if let g = hit(r.origin, r.direction, -0.10) {
                            take(g.t)
                        }
                    } else {
                        take(q.t)
                    }
                }
                if let t = nearest { d[y * w + x] = Float(-inverse.transform(r.origin + r.direction * t).z) }
            }
        }
        return FrozenDepth(width: w, height: h, depthM: d, confidence: [UInt8](repeating: 2, count: w * h))
    }

    /// The blinds, lamp, valance and picture drawn over the sample photo where their planes put them.
    private static func draw(clutter: [Patch], blinds: Patch?, over image: UIImage, view: FrozenView, wallZ: Double) -> UIImage {
        func photo(_ p: Patch) -> CGRect? {
            let a = view.photoPixel(ofWorld: Vec3(p.x0, p.y1, wallZ + p.offset)), b = view.photoPixel(ofWorld: Vec3(p.x1, p.y0, wallZ + p.offset))
            guard let a = a, let b = b else { return nil }
            return CGRect(x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y)
        }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: image.size, format: format).image { ctx in
            image.draw(at: .zero)
            let g = ctx.cgContext
            if let b = blinds, let r = photo(b) {
                // Slats hung inside the recess
                UIColor(rgb: 0xCFC9BC).setFill()
                g.fill(r)
                UIColor(rgb: 0xB5AE9F).setFill()
                var y = r.minY
                while y < r.maxY { g.fill(CGRect(x: r.minX, y: y, width: r.width, height: 3)); y += 14 }
            }
            // The picture on the wall: a dark frame round a bright print
            if let r = photo(clutter[2]) {
                UIColor(rgb: 0x2B2B2B).setFill()
                g.fill(r)
                UIColor(rgb: 0xE6D9B8).setFill()
                g.fill(r.insetBy(dx: 12, dy: 12))
                UIColor(rgb: 0x8DA28B).setFill()
                g.fill(r.insetBy(dx: 30, dy: 40))
            }
            // The valance above the window
            if let r = photo(clutter[1]) {
                g.saveGState()
                g.setShadow(offset: CGSize(width: 0, height: 6), blur: 12, color: UIColor.black.withAlphaComponent(0.35).cgColor)
                UIColor(rgb: 0x6E5B4B).setFill()
                g.fill(r)
                g.restoreGState()
            }
            // The lamp: a shade on a stand, in front of the lower-left corner
            if let r = photo(clutter[0]) {
                g.saveGState()
                g.setShadow(offset: CGSize(width: 4, height: 8), blur: 14, color: UIColor.black.withAlphaComponent(0.4).cgColor)
                UIColor(rgb: 0x3A3A3E).setFill()
                g.fill(CGRect(x: r.midX - 7, y: r.minY + r.height * 0.45, width: 14, height: r.height * 0.55))
                UIColor(rgb: 0xE9E0C9).setFill()
                let shade = CGMutablePath()
                shade.move(to: CGPoint(x: r.minX + r.width * 0.12, y: r.minY + r.height * 0.45))
                shade.addLine(to: CGPoint(x: r.maxX - r.width * 0.12, y: r.minY + r.height * 0.45))
                shade.addLine(to: CGPoint(x: r.maxX, y: r.minY))
                shade.addLine(to: CGPoint(x: r.minX, y: r.minY))
                shade.closeSubpath()
                g.addPath(shade)
                g.fillPath()
                g.restoreGState()
            }
        }
    }

    /// A rectangle a shaky hand leaves: the left edge 1.6 in outside the frame, the bottom 1.4 in below it, the right side 0.4 in in.
    static func off(_ opening: [Vec3], view: FrozenView) -> FrozenRect? {
        guard let r = FrozenRect.bounding(of: opening, plane: view.wall, viewer: view.viewer) else { return nil }
        var o = r
        o.left -= 1.6 / inchesPerMetre
        o.bottom -= 1.4 / inchesPerMetre
        o.right -= 0.4 / inchesPerMetre
        return o
    }
}

// MARK: - The AR screen, over a drawn window

/// The measuring screens as they look on a phone: the capture screen with a drawn window where the camera would be, and the frozen-photo
/// editor over the same drawn photo (`-debugOpen hud`, `freeze`, `freeze-clutter`, `freeze-off`, `freeze-two`).
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
        let clutter = mode == "freeze-clutter"
        let s = SampleFrozen.scene(clutter: clutter)
        let made = SampleFrozen.capture(s, clutter: clutter)
        let title = "WINDOW \(session.number) OF 7"
        switch mode {
        case "freeze-off":
            // Dragged off the frame: the outline goes through the dots, wherever they are
            FreezeFrameEditor(capture: made.capture, earlier: [], title: title, start: (SampleFrozen.off(made.opening, view: made.capture.view), .editing),
                              onClose: { }, onRetake: { }, onAddAnother: { _ in }, onUse: { _ in })
        case "freeze-two":
            FreezeFrameEditor(capture: made.capture, earlier: Self.earlierPhoto(made), title: title,
                              start: (FrozenRect.bounding(of: made.opening, plane: made.capture.view.wall, viewer: made.capture.view.viewer), .editing),
                              onClose: { }, onRetake: { }, onAddAnother: { _ in }, onUse: { _ in })
        default:
            // The whole pipeline: the depth sensor finds the opening and each side is set onto its edge in the photo
            FreezeFrameEditor(capture: made.capture, earlier: [], title: title,
                              onClose: { }, onRetake: { }, onAddAnother: { _ in }, onUse: { _ in })
        }
    }

    /// The answer of an earlier photo of the same window that is two inches wider.
    private static func earlierPhoto(_ made: (capture: FrozenCapture, opening: [Vec3])) -> [FrozenResult] {
        guard var r = FrozenRect.bounding(of: made.opening, plane: made.capture.view.wall, viewer: made.capture.view.viewer) else { return [] }
        r.right += 2.0 / inchesPerMetre
        return FrozenMeasure.measure(rect: r, view: made.capture.view).map { [$0] } ?? []
    }
}

// MARK: - A scanned room

/// 07b over a sample room: three windows, as the mockup lists them (`-debugOpen scan`); `quickscan` is the one-wall review with two
/// windows of 35 3/8 x 47 1/4 and 23 5/8 x 35 7/16 in; `quickscan-live` is the scanning screen over the sample photo.
struct DebugScanSample: View {
    @Environment(HomeownerStore.self) private var store
    let session: MeasureSession

    /// The sample window photo, small, with the window's outline on it (the same one for every row).
    private static let photo: ScanPhoto? = {
        let scene = SampleScene.photo
        let thumb = scene.image(withCard: false).preparingThumbnail(of: CGSize(width: 420, height: 420 * scene.size.height / scene.size.width))
        guard let image = thumb else { return nil }
        return ScanPhoto(image: image, outline: scene.frameCorners.map { CGPoint(x: $0.x / scene.size.width, y: $0.y / scene.size.height) })
    }()

    var body: some View {
        switch store.debugOpen {
        case "quickscan-live":
            live
        case "quickscan":
            let rows = [
                ScanReviewRow(id: UUID(), letter: "A", name: "Window A", room: session.room, included: true, widthM: 0.9, heightM: 1.2, confidence: .high, styleKey: "double-hung", photo: Self.photo),
                ScanReviewRow(id: UUID(), letter: "B", name: "Window B", room: session.room, included: true, widthM: 0.6, heightM: 0.9, confidence: .medium, styleKey: "single-hung", photo: Self.photo),
            ]
            RoomScanReview(mode: .oneWall, room: session.room, seconds: 8, plan: ScanPlan.sample, rows: rows, onAdd: { _ in store.measureSession = nil }, onCorners: { store.measureSession = nil }, onCancel: { store.measureSession = nil })
        default:
            let plan = ScanPlan.sample
            let windows = plan.openings.filter { !$0.isDoor }
            let sizes: [(Double, Double)] = [(36, 60), (36, 59), (48, 36)]
            let rows = windows.enumerated().map { i, o in
                ScanReviewRow(id: o.id, letter: String(UnicodeScalar(UInt8(65 + i))), name: ["Front, left", "Front, right", "Side"][i], room: session.room, included: true,
                              widthM: sizes[i].0 / inchesPerMetre, heightM: sizes[i].1 / inchesPerMetre, confidence: .high,
                              styleKey: i < 2 ? "double-hung" : "slider-2", photo: i < 2 ? Self.photo : nil)
            }
            RoomScanReview(room: session.room, seconds: 41, plan: plan, rows: rows, onAdd: { _ in store.measureSession = nil }, onCorners: { store.measureSession = nil }, onCancel: { store.measureSession = nil })
        }
    }

    /// The scanning screen over a sample photo (the simulator has no RoomPlan camera view to put it on).
    private var live: some View {
        ZStack {
            // The photo fills the screen without making the screen any wider than it is
            Color.black.ignoresSafeArea().overlay {
                Image(uiImage: SampleScene(size: CGSize(width: 1080, height: 1440), windowShare: 0.60).image(withCard: false))
                    .resizable().scaledToFill()
            }
            .clipped()
            ScanHud(room: session.room, progress: ScanProgress(mode: .oneWall, seconds: 6, windowsFound: 2),
                    windows: [RoomScanner.LiveWindow(id: UUID(), letter: "A", widthIn: 35.625, heightIn: 59.625, confidence: .high),
                              RoomScanner.LiveWindow(id: UUID(), letter: "B", widthIn: 23.6, heightIn: 35.4, confidence: .medium)],
                    onCancel: { store.measureSession = nil }, onDone: { store.measureSession = nil })
        }
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
        case "hud", "hud-howto", "freeze", "freeze-clutter", "freeze-off", "freeze-two":
            method = .corners
            measureSession = MeasureSession(method: .corners, room: room, number: 4)
        case "label":
            method = .corners
            measureSession = MeasureSession(method: .corners, room: room, number: 4)
            pending = Self.sampleWindow(room: room)
        case "scan", "scan-review":
            method = .roomScan
            measureSession = MeasureSession(method: .roomScan, room: room, number: 4)
        case "quickscan", "quickscan-live":
            method = .quickScan
            measureSession = MeasureSession(method: .quickScan, room: room, number: 4)
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
