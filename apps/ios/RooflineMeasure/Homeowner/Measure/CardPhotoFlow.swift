import AVFoundation
import RooflineCore
import SwiftUI
import UIKit

/// "Photo with a bank card" (ios-hw-07c): put a card flat on the glass, take one photo, tap the card's four corners (it is a
/// ruler of known size), tap the window frame's four corners, see the size. Works on any iPhone. The photo is kept upright
/// and the corners are in its pixels; the server recomputes the size from the same data.
struct CardPhotoFlow: View {
    @Environment(HomeownerStore.self) private var store
    let session: MeasureSession

    enum Step { case intro, card, window }

    @State private var step = Step.intro
    @State private var photo: PreparedPhoto?
    @State private var cardPoints: [CGPoint] = []
    @State private var windowPoints: [CGPoint] = []
    @State private var showCamera = false
    @State private var cameraDenied = false
    @State private var cameraNote: String?

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
        VStack(spacing: 0) {
            HStack {
                Button { store.measureSession = nil } label: {
                    IconView(icon: .close, size: 20, weight: 2).foregroundStyle(Theme.ink).frame(width: 44, height: 44).background(Circle().fill(Theme.surface))
                }
                .accessibilityLabel("Close")
                Spacer()
            }
            .padding(.horizontal, 12).padding(.top, 8)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    WCHeadline(text: "Photo with a bank card", subtitle: "One photo of the whole window, with a card on the glass.")
                    CardTip(icon: .card, title: "Put a card flat on the glass", detail: "In the middle of the window, the whole card in view, no glare. A credit, debit or driver licence card works.")
                    CardTip(icon: .back, title: "Stand 3 to 5 feet back", detail: "Straight in front of the window, with all of it in the photo and some room around it. Hold still.")
                    CardTip(icon: .light, title: "Tap the tip of each corner", detail: "The magnifier helps you hit the very tip of the card's rounded corners, then the 4 inside corners of the frame.")
                    if cameraDenied {
                        InfoPanel(icon: .camera, text: "Camera access is off. Turn it on in Settings, then come back.", tint: Theme.warnTint, iconColor: Theme.warn)
                    }
                    if let note = cameraNote { InfoPanel(icon: .info, text: note) }
                    WCScrollFooter()
                }
                .padding(.horizontal, Theme.gutter).padding(.bottom, 24)
            }
        }
        .background(Theme.ground.ignoresSafeArea())
        .wcFooter {
            WCPrimaryButton(title: "Take the photo", icon: .camera, iconLeading: true) { Task { await openCamera() } }
            #if DEBUG
            if !DeviceCaps.cameraAvailable { WCSecondaryButton(title: "Use the sample photo (debug)") { useSample() } }
            #endif
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
    }

    // MARK: Tapping

    private func tapping(_ photo: PreparedPhoto) -> some View {
        let onCard = step == .card
        let points = onCard ? $cardPoints : $windowPoints
        let count = onCard ? cardPoints.count : windowPoints.count
        return VStack(spacing: 10) {
            topBar(onCard: onCard)
            instruction(onCard: onCard)
            PhotoTapView(photo: photo, points: points, reference: onCard ? [] : cardPoints, focus: debugFocus(onCard: onCard), startZoom: debugFocus(onCard: onCard) == nil ? 1 : 5)
                .id(onCard)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            statusPanel(onCard: onCard, count: count)
            buttons(onCard: onCard, count: count)
        }
        .padding(.horizontal, 12)
        .background(Color.black.ignoresSafeArea())
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
                IconView(icon: .chevLeft, size: 20, weight: 2.2).foregroundStyle(.white).frame(width: 44, height: 44).background(Circle().fill(Color(white: 0.12, opacity: 0.8)))
            }
            .accessibilityLabel("Back")
            Text(onCard ? "Step 1 of 2 · the card" : "Step 2 of 2 · the window")
                .wc(17, .semibold, relativeTo: .headline).foregroundStyle(.white)
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color(white: 0.1, opacity: 0.85)))
            Button { store.measureSession = nil } label: {
                IconView(icon: .close, size: 18, weight: 2).foregroundStyle(.white).frame(width: 44, height: 44).background(Circle().fill(Color(white: 0.12, opacity: 0.8)))
            }
            .accessibilityLabel("Close")
        }
        .padding(.top, 8)
    }

    private func instruction(onCard: Bool) -> some View {
        HStack(spacing: 14) {
            if onCard { BankCardGlyph(width: 44) } else { IconView(icon: .win, size: 30).foregroundStyle(Theme.tape).frame(width: 44) }
            Text(instructionText(onCard: onCard)).wc(16, relativeTo: .subheadline).foregroundStyle(Color.white.opacity(0.92)).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color(white: 0.16, opacity: 0.88)))
    }

    private func instructionText(onCard: Bool) -> AttributedString {
        var lead = AttributedString(onCard ? "Tap the 4 corners of the card. " : "Tap the 4 corners of the window frame. ")
        lead.inlinePresentationIntent = .stronglyEmphasized
        let rest = onCard ? "Every bank card is the same size (85.60 × 53.98 mm), so it works as a ruler. Tap the very tip of each rounded corner; drag a dot to adjust."
                          : "The inside of the frame, not the trim. Drag a dot to adjust."
        return lead + AttributedString(rest)
    }

    private func statusPanel(onCard: Bool, count: Int) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(onCard ? "Card: \(count) of 4 corners" : "Window: \(count) of 4 corners").wcMono(20, .bold, relativeTo: .title3).foregroundStyle(.white)
            if onCard {
                Text(count < 4 ? "Next, tap the 4 corners of the window frame. Then we show the size." : "Good. Next, tap the 4 corners of the window frame.")
                    .wc(15, relativeTo: .subheadline).foregroundStyle(Color.white.opacity(0.8)).fixedSize(horizontal: false, vertical: true)
            } else if count == 4 {
                sizeLine
            } else {
                Text("Then we show the size.").wc(15, relativeTo: .subheadline).foregroundStyle(Color.white.opacity(0.8))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color(white: 0.16, opacity: 0.88)))
        .accessibilityElement(children: .combine)
    }

    /// The live size from the card, in the app's own words; a number the phone is wildly unsure of is not printed.
    @ViewBuilder private var sizeLine: some View {
        if let p = preview, p.isShowable {
            VStack(alignment: .leading, spacing: 2) {
                Text(SizeFormat.pair(p.widthIn, p.heightIn, size: 24, weight: .bold, color: .white, unit: true))
                    .accessibilityLabel(SizeWording.spokenSize(widthIn: p.widthIn, heightIn: p.heightIn))
                Text(p.needsCheck ? "\(SizeWording.plusMinus(p.uncertaintyIn ?? 1)). We confirm it at your free visit." : "Accurate to \(SizeWording.accuracy(p.uncertaintyIn ?? 0.25)).")
                    .wc(14, relativeTo: .footnote).foregroundStyle(Color.white.opacity(0.8)).fixedSize(horizontal: false, vertical: true)
            }
        } else if let problem = problem {
            // The server would refuse this photo: its sentence says what to change, and "Use this size" waits
            HStack(alignment: .top, spacing: 10) {
                IconView(icon: .alert, size: 20).foregroundStyle(Theme.tape).padding(.top, 1)
                Text(problem).wc(15, relativeTo: .subheadline).foregroundStyle(Color.white.opacity(0.92)).fixedSize(horizontal: false, vertical: true)
            }
        } else {
            Text(preview?.reasons.first ?? "The size comes after we upload your photo.")
                .wc(15, relativeTo: .subheadline).foregroundStyle(Color.white.opacity(0.85)).fixedSize(horizontal: false, vertical: true)
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
                if onCard { photo = nil; step = .intro } else { windowPoints = [] }
            } label: {
                Text(onCard ? "Retake" : "Start over").wc(17, .semibold, relativeTo: .headline).foregroundStyle(.white)
                    .frame(maxWidth: .infinity, minHeight: Theme.buttonHeight)
                    .background(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).fill(Color(white: 0.3, opacity: 0.7)))
            }
            Button {
                if onCard { step = .window } else { finish() }
            } label: {
                Text(onCard ? "Next: window corners" : "Use this size").wc(17, .semibold, relativeTo: .headline).foregroundStyle(.white)
                    .frame(maxWidth: .infinity, minHeight: Theme.buttonHeight)
                    .background(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).fill(Theme.red))
                    .opacity(count == 4 && (onCard || problem == nil) ? 1 : 0.45)
            }
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
        HStack(spacing: 14) {
            Group {
                switch icon {
                case .card: BankCardGlyph(width: 36)
                case .back: IconView(icon: .ruler, size: 26).foregroundStyle(Theme.ink)
                case .light: IconView(icon: .target, size: 26).foregroundStyle(Theme.tape)
                }
            }
            .frame(width: 64, height: 56)
            .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(title).wc(16, .semibold, relativeTo: .headline).foregroundStyle(Theme.ink)
                Text(detail).wc(13, relativeTo: .footnote).foregroundStyle(Theme.ink3).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(10)
        .wcCard()
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
