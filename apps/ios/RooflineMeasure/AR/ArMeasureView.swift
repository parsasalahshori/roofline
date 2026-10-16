#if STAFF_APP
import ARKit
import RooflineCore
import SwiftUI

/// The AR corner measure screen: camera, centre reticle, loupe, live sides in eighths, Place / Undo / Start over,
/// then the size with its ± and Save (the window goes into the outbox; the screen closes).
struct ArMeasureView: View {
    let context: MeasureContext
    let onDone: () -> Void
    /// Made once, on appear (a @State default would build a new ARSCNView every time SwiftUI re-creates this view).
    @State private var controller: ArMeasureController?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        if !DeviceCaps.arSupported {
            UnsupportedDeviceView(
                title: "AR needs an iPhone camera",
                detail: "Corner measuring uses ARKit world tracking, which this device (or the simulator) does not have. "
                    + "Use an iPhone; a LiDAR iPhone (12 Pro or a later Pro) gives order-grade candidates.",
                onClose: { dismiss() }
            )
        } else {
            arBody
        }
    }

    private var arBody: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let c = controller { ArMeasureScreen(context: context, onDone: onDone, controller: c) }
        }
        .onAppear { if controller == nil { controller = ArMeasureController() } }
    }
}

private struct ArMeasureScreen: View {
    let context: MeasureContext
    let onDone: () -> Void
    let controller: ArMeasureController
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var label = ""
    @State private var saving = false
    @State private var saveError: String?

    var body: some View {
        ZStack {
            ArSceneContainer(view: controller.sceneView)
                .ignoresSafeArea()
            Reticle(active: controller.canPlace, progress: controller.sampleProgress)
                .allowsHitTesting(false)
            VStack(spacing: 10) {
                topBar
                HStack(alignment: .top) {
                    if let img = controller.loupe, !controller.capture.isComplete { Loupe(image: img) }
                    Spacer()
                    sides
                }
                .padding(.horizontal)
                Spacer()
                bottomPanel
            }
        }
        .statusBarHidden()
        .onAppear {
            if label.isEmpty { label = context.label }
            UIApplication.shared.isIdleTimerDisabled = true
            controller.start()
        }
        .onDisappear {
            UIApplication.shared.isIdleTimerDisabled = false
            controller.pause()
        }
    }

    // MARK: Parts

    private var topBar: some View {
        HStack(alignment: .top) {
            Button { close() } label: {
                Image(systemName: "xmark").font(.headline).padding(10).background(.ultraThinMaterial, in: Circle())
            }
            .accessibilityLabel("Close")
            VStack(alignment: .leading, spacing: 4) {
                Text(statusText).font(.subheadline.weight(.semibold))
                HStack(spacing: 6) {
                    Chip(text: controller.lidar ? "LiDAR" : "No LiDAR · quote-grade", tint: controller.lidar ? .green : .orange)
                    if controller.wallLocked { Chip(text: "Wall found", tint: .blue) }
                    if controller.capture.trackingLostCount > 0 { Chip(text: "Lost \(controller.capture.trackingLostCount)×", tint: .red) }
                }
            }
            .padding(10)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
            Spacer()
        }
        .padding(.horizontal)
        .padding(.top, 8)
    }

    private var sides: some View {
        VStack(alignment: .trailing, spacing: 4) {
            ForEach(Array(controller.liveSides.enumerated()), id: \.offset) { _, s in
                Text(s.text)
                    .font(.callout.monospacedDigit().weight(s.toAim ? .regular : .semibold))
                    .foregroundStyle(s.toAim ? Color.secondary : Color.primary)
            }
        }
        .padding(controller.liveSides.isEmpty ? 0 : 8)
        .background(controller.liveSides.isEmpty ? AnyShapeStyle(Color.clear) : AnyShapeStyle(.ultraThinMaterial), in: RoundedRectangle(cornerRadius: 10))
    }

    @ViewBuilder
    private var bottomPanel: some View {
        VStack(spacing: 10) {
            if let m = controller.message ?? saveError {
                Text(m).font(.footnote).multilineTextAlignment(.center).padding(8).frame(maxWidth: .infinity)
                    .background(Color.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 10)).foregroundStyle(.white)
            }
            if controller.capture.isComplete {
                completePanel
            } else {
                HStack(spacing: 12) {
                    Button("Undo") { controller.undo() }
                        .buttonStyle(.bordered)
                        .disabled(controller.capture.corners.isEmpty)
                    Button {
                        controller.placeCorner()
                    } label: {
                        Text(controller.phase == .sampling || controller.phase == .holdStill ? "Hold still…" : "Place corner \(controller.capture.corners.count + 1) of 4")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(!controller.canPlace)
                    Button("Start over") { controller.startOver() }
                        .buttonStyle(.bordered)
                        .disabled(controller.capture.corners.isEmpty)
                }
            }
        }
        .padding()
        .background(.ultraThinMaterial)
    }

    @ViewBuilder
    private var completePanel: some View {
        VStack(spacing: 8) {
            if let p = controller.preview {
                HStack {
                    Text(Eighths.size(widthIn: p.widthIn, heightIn: p.heightIn)).font(.title2.monospacedDigit().bold())
                    if p.quality == .check { CheckBadge() }
                }
                Text("± \(Eighths.formatUncertainty(p.uncertaintyWidthIn)) wide, ± \(Eighths.formatUncertainty(p.uncertaintyHeightIn)) high · \(controller.lidar ? "LiDAR" : "quote-grade")")
                    .font(.footnote).foregroundStyle(.secondary)
                if !p.reasons.isEmpty {
                    Text("Check: " + p.reasons.joined(separator: "; ")).font(.footnote).foregroundStyle(.orange)
                }
            }
            if !controller.cornersInPhoto {
                Label("Step back until the whole window is on screen: Save keeps this view as the photo.", systemImage: "arrow.down.backward.and.arrow.up.forward")
                    .font(.footnote)
            }
            TextField("Label", text: $label)
                .textFieldStyle(.roundedBorder)
            HStack(spacing: 12) {
                Button("Undo") { controller.undo() }.buttonStyle(.bordered)
                Button("Start over") { controller.startOver() }.buttonStyle(.bordered)
                Button {
                    Task { await save() }
                } label: {
                    HStack {
                        if saving { ProgressView() }
                        Text("Save")
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(saving || controller.preview == nil)
            }
        }
    }

    private var statusText: String {
        switch controller.phase {
        case .starting: return "Starting the camera…"
        case .searching: return controller.capture.corners.isEmpty ? "Point at the window frame and move the phone a little." : "Looking for the wall…"
        case .aiming: return "Put the crosshair on a frame corner, then tap Place."
        case .sampling: return "Measuring the corner: hold still."
        case .holdStill: return "Hold the phone still."
        case .limited(let r): return r
        case .lost: return "Tracking lost. Move the phone slowly over the wall."
        case .complete: return "All four corners placed."
        }
    }

    private func save() async {
        saving = true
        saveError = nil
        defer { saving = false }
        let name = label.trimmingCharacters(in: .whitespaces).isEmpty ? context.label : label.trimmingCharacters(in: .whitespaces)
        guard let made = controller.makeWindow(context: context, label: name) else { return }
        do {
            try await model.save(window: made.window, measurementId: context.measurementId, address: context.address,
                                 jpeg: made.shot.jpeg, widthPx: made.shot.widthPx, heightPx: made.shot.heightPx, pass: made.pass)
            close()
        } catch {
            saveError = "Could not save on the phone: \(error.localizedDescription)"
        }
    }

    private func close() {
        controller.pause()
        dismiss()
        onDone()
    }
}

/// The centre crosshair, with a ring that fills while a corner is sampled.
private struct Reticle: View {
    let active: Bool
    let progress: Double

    var body: some View {
        ZStack {
            Circle().stroke(Color.white.opacity(0.8), lineWidth: 1.5).frame(width: 34, height: 34)
            if progress > 0 {
                Circle().trim(from: 0, to: progress).stroke(Color.green, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                    .rotationEffect(.degrees(-90)).frame(width: 42, height: 42)
            }
            Rectangle().fill(active ? Color.green : Color.white).frame(width: 1.5, height: 22)
            Rectangle().fill(active ? Color.green : Color.white).frame(width: 22, height: 1.5)
        }
        .shadow(radius: 1)
    }
}

/// The magnified view around the crosshair.
private struct Loupe: View {
    let image: UIImage

    var body: some View {
        ZStack {
            Image(uiImage: image).resizable().interpolation(.high).scaledToFill()
            Rectangle().fill(Color.green).frame(width: 1, height: 28)
            Rectangle().fill(Color.green).frame(width: 28, height: 1)
        }
        .frame(width: 120, height: 120)
        .clipShape(Circle())
        .overlay(Circle().stroke(Color.white, lineWidth: 2))
        .shadow(radius: 3)
        .accessibilityHidden(true)
    }
}

private struct Chip: View {
    let text: String
    let tint: Color

    var body: some View {
        Text(text).font(.caption2.bold()).padding(.horizontal, 6).padding(.vertical, 2)
            .background(tint.opacity(0.25), in: Capsule()).foregroundStyle(tint)
    }
}
#endif
