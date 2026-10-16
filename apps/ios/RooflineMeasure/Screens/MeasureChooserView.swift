#if STAFF_APP
import ARKit
import RooflineCore
import SwiftUI

/// How to measure this window: AR corners (LiDAR when the phone has it), a RoomPlan room scan (LiDAR phones, new
/// windows only), or the measuring sheet in the web app's photo screen.
struct MeasureChooserView: View {
    let context: MeasureContext
    @Environment(\.dismiss) private var dismiss
    @State private var label: String = ""
    @State private var mode: Mode?

    enum Mode: String, Identifiable {
        case ar, roomplan, sheet
        var id: String { rawValue }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Window") {
                    TextField("Label (e.g. Kitchen left)", text: $label)
                    if context.again { Text("Another pass of this window: its sizes are combined.").font(.footnote).foregroundStyle(.secondary) }
                }
                Section {
                    Button { mode = .ar } label: {
                        MethodRow(
                            title: DeviceCaps.hasLiDAR ? "LiDAR corners" : "AR corners",
                            detail: DeviceCaps.hasLiDAR
                                ? "Tap the frame's four corners. LiDAR: an order-grade candidate."
                                : "Tap the frame's four corners. No LiDAR on this phone: quote-grade.",
                            systemImage: "viewfinder"
                        )
                    }
                    .disabled(!DeviceCaps.arSupported)
                    if !context.again {
                        Button { mode = .roomplan } label: {
                            MethodRow(title: "Room scan", detail: "Walk the room; every window RoomPlan finds is listed with its size. Quote-grade (± 1 in).", systemImage: "cube.transparent")
                        }
                        .disabled(!DeviceCaps.roomPlanSupported)
                    }
                    Button { mode = .sheet } label: {
                        MethodRow(title: "Sheet photo", detail: "The printed measuring sheet on the glass, in the web app's photo screen.", systemImage: "doc.viewfinder")
                    }
                } header: {
                    Text("Measure with")
                } footer: {
                    if let why = DeviceCaps.unavailableReason(again: context.again) {
                        Label(why, systemImage: "iphone.slash").font(.footnote)
                    }
                }
            }
            .navigationTitle(context.again ? "Measure again" : "Add window")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .onAppear {
                if label.isEmpty { label = context.label }
                #if DEBUG
                if let m = DebugLaunch.method.flatMap(Mode.init(rawValue:)), DebugLaunch.once("method") { mode = m }
                #endif
            }
            .fullScreenCover(item: $mode) { m in
                switch m {
                case .ar:
                    ArMeasureView(context: withLabel, onDone: { dismiss() })
                case .roomplan:
                    RoomScanFlow(context: withLabel, onDone: { dismiss() })
                case .sheet:
                    SheetPhotoView(measurementId: context.measurementId, onDone: { dismiss() })
                }
            }
        }
    }

    private var withLabel: MeasureContext {
        var c = context
        c.label = label.trimmingCharacters(in: .whitespaces).isEmpty ? context.label : label.trimmingCharacters(in: .whitespaces)
        return c
    }
}

private struct MethodRow: View {
    let title: String
    let detail: String
    let systemImage: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: systemImage).font(.title2).frame(width: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline).foregroundStyle(.primary)
                Text(detail).font(.footnote).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}

/// Shown instead of the AR / room-scan screen on a device that cannot run it (the simulator, an old phone), so the
/// session is never started with an unsupported configuration.
struct UnsupportedDeviceView: View {
    let title: String
    let detail: String
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "iphone.slash").font(.system(size: 48)).foregroundStyle(.secondary)
            Text(title).font(.title3.weight(.semibold)).multilineTextAlignment(.center)
            Text(detail).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Button("Close", action: onClose).buttonStyle(.borderedProminent)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
    }
}
#endif
