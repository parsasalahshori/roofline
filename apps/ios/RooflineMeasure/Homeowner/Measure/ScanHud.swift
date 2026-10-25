import RooflineCore
import SwiftUI

/// What is drawn over Apple's camera view while a room scan runs: the room, how many windows have been found ("2 windows found"),
/// each one's size so far, what to do next, and "Done". RoomCaptureView underneath outlines the windows itself.
/// Plain values in, so it can be drawn over a sample photo in the simulator (which has no RoomPlan).
struct ScanHud: View {
    let room: String
    let progress: ScanProgress
    let windows: [RoomScanner.LiveWindow]
    let onCancel: () -> Void
    let onDone: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                Button(action: onCancel) {
                    Image(systemName: WCIcon.close.symbol).font(.body.weight(.semibold)).foregroundStyle(.white).hudCircle()
                }
                .accessibilityLabel("Cancel the scan")
                Text(room).font(.headline).foregroundStyle(.white).lineLimit(1).minimumScaleFactor(0.7)
                    .padding(.horizontal, 16).frame(minHeight: Theme.minTap)
                    .hudCapsule()
                Spacer()
            }
            .padding(.horizontal, 12).padding(.top, 8)
            HStack {
                countPill
                Spacer()
            }
            .padding(.horizontal, 12)
            Spacer()
            if !windows.isEmpty { chips }
            Text(progress.hint).font(.body.weight(.medium)).foregroundStyle(.white).multilineTextAlignment(.center)
                .padding(.horizontal, 16).padding(.vertical, 12)
                .hudPanel()
                .padding(.horizontal, 20)
                .accessibilityIdentifier("scanHint")
            WCPrimaryButton(title: progress.doneTitle, isEnabled: progress.canFinish, action: onDone)
                .padding(.horizontal, Theme.gutter).padding(.bottom, 12)
        }
        .environment(\.colorScheme, .dark)
        // Over the camera the controls stop at the largest ordinary text size, so the room stays in view
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }

    private var countPill: some View {
        let any = progress.windowsFound > 0
        return HStack(spacing: 8) {
            Image(systemName: WCIcon.win.symbol)
            Text(progress.found).font(.headline).accessibilityIdentifier("scanCount")
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 14).frame(minHeight: 40)
        .background {
            // The accent once a window is found; system material before that
            if any { Capsule().fill(Theme.buttonFill) } else { Capsule().fill(.regularMaterial) }
        }
        .accessibilityElement(children: .combine)
    }

    /// Each window found so far with the size RoomPlan has for it now (it settles as the scan goes on).
    private var chips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(windows) { w in
                    HStack(spacing: 8) {
                        Text(w.letter).font(.footnote.weight(.bold)).monospacedDigit().foregroundStyle(Theme.tapeInk)
                            .frame(width: 24, height: 24).background(Theme.tape, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                        SizeText(widthIn: w.widthIn, heightIn: w.heightIn, size: 16, weight: .semibold, unit: true, color: .white, relativeTo: .callout)
                    }
                    .padding(.horizontal, 10).frame(minHeight: 40)
                    .hudCapsule()
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Window \(w.letter), \(SizeWording.spokenSize(widthIn: w.widthIn, heightIn: w.heightIn)) so far")
                }
            }
            .padding(.horizontal, 20)
        }
        .frame(height: 44)
    }
}
