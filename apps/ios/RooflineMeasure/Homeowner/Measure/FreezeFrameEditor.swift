import RooflineCore
import SwiftUI
import UIKit

/// The frozen photo of a window, with the window on it as a RECTANGLE. The four dots are its corners and the outline goes exactly through
/// them: dragging a corner moves the two edges that meet there (the dots next to it follow), and the square in the middle of each side
/// moves that one side. The dot stays under the finger (a magnifier shows it above), and a corner let go near a corner of the frame snaps
/// onto it. What is drawn is what is measured is what is sent: the two plates and the status card show the width and height of this
/// rectangle. The phone starts it from what the server's AI finds in the photo (the window, cut out and set onto the frame's edges), when
/// that answers in time; else from the depth sensor's opening (the part of the picture where the wall isn't), then Vision. The person can
/// drag from the first moment: a proposal that arrives after they have touched a dot is not put on the screen.
struct FreezeFrameEditor: View {
    let capture: FrozenCapture
    /// The answers of the earlier photos of this window (same tracking session): this photo's size is checked against them.
    let earlier: [FrozenResult]
    let title: String
    /// A sample or a test starts from this rectangle and stage, with no looking.
    var start: (rect: FrozenRect?, stage: FreezeEditing.Stage)?
    /// How to reach the server's AI window finder and the testers' dump. `.none`: the depth sensor, then Vision, as before.
    var services: FreezeServices = .none
    /// "Take another photo to double-check" is offered (the single-photo flow); the guided scan outlines the window with this editor and turns it off.
    var allowAnother = true
    let onClose: () -> Void
    let onRetake: () -> Void
    let onAddAnother: (FrozenResult) -> Void
    let onUse: (FrozenResult) -> Void

    @State private var photo: PreparedPhoto?
    @State private var rect: FrozenRect?
    @State private var stage: FreezeEditing.Stage = .looking
    /// For the testers' dump: what the proposal was and where it came from, what the server said, what the depth sensor alone found.
    @State private var proposed: WindowProposal.Result?
    @State private var attempt: AiAttempt?
    @State private var depthOnly: FrozenRect?
    /// False when the person had touched a dot before the proposal came, so it was not put on the screen.
    @State private var proposalApplied: Bool?
    /// The window's own frame inside the rectangle (found in the photo after the rectangle settles; dropped while a dot is dragged).
    @State private var frame: FreezeFrameFound?
    @State private var frameTask: Task<Void, Never>?

    private var photoNumber: Int { earlier.count + 1 }

    var body: some View {
        let editing = FreezeEditing(capture: capture, earlier: earlier, rect: rect, frame: frame)
        ZStack {
            Color.black.ignoresSafeArea()
            VStack(spacing: 0) {
                topBar(editing)
                ZStack {
                    if let photo = photo {
                        PhotoTapView(photo: photo, points: handles(editing), maxPoints: 0, proposed: false,
                                     onEdit: { released() },
                                     outline: editing.outline, innerOutline: editing.windowOutline, plates: editing.plates,
                                     snap: { i, p in i < 4 ? photo.image.cgImage.flatMap { PhotoSnap.snap(p, in: $0) } : nil },
                                     gain: 1, sideHandlesFrom: 4,
                                     voiceOver: "Photo of the window. The outline has a dot on each corner and a square on each side. Touch one and drag to move it. Pinch to zoom.")
                            .allowsHitTesting(stage != .looking && rect != nil)
                    }
                    if stage == .looking {
                        ProgressView().progressViewStyle(.circular).tint(.white).scaleEffect(1.4)
                    }
                    if stage == .findingWindow {
                        findingPill
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
            rect = start.rect
            stage = start.stage
            findFrame(in: start.rect, of: image)
            return
        }
        stage = .looking
        rect = nil
        proposed = nil
        attempt = nil
        depthOnly = nil
        proposalApplied = nil
        frame = nil
        frameTask?.cancel()
        guard let cg = image.cgImage else { return }
        let view = capture.view
        // The depth sensor's opening, off the main thread, while the server looks
        let depthTask = Task.detached(priority: .userInitiated) { FreezeProposal.depth(in: cg, view: view) }
        var asked: AiAttempt?
        if let find = services.findWindow {
            // Only a server that is slow to answer shows the inset rectangle and the small spinner (one that is off answers at once)
            let spinner = Task { @MainActor in
                try? await Task.sleep(nanoseconds: UInt64(AiFinding.spinnerAfterSeconds * 1_000_000_000))
                guard !Task.isCancelled, stage == .looking, rect == nil else { return }
                rect = FreezeProposal.inset(view: view)
                stage = rect == nil ? .looking : .findingWindow
            }
            let sent = await Task.detached(priority: .userInitiated) { DetectionPhoto.jpeg(from: cg) }.value
            if let sent = sent { asked = await find(sent) } else { asked = AiAttempt(status: "error", detection: nil, ms: 0) }
            spinner.cancel()
        }
        let depthFound = await depthTask.value
        guard !Task.isCancelled else { return }
        attempt = asked
        depthOnly = depthFound?.rect
        services.dumpCapture?(capture)
        let result = await Task.detached(priority: .userInitiated) { FreezeProposal.resolve(in: cg, view: view, ai: asked?.detection, depth: depthFound) }.value
        guard !Task.isCancelled else { return }
        proposed = result
        // The person began dragging while the server looked: their rectangle stays; what it would have been is only recorded
        let untouched = stage != .editing
        proposalApplied = untouched
        if untouched {
            if let found = result {
                rect = found.rect
                stage = [.ai, .aiQuad, .aiDepth].contains(found.source) ? .proposedByAI : (found.source == .depth ? .proposedByDepth : .proposedByPhoto)
                findFrame(in: found.rect, of: image)
            } else {
                rect = FreezeProposal.inset(view: view)
                stage = .notFound
            }
        }
        services.dumpResult?(debugResult(final: nil))
    }

    /// What the testers' dump records about this capture: the AI's answer, where the proposal came from, the proposal, the rectangle now.
    private func debugResult(final: FrozenRect?, usedAt: String? = nil) -> DebugCapture.Result {
        let view = capture.view
        return DebugCapture.Result(captureId: capture.id.uuidString.lowercased(), source: proposed?.source.rawValue ?? ProposalSource.none.rawValue, ai: attempt,
                                   proposed: proposed.map { DebugCapture.Rect($0.rect, view: view) }, final: final.map { DebugCapture.Rect($0, view: view) },
                                   depthFound: depthOnly.map { DebugCapture.Rect($0, view: view) }, usedAt: usedAt, applied: proposalApplied)
    }

    // MARK: Dragging

    /// The eight handles as the picture's markers. A marker dragged to a new place edits the rectangle; the markers then come back from
    /// the rectangle, so they are always exactly on it.
    private func handles(_ editing: FreezeEditing) -> Binding<[CGPoint]> {
        Binding(get: { editing.handles }, set: { moved($0, from: editing.handles) })
    }

    private func moved(_ new: [CGPoint], from old: [CGPoint]) {
        guard let r = rect, new.count == 8, old.count == 8,
              let i = (0..<8).first(where: { hypot(new[$0].x - old[$0].x, new[$0].y - old[$0].y) > 1e-6 }),
              let handle = FrozenRect.Handle(rawValue: i) else { return }
        rect = r.moved(handle, toPhoto: Vec2(Double(new[i].x), Double(new[i].y)), view: capture.view)
        // From the first touch on it is the person's: a proposal still on its way is not put over it
        stage = .editing
        // The window's frame was found for the old rectangle: it goes while a dot is on the move, and is looked for again when it is let go
        frameTask?.cancel()
        frame = nil
    }

    /// A marker was let go (after any snap): the depth round the corners as they are now says more exactly where the frame's face is.
    private func released() {
        stage = .editing
        rect = rect?.rebased(view: capture.view)
        if let image = photo?.image { findFrame(in: rect, of: image) }
    }

    /// Looks for the window's own frame just inside `opening` in the photo, off the main thread. The answer is kept only for that exact
    /// rectangle (`FreezeEditing` shows it only while the rectangle is still the one it was found for).
    private func findFrame(in opening: FrozenRect?, of image: UIImage) {
        frameTask?.cancel()
        guard let opening = opening, let cg = image.cgImage else { return }
        let view = capture.view
        frameTask = Task {
            let found = await Task.detached(priority: .userInitiated) {
                WindowFrameFinder.find(opening: opening, view: view, photo: { x, y, w, h in PhotoSnap.gray(cg, x: x, y: y, width: w, height: h) })
            }.value
            guard !Task.isCancelled else { return }
            frame = found.map { FreezeFrameFound(opening: opening, found: $0) }
        }
    }

    // MARK: Pieces

    private func topBar(_ editing: FreezeEditing) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Button(action: onClose) {
                Image(systemName: WCIcon.close.symbol).font(.body.weight(.semibold)).foregroundStyle(.white).hudCircle()
            }
            .accessibilityLabel("Close")
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(title).font(.footnote.weight(.medium)).monospacedDigit().foregroundStyle(Color.white.opacity(0.85))
                    Spacer()
                    Text(photosLine).font(.footnote.weight(.semibold)).foregroundStyle(Theme.tape)
                }
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("Opening").font(.subheadline).foregroundStyle(Color.white.opacity(0.85))
                    number(editing.widthIn)
                    Text("×").font(.title3.weight(.medium)).foregroundStyle(Color.white.opacity(0.85))
                    number(editing.heightIn)
                    Text("in").font(.subheadline.weight(.semibold)).monospacedDigit().foregroundStyle(.white)
                }
                .lineLimit(1).minimumScaleFactor(0.7)
                if let window = editing.windowSize {
                    Text(window.line).font(.subheadline.weight(.semibold)).foregroundStyle(Color.white.opacity(0.92))
                        .lineLimit(1).minimumScaleFactor(0.75)
                }
                if let standard = editing.standardSize {
                    Text(standard.sentence).font(.footnote.weight(.medium)).foregroundStyle(Color.white.opacity(0.85))
                        .lineLimit(2).minimumScaleFactor(0.8)
                }
                if editing.needsCheck {
                    Label("Your photos differ a little", systemImage: WCIcon.alert.symbol)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Theme.tape)
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .hudPanel(cornerRadius: 20)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityReadout(editing))
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 8)
    }

    private var photosLine: String {
        "Photo \(photoNumber)"
    }

    @ViewBuilder private func number(_ inches: Double?) -> some View {
        if let v = inches {
            Text(SizeFormat.attributed(v, size: 30, weight: .medium, color: .white))
        } else {
            Text("–").font(.title.weight(.medium)).monospacedDigit().foregroundStyle(Color.white.opacity(0.5))
        }
    }

    private func accessibilityReadout(_ editing: FreezeEditing) -> String {
        var parts = [title.capitalized]
        if let w = editing.widthIn, let h = editing.heightIn { parts.append("Opening \(SizeWording.spokenSize(widthIn: w, heightIn: h))") }
        if let window = editing.windowSize { parts.append(TwoSizes.windowSpoken(window)) }
        if let standard = editing.standardSize { parts.append(standard.sentence) }
        parts.append(photosLine)
        if editing.needsCheck { parts.append("Your photos differ a little") }
        return parts.joined(separator: ". ")
    }

    /// A small spinner on the photo while the AI looks: the corners can be dragged under it.
    private var findingPill: some View {
        VStack {
            HStack(spacing: 8) {
                ProgressView().progressViewStyle(.circular).tint(.white).controlSize(.small)
                Text("Finding your window…").font(.subheadline.weight(.semibold)).foregroundStyle(.white)
            }
            .padding(.horizontal, 14).padding(.vertical, 8)
            .hudCapsule()
            .padding(.top, 10)
            Spacer()
        }
        .allowsHitTesting(false)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Finding your window")
    }

    private func hint(_ editing: FreezeEditing) -> some View {
        HStack(spacing: 10) {
            Image(systemName: WCIcon.target.symbol).font(.title3).foregroundStyle(Theme.tape)
            Text(editing.hint(stage)).font(.body.weight(.medium)).foregroundStyle(.white)
                .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .hudPanel()
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .accessibilityElement(children: .combine)
        .padding(.bottom, 10)
    }

    private func controls(_ editing: FreezeEditing) -> some View {
        VStack(spacing: 6) {
            HStack(spacing: 12) {
                Button(action: onRetake) {
                    Label("Retake", systemImage: WCIcon.refresh.symbol)
                        .fontWeight(.semibold)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .tint(.white)
                .accessibilityLabel("Retake")
                .accessibilityHint("Goes back to the camera to take this photo again")
                Button {
                    if var r = editing.sent {
                        if start == nil { services.dumpResult?(debugResult(final: rect, usedAt: ISO8601DateFormatter().string(from: Date()))) }
                        // The opening is what is sent; the window's frame is only kept to show next to it
                        r.windowFrame = editing.windowSize
                        onUse(r)
                    }
                } label: {
                    Label("Use this size", systemImage: WCIcon.check.symbol)
                        .fontWeight(.semibold)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .tint(Theme.buttonFill)
                .disabled(!editing.canUse)
                .accessibilityLabel("Use this size")
                .accessibilityHint("Keeps this window and goes on to name it")
            }
            .padding(.horizontal, 16)
            if allowAnother, photoNumber < ArCaptureModel.maxPhotos, let now = editing.sent {
                Button { onAddAnother(now) } label: {
                    Text("Take another photo to double-check").font(.subheadline.weight(.semibold)).foregroundStyle(.white)
                        .frame(minHeight: Theme.minTap)
                }
                .accessibilityHint("Keeps this photo and takes another of the same window, to check the size against")
            }
        }
        .padding(.top, 6)
        .padding(.bottom, 4)
    }
}
