#if STAFF_APP
import ARKit
import RoomPlan
import RooflineCore
import SwiftUI

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
#endif
