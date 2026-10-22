import RooflineCore
import SwiftUI
import UIKit

/// The frozen photo of a window, with four corners to drag onto it. The phone has already stopped moving: the photo is a still, so
/// nothing flies about and a corner stays where it is put. What is drawn is the level rectangle fitted to the four dots (never a
/// slanted four-sided shape), its two plates and the status card show the one width and height that are sent, and a dot let go near a
/// corner of the frame snaps onto it. Dragging is slow and magnified; pinch zooms in.
struct FreezeFrameEditor: View {
    let capture: FrozenCapture
    /// The answers of the earlier photos of this window (same tracking session); the shown size is the median with them.
    let earlier: [FrozenResult]
    let title: String
    /// A sample or a test starts from these corners and stage, with no looking.
    var start: (points: [CGPoint], stage: FreezeEditing.Stage)?
    let onClose: () -> Void
    let onRetake: () -> Void
    let onAddAnother: (FrozenResult) -> Void
    let onUse: (FrozenMeasure.Combined) -> Void

    @State private var photo: PreparedPhoto?
    @State private var points: [CGPoint] = []
    @State private var stage: FreezeEditing.Stage = .looking

    private var photoNumber: Int { earlier.count + 1 }

    var body: some View {
        let editing = FreezeEditing(capture: capture, earlier: earlier, points: points)
        ZStack {
            Color.black.ignoresSafeArea()
            VStack(spacing: 0) {
                topBar(editing)
                ZStack {
                    if let photo = photo {
                        PhotoTapView(photo: photo, points: $points, maxPoints: 4, proposed: stage == .proposed,
                                     onEdit: { stage = .editing },
                                     outline: editing.outline, plates: editing.plates, flagged: editing.flaggedHandle,
                                     snap: { p in photo.image.cgImage.flatMap { PhotoSnap.snap(p, in: $0) } })
                            .allowsHitTesting(stage != .looking)
                    }
                    if stage == .looking {
                        ProgressView().progressViewStyle(.circular).tint(.white).scaleEffect(1.4)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                hint(editing)
                controls(editing)
            }
        }
        .environment(\.colorScheme, .dark)
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        .task(id: capture.id) { await load() }
    }

    // MARK: Loading

    private func load() async {
        guard let image = UIImage(data: capture.jpeg) else { return }
        let prepared = PreparedPhoto(image: image, jpeg: capture.jpeg, widthPx: capture.widthPx, heightPx: capture.heightPx, focal35mm: nil)
        photo = prepared
        if let start = start {
            points = start.points
            stage = start.stage
            return
        }
        stage = .looking
        points = []
        let cg = image.cgImage
        let view = capture.view
        let found = await Task.detached(priority: .userInitiated) { cg.flatMap { FreezeProposal.corners(in: $0, view: view) } }.value
        if let found = found {
            points = found
            stage = .proposed
        } else {
            points = FreezeProposal.inset(width: capture.widthPx, height: capture.heightPx)
            stage = .notFound
        }
    }

    // MARK: Pieces

    private func topBar(_ editing: FreezeEditing) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Button(action: onClose) {
                IconView(icon: .close, size: 20, weight: 2).foregroundStyle(.white)
                    .frame(width: 44, height: 44).background(Circle().fill(Color(white: 0.12, opacity: 0.75)))
            }
            .accessibilityLabel("Close")
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(title).wcMono(14, .medium, relativeTo: .footnote).foregroundStyle(Color.white.opacity(0.7))
                    Spacer()
                    Text(photosLine).wc(14, .semibold, relativeTo: .footnote).foregroundStyle(Theme.tape)
                }
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("Width").wc(15, relativeTo: .subheadline).foregroundStyle(Color.white.opacity(0.7))
                    number(editing.widthIn)
                    Text("Height").wc(15, relativeTo: .subheadline).foregroundStyle(Color.white.opacity(0.7))
                    number(editing.heightIn)
                    Text("in").wcMono(15, .semibold, relativeTo: .subheadline).foregroundStyle(.white)
                }
                .lineLimit(1).minimumScaleFactor(0.7)
                if editing.needsCheck {
                    HStack(spacing: 6) {
                        IconView(icon: .alert, size: 14, weight: 2)
                        Text("Needs a check: the corners are not on the frame yet").wc(14, .semibold, relativeTo: .footnote)
                    }
                    .foregroundStyle(Theme.tape)
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Color(white: 0.14, opacity: 0.78)))
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Color.white.opacity(0.08), lineWidth: 1))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityReadout(editing))
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 8)
    }

    private var photosLine: String {
        earlier.isEmpty ? "Photo 1" : "Photo \(photoNumber) · combined"
    }

    @ViewBuilder private func number(_ inches: Double?) -> some View {
        if let v = inches {
            Text(SizeFormat.attributed(v, size: 30, weight: .medium, color: .white))
        } else {
            Text("–").wcMono(30, .medium, relativeTo: .title).foregroundStyle(Color.white.opacity(0.4))
        }
    }

    private func accessibilityReadout(_ editing: FreezeEditing) -> String {
        var parts = [title.capitalized]
        if let w = editing.widthIn { parts.append("Width \(SizeWording.spoken(w)) inches") }
        if let h = editing.heightIn { parts.append("Height \(SizeWording.spoken(h)) inches") }
        parts.append(photosLine)
        if editing.needsCheck { parts.append("Needs a check") }
        return parts.joined(separator: ". ")
    }

    private func hint(_ editing: FreezeEditing) -> some View {
        HStack(spacing: 10) {
            IconView(icon: .target, size: 20).foregroundStyle(Theme.tape)
            Text(editing.hint(stage)).wc(17, .medium, relativeTo: .body).foregroundStyle(.white)
                .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(Capsule().fill(Color(white: 0.14, opacity: 0.78)))
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .accessibilityElement(children: .combine)
        .padding(.bottom, 10)
    }

    private func controls(_ editing: FreezeEditing) -> some View {
        VStack(spacing: 10) {
            HStack(spacing: 12) {
                Button(action: onRetake) {
                    HStack(spacing: 8) {
                        IconView(icon: .refresh, size: 18, weight: 2)
                        Text("Retake").wc(17, .semibold, relativeTo: .headline)
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 20)
                    .frame(minHeight: 56)
                    .background(Capsule().fill(Color(white: 0.2, opacity: 0.9)))
                }
                .accessibilityLabel("Retake")
                .accessibilityHint("Goes back to the camera to take this photo again")
                Button {
                    if let c = editing.combined { onUse(c) }
                } label: {
                    HStack(spacing: 8) {
                        IconView(icon: .check, size: 20, weight: 2.2)
                        Text("Use this size").wc(18, .bold, relativeTo: .headline)
                    }
                    .foregroundStyle(Theme.onRed)
                    .frame(maxWidth: .infinity, minHeight: 56)
                    .background(Capsule().fill(Theme.red))
                    .overlay(Capsule().strokeBorder(Color.white, lineWidth: 3))
                    .opacity(editing.canUse ? 1 : 0.45)
                }
                .disabled(!editing.canUse)
                .accessibilityLabel("Use this size")
                .accessibilityHint("Keeps this window and goes on to name it")
            }
            .padding(.horizontal, 16)
            if photoNumber < ArCaptureModel.maxPhotos, let now = editing.current {
                Button { onAddAnother(now) } label: {
                    Text("Take another photo to double-check").wc(15, .semibold, relativeTo: .subheadline).foregroundStyle(Theme.tape)
                        .frame(minHeight: 36)
                }
                .accessibilityHint("Keeps this photo and takes another of the same window; the size is the middle of them")
            }
        }
        .padding(.top, 6)
        .padding(.bottom, 8)
    }
}
