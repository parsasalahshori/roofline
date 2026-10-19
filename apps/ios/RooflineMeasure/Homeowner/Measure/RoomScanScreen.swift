import RoomPlan
import RooflineCore
import SwiftUI

/// "Scan the whole room" on a phone with a depth sensor: Apple's room capture with a small bar over it, then the review (07b).
/// The scanner (shared with the rep app) keeps a photo to go with each window it finds.
struct RoomScanScreen: View {
    @Environment(HomeownerStore.self) private var store
    let session: MeasureSession
    /// Made when the camera is allowed, not with the view (RoomPlan's capture view is heavy, and the simulator has none).
    @State private var scanner: RoomScanner?
    @State private var access: CameraAccess.State?

    var body: some View {
        Group {
            #if DEBUG
            if let mode = store.debugOpen, mode.hasPrefix("scan") {
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
                        let s = RoomScanner()
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
                    Text("Building your room…").wc(17, .semibold, relativeTo: .headline).foregroundStyle(.white)
                }
                .padding(28)
                .background(RoundedRectangle(cornerRadius: 20).fill(Color(white: 0.12, opacity: 0.85)))
            } else {
            VStack {
                HStack(spacing: 10) {
                    Button { store.measureSession = nil } label: {
                        IconView(icon: .close, size: 20, weight: 2).foregroundStyle(.white).frame(width: 44, height: 44).background(Circle().fill(Color(white: 0.12, opacity: 0.75)))
                    }
                    .accessibilityLabel("Cancel the scan")
                    Text(session.room).wc(17, .semibold, relativeTo: .headline).foregroundStyle(.white)
                        .padding(.horizontal, 16).frame(height: 44)
                        .background(Capsule().fill(Color(white: 0.12, opacity: 0.75)))
                    Spacer()
                }
                .padding(.horizontal, 12).padding(.top, 8)
                Spacer()
                Text("Walk slowly around the room. Keep every window in view.").wc(16, .medium, relativeTo: .body).foregroundStyle(.white).multilineTextAlignment(.center)
                    .padding(.horizontal, 16).padding(.vertical, 12)
                    .background(Capsule().fill(Color(white: 0.12, opacity: 0.78)))
                    .padding(.horizontal, 20)
                WCPrimaryButton(title: "Done scanning") { scanner.stop() }
                    .padding(.horizontal, Theme.gutter).padding(.vertical, 12)
            }
            // Over the camera the controls stop at the largest ordinary text size, so the room stays in view
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
            }
        }
    }

    private func review(_ scanner: RoomScanner) -> some View {
        let windows = scanner.found.filter { !$0.isDoor }
        let rows = windows.enumerated().map { i, f in
            ScanReviewRow(id: f.id, letter: Self.letter(i), name: windows.count > 1 ? "Window \(Self.letter(i))" : "Window", room: session.room, included: f.include,
                          widthM: f.widthM, heightM: f.heightM, confidence: f.confidence,
                          styleKey: StyleGuess.suggestion(widthIn: f.widthM * inchesPerMetre, heightIn: f.heightM * inchesPerMetre, offered: store.styles.map { $0.key }).keys.first)
        }
        return RoomScanReview(room: session.room, seconds: scanner.scanSeconds, plan: scanner.plan ?? ScanPlan(walls: [], openings: [], wallHeight: 2.4), rows: rows,
                              onAdd: { chosen in add(chosen, scanner: scanner) }, onCorners: { corners() }, onCancel: { store.measureSession = nil })
    }

    private func failed(_ message: String) -> some View {
        VStack(spacing: 18) {
            Text("The scan didn't finish").wcHeading(24, .heavy, relativeTo: .title).foregroundStyle(.white).multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            Text(message).wc(16, relativeTo: .body).foregroundStyle(Color.white.opacity(0.85)).multilineTextAlignment(.center)
            WCPrimaryButton(title: "Try again") { store.measureSession = MeasureSession(method: .roomScan, room: session.room, number: session.number) }
            WCSecondaryButton(title: "Measure one window at a time instead") { corners() }
            Button("Close") { store.measureSession = nil }
                .wc(17, .semibold, relativeTo: .body).foregroundStyle(Color.white.opacity(0.85)).frame(minHeight: Theme.minTap)
        }
        .padding(Theme.gutter)
    }

    private static func letter(_ i: Int) -> String { String(UnicodeScalar(UInt8(65 + i % 26))) }

    private func add(_ chosen: [ScanReviewRow], scanner: RoomScanner) {
        let multiple = chosen.count > 1
        let list: [ScannedWindow] = chosen.compactMap { row in
            guard let f = scanner.found.first(where: { $0.id == row.id }) else { return nil }
            let shot = scanner.keyframePhoto(for: f)
            return ScannedWindow(name: multiple ? "\(row.room), window \(row.letter)" : "", widthM: f.widthM, heightM: f.heightM, confidence: f.confidence,
                                 jpeg: shot?.jpeg, imageWidthPx: shot?.widthPx ?? 0, imageHeightPx: shot?.heightPx ?? 0, corners: shot?.corners, room: row.room)
        }
        Task { await store.saveScanned(list, room: session.room) }
    }

    /// "Tap corners for each one": the same room, the corner method instead.
    private func corners() {
        store.method = .corners
        store.measureSession = MeasureSession(method: .corners, room: session.room, number: session.number)
    }
}
