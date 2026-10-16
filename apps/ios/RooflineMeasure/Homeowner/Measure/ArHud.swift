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

    var title = "WINDOW 1"
    /// "Depth sensor on", or nil for a phone without one.
    var deviceChip: String?
    var readout = LiveReadout()
    var hint = "Move the phone slowly to find the wall."
    var phase: Phase = .searching
    var canPlace = false
    var canUndo = false
    var dots: [CGPoint] = []
    var edges: [Edge] = []
    var loupe: UIImage?
    /// The corner the button will place next (1 to 4).
    var nextCorner: Int { min(readout.placed + 1, 4) }

    var buttonLabel: String {
        switch phase {
        case .complete: return "All four corners set"
        case .sampling: return "Hold still"
        case .holdStill: return "Hold the phone still"
        case .lost: return "Start again"
        default: return "Tap corner \(nextCorner)"
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

    var body: some View {
        ZStack {
            // Corners and side plates sit on the picture
            GeometryReader { _ in
                ForEach(Array(model.dots.enumerated()), id: \.offset) { _, p in
                    Circle().fill(Theme.tape).frame(width: 22, height: 22)
                        .overlay(Circle().strokeBorder(Theme.navy, lineWidth: 2))
                        .position(p)
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
            if model.phase != .complete { Reticle(phase: model.phase) }
            VStack(spacing: 0) {
                topBar
                HStack(alignment: .top) {
                    Magnifier(image: model.loupe)
                    Spacer()
                }
                .padding(.leading, 16).padding(.top, 14)
                Spacer()
                hint
                controls
            }
        }
        .environment(\.colorScheme, .dark)
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
                mainButton
                Spacer()
                roundButton(icon: .check, enabled: model.phase == .complete, label: "Use these four corners", highlighted: model.phase == .complete, action: onDone)
            }
            .padding(.horizontal, 28)
            Text(model.buttonLabel).wc(17, .semibold, relativeTo: .headline).foregroundStyle(.white).padding(.bottom, 6)
        }
        .padding(.top, 14)
        .padding(.bottom, 8)
        .background(LinearGradient(colors: [Color.black.opacity(0), Color.black.opacity(0.78)], startPoint: .top, endPoint: .bottom).ignoresSafeArea(edges: .bottom))
    }

    private var mainButton: some View {
        Button(action: model.phase == .complete ? onDone : onPlace) {
            ZStack {
                Circle().strokeBorder(Color.white, lineWidth: 5).frame(width: 82, height: 82)
                if case .sampling(let p) = model.phase {
                    Circle().trim(from: 0, to: max(0.03, p)).stroke(Theme.tape, style: StrokeStyle(lineWidth: 5, lineCap: .round)).rotationEffect(.degrees(-90)).frame(width: 82, height: 82)
                }
                Circle().fill(model.canPlace || model.phase == .complete ? Theme.red : Color.gray.opacity(0.5)).frame(width: 64, height: 64)
                IconView(icon: model.phase == .complete ? .check : .plus, size: 30, weight: 2.2).foregroundStyle(.white)
            }
        }
        .disabled(!(model.canPlace || model.phase == .complete))
        .accessibilityLabel(model.phase == .complete ? "Use these four corners" : "Place corner \(model.nextCorner)")
        .accessibilityHint("Aim the circle at the corner of the window frame first")
    }

    private func roundButton(icon: WCIcon, enabled: Bool, label: String, highlighted: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            IconView(icon: icon, size: 24, weight: 2)
                .foregroundStyle(enabled ? .white : Color.white.opacity(0.35))
                .frame(width: 56, height: 56)
                .background(Circle().fill(highlighted ? Theme.red : Color(white: 0.12, opacity: 0.8)))
        }
        .disabled(!enabled)
        .accessibilityLabel(label)
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
