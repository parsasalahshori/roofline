import RoomPlan
import RooflineCore
import SwiftUI

/// "Scan the whole room" or "Quick scan (Apple)" on a phone with a depth sensor: Apple's room capture with the windows-found bar
/// over it, then the review (07b). The quick scan is one wall: point at it, pan a few seconds, Done.
/// The scanner (shared with the rep app) keeps a photo to go with each window it finds.
struct RoomScanScreen: View {
    @Environment(HomeownerStore.self) private var store
    let session: MeasureSession
    /// Made when the camera is allowed, not with the view (RoomPlan's capture view is heavy, and the simulator has none).
    @State private var scanner: RoomScanner?
    @State private var access: CameraAccess.State?

    private var mode: RoomScanMode { session.method == .quickScan ? .oneWall : .wholeRoom }

    var body: some View {
        Group {
            #if DEBUG
            if let mode = store.debugOpen, mode.hasPrefix("scan") || mode.hasPrefix("quickscan") {
                DebugScanSample(session: session)
            } else {
                live
            }
            #else
            live
            #endif
        }
    }

    @ViewBuilder private var live: some View {
        if !RoomScanSupport.isSupported {
            UnsupportedMeasureView(reason: DeviceCaps.arSupported ? .noDepth : .noCamera, method: .roomScan) { store.measureSession = nil }
        } else if access == .denied {
            UnsupportedMeasureView(reason: .cameraOff, method: .roomScan) { store.measureSession = nil }
        } else if access == .restricted {
            UnsupportedMeasureView(reason: .cameraRestricted, method: .roomScan) { store.measureSession = nil }
        } else if let scanner = scanner {
            Group {
                switch scanner.phase {
                // The capture view stays in the hierarchy while RoomPlan processes: it is the view that runs the processing
                // and calls back with the finished room, so taking it out would leave the scan hanging on "Building".
                case .scanning, .processing: scanning(scanner)
                case .review: review(scanner)
                case .failed(let message): failed(message)
                }
            }
            .onDisappear { scanner.cancel() }
        } else {
            Color.black.ignoresSafeArea()
                .task {
                    access = await CameraAccess.request()
                    if access == .allowed {
                        let s = RoomScanner(mode: mode)
                        scanner = s
                        s.start()
                    }
                }
        }
    }

    private func scanning(_ scanner: RoomScanner) -> some View {
        ZStack {
            RoomCaptureContainer(view: scanner.captureView).ignoresSafeArea()
            if scanner.phase == .processing {
                VStack(spacing: 16) {
                    ProgressView().tint(.white).scaleEffect(1.3)
                    Text(mode == .oneWall ? "Measuring your windows…" : "Building your room…").wc(17, .semibold, relativeTo: .headline).foregroundStyle(.white)
                }
                .padding(28)
                .background(RoundedRectangle(cornerRadius: 20).fill(Color(white: 0.12, opacity: 0.85)))
            } else {
                ScanHud(room: session.room, progress: scanner.progress, windows: scanner.liveWindows,
                        onCancel: { store.measureSession = nil }, onDone: { scanner.stop() })
            }
        }
    }

    @ViewBuilder private func review(_ scanner: RoomScanner) -> some View {
        let windows = scanner.found.filter { !$0.isDoor }
        if windows.isEmpty {
            noWindows
        } else {
            let rows = windows.enumerated().map { i, f in
                ScanReviewRow(id: f.id, letter: ScanWording.letter(i), name: windows.count > 1 ? "Window \(ScanWording.letter(i))" : "Window", room: session.room, included: f.include,
                              widthM: f.widthM, heightM: f.heightM, confidence: f.confidence,
                              styleKey: StyleGuess.suggestion(widthIn: f.widthM * inchesPerMetre, heightIn: f.heightM * inchesPerMetre, offered: store.styles.map { $0.key }).keys.first,
                              photo: f.photo)
            }
            RoomScanReview(mode: mode, room: session.room, seconds: scanner.scanSeconds, plan: scanner.plan ?? ScanPlan(walls: [], openings: [], wallHeight: 2.4), rows: rows,
                           onAdd: { chosen in add(chosen, scanner: scanner) }, onCorners: { corners() }, onCancel: { store.measureSession = nil })
        }
    }

    /// The scan worked, but there is no window in it: say so, and offer another go or the photo method.
    private var noWindows: some View {
        VStack(spacing: 18) {
            Text(ScanWording.foundTitle(0)).wcHeading(24, .heavy, relativeTo: .title).foregroundStyle(.white).multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            Text(mode == .oneWall ? "Point your phone at the window for a few seconds, then tap Done. Or measure it with a photo and a bank card."
                                  : "Walk round the room again with every window in view. Or measure them with a photo and a bank card.")
                .wc(16, relativeTo: .body).foregroundStyle(Color.white.opacity(0.85)).multilineTextAlignment(.center)
            WCPrimaryButton(title: "Scan again") { store.measureSession = MeasureSession(method: session.method, room: session.room, number: session.number) }
            if store.isAvailable(.card) {
                WCSecondaryButton(title: "Measure with a photo instead") { photoMethod() }
            }
            Button("Close") { store.measureSession = nil }
                .wc(17, .semibold, relativeTo: .body).foregroundStyle(Color.white.opacity(0.85)).frame(minHeight: Theme.minTap)
        }
        .padding(Theme.gutter)
    }

    private func failed(_ message: String) -> some View {
        VStack(spacing: 18) {
            Text("The scan didn't finish").wcHeading(24, .heavy, relativeTo: .title).foregroundStyle(.white).multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            Text(message).wc(16, relativeTo: .body).foregroundStyle(Color.white.opacity(0.85)).multilineTextAlignment(.center)
            WCPrimaryButton(title: "Try again") { store.measureSession = MeasureSession(method: session.method, room: session.room, number: session.number) }
            WCSecondaryButton(title: "Measure one window at a time instead") { corners() }
            Button("Close") { store.measureSession = nil }
                .wc(17, .semibold, relativeTo: .body).foregroundStyle(Color.white.opacity(0.85)).frame(minHeight: Theme.minTap)
        }
        .padding(Theme.gutter)
    }

    /// Saves the windows that were kept, each in the room it was given (the review can rename the room or move one window), through
    /// the same path as every other measured window: the outbox, unchanged.
    private func add(_ chosen: [ScanReviewRow], scanner: RoomScanner) {
        let multiple = chosen.count > 1
        let list: [ScannedWindow] = chosen.compactMap { row in
            guard let f = scanner.found.first(where: { $0.id == row.id }) else { return nil }
            return row.scannedWindow(multiple: multiple, photo: scanner.keyframePhoto(for: f))
        }
        Task { await store.saveScanned(list, room: chosen.first?.room ?? session.room) }
    }

    /// "Measure with a photo instead": the same room, the bank-card photo.
    private func photoMethod() {
        store.method = .card
        store.measureSession = MeasureSession(method: .card, room: session.room, number: session.number)
    }

    /// "Tap corners for each one": the same room, the corner method instead.
    private func corners() {
        store.method = .corners
        store.measureSession = MeasureSession(method: .corners, room: session.room, number: session.number)
    }
}
