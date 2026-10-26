import AVFoundation
import RooflineCore
import SwiftUI
import UIKit

/// "Photo with a bank card" (ios-hw-07c): put a card flat on the glass, take one photo, tap the card's four corners (it is a
/// ruler of known size), tap the window frame's four corners, see the size. Works on any iPhone. The photo is kept upright
/// and the corners are in its pixels; the server recomputes the size from the same data.
struct CardPhotoFlow: View {
    @Environment(HomeownerStore.self) private var store
    @Environment(\.dynamicTypeSize) private var typeSize
    let session: MeasureSession

    enum Step { case intro, card, window }

    @State private var step = Step.intro
    @State private var photo: PreparedPhoto?
    @State private var cardPoints: [CGPoint] = []
    @State private var windowPoints: [CGPoint] = []
    @State private var showCamera = false
    @State private var cameraDenied = false
    @State private var cameraRestricted = false
    @State private var cameraNote: String?
    @State private var showHowTo = false
    /// The card's (window's) corners on the photo are the ones the phone found, not the person's taps: the screen says so and the person
    /// drags any that is off. Both go false when the person starts over or retakes the photo.
    @State private var cardFound = false
    @State private var windowFound = false
    /// Which photo the phone is looking at: a look that finishes after the photo was retaken is thrown away.
    @State private var lookToken = 0

    var body: some View {
        Group {
            switch step {
            case .intro: intro
            case .card, .window: if let photo = photo { tapping(photo) } else { intro }
            }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image, metadata in
                showCamera = false
                if let image = image { use(image, metadata: metadata) }
            }
            .ignoresSafeArea()
        }
        .onAppear { seedForDebug() }
    }

    // MARK: Intro

    private var intro: some View {
        NavigationStack {
            List {
                Section {
                    CardTip(icon: .card, title: "1. Tape or hold a bank card flat on the glass", detail: "In the middle of the window, the whole card in view, no glare. A credit card, debit card or driver's license works.")
                    CardTip(icon: .back, title: "2. Stand about 4 feet back and take one photo", detail: "Straight in front of the window, with all of it in the photo and some room around it. Hold still.")
                    CardTip(icon: .light, title: "3. Tap the card's 4 corners, then the window's 4 corners", detail: "The magnifier helps you hit the very tip of the card's rounded corners, then the 4 inside corners of the frame.")
                } header: {
                    Text("One photo of the whole window, with a card on the glass.").font(.subheadline).foregroundStyle(Theme.ink2).textCase(nil)
                        .padding(.bottom, 4)
                }
                if cameraDenied || cameraRestricted || cameraNote != nil {
                    Section {
                        if cameraDenied {
                            notice(icon: .camera, "Camera access is off. Turn it on in Settings, then come back.", warn: true)
                        }
                        if cameraRestricted {
                            notice(icon: .camera, CameraAccess.restrictedText, warn: true)
                        }
                        if let note = cameraNote { notice(icon: .info, note, warn: false) }
                    }
                }
                if typeSize.isAccessibilitySize {
                    Section { WCScrollFooter() }
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }
            }
            .listStyle(.insetGrouped)
            .wcFooter {
                WCPrimaryButton(title: "Take the photo", icon: .camera, iconLeading: true) { Task { await openCamera() } }
                #if DEBUG
                if !DeviceCaps.cameraAvailable { WCSecondaryButton(title: "Use the sample photo (debug)") { useSample() } }
                #endif
            }
            .navigationTitle("Photo with a bank card")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { store.measureSession = nil } label: { Image(systemName: WCIcon.close.symbol) }
                        .accessibilityLabel("Close")
                }
            }
        }
    }

    private func notice(icon: WCIcon, _ text: String, warn: Bool) -> some View {
        Label {
            Text(text).font(.subheadline).foregroundStyle(Theme.ink)
        } icon: {
            Image(systemName: icon.symbol).foregroundStyle(warn ? Theme.warn : Theme.ink2)
        }
    }

    private func openCamera() async {
        guard DeviceCaps.cameraAvailable else {
            cameraNote = "This device has no camera. Open WinChoice on your iPhone to take the photo."
            return
        }
        switch await CameraAccess.request() {
        case .allowed: showCamera = true
        case .denied: cameraDenied = true
        case .restricted: cameraRestricted = true
        }
    }

    private func use(_ image: UIImage, metadata: [AnyHashable: Any]?) {
        guard let p = PhotoPreparation.prepare(image, metadata: metadata) else {
            cameraNote = "That photo couldn't be prepared. Please take it again."
            return
        }
        photo = p
        cardPoints = []
        windowPoints = []
        step = .card
        look(for: p)
        // The first card photo ever: the steps again, before the tapping
        if !HowToSeen.isSeen("card") { showHowTo = true }
    }

    // MARK: Finding the corners

    /// While the person reads the first screen, Apple Vision looks for the card and the window in the photo (off the main thread, a
    /// fraction of a second). What it finds with good confidence is put on the photo for the person to check; nothing found means
    /// nothing changes: the person taps, as always.
    private func look(for p: PreparedPhoto) {
        lookToken += 1
        let token = lookToken
        cardFound = false
        windowFound = false
        Task {
            let found = await Task.detached(priority: .userInitiated) { () -> AutoCornerProposal in
                guard let cg = p.image.cgImage else { return AutoCornerProposal() }
                return WindowRectangleDetector.propose(in: cg)
            }.value
            guard token == lookToken, photo != nil else { return }
            adopt(found)
        }
    }

    /// Puts the found corners on the photo, unless the person has already started tapping them.
    private func adopt(_ found: AutoCornerProposal) {
        guard let photo = photo else { return }
        let proposal = Self.checked(found, widthPx: Double(photo.widthPx), heightPx: Double(photo.heightPx))
        if cardPoints.isEmpty, let taps = proposal.cardTaps {
            cardPoints = taps.map { CGPoint(x: $0.x, y: $0.y) }
            cardFound = true
        }
        if windowPoints.isEmpty, let window = proposal.window {
            windowPoints = window.corners.map { CGPoint(x: $0.x, y: $0.y) }
            windowFound = true
        }
        #if DEBUG
        if store.debugCardSeed?.thenWindow == true { step = .window }
        #endif
    }

    /// What the screens may put on the photo: corners clamped onto it, and a card and window that the server would refuse together
    /// (`CardSizing.problem`) are not proposed at all (the person taps them).
    static func checked(_ found: AutoCornerProposal, widthPx: Double, heightPx: Double) -> AutoCornerProposal {
        func clamp(_ p: PickedQuad) -> PickedQuad {
            PickedQuad(corners: p.corners.map { Vec2(min(max($0.x, 0), widthPx), min(max($0.y, 0), heightPx)) }, confidence: p.confidence)
        }
        var out = AutoCornerProposal(window: found.window.map(clamp), card: found.card.map(clamp))
        if let taps = out.cardTaps, let card = CardSizing.cardCornersForAPI(taps), let w = out.window, let window = CardSizing.orderedQuad(w.corners) {
            if CardSizing.problem(cardCorners: card, windowCorners: window, imageWidthPx: widthPx, imageHeightPx: heightPx) != nil { out = AutoCornerProposal() }
        } else if out.window != nil, out.card != nil {
            out = AutoCornerProposal()
        }
        return out
    }

    // MARK: Tapping

    private func tapping(_ photo: PreparedPhoto) -> some View {
        let onCard = step == .card
        let points = onCard ? $cardPoints : $windowPoints
        let count = onCard ? cardPoints.count : windowPoints.count
        return VStack(spacing: 10) {
            topBar(onCard: onCard)
            instruction(onCard: onCard)
            PhotoTapView(photo: photo, points: points, reference: onCard ? [] : cardPoints, focus: debugFocus(onCard: onCard), startZoom: debugFocus(onCard: onCard) == nil ? 1 : 5,
                         proposed: onCard ? cardFound : windowFound)
                .id(onCard)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            statusPanel(onCard: onCard, count: count)
            buttons(onCard: onCard, count: count)
        }
        .padding(.horizontal, 12)
        .background(Color.black.ignoresSafeArea())
        .overlay {
            if showHowTo { CardHowTo { HowToSeen.markSeen("card"); showHowTo = false } }
        }
        .environment(\.colorScheme, .dark)
        // The photo needs the room: the controls around it stop at the largest ordinary text size
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }

    /// A debug seed opens the card step zoomed in on the card (the real photo starts with the whole photo in view).
    private func debugFocus(onCard: Bool) -> CGPoint? {
        #if DEBUG
        guard onCard, store.debugCardSeed != nil, photo != nil else { return nil }
        let c = SampleScene.cardCorners
        return CGPoint(x: c.map { $0.x }.reduce(0, +) / 4, y: c.map { $0.y }.reduce(0, +) / 4)
        #else
        return nil
        #endif
    }

    private func topBar(onCard: Bool) -> some View {
        HStack(spacing: 10) {
            Button {
                if onCard { step = .intro } else { step = .card }
            } label: {
                Image(systemName: WCIcon.chevLeft.symbol).font(.body.weight(.semibold)).foregroundStyle(.white).hudCircle()
            }
            .accessibilityLabel("Back")
            Text(onCard ? "Step 1 of 2 · the card" : "Step 2 of 2 · the window")
                .font(.headline).monospacedDigit().foregroundStyle(.white)
                .frame(maxWidth: .infinity, minHeight: Theme.minTap)
                .hudCapsule()
            Button { store.measureSession = nil } label: {
                Image(systemName: WCIcon.close.symbol).font(.body.weight(.semibold)).foregroundStyle(.white).hudCircle()
            }
            .accessibilityLabel("Close")
        }
        .padding(.top, 8)
    }

    private func instruction(onCard: Bool) -> some View {
        HStack(spacing: 14) {
            if onCard { BankCardGlyph(width: 44) } else { Image(systemName: WCIcon.win.symbol).font(.title).foregroundStyle(Theme.tape).frame(width: 44) }
            Text(instructionText(onCard: onCard)).font(.subheadline).foregroundStyle(Color.white.opacity(0.95)).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            HowButton { showHowTo = true }
        }
        .padding(14)
        .hudPanel(cornerRadius: 18)
    }

    private func instructionText(onCard: Bool) -> AttributedString {
        if onCard ? cardFound : windowFound {
            // The phone found it: the person only checks
            var found = AttributedString(onCard ? "We found your card. " : "We found your window. ")
            found.inlinePresentationIntent = .stronglyEmphasized
            return found + AttributedString("Drag a corner if it's off.")
        }
        var lead = AttributedString(onCard ? "Tap the 4 corners of the card. " : "Tap the 4 corners of the window frame. ")
        lead.inlinePresentationIntent = .stronglyEmphasized
        let rest = onCard ? "Every bank card is the same size (85.60 × 53.98 mm), so it works as a ruler. Tap the very tip of each rounded corner; drag a dot to adjust."
                          : "The inside of the frame, not the trim. Drag a dot to adjust."
        return lead + AttributedString(rest)
    }

    private func statusPanel(onCard: Bool, count: Int) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(Self.counter(onCard: onCard, count: count)).font(.title3.weight(.bold)).monospacedDigit().foregroundStyle(.white)
            if onCard {
                Text(count < 4 ? "Next, tap the 4 corners of the window frame. Then we show the size."
                     : (windowFound ? "Good. Next, check the window we found." : "Good. Next, tap the 4 corners of the window frame."))
                    .font(.subheadline).foregroundStyle(Color.white.opacity(0.88)).fixedSize(horizontal: false, vertical: true)
            } else if count == 4 {
                sizeLine
            } else {
                Text("Then we show the size.").font(.subheadline).foregroundStyle(Color.white.opacity(0.88))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .hudPanel(cornerRadius: 18)
        .accessibilityElement(children: .combine)
    }

    /// "Card corner 2 of 4": the corner to tap next (the count of the ones set, plus one), then "4 corners set".
    static func counter(onCard: Bool, count: Int) -> String {
        let what = onCard ? "Card" : "Window"
        return count >= 4 ? "\(what): 4 corners set" : "\(what) corner \(count + 1) of 4"
    }

    /// The live size from the card, in the app's own words; a number the phone is wildly unsure of is not printed.
    @ViewBuilder private var sizeLine: some View {
        if let p = preview, p.isShowable {
            VStack(alignment: .leading, spacing: 2) {
                Text(SizeFormat.pair(p.widthIn, p.heightIn, size: 24, weight: .bold, color: .white, unit: true))
                    .accessibilityLabel(SizeWording.spokenSize(widthIn: p.widthIn, heightIn: p.heightIn))
                Text(p.needsCheck ? "\(SizeWording.plusMinus(p.uncertaintyIn ?? 1))." : "Accurate to \(SizeWording.accuracy(p.uncertaintyIn ?? 0.25)).")
                    .font(.footnote).foregroundStyle(Color.white.opacity(0.88)).fixedSize(horizontal: false, vertical: true)
            }
        } else if let problem = problem {
            // The server would refuse this photo: its sentence says what to change, and "Use this size" waits
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: WCIcon.alert.symbol).font(.title3).foregroundStyle(Theme.tape)
                Text(problem).font(.subheadline).foregroundStyle(Color.white.opacity(0.95)).fixedSize(horizontal: false, vertical: true)
            }
        } else {
            Text(preview?.reasons.first ?? "The size comes after we upload your photo.")
                .font(.subheadline).foregroundStyle(Color.white.opacity(0.9)).fixedSize(horizontal: false, vertical: true)
        }
    }

    /// The corners as the server wants them: the card from its first long edge, the window as TL, TR, BR, BL. Nil until both are
    /// placed, or when the taps are not a four-sided shape.
    private var ordered: (card: [Vec2], window: [Vec2])? {
        guard cardPoints.count == 4, windowPoints.count == 4,
              let card = CardSizing.cardCornersForAPI(cardPoints.map(vec)),
              let window = CardSizing.orderedQuad(windowPoints.map(vec)) else { return nil }
        return (card, window)
    }

    /// Why the server would refuse this photo, in its own sentence (a card too small to tap, bigger than the window, a corner
    /// off the photo, corners that cross); nil when it would take it. The same check runs here so the homeowner fixes it now.
    private var problem: String? {
        guard let photo = photo, cardPoints.count == 4, windowPoints.count == 4 else { return nil }
        let corners = ordered
        return CardSizing.problem(cardCorners: corners?.card ?? cardPoints.map(vec), windowCorners: corners?.window ?? windowPoints.map(vec),
                                  imageWidthPx: Double(photo.widthPx), imageHeightPx: Double(photo.heightPx))
    }

    private var preview: WindowPreview? {
        guard let photo = photo, problem == nil, let c = ordered,
              let size = CardSizing.size(cardCorners: c.card, windowCorners: c.window, imageWidthPx: Double(photo.widthPx), imageHeightPx: Double(photo.heightPx), focal35mm: photo.focal35mm) else { return nil }
        return WindowPreview(widthIn: size.widthIn, heightIn: size.heightIn, uncertaintyIn: max(size.uncertaintyWidthIn, size.uncertaintyHeightIn), needsCheck: size.quality == .check, reasons: size.reasons)
    }

    private func vec(_ p: CGPoint) -> Vec2 { Vec2(Double(p.x), Double(p.y)) }

    private func buttons(onCard: Bool, count: Int) -> some View {
        HStack(spacing: 12) {
            Button {
                if onCard {
                    photo = nil
                    lookToken += 1
                    cardFound = false
                    windowFound = false
                    step = .intro
                } else {
                    windowPoints = []
                    windowFound = false
                }
            } label: {
                Text(onCard ? "Retake" : "Start over").fontWeight(.semibold).frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .tint(.white)
            Button {
                if onCard { step = .window } else { finish() }
            } label: {
                Text(onCard ? "Next: window corners" : "Use this size").fontWeight(.semibold).multilineTextAlignment(.center).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .tint(Theme.buttonFill)
            .disabled(count != 4 || (!onCard && problem != nil))
        }
        .padding(.bottom, 8)
    }

    /// Four corners on the card and four on the frame: the photo, the corners in it, and the card's, go to the label sheet.
    private func finish() {
        guard let photo = photo, problem == nil, let c = ordered else { return }
        store.capture(scale: .card(CardScale(cardCorners: c.card)), corners: c.window, jpeg: photo.jpeg, widthPx: photo.widthPx, heightPx: photo.heightPx, focal35mm: photo.focal35mm, in: session)
    }

    // MARK: Debug

    private func seedForDebug() {
        #if DEBUG
        guard let seed = store.debugCardSeed, photo == nil else { return }
        useSample()
        if seed.auto {
            // No corners seeded: the phone looks for them on the drawn photo
            if let p = photo { look(for: p) }
            step = .card
            return
        }
        cardPoints = Array(SampleScene.cardCorners.prefix(seed.cardCount))
        let frame = SampleScene.frameCorners
        let inside = CGPoint(x: (frame[0].x + frame[1].x + frame[2].x) / 3, y: (frame[0].y + frame[1].y + frame[2].y) / 3)
        windowPoints = seed.dart ? [frame[0], frame[1], frame[2], inside] : Array(frame.prefix(seed.windowCount))
        step = seed.step
        #endif
    }

    #if DEBUG
    private func useSample() {
        guard let p = PhotoPreparation.prepare(SampleScene.render(withCard: true)) else { return }
        photo = p
        cardPoints = []
        windowPoints = []
        step = .card
    }
    #endif
}

private struct CardTip: View {
    enum Icon { case card, back, light }
    let icon: Icon
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Group {
                switch icon {
                case .card: BankCardGlyph(width: 32)
                case .back: Image(systemName: WCIcon.ruler.symbol).font(.title2).foregroundStyle(Theme.ink)
                case .light: Image(systemName: WCIcon.target.symbol).font(.title2).foregroundStyle(Theme.ink)
                }
            }
            .frame(width: 48, height: 48)
            .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline).foregroundStyle(Theme.ink)
                Text(detail).font(.subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

/// The system camera (one photo). The photo comes back as the camera wrote it; PhotoPreparation turns it upright.
struct CameraPicker: UIViewControllerRepresentable {
    let onFinish: (UIImage?, [AnyHashable: Any]?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.cameraCaptureMode = .photo
        picker.allowsEditing = false
        // A flash on the glass makes a glare spot over the card and the frame
        picker.cameraFlashMode = .off
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ vc: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onFinish: (UIImage?, [AnyHashable: Any]?) -> Void
        init(onFinish: @escaping (UIImage?, [AnyHashable: Any]?) -> Void) { self.onFinish = onFinish }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            onFinish(info[.originalImage] as? UIImage, info[.mediaMetadata] as? [AnyHashable: Any])
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onFinish(nil, nil)
        }
    }
}

/// The card photo's how-to (first time, and from "How?").
struct CardHowTo: View {
    static let steps = ["Tape or hold a bank card flat on the glass.", "Stand about 4 feet back and take one photo.", "Tap the card's 4 corners, then the window's 4 corners."]
    let onDone: () -> Void

    var body: some View {
        HowToOverlay(title: "Photo with a bank card", steps: Self.steps, art: .corners, onDone: onDone)
    }
}
