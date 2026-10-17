import ARKit
import RooflineCore
import SwiftUI

/// "Tap the 4 corners" on a phone: the AR camera with the HUD over it. The controller (shared with the rep app) does the
/// AR; this screen turns its state into the HUD's values and its finished corners into a pending window.
struct ArMeasureScreen: View {
    @Environment(HomeownerStore.self) private var store
    let session: MeasureSession
    /// Made when the camera is allowed, not with the view (an AR view is not cheap to build, and the simulator has none).
    @State private var controller: ArMeasureController?
    @State private var access: CameraAccess.State?

    var body: some View {
        Group {
            #if DEBUG
            if let mode = store.debugOpen, mode.hasPrefix("hud") || mode == "label" {
                DebugHudSample(mode: mode, session: session)
            } else {
                live
            }
            #else
            live
            #endif
        }
    }

    @ViewBuilder private var live: some View {
        if !DeviceCaps.arSupported {
            UnsupportedMeasureView(reason: .noCamera, method: .corners) { store.measureSession = nil }
        } else if access == .denied {
            UnsupportedMeasureView(reason: .cameraOff, method: .corners) { store.measureSession = nil }
        } else if access == .restricted {
            UnsupportedMeasureView(reason: .cameraRestricted, method: .corners) { store.measureSession = nil }
        } else if let controller = controller {
            ZStack {
                ArSceneContainer(view: controller.sceneView).ignoresSafeArea()
                ArHud(model: model(controller), onClose: { store.measureSession = nil }, onPlace: { controller.placeCorner() }, onUndo: { controller.undo() }, onDone: { finish(controller) })
            }
            .onChange(of: controller.message) { _, m in
                // A refused tap or a restart: say it once, in the hint's place
                if m != nil { Haptics.warning() }
            }
            .onDisappear { controller.pause() }
        } else {
            Color.black.ignoresSafeArea()
                .task {
                    guard DeviceCaps.arSupported else { return }
                    access = await CameraAccess.request()
                    if access == .allowed {
                        let c = ArMeasureController(tapeStyle: true)
                        controller = c
                        c.start()
                    }
                }
        }
    }

    private func model(_ controller: ArMeasureController) -> ArHudModel {
        var m = ArHudModel()
        m.title = WindowCountHint.hudTitle(number: session.number, estimate: store.windowEstimate)
        m.deviceChip = controller.lidar ? "Depth sensor on" : nil
        m.readout = controller.liveReadout
        m.canUndo = !controller.capture.points.isEmpty
        m.dots = controller.cornerDots
        m.edges = controller.edgeLabels.map { ArHudModel.Edge(id: $0.id, point: $0.point, inches: $0.inches, live: $0.live) }
        m.loupe = controller.loupe
        m.canPlace = controller.canPlace
        switch controller.phase {
        case .starting, .searching:
            m.phase = .searching
            m.hint = "Move the phone slowly to find the wall."
        case .aiming:
            m.phase = .ready
            m.hint = controller.capture.points.isEmpty ? "Blinds up · tap the frame, not the glass" : "Aim at corner \(min(controller.capture.points.count + 1, 4))"
        case .sampling:
            m.phase = .sampling(controller.sampleProgress)
            m.hint = "Hold still on the corner."
        case .holdStill:
            m.phase = .holdStill
            m.hint = "Hold the phone still."
        case .limited(let why):
            m.phase = .searching
            m.hint = why
        case .lost:
            m.phase = .lost
            m.hint = controller.message ?? "Tracking was lost. Start again from the first corner."
        case .complete:
            m.phase = .complete
            m.hint = controller.cornersInPhoto ? "Looks right? Tap the check to keep it." : "The frame isn't all in the picture. Step back, or start over."
        }
        if let message = controller.message, controller.phase != .lost { m.hint = message }
        return m
    }

    /// The four corners are set: the photo of this frame, the corners in it, and the size the phone works out.
    private func finish(_ controller: ArMeasureController) {
        guard let cap = controller.makeCapture() else { return }
        controller.pause()
        let scale = WindowPhotoScale.ar(ArScale(pointsM: cap.finished.pointsM, trackingLostCount: controller.capture.trackingLostCount, device: controller.device, cornerSpreadM: cap.finished.cornerSpreadM))
        store.capture(scale: scale, corners: cap.shot.corners, jpeg: cap.shot.jpeg, widthPx: cap.shot.widthPx, heightPx: cap.shot.heightPx, in: session)
    }
}
