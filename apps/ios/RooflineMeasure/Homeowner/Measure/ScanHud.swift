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
                    IconView(icon: .close, size: 20, weight: 2).foregroundStyle(.white).frame(width: 44, height: 44).background(Circle().fill(Color(white: 0.12, opacity: 0.75)))
                }
                .accessibilityLabel("Cancel the scan")
                Text(room).wc(17, .semibold, relativeTo: .headline).foregroundStyle(.white).lineLimit(1).minimumScaleFactor(0.7)
                    .padding(.horizontal, 16).frame(height: 44)
                    .background(Capsule().fill(Color(white: 0.12, opacity: 0.75)))
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
            Text(progress.hint).wc(16, .medium, relativeTo: .body).foregroundStyle(.white).multilineTextAlignment(.center)
                .padding(.horizontal, 16).padding(.vertical, 12)
                .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(Color(white: 0.12, opacity: 0.78)))
                .padding(.horizontal, 20)
                .accessibilityIdentifier("scanHint")
            WCPrimaryButton(title: progress.doneTitle, isEnabled: progress.canFinish, action: onDone)
                .padding(.horizontal, Theme.gutter).padding(.bottom, 12)
        }
        // Over the camera the controls stop at the largest ordinary text size, so the room stays in view
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }

    private var countPill: some View {
        let any = progress.windowsFound > 0
        return HStack(spacing: 8) {
            IconView(icon: .win, size: 18, weight: 1.9)
            Text(progress.found).wc(16, .semibold, relativeTo: .headline).accessibilityIdentifier("scanCount")
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 14).frame(height: 40)
        .background(Capsule().fill(any ? Theme.blue : Color(white: 0.12, opacity: 0.75)))
        .accessibilityElement(children: .combine)
    }

    /// Each window found so far with the size RoomPlan has for it now (it settles as the scan goes on).
    private var chips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(windows) { w in
                    HStack(spacing: 8) {
                        Text(w.letter).wcMono(14, .bold, relativeTo: .footnote).foregroundStyle(Theme.blue)
                            .frame(width: 24, height: 24).background(Color.white, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                        SizeText(widthIn: w.widthIn, heightIn: w.heightIn, size: 16, weight: .semibold, unit: true, color: .white, relativeTo: .callout)
                    }
                    .padding(.horizontal, 10).frame(height: 40)
                    .background(Capsule().fill(Color(white: 0.12, opacity: 0.78)))
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Window \(w.letter), \(SizeWording.spokenSize(widthIn: w.widthIn, heightIn: w.heightIn)) so far")
                }
            }
            .padding(.horizontal, 20)
        }
        .frame(height: 44)
    }
}
