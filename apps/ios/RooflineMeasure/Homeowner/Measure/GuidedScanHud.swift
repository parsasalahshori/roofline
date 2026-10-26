import RooflineCore
import SwiftUI

// The guided scan's camera screens, in Apple's own patterns (like the Measure app and Object Capture): system materials for the chrome over
// the camera, text styles that follow Dynamic Type, SF Symbols, standard bordered buttons, a large round shutter with a progress ring, and a
// haptic on every photo. Nothing is drawn over the picture that a system control already does.

/// What a coaching message looks like: an SF Symbol and whether it is a problem to fix.
enum ScanCoachLook {
    static func symbol(_ c: ScanCoach) -> String {
        switch c.code {
        case .sweep, .stepFurther, .trackingLimited: return "arrow.left.and.right"
        case .tooFast: return "tortoise.fill"
        case .tooDark: return "moon.fill"
        case .tooBright: return "sun.max.fill"
        case .lowDetail: return "eye.slash"
        case .windowNotInView: return "viewfinder"
        case .findingWindow: return "magnifyingglass"
        case .stoppedTooEarly: return "exclamationmark.triangle.fill"
        case .closeupFar: return "plus.magnifyingglass"
        case .closeupNear: return "minus.magnifyingglass"
        case .closeupCentre, .closeupHold: return "scope"
        case .cornerBehind: return "arrow.uturn.left"
        case .cornerDone, .sweepDone, .allDone: return "checkmark.circle.fill"
        case .needWindow: return "rectangle.dashed"
        }
    }

    static func tint(_ c: ScanCoach) -> Color {
        if c.isProblem { return .yellow }
        switch c.code {
        case .cornerDone, .sweepDone, .allDone: return .green
        default: return .white
        }
    }
}

/// A short instruction on a material pill, at the top of the camera.
struct ScanPill: View {
    let symbol: String
    let text: String
    var tint: Color = .white
    var busy = false

    var body: some View {
        HStack(spacing: 10) {
            if busy {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: symbol).foregroundStyle(tint).imageScale(.large)
            }
            Text(text).font(.headline).foregroundStyle(.primary).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(.ultraThinMaterial, in: Capsule())
        .padding(.horizontal, 16)
        .accessibilityElement(children: .combine)
    }
}

/// The round close button of a camera screen: a material circle, 44 pt.
private struct ScanCloseButton: View {
    let action: () -> Void
    var label = "Close"
    var body: some View {
        Button(action: action) {
            Image(systemName: "xmark").font(.body.weight(.semibold)).foregroundStyle(.primary)
                .frame(width: 44, height: 44).background(.ultraThinMaterial, in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

// MARK: Aim

/// Before Start: the camera finds the wall (Apple's coaching overlay helps), the person aims at the window and taps Start.
struct ScanAimOverlay: View {
    let title: String
    let ready: Bool
    let depth: Bool
    let onClose: () -> Void
    let onStart: () -> Void
    let onSinglePhoto: () -> Void

    var body: some View {
        VStack(spacing: 12) {
            HStack {
                ScanCloseButton(action: onClose)
                Spacer()
                Text(title).font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                    .padding(.horizontal, 12).padding(.vertical, 8).background(.ultraThinMaterial, in: Capsule())
                    .accessibilityLabel(title.capitalized)
            }
            .padding(.horizontal, 12)
            ScanPill(symbol: ready ? "viewfinder" : "arrow.left.and.right",
                     text: ready ? "Stand 5 to 8 feet back and fit the whole window in view. Then tap Start." : "Move your iPhone slowly to find the wall.", tint: ready ? .white : .yellow)
            Spacer()
            Image(systemName: "plus").font(.largeTitle.weight(.ultraLight)).foregroundStyle(.white.opacity(0.9)).shadow(radius: 2).accessibilityHidden(true)
            Spacer()
            VStack(spacing: 10) {
                Button(action: onStart) {
                    ZStack {
                        Circle().strokeBorder(.white, lineWidth: 4).frame(width: 78, height: 78)
                        Circle().fill(ready ? Theme.red : Color.gray.opacity(0.6)).frame(width: 64, height: 64)
                        Image(systemName: "play.fill").font(.title2).foregroundStyle(.white)
                    }
                    .frame(minWidth: 88, minHeight: 88)
                }
                .disabled(!ready)
                .accessibilityLabel("Start scan")
                .accessibilityHint("Starts a scan of about ten seconds: step slowly left and right, then move closer to each corner")
                Text("Start scan").font(.headline).foregroundStyle(.white).shadow(radius: 2)
                Button("Take one photo instead", action: onSinglePhoto)
                    .buttonStyle(.bordered).controlSize(.regular).frame(minHeight: 44)
            }
            .padding(.bottom, 12)
        }
        .environment(\.colorScheme, .dark)
        .tint(Theme.red)
        // Over the camera the controls stop at the largest ordinary text size: bigger would hide the window being measured
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }
}

// MARK: Scanning

/// During the scan: the instruction, the progress, the target for the next close-up, and the shutter ring.
struct ScanCaptureOverlay: View {
    let ui: ScanUiState
    let shots: [ScanShot]
    let finding: Bool
    let corners: [Vec3]?
    let title: String
    let onClose: () -> Void
    let onRedo: () -> Void
    let onShutter: () -> Void
    let onNext: () -> Void
    let onSkip: () -> Void
    let onStop: () -> Void
    /// The room-scan hybrid's close-up step: only the four corners are asked for (the regular photos were taken while panning), "Done" ends the
    /// window's close-ups, and the camera picture has the pan photos' size even before a close-up has been kept.
    var closeupsOnly = false
    var stopTitle = "Stop"
    var stopEnabled: Bool?
    var photoSize: CGSize?
    var closeTitle = "Close"
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var step: ScanStep? { ui.step }
    private var coach: ScanCoach { step?.coach ?? ScanCoach(closeupsOnly ? .sweepDone : .sweep) }
    private var text: String { ScanCopy.text(coach) }
    private var inCloseups: Bool { closeupsOnly || step?.phase == .closeups }
    private var regular: Int { step?.regularKept ?? 0 }
    private var target: ScanGuideConfig { ScanGuideConfig() }
    /// 0 ... 1 over the whole scan: half for the regular photos, half for the corners.
    private var progress: Double {
        let r = min(1, Double(regular) / Double(target.targetRegular))
        let c = Double(step?.closeupsDone ?? 0) / 4
        return closeupsOnly ? c : (r + c) / 2
    }

    var body: some View {
        ZStack {
            targetMark
            VStack(spacing: 10) {
                HStack {
                    ScanCloseButton(action: onClose, label: closeTitle)
                    Spacer()
                    if closeupsOnly {
                        Text(title).font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                            .padding(.horizontal, 12).padding(.vertical, 8).background(.ultraThinMaterial, in: Capsule())
                            .accessibilityLabel(title.capitalized)
                        Spacer()
                    }
                    Button(stopTitle, action: onStop).buttonStyle(.bordered).controlSize(.regular).frame(minHeight: 44)
                        .disabled(!(stopEnabled ?? (regular >= ScanLimits.minFrames)))
                        .accessibilityHint(closeupsOnly ? "Goes back to the list of windows with the close-ups taken so far" : "Measures from the photos taken so far")
                }
                .padding(.horizontal, 12)
                ScanPill(symbol: ScanCoachLook.symbol(coach), text: text, tint: ScanCoachLook.tint(coach), busy: coach.code == .findingWindow)
                progressRow
                Spacer()
                bottomBar
            }
        }
        .environment(\.colorScheme, .dark)
        .tint(Theme.red)
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        .sensoryFeedback(.impact(weight: .medium), trigger: ui.shotCount)
        .sensoryFeedback(.success, trigger: step?.phase == .finished)
        .onChange(of: text) { _, new in
            // VoiceOver says what to change; the plain instruction is not repeated
            if coach.isProblem || inCloseups { AccessibilityNotification.Announcement(new).post() }
        }
    }

    // MARK: Progress

    @ViewBuilder private var progressRow: some View {
        if inCloseups {
            HStack(spacing: 14) {
                ForEach(0..<4, id: \.self) { i in
                    let taken = step?.closeupsKept.indices.contains(i) == true ? step!.closeupsKept[i] : false
                    let current = (step?.target?.corner ?? step?.closeupsDone ?? 0) == i && !taken
                    VStack(spacing: 2) {
                        Image(systemName: taken ? "checkmark.circle.fill" : (current ? "circle.inset.filled" : "circle"))
                            .foregroundStyle(taken ? .green : (current ? Theme.tape : .white.opacity(0.7)))
                        Text(ScanCorner.short[i]).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(ScanCorner.names[i]) corner, \(taken ? "done" : (current ? "now" : "next"))")
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 6).background(.ultraThinMaterial, in: Capsule())
        } else if !closeupsOnly {
            HStack(spacing: 6) {
                ForEach(0..<target.targetRegular, id: \.self) { i in
                    Circle().fill(i < regular ? Color.white : Color.white.opacity(0.3)).frame(width: 9, height: 9)
                }
                Text(ScanCopy.progress(step ?? placeholder, targetRegular: target.targetRegular)).font(.footnote.weight(.semibold)).foregroundStyle(.secondary).padding(.leading, 4)
            }
            .padding(.horizontal, 14).padding(.vertical, 8).background(.ultraThinMaterial, in: Capsule())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(regular) of \(target.targetRegular) photos")
        }
    }

    private var placeholder: ScanStep {
        ScanStep(phase: .sweep, coach: ScanCoach(.sweep), regularKept: 0, closeupsKept: [false, false, false, false], closeupsDone: 0)
    }

    // MARK: The corner to go to

    /// The ring on the corner being asked for when it is on the screen; a big arrow toward it when it is not.
    @ViewBuilder private var targetMark: some View {
        if inCloseups, let t = step?.target, let photo = photoSize ?? shots.first.map({ CGSize(width: $0.view.photoWidthPx, height: $0.view.photoHeightPx) }) {
            GeometryReader { geo in
                let size = geo.size
                // The camera picture fills the screen (aspect fill): one photo pixel is this many points
                let scale = max(size.width / max(photo.width, 1), size.height / max(photo.height, 1))
                if let o = t.offsetPortrait {
                    let p = CGPoint(x: size.width / 2 + o.x * scale, y: size.height / 2 + o.y * scale)
                    let onScreen = p.x > 40 && p.x < size.width - 40 && p.y > 120 && p.y < size.height - 190
                    if onScreen {
                        cornerRing(t).position(p)
                    } else {
                        arrow(toward: CGVector(dx: o.x, dy: o.y), in: size, label: ScanCorner.names[t.corner])
                    }
                } else {
                    arrow(toward: CGVector(dx: 0, dy: 1), in: size, label: ScanCorner.names[t.corner])
                }
            }
            .allowsHitTesting(false)
        }
    }

    private func cornerRing(_ t: ScanTarget) -> some View {
        let good = t.centred && t.rightDistance
        return ZStack {
            Circle().strokeBorder(good ? Color.green : Color.white, lineWidth: 3).frame(width: 84, height: 84)
            Circle().trim(from: 0, to: step?.holdProgress ?? 0).stroke(Theme.tape, style: StrokeStyle(lineWidth: 6, lineCap: .round)).rotationEffect(.degrees(-90)).frame(width: 84, height: 84)
            Image(systemName: "plus").font(.title3.weight(.semibold)).foregroundStyle(good ? Color.green : Color.white)
        }
        .shadow(color: .black.opacity(0.4), radius: 3)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: step?.holdProgress)
        .accessibilityHidden(true)
    }

    private func arrow(toward v: CGVector, in size: CGSize, label: String) -> some View {
        let angle = Angle(radians: atan2(Double(v.dx), -Double(v.dy)))
        let len = max(hypot(v.dx, v.dy), 1)
        let reach = min(size.width, size.height) * 0.28
        return VStack(spacing: 6) {
            Image(systemName: "arrow.up").font(.largeTitle.weight(.bold)).imageScale(.large).foregroundStyle(Theme.tape)
                .rotationEffect(angle)
                .padding(18).background(.ultraThinMaterial, in: Circle())
            Text("\(label.prefix(1).uppercased() + label.dropFirst()) corner").font(.footnote.weight(.semibold)).padding(.horizontal, 10).padding(.vertical, 4).background(.ultraThinMaterial, in: Capsule())
        }
        .position(x: size.width / 2 + CGFloat(v.dx / len) * reach, y: size.height / 2 + CGFloat(v.dy / len) * reach)
        .accessibilityHidden(true)
    }

    // MARK: Controls

    private var bottomBar: some View {
        HStack {
            Button(action: onRedo) { Label("Redo", systemImage: "arrow.counterclockwise") }
                .buttonStyle(.bordered).controlSize(.large).frame(maxWidth: .infinity, alignment: .leading)
            shutter
            Group {
                if inCloseups {
                    prominence(Button(action: onSkip) { Label("Skip", systemImage: "forward.end") }, step?.offerSkip == true)
                } else {
                    prominence(Button(action: onNext) { Label("Next", systemImage: "chevron.right") }, step?.canFinishSweep == true)
                        .disabled(step?.canFinishSweep != true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .tint(Theme.red)
        .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 8)
        .background(.ultraThinMaterial.opacity(0.9), ignoresSafeAreaEdges: .bottom)
    }

    /// A standard bordered button, prominent when it is the thing to do now.
    @ViewBuilder private func prominence<B: View>(_ button: B, _ prominent: Bool) -> some View {
        if prominent {
            button.buttonStyle(.borderedProminent).controlSize(.large)
        } else {
            button.buttonStyle(.bordered).controlSize(.large)
        }
    }

    /// The shutter: a white disc inside a ring that fills as the scan goes. Tapping takes a photo by hand.
    private var shutter: some View {
        Button(action: onShutter) {
            ZStack {
                Circle().stroke(Color.white.opacity(0.35), lineWidth: 5).frame(width: 82, height: 82)
                Circle().trim(from: 0, to: progress).stroke(Theme.red, style: StrokeStyle(lineWidth: 5, lineCap: .round)).rotationEffect(.degrees(-90)).frame(width: 82, height: 82)
                    .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: progress)
                Circle().fill(Color.white).frame(width: 62, height: 62)
            }
            .frame(minWidth: 88, minHeight: 88)
        }
        .accessibilityLabel("Take a photo")
        .accessibilityValue("\(Int(progress * 100)) percent of the scan")
        .accessibilityHint("The phone takes photos by itself. Use this to take one by hand")
    }
}

// MARK: Working, and notices

struct ScanWorkingOverlay: View {
    let photos: Int

    var body: some View {
        VStack(spacing: 14) {
            ProgressView().controlSize(.large)
            Text("Measuring from \(photos) photos").font(.headline)
            Text("Finding the corners in every photo").font(.subheadline).foregroundStyle(.secondary)
        }
        .padding(28)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Measuring from \(photos) photos. Finding the corners in every photo.")
        .environment(\.colorScheme, .dark)
    }
}

/// A scan that cannot go on, with the way out (system empty-state layout).
struct ScanNoticeView: View {
    let symbol: String
    let title: String
    let message: String
    let action: String
    let onAction: () -> Void
    let onClose: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: symbol)
        } description: {
            Text(message)
        } actions: {
            Button(action, action: onAction).buttonStyle(.borderedProminent).controlSize(.large)
            Button("Close", action: onClose).buttonStyle(.bordered).controlSize(.large)
        }
        .tint(Theme.red)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground).ignoresSafeArea())
    }
}
