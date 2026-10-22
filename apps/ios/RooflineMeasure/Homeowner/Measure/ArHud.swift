import RooflineCore
import SwiftUI

/// What the AR measuring screen shows, as plain values: the live controller fills it in on a phone, and a sample fills it in
/// for previews and screenshots (the simulator has no AR). Nothing here touches ARKit.
struct ArHudModel: Equatable {
    enum Phase: Equatable {
        case searching
        case ready
        case sampling(Double)
        case holdStill
        case complete
        case lost
    }

    struct Edge: Equatable, Identifiable {
        var id: Int
        var point: CGPoint
        var inches: Double
        var live: Bool
    }

    /// Every corner of the frame is inside the photo taken at the 4th tap (else "Use this size" waits).
    var cornersInPhoto = true
    var title = "WINDOW 1"
    /// "Depth sensor on", or nil for a phone without one.
    var deviceChip: String?
    var readout = LiveReadout()
    var hint = "Move the phone slowly to find the wall."
    var phase: Phase = .searching
    var canPlace = false
    var canUndo = false
    var dots: [CGPoint] = []
    /// The window outline the phone found (TL, TR, BR, BL, full-screen points), or empty. With it the screen offers "Use these corners".
    var proposal: [CGPoint] = []
    var edges: [Edge] = []
    var loupe: UIImage?
    /// The number each dot shows (empty: 1, 2, 3, 4 in order). While one corner is placed again the others keep their own numbers.
    var dotNumbers: [Int] = []
    /// The corner (1 to 4) that looks off the frame once the four are placed: its dot gets a red ring and "Redo corner N" is offered.
    var flaggedCorner: Int?
    /// The corner (1 to 4) being placed again, or nil.
    var redoing: Int?
    /// The corner the button will place next (1 to 4): the one being placed again, or the next in order.
    var nextCorner: Int { redoing ?? min(readout.placed + 1, 4) }

    /// The number the dot at `index` shows.
    func number(ofDot index: Int) -> Int { index < dotNumbers.count ? dotNumbers[index] : index + 1 }

    static let cornerNames = ["top-left", "top-right", "bottom-right", "bottom-left"]

    /// The hint while one corner is placed again.
    static func redoHint(corner n: Int) -> String {
        "Aim the ring at the \(cornerNames[min(max(n, 1), 4) - 1]) corner (corner \(n)) again, then tap."
    }

    /// The hint for a corner that looks off the frame (the other three agree with each other, this one does not).
    static func offCornerHint(corner n: Int) -> String { "Corner \(n) looks off the frame. Move it onto the corner and tap again." }

    /// The hint for the next corner, by name, one at a time (the corners are asked for top-left first, clockwise).
    static func cornerHint(placed: Int) -> String {
        switch placed {
        case 0: return "Aim the ring at the top-left corner of the frame"
        case 1: return "Now the top-right corner"
        case 2: return "Now the bottom-right corner"
        default: return "Last one: the bottom-left corner"
        }
    }

    var canUse: Bool { phase == .complete && cornersInPhoto }

    /// An outline is on screen and no corner is placed: "Use these corners" is offered.
    var hasProposal: Bool { proposal.count == 4 && phase == .ready && readout.placed == 0 }

    /// What the hint says while an outline is offered.
    static let proposalHint = "We found your window. Use these corners, or tap them yourself."

    var buttonLabel: String {
        switch phase {
        case .complete: return "Use this size"
        case .sampling: return "Hold still"
        case .holdStill: return "Hold the phone still"
        case .lost: return "Start again"
        default: return redoing != nil ? "Tap corner \(nextCorner) again" : "Tap corner \(nextCorner)"
        }
    }
}

/// The measuring screen's controls over the camera (ios-hw-07): close, the live size, the magnifier, the corners, the hint and
/// the big red button. Positions of corners and side plates are in the full screen's coordinates.
struct ArHud: View {
    let model: ArHudModel
    let onClose: () -> Void
    let onPlace: () -> Void
    let onUndo: () -> Void
    let onDone: () -> Void
    var onHow: () -> Void = {}
    var onUseProposal: () -> Void = {}
    /// A placed corner's dot was tapped (its number, 1 to 4): place that one again.
    var onRedo: (Int) -> Void = { _ in }

    /// Where the status card ends and how wide the screen is, as laid out (the magnifier stays clear of the corners).
    @State private var topBarFrame = CGRect(x: 12, y: 8, width: 378, height: 124)

    var body: some View {
        ZStack {
            // Corners and side plates sit on the picture
            GeometryReader { _ in
                if model.hasProposal { outline(model.proposal) }
                ForEach(Array(model.dots.enumerated()), id: \.offset) { i, p in
                    cornerDot(number: model.number(ofDot: i)).position(p)
                }
                ForEach(model.edges) { e in
                    Text(SizeFormat.attributed(e.inches, size: 17, weight: .bold, color: Theme.tapeInk))
                        .padding(.horizontal, 10).padding(.vertical, 6)
                        .background(Theme.tape.opacity(e.live ? 0.85 : 1), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .position(e.point)
                        .accessibilityHidden(true)
                }
            }
            .ignoresSafeArea()
            if model.phase != .complete {
                Reticle(phase: model.phase)
                // Which corner is next: a ghost numbered dot beside the ring, once the first is down
                if model.readout.placed >= 1 && model.readout.placed < 4 {
                    Circle().strokeBorder(Theme.tape, style: StrokeStyle(lineWidth: 2, dash: [3, 3])).frame(width: 26, height: 26)
                        .overlay(Text("\(model.nextCorner)").wcMono(13, .bold, relativeTo: .caption).foregroundStyle(Theme.tape))
                        .background(Circle().fill(Color.black.opacity(0.35)))
                        .offset(x: 38, y: -38)
                        .accessibilityHidden(true)
                }
            }
            VStack(spacing: 0) {
                topBar
                    .background(GeometryReader { g in Color.clear.preference(key: HudTopBarKey.self, value: g.frame(in: .global)) })
                // The magnifier keeps clear of the corners on screen: top left unless one is under it, then top right
                HStack(alignment: .top) {
                    if loupeSide != .leading { Spacer() }
                    Magnifier(image: model.loupe)
                    if loupeSide != .trailing { Spacer() }
                }
                .padding(.horizontal, LoupePlacement.inset).padding(.top, LoupePlacement.gap + (loupeSide == .center ? LoupePlacement.centerDrop : 0))
                Spacer()
                hint
                controls
            }
        }
        .onPreferenceChange(HudTopBarKey.self) { topBarFrame = $0 }
        .environment(\.colorScheme, .dark)
        // Over the camera the controls stop at the largest ordinary text size: bigger would hide the window being measured
        // (VoiceOver reads the same words at any size)
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }

    private var loupeSide: LoupePlacement.Side {
        LoupePlacement.side(avoiding: model.dots + (model.hasProposal ? model.proposal : []), topBarBottom: topBarFrame.maxY, screenWidth: topBarFrame.maxX + 12)
    }

    /// A placed corner: a numbered tape dot. Once the four are placed a dot is a button (place that corner again), and the one that looks
    /// off the frame has a pulsing red ring.
    @ViewBuilder private func cornerDot(number: Int) -> some View {
        let dot = Circle().fill(Theme.tape).frame(width: 22, height: 22)
            .overlay(Circle().strokeBorder(Theme.navy, lineWidth: 2))
            .overlay(Text("\(number)").wcMono(12, .bold, relativeTo: .caption2).foregroundStyle(Theme.tapeInk))
        if model.phase == .complete {
            Button { onRedo(number) } label: {
                ZStack {
                    if model.flaggedCorner == number { FlagRing() }
                    dot
                }
                .frame(width: 44, height: 44)
                .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Corner \(number)")
            .accessibilityHint(model.flaggedCorner == number ? "Looks off the frame. Double tap to place it again" : "Double tap to place it again")
        } else {
            dot
        }
    }

    /// The window the phone found: a dashed tape outline with a ring on each corner, on the picture (fixed on the wall, as the tape is).
    private func outline(_ q: [CGPoint]) -> some View {
        ZStack {
            Path { p in
                p.move(to: q[0])
                q.dropFirst().forEach { p.addLine(to: $0) }
                p.closeSubpath()
            }
            .stroke(Color.black.opacity(0.45), style: StrokeStyle(lineWidth: 5.5, lineJoin: .round))
            Path { p in
                p.move(to: q[0])
                q.dropFirst().forEach { p.addLine(to: $0) }
                p.closeSubpath()
            }
            .stroke(Theme.tape, style: StrokeStyle(lineWidth: 3, lineJoin: .round, dash: [10, 6]))
            ForEach(0..<4, id: \.self) { i in
                Circle().strokeBorder(Theme.tape, lineWidth: 3).frame(width: 22, height: 22)
                    .background(Circle().fill(Color.black.opacity(0.3)))
                    .position(q[i])
            }
        }
        .accessibilityHidden(true)
    }

    private var topBar: some View {
        HStack(alignment: .top, spacing: 10) {
            Button(action: onClose) {
                IconView(icon: .close, size: 20, weight: 2).foregroundStyle(.white)
                    .frame(width: 44, height: 44).background(Circle().fill(Color(white: 0.12, opacity: 0.75)))
            }
            .accessibilityLabel("Close")
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(model.title).wcMono(14, .medium, relativeTo: .footnote).foregroundStyle(Color.white.opacity(0.7))
                    Spacer()
                    if let chip = model.deviceChip {
                        HStack(spacing: 5) {
                            IconView(icon: .lidar, size: 16)
                            Text(chip).wc(15, .semibold, relativeTo: .subheadline)
                        }
                        .foregroundStyle(Theme.tape)
                    }
                }
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("Width").wc(15, relativeTo: .subheadline).foregroundStyle(Color.white.opacity(0.7))
                    readoutNumber(model.readout.widthIn)
                    Text("Height").wc(15, relativeTo: .subheadline).foregroundStyle(Color.white.opacity(0.7))
                    readoutNumber(model.readout.heightIn)
                    Text("in").wcMono(15, .semibold, relativeTo: .subheadline).foregroundStyle(.white)
                }
                .lineLimit(1).minimumScaleFactor(0.7)
                HStack(spacing: 8) {
                    ForEach(0..<4, id: \.self) { i in
                        Circle().fill(i < model.readout.placed ? Theme.tape : Color.clear).frame(width: 12, height: 12)
                            .overlay(Circle().strokeBorder(i < model.readout.placed ? Theme.tape : Color.white.opacity(0.7), lineWidth: 2))
                    }
                    Text("\(model.readout.placed) of 4 corners set").wc(15, relativeTo: .subheadline).foregroundStyle(Color.white.opacity(0.85))
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Color(white: 0.14, opacity: 0.78)))
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Color.white.opacity(0.08), lineWidth: 1))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityReadout)
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
    }

    @ViewBuilder private func readoutNumber(_ inches: Double?) -> some View {
        if let v = inches {
            Text(SizeFormat.attributed(v, size: 30, weight: .medium, color: .white))
        } else {
            Text("–").wcMono(30, .medium, relativeTo: .title).foregroundStyle(Color.white.opacity(0.4))
        }
    }

    private var accessibilityReadout: String {
        var parts = [model.title.capitalized]
        if let w = model.readout.widthIn { parts.append("Width \(SizeWording.spoken(w)) inches") }
        if let h = model.readout.heightIn { parts.append("Height \(SizeWording.spoken(h)) inches") }
        parts.append("\(model.readout.placed) of 4 corners set")
        return parts.joined(separator: ". ")
    }

    /// Over the hint, when the phone found the window: one tap puts all four corners on it.
    private var useCorners: some View {
        Button(action: onUseProposal) {
            HStack(spacing: 8) {
                IconView(icon: .check, size: 18, weight: 2.2)
                Text("Use these corners").wc(17, .bold, relativeTo: .headline)
            }
            .foregroundStyle(Theme.tapeInk)
            .padding(.horizontal, 22)
            .frame(minHeight: 48)
            .background(Capsule().fill(Theme.tape))
            .overlay(Capsule().strokeBorder(Color.black.opacity(0.5), lineWidth: 2))
        }
        .accessibilityLabel("Use these corners")
        .accessibilityHint("Puts the four corners on the window outlined in yellow")
    }

    /// A corner looks off the frame: place just that one again (the other three and the wall stay).
    private func redoButton(corner n: Int) -> some View {
        Button { onRedo(n) } label: {
            HStack(spacing: 8) {
                IconView(icon: .undo, size: 18, weight: 2.2)
                Text("Redo corner \(n)").wc(17, .bold, relativeTo: .headline)
            }
            .foregroundStyle(Theme.tapeInk)
            .padding(.horizontal, 22)
            .frame(minHeight: 48)
            .background(Capsule().fill(Theme.tape))
            .overlay(Capsule().strokeBorder(Color.black.opacity(0.5), lineWidth: 2))
        }
        .accessibilityLabel("Redo corner \(n)")
        .accessibilityHint("Aim at the real corner and tap to place just this one again")
    }

    private var hint: some View {
        HStack(spacing: 10) {
            IconView(icon: .target, size: 20).foregroundStyle(Theme.tape)
            Text(model.hint).wc(17, .medium, relativeTo: .body).foregroundStyle(.white).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(Capsule().fill(Color(white: 0.14, opacity: 0.78)))
        .padding(.horizontal, 16)
        .accessibilityElement(children: .combine)
        .padding(.bottom, 12)
    }

    private var controls: some View {
        VStack(spacing: 10) {
            HStack {
                roundButton(icon: .undo, enabled: model.canUndo, label: "Undo the last corner", action: onUndo)
                Spacer()
                if model.phase == .complete { usePill } else { mainButton }
                Spacer()
                // Opposite the undo button, off the picture so it never covers a corner
                HowButton(action: onHow).frame(minWidth: 56, minHeight: 56)
            }
            .padding(.horizontal, 28)
            if model.phase != .complete {
                // The outline the phone found is offered where the caption of the red button is: at the bottom, clear of the window's corners
                if model.hasProposal { useCorners.padding(.bottom, 2) } else {
                    Text(model.buttonLabel).wc(17, .semibold, relativeTo: .headline).foregroundStyle(.white).padding(.bottom, 6)
                }
            } else if let n = model.flaggedCorner {
                redoButton(corner: n).padding(.bottom, 2)
            }
        }
        .padding(.top, 14)
        .padding(.bottom, 8)
        .background(LinearGradient(colors: [Color.black.opacity(0), Color.black.opacity(0.78)], startPoint: .top, endPoint: .bottom).ignoresSafeArea(edges: .bottom))
    }

    /// After four corners: the one red button says what it does.
    private var usePill: some View {
        Button(action: onDone) {
            HStack(spacing: 8) {
                IconView(icon: .check, size: 20, weight: 2.2)
                Text("Use this size").wc(18, .bold, relativeTo: .headline)
            }
            .foregroundStyle(Theme.onRed)
            .padding(.horizontal, 24)
            .frame(minHeight: 56)
            .background(Capsule().fill(Theme.red))
            .overlay(Capsule().strokeBorder(Color.white, lineWidth: 3))
            .opacity(model.canUse ? 1 : 0.45)
        }
        .disabled(!model.canUse)
        .accessibilityLabel("Use this size")
        .accessibilityHint(model.canUse ? "Keeps these four corners and goes on to name the window" : "Step back so the whole window is on screen")
    }

    private var mainButton: some View {
        Button(action: onPlace) {
            ZStack {
                Circle().strokeBorder(Color.white, lineWidth: 5).frame(width: 82, height: 82)
                if case .sampling(let p) = model.phase {
                    Circle().trim(from: 0, to: max(0.03, p)).stroke(Theme.tape, style: StrokeStyle(lineWidth: 5, lineCap: .round)).rotationEffect(.degrees(-90)).frame(width: 82, height: 82)
                }
                Circle().fill(model.canPlace ? Theme.red : Color.gray.opacity(0.5)).frame(width: 64, height: 64)
                IconView(icon: .plus, size: 30, weight: 2.2).foregroundStyle(.white)
            }
        }
        .disabled(!model.canPlace)
        .accessibilityLabel("Place corner \(model.nextCorner)")
        .accessibilityHint("Aim the circle at the corner of the window frame first")
    }

    private func roundButton(icon: WCIcon, enabled: Bool, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            IconView(icon: icon, size: 24, weight: 2)
                .foregroundStyle(enabled ? .white : Color.white.opacity(0.35))
                .frame(width: 56, height: 56)
                .background(Circle().fill(Color(white: 0.12, opacity: 0.8)))
        }
        .disabled(!enabled)
        .accessibilityLabel(label)
    }
}

/// The magnifier clears the corners: where the status card ends (and, from its width, the screen's).
private struct HudTopBarKey: PreferenceKey {
    static var defaultValue = CGRect(x: 12, y: 8, width: 378, height: 124)
    static func reduce(value: inout CGRect, nextValue: () -> CGRect) { value = nextValue() }
}

/// A red ring round the corner that looks off the frame; it pulses (not with Reduce Motion).
private struct FlagRing: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulse = false

    var body: some View {
        ZStack {
            Circle().strokeBorder(Color.white, lineWidth: 6).frame(width: 38, height: 38)
            Circle().strokeBorder(Theme.red, lineWidth: 4).frame(width: 38, height: 38)
        }
        .scaleEffect(pulse && !reduceMotion ? 1.22 : 1)
        .opacity(pulse && !reduceMotion ? 0.7 : 1)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.8).repeatForever(autoreverses: true), value: pulse)
        .onAppear { pulse = true }
        .accessibilityHidden(true)
    }
}

/// The circle at the middle of the picture: aim it at the corner. White rings with a cross; it fills with the sampling.
private struct Reticle: View {
    let phase: ArHudModel.Phase

    var body: some View {
        ZStack {
            Circle().strokeBorder(Color.white, lineWidth: 2).frame(width: 34, height: 34)
            Path { p in
                p.move(to: CGPoint(x: -26, y: 0)); p.addLine(to: CGPoint(x: -9, y: 0))
                p.move(to: CGPoint(x: 9, y: 0)); p.addLine(to: CGPoint(x: 26, y: 0))
                p.move(to: CGPoint(x: 0, y: -26)); p.addLine(to: CGPoint(x: 0, y: -9))
                p.move(to: CGPoint(x: 0, y: 9)); p.addLine(to: CGPoint(x: 0, y: 26))
            }
            .stroke(Color.white, lineWidth: 2)
            Circle().fill(Color.white).frame(width: 5, height: 5)
        }
        .opacity(phase == .lost ? 0.35 : 1)
        .shadow(color: .black.opacity(0.5), radius: 2)
        .accessibilityHidden(true)
    }
}

/// The 4x magnifier: the picture around the circle, enlarged, so a corner can be hit exactly.
struct Magnifier: View {
    let image: UIImage?
    var diameter: CGFloat = 134

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ZStack {
                Circle().fill(Color(white: 0.2))
                if let image = image {
                    Image(uiImage: image).resizable().scaledToFill().frame(width: diameter, height: diameter).clipShape(Circle())
                }
                // A cross in the middle, as on the picture
                Path { p in
                    p.move(to: CGPoint(x: diameter / 2 - 24, y: diameter / 2)); p.addLine(to: CGPoint(x: diameter / 2 - 8, y: diameter / 2))
                    p.move(to: CGPoint(x: diameter / 2 + 8, y: diameter / 2)); p.addLine(to: CGPoint(x: diameter / 2 + 24, y: diameter / 2))
                    p.move(to: CGPoint(x: diameter / 2, y: diameter / 2 - 24)); p.addLine(to: CGPoint(x: diameter / 2, y: diameter / 2 - 8))
                    p.move(to: CGPoint(x: diameter / 2, y: diameter / 2 + 8)); p.addLine(to: CGPoint(x: diameter / 2, y: diameter / 2 + 24))
                }
                .stroke(Color.white, lineWidth: 2)
                Circle().fill(Color.white).frame(width: 5, height: 5)
                Circle().strokeBorder(Color.white, lineWidth: 4)
            }
            .frame(width: diameter, height: diameter)
            .shadow(color: .black.opacity(0.4), radius: 6)
            Text("4× magnifier").wcMono(14, .semibold, relativeTo: .footnote).foregroundStyle(.white)
                .padding(.horizontal, 10).padding(.vertical, 4)
                .background(Capsule().fill(Color(white: 0.14, opacity: 0.8)))
        }
        .accessibilityHidden(true)
    }
}
