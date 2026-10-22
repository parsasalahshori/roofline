import ARKit
import RooflineCore
import SwiftUI

/// "Measure a window" on a phone. The camera finds the wall; Capture freezes one frame (its photo, the camera's pose and lens, the wall and
/// the LiDAR depth); the window is then a rectangle on that still photo (`FreezeFrameEditor`), found by the depth sensor and dragged by its
/// corners and sides, where nothing moves; and the window goes on as that rectangle. One to three photos of the same window may be taken:
/// each is checked against the others.
struct ArMeasureScreen: View {
    @Environment(HomeownerStore.self) private var store
    let session: MeasureSession
    /// Made when the camera is allowed, not with the view (an AR view is not cheap to build, and the simulator has none).
    @State private var controller: ArMeasureController?
    @State private var access: CameraAccess.State?
    @State private var showHowTo = !HowToSeen.isSeen("ar")
    /// The frozen photo being worked on, and the answers of the photos kept before it (from one tracking session).
    @State private var editing: FrozenCapture?
    @State private var kept: [FrozenResult] = []
    @State private var keptEpoch: Int?
    @State private var notice: String?

    var body: some View {
        Group {
            #if DEBUG
            if let mode = store.debugOpen, mode.hasPrefix("hud") || mode == "label" || mode.hasPrefix("freeze") {
                DebugCaptureSample(mode: mode, session: session)
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
                // The camera keeps running under the photo, so another photo of the same window is in the same world
                ArSceneContainer(view: controller.sceneView).ignoresSafeArea()
                if let capture = editing {
                    FreezeFrameEditor(capture: capture, earlier: kept, title: title,
                                      services: FreezeServices(findWindow: { await store.findWindow(jpeg: $0) }, dumpCapture: { store.dumpCapture($0) }, dumpResult: { store.dumpResult($0) }),
                                      onClose: { store.measureSession = nil },
                                      onRetake: { editing = nil },
                                      onAddAnother: { keep($0) },
                                      onUse: { finish($0, capture: capture, controller: controller) })
                        .id(capture.id)
                        .transition(.opacity)
                } else {
                    ArCaptureHud(model: model(controller), onClose: { store.measureSession = nil }, onCapture: { controller.captureFrozen() },
                                 onHow: { showHowTo = true })
                }
                if showHowTo { ArHowTo { HowToSeen.markSeen("ar"); showHowTo = false } }
            }
            .onChange(of: controller.frozen?.id) { _, id in
                if id != nil, let f = controller.frozen { open(f) }
            }
            .onChange(of: controller.message) { _, m in
                // A refused capture or a restart: say it once, in the hint's place
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

    private var title: String { WindowCountHint.hudTitle(number: session.number, estimate: store.windowEstimate) }

    private func model(_ controller: ArMeasureController) -> ArCaptureModel {
        var m = ArCaptureModel()
        m.title = title
        m.deviceChip = controller.lidar ? "Depth sensor on" : nil
        m.photosTaken = kept.count
        switch controller.phase {
        case .starting, .searching:
            m.phase = .searching
            m.hint = ArCaptureModel.searchHint
        case .aiming, .sampling, .holdStill, .complete:
            m.phase = controller.capturing ? .holding : .ready
            m.hint = controller.capturing ? ArCaptureModel.holdingHint : ArCaptureModel.readyHint(photosTaken: kept.count)
        case .limited(let why):
            m.phase = controller.capturing ? .holding : .searching
            m.hint = why
        case .lost:
            m.phase = .lost
            m.hint = controller.message ?? "Tracking was lost. Move the phone slowly to find the wall again."
        }
        if let message = notice ?? controller.message, controller.phase != .lost { m.hint = message }
        return m
    }

    /// A photo was taken: work on it. Photos from before a tracking restart are set aside (the world is not the same).
    private func open(_ f: FrozenCapture) {
        if let e = keptEpoch, e != f.epoch, !kept.isEmpty {
            kept = []
            notice = "Tracking restarted, so the earlier photos were set aside."
        } else {
            notice = nil
        }
        keptEpoch = f.epoch
        editing = f
    }

    /// Keep this photo's answer and go back to the camera for another of the same window.
    private func keep(_ result: FrozenResult) {
        kept.append(result)
        notice = nil
        editing = nil
    }

    /// The window goes as the rectangle on the photo, with the doubt of photos that disagreed; the outline is drawn into this photo for the
    /// corners the server sees.
    private func finish(_ r: FrozenResult, capture: FrozenCapture, controller: ArMeasureController) {
        guard let drawing = FrozenMeasure.drawing(r, view: capture.view) else { return }
        controller.pause()
        let corners = drawing.outline.map { ImageMapping.clamp($0, width: Double(capture.widthPx), height: Double(capture.heightPx)) }
        let scale = WindowPhotoScale.ar(ArScale(pointsM: r.windowPointsM, trackingLostCount: capture.trackingLostCount, device: capture.view.device, cornerSpreadM: r.windowSpreadM))
        store.capture(scale: scale, corners: corners, jpeg: capture.jpeg, widthPx: capture.widthPx, heightPx: capture.heightPx, in: session)
    }
}

/// The AR screen's how-to (shown the first time, and from "How?"): the same steps as the coaching, in the order of the screens.
struct ArHowTo: View {
    static let steps = ["Stand 3 to 5 feet back, aim the circle at the window, and tap Capture.", "Drag a corner, or the square on a side, until the outline sits on the frame.", "Check the yellow outline follows the frame, then tap Use this size."]
    let onDone: () -> Void

    var body: some View {
        HowToOverlay(title: "Measure a window", steps: Self.steps, art: .corners, onDone: onDone)
    }
}
