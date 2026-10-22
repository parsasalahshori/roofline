import MapKit
import RooflineCore
import SwiftUI

// The results screen's hero: the homeowner's own house from above (Apple's satellite imagery), the map settling on it, the roof
// outline drawing itself round it, then the result cards. About 2.5 s, a tap skips it, Reduce Motion and VoiceOver get the finished
// picture at once, and it never holds back the price: the cards come in by themselves, and "Continue" is on screen throughout.

/// Where the reveal is: the cards below the hero come in when it is `done`.
enum HeroStage: Equatable {
    case pending, finding, measuring, done
}

/// Shared by the results screen (which shows the cards and takes the skip tap) and the hero (which plays the animation).
@MainActor @Observable
final class HomeReveal {
    var stage: HeroStage = .pending
    /// Counted up by a tap; the hero finishes at once.
    var skipCount = 0

    func skip() { skipCount += 1 }
}

// MARK: - Shapes

/// The roof's outline as a closed line through `points`, drawn as far round as `progress` (0...1) says.
struct RoofTraceShape: Shape {
    var points: [CGPoint]
    var progress: Double

    var animatableData: Double {
        get { progress }
        set { progress = newValue }
    }

    func path(in rect: CGRect) -> Path {
        guard points.count >= 3, progress > 0 else { return Path() }
        var p = Path()
        p.move(to: points[0])
        for pt in points.dropFirst() { p.addLine(to: pt) }
        p.closeSubpath()
        return progress >= 1 ? p : p.trimmedPath(from: 0, to: progress)
    }
}

/// The roof's outline, closed, for the soft fill.
struct RoofAreaShape: Shape {
    var points: [CGPoint]

    func path(in rect: CGRect) -> Path {
        guard points.count >= 3 else { return Path() }
        var p = Path()
        p.move(to: points[0])
        for pt in points.dropFirst() { p.addLine(to: pt) }
        p.closeSubpath()
        return p
    }
}

/// Everything but the roof (fill it with the even-odd rule): a dimmer over the ground around the house.
struct AroundRoofShape: Shape {
    var points: [CGPoint]

    func path(in rect: CGRect) -> Path {
        var p = Path(rect)
        guard points.count >= 3 else { return p }
        p.move(to: points[0])
        for pt in points.dropFirst() { p.addLine(to: pt) }
        p.closeSubpath()
        return p
    }
}

/// A small dot on each corner the line has reached.
struct RoofCornersShape: Shape {
    var points: [CGPoint]
    var fractions: [Double]
    var progress: Double
    var radius: CGFloat = 3.6

    var animatableData: Double {
        get { progress }
        set { progress = newValue }
    }

    func path(in rect: CGRect) -> Path {
        var p = Path()
        guard points.count == fractions.count else { return p }
        for (pt, f) in zip(points, fractions) where f < progress {
            p.addEllipse(in: CGRect(x: pt.x - radius, y: pt.y - radius, width: radius * 2, height: radius * 2))
        }
        return p
    }
}

/// The bright dot at the front of the line while it is being drawn.
struct RoofPenShape: Shape {
    var points: [CGPoint]
    var progress: Double
    var radius: CGFloat = 5

    var animatableData: Double {
        get { progress }
        set { progress = newValue }
    }

    func path(in rect: CGRect) -> Path {
        guard progress > 0, progress < 1, let c = HomeOutlineGeometry.point(at: progress, along: points) else { return Path() }
        return Path(ellipseIn: CGRect(x: c.x - radius, y: c.y - radius, width: radius * 2, height: radius * 2))
    }
}

// MARK: - The hero

/// The satellite picture with the outline drawn on it. Fixed to `size` (the hero's frame).
struct HomeHeroMap: View {
    enum Chip: Equatable { case finding, measuring, done, none }

    let geometry: HomeOutlineGeometry
    let size: CGSize
    let reveal: HomeReveal
    let onDone: () -> Void

    private let framing: HomeOutlineGeometry.Framing
    private let animated: Bool
    private let fractions: [Double]

    @State private var position: MapCameraPosition
    /// The corners in this view's points, once the map has settled and told us where they are.
    @State private var points: [CGPoint] = []
    @State private var progress = 0.0
    @State private var fill = 0.0
    /// A navy cover over the map while its first tiles come in (the map's own placeholder is a grey grid); fades out as the camera moves.
    @State private var cover = 1.0
    @State private var chip: Chip = .finding
    /// What the map is asked for, as a multiple of the framing: MapKit does not always show the ground a region says (an animated
    /// move can land on more of it), so the first placement measures the house and the camera is nudged once to match.
    @State private var zoom = 1.0
    /// The size of the house against what was asked for, from the last placement.
    @State private var lastScale = 1.0
    @State private var runID = 0
    @State private var skipped = false

    init(geometry: HomeOutlineGeometry, size: CGSize, animated: Bool, reveal: HomeReveal, onDone: @escaping () -> Void) {
        self.geometry = geometry
        self.size = size
        self.reveal = reveal
        self.onDone = onDone
        self.animated = animated
        let tight = geometry.framing(for: size)
        framing = tight
        fractions = geometry.vertexFractions
        let start = animated ? HomeOutlineGeometry.wide(from: tight) : tight
        _position = State(initialValue: .region(start.region))
    }

    var body: some View {
        MapReader { proxy in
            ZStack {
                // What shows until the tiles are in (or if they never come): the brand's navy
                Theme.navy
                // The minimum distance is lowered: MapKit's own stops the camera short of a close frame like this one (it landed on 1.6x the ground)
                Map(position: $position, bounds: MapCameraBounds(minimumDistance: 10), interactionModes: []) {}
                    .mapStyle(.imagery(elevation: .flat))
                    .allowsHitTesting(false)
                Theme.navy.opacity(cover).allowsHitTesting(false)
                if points.count >= 3 { outlineLayers }
                chipView
            }
            .frame(width: size.width, height: size.height)
            .clipped()
            .task(id: runID) { await run(proxy) }
        }
        .frame(width: size.width, height: size.height)
        .onChange(of: reveal.skipCount) { _, _ in
            guard reveal.stage != .done else { return }
            skipped = true
            runID += 1
        }
    }

    // MARK: Layers

    private var outlineLayers: some View {
        ZStack {
            AroundRoofShape(points: points)
                .fill(Theme.navy.opacity(0.34), style: FillStyle(eoFill: true))
                .opacity(fill)
            RoofAreaShape(points: points)
                .fill(Theme.red.opacity(0.30))
                .opacity(fill)
            RoofTraceShape(points: points, progress: progress)
                .stroke(Color.white.opacity(0.92), style: StrokeStyle(lineWidth: 6.5, lineCap: .round, lineJoin: .round))
            RoofTraceShape(points: points, progress: progress)
                .stroke(Theme.red, style: StrokeStyle(lineWidth: 3.2, lineCap: .round, lineJoin: .round))
            RoofCornersShape(points: points, fractions: fractions, progress: progress)
                .fill(Color.white)
            RoofCornersShape(points: points, fractions: fractions, progress: progress, radius: 2)
                .fill(Theme.red)
            RoofPenShape(points: points, progress: progress, radius: 9)
                .fill(Theme.red.opacity(0.35))
            RoofPenShape(points: points, progress: progress, radius: 4.5)
                .fill(Color.white)
        }
        .allowsHitTesting(false)
    }

    @ViewBuilder private var chipView: some View {
        if chip != .none {
            VStack {
                HStack {
                    HStack(spacing: 6) {
                        if chip == .done {
                            IconView(icon: .check, size: 13)
                        } else {
                            ProgressView().controlSize(.mini).tint(.white)
                        }
                        Text(chipText).wc(13, .semibold, relativeTo: .caption).lineLimit(1)
                    }
                    .dynamicTypeSize(...DynamicTypeSize.xxLarge)
                    .foregroundStyle(Color.white)
                    .padding(.horizontal, 11).padding(.vertical, 6)
                    .background(Theme.navy.opacity(0.84), in: Capsule())
                    Spacer(minLength: 0)
                }
                Spacer(minLength: 0)
            }
            .padding(10)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }

    private var chipText: String {
        switch chip {
        case .finding: return "Finding your home"
        case .measuring: return "Measuring your home"
        case .done, .none: return "Measured from above"
        }
    }

    // MARK: The reveal

    private func set(_ animation: Animation?, _ change: () -> Void) {
        var t = Transaction(animation: animation)
        t.disablesAnimations = animation == nil
        withTransaction(t, change)
    }

    private func run(_ proxy: MapProxy) async {
        if skipped || !animated {
            await finish(proxy)
            return
        }
        // 1. The map settles: from further out, off to one side, onto the house
        chip = .finding
        reveal.stage = .finding
        guard await pause(0.2) else { return }
        set(.easeOut(duration: 0.4)) { cover = 0 }
        guard await pause(0.25) else { return }
        set(.easeInOut(duration: 1.0)) { position = requested }
        // 2. The outline: once the camera has arrived (the map says so), the stroke goes round, a dot on each corner
        guard await pause(0.35) else { return }
        guard await place(proxy, within: 1.6) else {
            await finish(proxy, tryToPlace: false)
            return
        }
        if !(await settleZoom(proxy, animation: .easeInOut(duration: 0.35))) { return }
        chip = .measuring
        reveal.stage = .measuring
        set(.easeInOut(duration: 0.85)) { progress = 1 }
        guard await pause(0.87) else { return }
        // 3. The soft fill, then the cards
        set(.easeOut(duration: 0.35)) { fill = 1 }
        chip = .done
        guard await pause(0.12) else { return }
        reveal.stage = .done
        onDone()
    }

    /// The finished picture, at once: no flight, no drawing.
    private func finish(_ proxy: MapProxy, tryToPlace: Bool = true) async {
        if points.count < 3, tryToPlace {
            set(nil) { position = requested }
            if await place(proxy, within: 1.2) { _ = await settleZoom(proxy, animation: nil) }
        }
        set(nil) {
            progress = 1
            fill = 1
            cover = 0
        }
        chip = points.count >= 3 ? .done : .none
        reveal.stage = .done
        onDone()
    }

    /// False when this run was cancelled (the screen went away, or a tap restarted it as a skip).
    private func pause(_ seconds: Double) async -> Bool {
        (try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))) != nil && !Task.isCancelled
    }

    private var requested: MapCameraPosition { .region(framing.scaled(by: zoom).region) }

    /// If the map came out noticeably zoomed differently from the framing, asks for the zoom that makes it right (once) and places
    /// again. False only when this run was cancelled.
    private func settleZoom(_ proxy: MapProxy, animation: Animation?) async -> Bool {
        guard abs(lastScale - 1) > 0.06, (0.4...2.5).contains(lastScale) else { return true }
        zoom *= lastScale
        set(animation) { position = requested }
        guard await pause(animation == nil ? 0.15 : 0.5) else { return false }
        _ = await place(proxy, within: 1.0)
        return !Task.isCancelled
    }

    /// Asks the map where the corners are. Waits until two answers in a row agree and are where the framing says they should be (the
    /// camera has arrived), for at most `seconds`; false when the map never gives a usable answer (the picture is then shown without
    /// the outline).
    private func place(_ proxy: MapProxy, within seconds: Double) async -> Bool {
        let expected = geometry.expectedPoints(in: framing, size: size)
        let deadline = Date().addingTimeInterval(seconds)
        var last: HomeOutlineGeometry.Placement?
        while !Task.isCancelled {
            let measured = geometry.ring.compactMap { proxy.convert($0.coordinate, to: .local) }
            if let now = geometry.placement(of: measured, expected: expected, in: size) {
                if let l = last, zip(l.points, now.points).allSatisfy({ hypot($0.x - $1.x, $0.y - $1.y) < 0.6 }) {
                    points = now.points
                    lastScale = now.scale
                    return true
                }
                last = now
            } else {
                last = nil
            }
            if Date() >= deadline { return false }
            guard await pause(0.06) else { return false }
        }
        return false
    }
}
