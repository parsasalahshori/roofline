import AVFoundation
import RooflineCore
import SwiftUI

/// The measuring screens, full screen over everything: the AR corners, the room scan or the bank-card photo, then the label
/// sheet (room, optional name, save) over whichever one it was. "Measure it again" starts the same method over.
struct MeasureHost: View {
    @Environment(HomeownerStore.self) private var store
    let session: MeasureSession
    @State private var attempt = 0

    var body: some View {
        @Bindable var store = store
        ZStack {
            Color.black.ignoresSafeArea()
            // A window restored after the app was closed has no camera behind its sheet
            if !store.pendingRestored {
                Group {
                    switch session.method {
                    case .corners: ArMeasureScreen(session: session).id(attempt)
                    case .roomScan, .quickScan: RoomScanScreen(session: session).id(attempt)
                    case .roomCloseups: RoomHybridScreen(session: session).id(attempt)
                    case .card: CardPhotoFlow(session: session).id(attempt)
                    }
                }
                // The label sheet is modal: what is dimmed behind it is not read or audited as part of the screen
                .accessibilityHidden(store.pending != nil)
            }
            // The camera picture is dimmed behind the label sheet: the sheet is the thing to read
            if store.pending != nil { Color.black.opacity(0.6).ignoresSafeArea().allowsHitTesting(false) }
        }
        .sheet(item: $store.pending) { p in
            LabelSheet(pending: p) {
                store.clearPending()
                attempt += 1
            }
            .environment(store)
        }
    }
}

/// Camera permission, asked before the AR session or the camera picker starts, so a refusal can say what to do.
@MainActor
enum CameraAccess {
    /// `denied`: the person said no (Settings can turn it back on). `restricted`: this iPhone does not allow camera use at all
    /// (Screen Time, a managed device): Settings cannot fix it, so the wording is different.
    enum State { case allowed, denied, restricted }

    static let restrictedText = "Camera use is restricted on this iPhone, e.g. by Screen Time."

    static func request() async -> State {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return .allowed
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .video) ? .allowed : .denied
        case .restricted: return .restricted
        default: return .denied
        }
    }
}

/// A measuring screen that cannot run here: the phone has no camera or no AR (the simulator), or camera access is off. It says
/// what is needed and offers the way out, so nobody is left on a black screen.
struct UnsupportedMeasureView: View {
    enum Reason {
        case noCamera
        case noDepth
        case cameraOff
        /// Camera use is blocked on the phone itself (Screen Time): no Settings switch to point to.
        case cameraRestricted
    }

    let reason: Reason
    let method: MeasureMethod
    let onClose: () -> Void

    private var title: String {
        switch reason {
        case .noCamera: return "This needs an iPhone"
        case .noDepth: return "This needs a Pro iPhone"
        case .cameraOff: return "Camera access is off"
        case .cameraRestricted: return "Camera is restricted"
        }
    }

    private var detail: String {
        switch reason {
        case .noCamera: return "This device can't measure with a camera. Your request is saved. Open WinChoice on your iPhone to measure your windows."
        case .noDepth: return "Scanning a room needs the depth sensor in a Pro iPhone. Tap the 4 corners of each window instead, or take a photo with a bank card."
        case .cameraOff: return "WinChoice uses the camera only to measure your windows. Turn it on in Settings, then come back."
        case .cameraRestricted: return CameraAccess.restrictedText + " Ask whoever manages this iPhone to allow it, or measure from another iPhone."
        }
    }

    var body: some View {
        VStack(spacing: 18) {
            HStack {
                Button(action: onClose) {
                    Image(systemName: WCIcon.close.symbol).font(.body.weight(.semibold)).foregroundStyle(Theme.ink).hudCircle()
                }
                .accessibilityLabel("Close")
                Spacer()
            }
            Spacer()
            ContentUnavailableView {
                Label {
                    Text(title)
                } icon: {
                    Image(systemName: symbol)
                }
            } description: {
                Text(detail)
            }
            Spacer()
            if reason == .cameraOff {
                WCPrimaryButton(title: "Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                }
            }
            WCSecondaryButton(title: "Back", action: onClose)
        }
        .padding(Theme.gutter)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.ground.ignoresSafeArea())
        .accessibilityElement(children: .contain)
    }

    private var symbol: String {
        switch reason {
        case .cameraOff, .cameraRestricted: return WCIcon.camera.symbol
        case .noCamera, .noDepth: return WCIcon.alert.symbol
        }
    }
}
