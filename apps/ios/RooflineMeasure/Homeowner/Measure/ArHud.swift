import RooflineCore
import SwiftUI

/// What the AR capture screen shows, as plain values: the live controller fills it in on a phone, and a sample fills it in for previews and
/// screenshots (the simulator has no AR). Nothing here touches ARKit.
struct ArCaptureModel: Equatable {
    enum Phase: Equatable {
        /// Looking for the wall.
        case searching
        /// The wall is found: Capture is on.
        case ready
        /// Capture was tapped: waiting a moment for a still hand.
        case holding
        case lost
    }

    var title = "WINDOW 1"
    /// "Depth sensor on", or nil for a phone without one.
    var deviceChip: String?
    var phase: Phase = .searching
    var hint = ArCaptureModel.searchHint
    /// Photos of this window already taken (and kept): the next is "Photo n+1".
    var photosTaken = 0

    static let searchHint = "Move the phone slowly to find the wall."
    static let maxPhotos = 3
    static func readyHint(photosTaken n: Int) -> String {
        n == 0 ? "Stand 3 to 5 feet back, aim the circle at the window, and tap Capture."
               : "Photo \(n + 1) of \(maxPhotos): the same window again, from a slightly different spot."
    }
    static let holdingHint = "Hold still."

    var canCapture: Bool { phase == .ready }
    var buttonLabel: String { phase == .holding ? "Hold still" : (phase == .lost ? "Start again" : "Capture") }
}

// MARK: - Controls over a camera picture

extension View {
    /// A round control over the camera or a photo: a 44 pt (or larger) circle of system material. Used with an SF Symbol inside.
    /// (Shared by the measuring screens; the controls follow Apple's own camera: material, not a solid dark fill.)
    func hudCircle(_ size: CGFloat = Theme.minTap) -> some View {
        frame(width: size, height: size)
            .background(.regularMaterial, in: Circle())
            .contentShape(Circle())
    }

    /// A capsule of system material (a title, a chip, a "How?" button) over the camera.
    func hudCapsule() -> some View {
        background(.regularMaterial, in: Capsule())
            .contentShape(Capsule())
    }

    /// A panel of system material with continuous corners (a hint, a readout) over the camera or a photo.
    func hudPanel(cornerRadius: CGFloat = 22) -> some View {
        background(.regularMaterial, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
    }
}

/// The measuring screen's controls over the camera: close, the title, the circle that finds the wall, the hint and the Capture button. The
/// four corners are not placed here; they are dragged on the photo this button takes (`FreezeFrameEditor`).
struct ArCaptureHud: View {
    let model: ArCaptureModel
    let onClose: () -> Void
    let onCapture: () -> Void
    var onHow: () -> Void = {}

    var body: some View {
        ZStack {
            Reticle(lost: model.phase == .lost)
            VStack(spacing: 0) {
                topBar
                Spacer()
                hint
                controls
            }
        }
        .environment(\.colorScheme, .dark)
        // Over the camera the controls stop at the largest ordinary text size: bigger would hide the window being measured
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }

    private var topBar: some View {
        HStack(alignment: .center, spacing: 10) {
            Button(action: onClose) {
                Image(systemName: WCIcon.close.symbol).font(.body.weight(.semibold)).foregroundStyle(.white).hudCircle()
            }
            .accessibilityLabel("Close")
            HStack {
                Text(model.title).font(.footnote.weight(.medium)).monospacedDigit().foregroundStyle(Color.white.opacity(0.85))
                if model.photosTaken > 0 {
                    Text("Photo \(model.photosTaken + 1)").font(.footnote.weight(.semibold)).foregroundStyle(Theme.tape)
                }
                Spacer()
                if let chip = model.deviceChip {
                    HStack(spacing: 5) {
                        Image(systemName: WCIcon.lidar.symbol).foregroundStyle(Theme.tape)
                        Text(chip).font(.subheadline.weight(.semibold)).foregroundStyle(.white)
                    }
                }
            }
            .padding(.horizontal, 16).frame(minHeight: Theme.minTap)
            .hudCapsule()
            .accessibilityElement(children: .combine)
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
    }

    private var hint: some View {
        HStack(spacing: 10) {
            Image(systemName: WCIcon.target.symbol).font(.title3).foregroundStyle(Theme.tape)
            Text(model.hint).font(.body.weight(.medium)).foregroundStyle(.white).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .hudPanel()
        .padding(.horizontal, 16)
        .accessibilityElement(children: .combine)
        .padding(.bottom, 12)
    }

    private var controls: some View {
        VStack(spacing: 10) {
            ZStack {
                shutter
                HStack {
                    Spacer()
                    // Off the picture, at the side, so it never covers the window
                    HowButton(action: onHow).frame(minWidth: 56, minHeight: 56)
                }
            }
            .padding(.horizontal, 28)
            Text(model.buttonLabel).font(.headline).foregroundStyle(.white).padding(.bottom, 6)
        }
        .padding(.top, 14)
        .padding(.bottom, 8)
        .background(LinearGradient(colors: [Color.black.opacity(0), Color.black.opacity(0.6)], startPoint: .top, endPoint: .bottom).ignoresSafeArea(edges: .bottom))
    }

    /// The Capture button: a white ring and the accent disc, with a camera in it (the system camera's shutter, in WinChoice red).
    private var shutter: some View {
        Button(action: onCapture) {
            ZStack {
                Circle().strokeBorder(Color.white, lineWidth: 4).frame(width: 82, height: 82)
                Circle().fill(model.canCapture ? Theme.buttonFill : Color(.systemGray)).frame(width: 66, height: 66)
                if model.phase == .holding {
                    ProgressView().progressViewStyle(.circular).tint(.white)
                } else {
                    Image(systemName: "camera.fill").font(.title2).foregroundStyle(.white)
                }
            }
        }
        .disabled(!model.canCapture)
        .accessibilityLabel("Capture")
        .accessibilityHint("Takes a photo of the window to mark its corners on")
    }
}

/// The circle at the middle of the picture: it finds the wall the window is on. White rings with a cross.
private struct Reticle: View {
    let lost: Bool

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
        .opacity(lost ? 0.35 : 1)
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
            Text("4× magnifier").font(.footnote.weight(.semibold)).monospacedDigit().foregroundStyle(.white)
                .padding(.horizontal, 10).padding(.vertical, 4)
                .background(.regularMaterial, in: Capsule())
        }
        .accessibilityHidden(true)
    }
}
