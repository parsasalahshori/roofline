import ARKit
import RoomPlan
import RooflineCore
import SwiftUI

// Checked (iOS 26.5 SDK RoomPlan.swiftinterface): RoomCaptureSession is not actor-isolated (RoomCaptureView is
// @MainActor). @MainActor here is not required but harmless: every caller is a view.
@MainActor
enum RoomScanSupport {
    /// RoomPlan needs LiDAR.
    static var isSupported: Bool { RoomCaptureSession.isSupported }
}

/// RoomPlan auto-scan (LiDAR phones, quote-grade): walk the room with Apple's RoomCaptureView; every window (and, if
/// the rep ticks it, door) RoomPlan finds is listed with its size; the rep confirms and labels each, and each is saved
/// as a window with scale kind 'roomplan' (always 'check' on the server, ± about 1 in, never order-grade).
/// Each window gets the photo from the scan that saw it best (a keyframe kept during the scan), with its corners
/// drawn into it.
struct RoomScanFlow: View {
    let context: MeasureContext
    let onDone: () -> Void
    @State private var scanner: RoomScanner?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        if !RoomScanSupport.isSupported {
            UnsupportedDeviceView(
                title: "Room scan needs a LiDAR iPhone",
                detail: "RoomPlan runs only on iPhones with LiDAR (12 Pro or a later Pro). Use AR corners or Sheet photo here.",
                onClose: { dismiss() }
            )
        } else {
            scanBody
        }
    }

    private var scanBody: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let s = scanner { RoomScanScreen(context: context, onDone: onDone, scanner: s) }
        }
        .onAppear { if scanner == nil { scanner = RoomScanner() } }
    }
}

private struct RoomScanScreen: View {
    let context: MeasureContext
    let onDone: () -> Void
    let scanner: RoomScanner
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        switch scanner.phase {
        case .scanning, .processing:
            ZStack(alignment: .bottom) {
                RoomCaptureContainer(view: scanner.captureView).ignoresSafeArea()
                VStack(spacing: 8) {
                    if scanner.phase == .processing {
                        ProgressView("Finishing the scan…").padding().background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
                    }
                    HStack {
                        Button("Cancel") { close() }.buttonStyle(.bordered)
                        Spacer()
                        Button("Done scanning") { scanner.stop() }
                            .buttonStyle(.borderedProminent)
                            .disabled(scanner.phase != .scanning)
                    }
                }
                .padding()
            }
            .onAppear {
                UIApplication.shared.isIdleTimerDisabled = true
                scanner.start()
            }
            .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
        case .review:
            NavigationStack {
                List {
                    if scanner.found.isEmpty {
                        Text("RoomPlan found no windows. Scan again closer to the windows, or use AR corners.").foregroundStyle(.secondary)
                    }
                    Section {
                        ForEach(scanner.found.indices, id: \.self) { i in
                            FoundRow(item: Binding(get: { scanner.found[i] }, set: { scanner.found[i] = $0 }))
                        }
                    } footer: {
                        Text("Room-scan sizes are quote-grade (± 1 to 2 in by RoomPlan's confidence) and always marked 'check'. Measure a window with AR corners before ordering it.")
                    }
                    if let e = error { Text(e).foregroundStyle(.red) }
                }
                .navigationTitle("Windows found")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { close() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(saving ? "Saving…" : "Save \(scanner.found.filter { $0.include }.count)") { Task { await save() } }
                            .disabled(saving || !scanner.found.contains { $0.include })
                    }
                }
            }
        case .failed(let message):
            VStack(spacing: 16) {
                Text(message).multilineTextAlignment(.center).foregroundStyle(.white)
                Button("Close") { close() }.buttonStyle(.borderedProminent)
            }
            .padding()
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            for item in scanner.found where item.include {
                guard let made = scanner.makeWindow(item, context: context) else { continue }
                try await model.save(window: made.window, measurementId: context.measurementId, address: context.address,
                                     jpeg: made.jpeg, widthPx: made.widthPx, heightPx: made.heightPx, pass: made.pass)
            }
            close()
        } catch {
            self.error = "Could not save on the phone: \(error.localizedDescription)"
        }
    }

    private func close() {
        scanner.cancel()
        dismiss()
        onDone()
    }
}

private struct FoundRow: View {
    @Binding var item: RoomScanner.Found

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 10) {
                if let thumb = item.thumbnail {
                    Image(uiImage: thumb).resizable().scaledToFill().frame(width: 64, height: 64).clipped().cornerRadius(6)
                }
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(item.isDoor ? "Door" : "Window").font(.caption).foregroundStyle(.secondary)
                        CheckBadge(text: "scan · check")
                    }
                    Text(Eighths.size(widthIn: item.widthM * inchesPerMetre, heightIn: item.heightM * inchesPerMetre)).font(.headline.monospacedDigit())
                    Text("RoomPlan confidence: \(item.confidence.rawValue) · ± \(Eighths.formatUncertainty(RoomPlanLimits.uncertaintyIn(item.confidence))) in").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Toggle("Include", isOn: $item.include).labelsHidden()
            }
            TextField("Label", text: $item.label).textFieldStyle(.roundedBorder)
        }
        .padding(.vertical, 4)
    }
}

/// Hosts RoomPlan's own capture view.
struct RoomCaptureContainer: UIViewRepresentable {
    let view: RoomCaptureView
    func makeUIView(context: Context) -> RoomCaptureView { view }
    func updateUIView(_ uiView: RoomCaptureView, context: Context) {}
}

/// Drives one RoomPlan scan and keeps photos to go with what it finds.
@MainActor
@Observable
final class RoomScanner {
    enum Phase: Equatable {
        case scanning, processing, review
        case failed(String)
    }

    struct Found: Identifiable {
        var id: UUID
        var isDoor: Bool
        var widthM: Double
        var heightM: Double
        var confidence: RoomPlanConfidence
        /// World corners TL, TR, BR, BL.
        var corners: [Vec3]
        var include: Bool
        var label: String
        var keyframe: Int?
        var thumbnail: UIImage?
    }

    /// A photo kept during the scan, with the camera that took it (to draw any window into it later).
    struct Keyframe {
        var jpeg: Data
        var widthPx: Int
        var heightPx: Int
        var cameraTransform: Mat4
        /// For the native (landscape) image.
        var intrinsics: CameraIntrinsics
    }

    private(set) var phase: Phase = .scanning
    var found: [Found] = []

    @ObservationIgnored let captureView: RoomCaptureView
    @ObservationIgnored private let delegate = RoomCaptureDelegate()
    @ObservationIgnored private var keyframes: [Keyframe] = []
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var lastKey: Mat4?
    @ObservationIgnored private let encodeQueue = DispatchQueue(label: "roomscan.keyframes", qos: .utility)
    @ObservationIgnored private var encoding = false
    @ObservationIgnored private var started = false
    let startedAt = Date()

    static let maxKeyframes = 60

    init() {
        captureView = RoomCaptureView(frame: .zero)
        delegate.owner = self
        captureView.delegate = delegate
    }

    func start() {
        guard !started else { return }
        started = true
        captureView.captureSession.run(configuration: RoomCaptureSession.Configuration())
        // Keyframes: a photo whenever the phone has moved or turned enough since the last one
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.maybeKeyframe() }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        // At least one photo to go with what was found (a very short scan may have kept none yet)
        if keyframes.isEmpty, let frame = captureView.captureSession.arSession.currentFrame,
           let e = FrameCapture.uprightJPEG(frame.capturedImage, quality: 0.85) {
            keyframes.append(Keyframe(jpeg: e.0, widthPx: e.1, heightPx: e.2, cameraTransform: Mat4(frame.camera.transform), intrinsics: CameraIntrinsics(frame.camera)))
        }
        phase = .processing
        captureView.captureSession.stop()
    }

    func cancel() {
        timer?.invalidate()
        timer = nil
        captureView.captureSession.stop()
    }

    private func maybeKeyframe() {
        // Checked (SDK): RoomCaptureSession has `public var arSession: ARSession`, the session the scan runs on.
        // ON DEVICE: that CapturedRoom surface transforms are in this session's world space (Apple's iOS 17 multi-room
        // API relies on it); a wrong frame would show as corners drawn off the window in the saved photo.
        guard !encoding, keyframes.count < Self.maxKeyframes, let frame = captureView.captureSession.arSession.currentFrame,
              case .normal = frame.camera.trackingState else { return }
        let t = Mat4(frame.camera.transform)
        if let last = lastKey {
            let moved = t.translation.distance(to: last.translation)
            let turned = acos(max(-1, min(1, t.column(2).dot(last.column(2))))) * 180 / .pi
            guard moved > 0.4 || turned > 20 else { return }
        }
        lastKey = t
        // Read-only hand-off to the encoder queue (CVPixelBuffer is not Sendable; ARKit does not reuse it while held)
        nonisolated(unsafe) let pixels = frame.capturedImage
        let k = CameraIntrinsics(frame.camera)
        encoding = true
        encodeQueue.async { [weak self] in
            let encoded = FrameCapture.uprightJPEG(pixels, quality: 0.85)
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self = self else { return }
                    self.encoding = false
                    if let e = encoded {
                        self.keyframes.append(Keyframe(jpeg: e.0, widthPx: e.1, heightPx: e.2, cameraTransform: t, intrinsics: k))
                    }
                }
            }
        }
    }

    fileprivate func presented(_ room: CapturedRoom?, error: Error?) {
        guard let room = room, error == nil else {
            phase = .failed("The scan could not be finished: \(error?.localizedDescription ?? "no room was captured"). Try again, more slowly.")
            return
        }
        var list: [Found] = []
        let surfaces = room.windows.map { ($0, false) } + room.doors.map { ($0, true) }
        var n = 0
        for (s, isDoor) in surfaces {
            let w = Double(s.dimensions.x), h = Double(s.dimensions.y)
            guard w > 0.1, h > 0.1 else { continue }
            let t = Mat4(s.transform)
            // Seen from inside the room: the room's centre side (the camera path's middle is a fair viewer)
            let viewer = keyframes.isEmpty ? nil : Vec3.mean(keyframes.map { $0.cameraTransform.translation })
            let corners = RoomPlanMath.corners(transform: t, widthM: w, heightM: h, viewer: viewer)
            let conf = Self.confidence(s.confidence)
            let best = bestKeyframe(for: corners)
            if !isDoor { n += 1 }
            list.append(Found(
                id: s.identifier, isDoor: isDoor, widthM: w, heightM: h, confidence: conf,
                corners: corners, include: !isDoor, label: isDoor ? "Door" : "Scan window \(n)",
                keyframe: best, thumbnail: best.flatMap { thumbnail(keyframes[$0].jpeg) }
            ))
        }
        found = list
        phase = .review
    }

    private static func confidence(_ c: CapturedRoom.Confidence) -> RoomPlanConfidence {
        switch c {
        case .high: return .high
        case .medium: return .medium
        case .low: return .low
        @unknown default: return .low
        }
    }

    private func bestKeyframe(for corners: [Vec3]) -> Int? {
        var best: (Int, Double)?
        for (i, k) in keyframes.enumerated() {
            let score = RoomPlanMath.viewScore(corners: corners, cameraTransform: k.cameraTransform, intrinsics: k.intrinsics)
            if score > 0, score > (best?.1 ?? 0) { best = (i, score) }
        }
        return best?.0 ?? (keyframes.isEmpty ? nil : keyframes.count - 1)
    }

    private func thumbnail(_ jpeg: Data) -> UIImage? {
        guard let img = UIImage(data: jpeg) else { return nil }
        return img.preparingThumbnail(of: CGSize(width: 160, height: 160 * img.size.height / max(1, img.size.width)))
    }

    /// The window to save for one found surface: its keyframe photo with the corners drawn in, or no photo and no
    /// corners when no keyframe saw all four corners (the size comes from the scan either way; corners are never made up).
    func makeWindow(_ f: Found, context: MeasureContext) -> (window: PhotoWindowInput, jpeg: Data?, widthPx: Int, heightPx: Int, pass: TestPass)? {
        var jpeg: Data?
        var corners: [Vec2]?
        var widthPx = 0, heightPx = 0
        if let ki = f.keyframe, ki < keyframes.count {
            let k = keyframes[ki]
            let w = Double(k.widthPx), h = Double(k.heightPx)
            let projected = f.corners.compactMap { ImageMapping.project($0, cameraTransform: k.cameraTransform, intrinsics: k.intrinsics) }
                .map { ImageMapping.nativeToPortrait($0, nativeWidth: k.intrinsics.width, nativeHeight: k.intrinsics.height) }
            if projected.count == 4, projected.allSatisfy({ ImageMapping.isInside($0, width: w, height: h) }) {
                corners = projected.map { ImageMapping.clamp($0, width: w, height: h) }
                jpeg = k.jpeg
                widthPx = k.widthPx
                heightPx = k.heightPx
            }
        }
        let label = f.label.trimmingCharacters(in: .whitespaces).isEmpty ? (f.isDoor ? "Door" : "Scan window") : f.label
        let window = PhotoWindowInput(
            id: WindowIds.new(), uploadId: nil, label: label, windowKey: WindowIds.new(), corners: corners,
            scale: .roomplan(RoomPlanScale(widthM: f.widthM, heightM: f.heightM, confidence: f.confidence))
        )
        let pass = TestPass(
            measurementId: context.measurementId, windowId: window.id, windowKey: window.windowKey, label: label,
            method: "roomplan", device: "roomplan", lidar: true, pointsM: f.corners, cornerSpreadM: nil,
            trackingLostCount: 0, restartsForTracking: 0, wallPlaneLocked: false, maxOffPlaneMm: nil,
            widthIn: f.widthM * inchesPerMetre, heightIn: f.heightM * inchesPerMetre,
            uncertaintyWidthIn: RoomPlanLimits.uncertaintyIn(f.confidence), uncertaintyHeightIn: RoomPlanLimits.uncertaintyIn(f.confidence),
            quality: "check", reasons: ["room scan (RoomPlan confidence \(f.confidence.rawValue))"], durationS: Date().timeIntervalSince(startedAt)
        )
        return (window, jpeg, widthPx, heightPx, pass)
    }
}

/// RoomCaptureView's delegate. The protocol inherits NSCoding, so it needs the coder members.
final class RoomCaptureDelegate: NSObject, RoomCaptureViewDelegate {
    weak var owner: RoomScanner?

    override init() { super.init() }

    required init?(coder: NSCoder) { super.init() }

    func encode(with coder: NSCoder) {}

    /// Let RoomPlan process what was scanned (it then shows its model and calls didPresent).
    func captureView(shouldPresent roomDataForProcessing: CapturedRoomData, error: Error?) -> Bool {
        true
    }

    func captureView(didPresent processedResult: CapturedRoom, error: Error?) {
        // RoomCaptureViewDelegate is not annotated @MainActor in the SDK, so do not assume the main thread: hop if needed
        if Thread.isMainThread {
            MainActor.assumeIsolated { owner?.presented(processedResult, error: error) }
        } else {
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated { self?.owner?.presented(processedResult, error: error) }
            }
        }
    }
}
