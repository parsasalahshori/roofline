import ImageIO
import RooflineCore
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// An upright photo, ready to send: pixels as displayed, a JPEG under the server's limit, and the image to draw.
struct PreparedPhoto {
    var image: UIImage
    var jpeg: Data
    var widthPx: Int
    var heightPx: Int
    /// The camera's 35 mm equivalent focal length (EXIF), when the photo says: the server and the phone size the window with it.
    var focal35mm: Double?
}

enum PhotoPreparation {
    /// Draws the photo upright (the server reads pixels as displayed), at most `maxSide` px on its long side, as a JPEG under
    /// `maxBytes` (the server refuses over 12 MB). The JPEG keeps the one EXIF tag the sizing uses, the 35 mm focal length, and
    /// nothing else: no location, no camera serial. Nil when it cannot be encoded.
    static func prepare(_ source: UIImage, metadata: [AnyHashable: Any]? = nil, maxSide: CGFloat = 4032, maxBytes: Int = 11_000_000) -> PreparedPhoto? {
        let w = source.size.width * source.scale, h = source.size.height * source.scale
        guard w > 0, h > 0 else { return nil }
        let k = min(1, maxSide / max(w, h))
        let size = CGSize(width: (w * k).rounded(), height: (h * k).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let upright = UIGraphicsImageRenderer(size: size, format: format).image { _ in source.draw(in: CGRect(origin: .zero, size: size)) }
        let focal = focal35mm(in: metadata)
        var quality: CGFloat = 0.88
        while quality >= 0.5 {
            if let data = jpeg(upright, quality: quality, focal35mm: focal), data.count <= maxBytes {
                return PreparedPhoto(image: upright, jpeg: data, widthPx: Int(size.width), heightPx: Int(size.height), focal35mm: focal)
            }
            quality -= 0.1
        }
        return nil
    }

    /// EXIF FocalLenIn35mmFilm from the camera's metadata, when it is a believable lens (8 to 600 mm, as the server reads it).
    static func focal35mm(in metadata: [AnyHashable: Any]?) -> Double? {
        guard let exif = metadata?[kCGImagePropertyExifDictionary as String] as? [AnyHashable: Any],
              let f = (exif[kCGImagePropertyExifFocalLenIn35mmFilm as String] as? NSNumber)?.doubleValue,
              f.isFinite, f >= 8, f <= 600 else { return nil }
        return f
    }

    /// An upright JPEG (orientation 1) with the focal length, and no other metadata.
    static func jpeg(_ image: UIImage, quality: CGFloat, focal35mm: Double?) -> Data? {
        guard let cg = image.cgImage else { return image.jpegData(compressionQuality: quality) }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        var properties: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: quality, kCGImagePropertyOrientation: 1]
        if let f = focal35mm { properties[kCGImagePropertyExifDictionary] = [kCGImagePropertyExifFocalLenIn35mmFilm: Int(f.rounded())] }
        CGImageDestinationAddImage(destination, cg, properties as CFDictionary)
        return CGImageDestinationFinalize(destination) ? data as Data : nil
    }
}

/// The photo with corner markers to place (07c). Tap to put a marker down; touch one and drag to move it, slowly, so a
/// fingertip can land on a 1 pixel target; pinch to zoom in on a corner and drag the picture to move it. While a finger is
/// down a magnifier shows what is under the marker. Points are in the photo's own pixels.
struct PhotoTapView: View {
    let photo: PreparedPhoto
    @Binding var points: [CGPoint]
    var maxPoints = 4
    /// Points shown but not editable (the card's corners while the window's are placed).
    var reference: [CGPoint] = []
    /// Start zoomed on this photo point (a sample or a test); nil starts with the whole photo in view.
    var focus: CGPoint?
    var startZoom: CGFloat = 1
    /// The markers are corners the phone found (the person drags any that is off): VoiceOver says so.
    var proposed = false
    var onEdit: () -> Void = {}
    /// A straightened outline to draw (the rectangle fitted to the markers, photo pixels, TL TR BR BL) in place of the line through the
    /// markers, which then are small dots only: what is drawn is what is measured and sent.
    var outline: [CGPoint] = []
    /// Length plates on the picture, each at its photo point (the same numbers the status card shows).
    var plates: [Plate] = []
    /// When marker `i` is let go: the point it should land on instead (the frame's corner in the picture), or nil to leave it where it is.
    var snap: ((Int, CGPoint) -> CGPoint?)?
    /// How far a marker moves for each point the finger moves on screen: 1 keeps it under the finger, the card photos use less.
    var gain: CGFloat = PhotoTapView.dragGain
    /// Markers from this index on are the middles of the window's sides (small squares, not numbered dots).
    var sideHandlesFrom: Int = .max
    /// VoiceOver's description of the picture, when the markers are not the usual corners to place.
    var voiceOver: String?

    struct Plate: Identifiable, Equatable {
        var id: String
        var point: CGPoint
        var inches: Double
        /// Moved this far from the point, in screen points (so a plate sits just inside a side whatever the zoom).
        var offset: CGSize = .zero
    }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var zoom: CGFloat = 1
    @State private var pan: CGSize = .zero
    @State private var touch: Touch?
    @State private var pinch: Pinch?
    @State private var started = false

    /// A marker moves this share of what the finger moves (on screen), so the finger can be 3 times less precise than the target.
    static let dragGain: CGFloat = 0.4
    static let maxZoom: CGFloat = 8
    private static let grabRadius: CGFloat = 32

    private struct Touch {
        var startLocation: CGPoint
        var location: CGPoint
        var dot: Int?
        var dotStart: CGPoint
        var panStart: CGSize
        var moved = false
        var pinched = false
    }

    private struct Pinch {
        var zoom: CGFloat
        var pan: CGSize
        var anchor: CGPoint
    }

    /// Where the photo sits in the view: its pixels to points and back.
    private struct Place {
        var center: CGPoint
        var scale: CGFloat
        var pan: CGSize
        var size: CGSize

        func toScreen(_ p: CGPoint) -> CGPoint {
            CGPoint(x: center.x + pan.width + (p.x - size.width / 2) * scale, y: center.y + pan.height + (p.y - size.height / 2) * scale)
        }

        func toPhoto(_ s: CGPoint) -> CGPoint {
            CGPoint(x: (s.x - center.x - pan.width) / scale + size.width / 2, y: (s.y - center.y - pan.height) / scale + size.height / 2)
        }
    }

    private var photoSize: CGSize { CGSize(width: CGFloat(photo.widthPx), height: CGFloat(photo.heightPx)) }

    private func fitScale(_ view: CGSize) -> CGFloat { min(view.width / photoSize.width, view.height / photoSize.height) }

    private func place(_ view: CGSize) -> Place {
        Place(center: CGPoint(x: view.width / 2, y: view.height / 2), scale: fitScale(view) * zoom, pan: pan, size: photoSize)
    }

    /// The picture may move until its edge meets the view's edge (a little past, so a corner at the edge can be reached).
    private func clamp(_ pan: CGSize, zoom: CGFloat, view: CGSize) -> CGSize {
        let s = fitScale(view) * zoom
        let maxX = max(0, (photoSize.width * s - view.width) / 2 + 24)
        let maxY = max(0, (photoSize.height * s - view.height) / 2 + 24)
        return CGSize(width: min(max(pan.width, -maxX), maxX), height: min(max(pan.height, -maxY), maxY))
    }

    private func clampPoint(_ p: CGPoint) -> CGPoint {
        CGPoint(x: min(max(p.x, 0), photoSize.width), y: min(max(p.y, 0), photoSize.height))
    }

    var body: some View {
        GeometryReader { geo in
            let view = geo.size
            let place = self.place(view)
            ZStack {
                Image(uiImage: photo.image).resizable()
                    .frame(width: photoSize.width * place.scale, height: photoSize.height * place.scale)
                    .position(x: place.center.x + place.pan.width, y: place.center.y + place.pan.height)
                // The reference (white, dashed), then the markers' outline (tape yellow)
                if reference.count == 4 {
                    Path { p in
                        let q = ordered(reference).map(place.toScreen)
                        p.move(to: q[0]); q.dropFirst().forEach { p.addLine(to: $0) }; p.closeSubpath()
                    }
                    .stroke(Color(white: 1, opacity: 0.85), style: StrokeStyle(lineWidth: 1.5, dash: [5, 4]))
                }
                if outline.count == 4 {
                    // The straightened rectangle, dark under tape yellow so it reads on any picture
                    let q = outline.map(place.toScreen)
                    Path { p in
                        p.move(to: q[0]); q.dropFirst().forEach { p.addLine(to: $0) }; p.closeSubpath()
                    }
                    .stroke(Color.black.opacity(0.5), style: StrokeStyle(lineWidth: 5, lineJoin: .round))
                    Path { p in
                        p.move(to: q[0]); q.dropFirst().forEach { p.addLine(to: $0) }; p.closeSubpath()
                    }
                    .stroke(Theme.tape, style: StrokeStyle(lineWidth: 2.5, lineJoin: .round))
                } else if points.count >= 2 {
                    Path { p in
                        let q = (points.count == 4 ? ordered(points) : points).map(place.toScreen)
                        p.move(to: q[0]); q.dropFirst().forEach { p.addLine(to: $0) }
                        if points.count == 4 { p.closeSubpath() }
                    }
                    .stroke(Theme.tape, style: StrokeStyle(lineWidth: 2, lineJoin: .round, dash: points.count == 4 ? [] : [8, 5]))
                }
                ForEach(Array(points.enumerated()), id: \.offset) { i, p in
                    Marker(active: touch?.dot == i, small: outline.count == 4, side: i >= sideHandlesFrom, number: outline.count == 4 && i < 4 ? i + 1 : nil)
                        .position(place.toScreen(p))
                }
                ForEach(plates) { plate in
                    Text(SizeFormat.attributed(plate.inches, size: 17, weight: .bold, color: Theme.tapeInk))
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(Theme.tape, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Color.black.opacity(0.35), lineWidth: 1))
                        .position(place.toScreen(plate.point))
                        .offset(plate.offset)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
                if let t = touch, !t.pinched, t.dot != nil || !t.moved {
                    let target = t.dot.flatMap { points.indices.contains($0) ? points[$0] : nil } ?? place.toPhoto(t.location)
                    Magnifier(image: crop(around: target, scale: place.scale))
                        .position(loupePosition(for: t.location, in: view))
                        .allowsHitTesting(false)
                }
            }
            .frame(width: view.width, height: view.height)
            .clipped()
            .contentShape(Rectangle())
            .gesture(drag(view))
            .simultaneousGesture(magnify(view))
            .overlay(alignment: .topTrailing) {
                if zoom > 1.05 {
                    Button {
                        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
                            zoom = 1
                            pan = .zero
                        }
                    } label: {
                        Text("Show all").wc(14, .semibold, relativeTo: .footnote).foregroundStyle(.white)
                            .padding(.horizontal, 12).frame(minHeight: 36)
                            .background(Capsule().fill(Color(white: 0.12, opacity: 0.85)))
                    }
                    .padding(8)
                }
            }
            .onAppear { start(view) }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(voiceOver ?? (proposed ? "Photo. We found \(points.count) corners. Touch a corner and drag to move it. Pinch to zoom."
                                                       : "Photo. \(points.count) of \(maxPoints) corners placed. Touch the photo to place a corner. Pinch to zoom."))
            .accessibilityAddTraits(.allowsDirectInteraction)
        }
    }

    /// A debug seed may open zoomed in on a corner.
    private func start(_ view: CGSize) {
        guard !started else { return }
        started = true
        guard let focus = focus, startZoom > 1 else { return }
        zoom = min(startZoom, Self.maxZoom)
        let scale = fitScale(view) * zoom
        pan = clamp(CGSize(width: (photoSize.width / 2 - focus.x) * scale, height: (photoSize.height / 2 - focus.y) * scale), zoom: zoom, view: view)
    }

    // MARK: Gestures

    private func drag(_ view: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .local)
            .onChanged { v in
                let place = self.place(view)
                var t = touch ?? begin(at: v.startLocation, place)
                t.location = v.location
                if pinch != nil {
                    t.pinched = true
                    touch = t
                    return
                }
                if hypot(v.translation.width, v.translation.height) > 8 { t.moved = true }
                if let i = t.dot, points.indices.contains(i) {
                    // Slow, relative: a marker never jumps to the finger
                    let dx = v.translation.width / place.scale * gain
                    let dy = v.translation.height / place.scale * gain
                    points[i] = clampPoint(CGPoint(x: t.dotStart.x + dx, y: t.dotStart.y + dy))
                } else if t.moved, zoom > 1.001 {
                    pan = clamp(CGSize(width: t.panStart.width + v.translation.width, height: t.panStart.height + v.translation.height), zoom: zoom, view: view)
                }
                touch = t
            }
            .onEnded { v in
                let place = self.place(view)
                defer { touch = nil }
                guard let t = touch, !t.pinched else { return }
                if let i = t.dot {
                    // Let go near a corner of the frame in the picture: onto it, when the picture is clear about where it is
                    if points.indices.contains(i), let to = snap?(i, points[i]), to != points[i] {
                        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) { points[i] = clampPoint(to) }
                        Haptics.tap()
                    }
                    onEdit()
                } else if !t.moved, points.count < maxPoints {
                    points.append(clampPoint(place.toPhoto(v.location)))
                    Haptics.tap()
                    onEdit()
                }
            }
    }

    private func begin(at location: CGPoint, _ place: Place) -> Touch {
        var nearest: (Int, CGFloat)?
        for (i, p) in points.enumerated() {
            let s = place.toScreen(p)
            let d = hypot(s.x - location.x, s.y - location.y)
            if d <= Self.grabRadius, d < (nearest?.1 ?? .infinity) { nearest = (i, d) }
        }
        return Touch(startLocation: location, location: location, dot: nearest?.0, dotStart: nearest.map { points[$0.0] } ?? .zero, panStart: pan)
    }

    private func magnify(_ view: CGSize) -> some Gesture {
        MagnifyGesture()
            .onChanged { v in
                if pinch == nil { pinch = Pinch(zoom: zoom, pan: pan, anchor: v.startLocation) }
                guard let p = pinch else { return }
                let s0 = fitScale(view)
                let newZoom = min(max(p.zoom * v.magnification, 1), Self.maxZoom)
                let center = CGPoint(x: view.width / 2, y: view.height / 2)
                // The photo point under the fingers stays under them
                let q = CGPoint(x: (p.anchor.x - center.x - p.pan.width) / (s0 * p.zoom), y: (p.anchor.y - center.y - p.pan.height) / (s0 * p.zoom))
                let newPan = CGSize(width: p.anchor.x - center.x - q.x * s0 * newZoom, height: p.anchor.y - center.y - q.y * s0 * newZoom)
                zoom = newZoom
                pan = clamp(newPan, zoom: newZoom, view: view)
            }
            .onEnded { _ in pinch = nil }
    }

    // MARK: Pieces

    private func ordered(_ pts: [CGPoint]) -> [CGPoint] {
        guard pts.count == 4, let q = CardSizing.orderedQuad(pts.map { Vec2(Double($0.x), Double($0.y)) }) else { return pts }
        return q.map { CGPoint(x: $0.x, y: $0.y) }
    }

    /// The magnifier sits above the finger (below it near the top edge), kept on screen.
    private func loupePosition(for t: CGPoint, in size: CGSize) -> CGPoint {
        let x = min(max(t.x, 80), size.width - 80)
        let above = t.y - 120
        return CGPoint(x: x, y: above > 90 ? above : min(t.y + 120, size.height - 90))
    }

    /// 4x: a square of what is on screen around the point, a quarter of the magnifier's width, drawn at the magnifier's size.
    private func crop(around p: CGPoint, scale: CGFloat) -> UIImage? {
        guard let cg = photo.image.cgImage else { return nil }
        let side = 134 / 4 / max(scale, 0.01)
        let rect = CGRect(x: p.x - side / 2, y: p.y - side / 2, width: side, height: side).integral
        // A corner near the edge: crop what exists, on a grey ground
        let bounds = CGRect(x: 0, y: 0, width: cg.width, height: cg.height)
        let inside = rect.intersection(bounds)
        guard !inside.isNull, let piece = cg.cropping(to: inside) else { return nil }
        if inside == rect { return UIImage(cgImage: piece) }
        let r = UIGraphicsImageRenderer(size: rect.size)
        return r.image { ctx in
            UIColor(white: 0.2, alpha: 1).setFill()
            ctx.fill(CGRect(origin: .zero, size: rect.size))
            UIImage(cgImage: piece).draw(at: CGPoint(x: inside.minX - rect.minX, y: inside.minY - rect.minY))
        }
    }
}

/// A corner marker: a small ring with a dot at its centre, so the corner itself stays visible inside it. `small` (the outline is the
/// rectangle itself, and these are its corners): a smaller ring with its number. `side`: the middle of a side, a small square.
private struct Marker: View {
    var active: Bool
    var small = false
    var side = false
    var number: Int?

    var body: some View {
        let d: CGFloat = small ? 16 : 20
        ZStack {
            if side {
                RoundedRectangle(cornerRadius: 3, style: .continuous).fill(Theme.tape).frame(width: 13, height: 13)
                    .overlay(RoundedRectangle(cornerRadius: 3, style: .continuous).strokeBorder(Theme.navy.opacity(0.85), lineWidth: 2))
            } else {
                Circle().strokeBorder(Theme.navy.opacity(0.75), lineWidth: 4.5).frame(width: d, height: d)
                Circle().strokeBorder(Theme.tape, lineWidth: 2.5).frame(width: d, height: d)
                Circle().fill(Theme.tape).frame(width: 3.5, height: 3.5)
                if let n = number {
                    Text("\(n)").wcMono(11, .bold, relativeTo: .caption2).foregroundStyle(.white)
                        .shadow(color: .black.opacity(0.8), radius: 1.5)
                        .offset(x: 14, y: -13)
                }
            }
        }
        .scaleEffect(active ? 1.3 : 1)
        .accessibilityHidden(true)
    }
}
