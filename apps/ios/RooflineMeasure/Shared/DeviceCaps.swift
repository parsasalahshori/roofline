import ARKit
import AVFoundation
import RooflineCore
import UIKit

/// What this phone can do. Shared by the rep app and the WinChoice homeowner app.
@MainActor
enum DeviceCaps {
    static var arSupported: Bool { ARWorldTrackingConfiguration.isSupported }

    /// LiDAR: scene depth and mesh reconstruction (iPhone 12 Pro and later Pro models).
    static var hasLiDAR: Bool {
        ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) && ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
    }

    static var roomPlanSupported: Bool { RoomScanSupport.isSupported }

    /// A camera to take the bank card photo with (the simulator has none).
    static var cameraAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

    /// Why AR corners or Room scan are greyed out on this device (the simulator has neither), or nil.
    static func unavailableReason(again: Bool) -> String? {
        if !arSupported {
            return "AR corners and Room scan need an iPhone with a camera (Room scan: a LiDAR iPhone, 12 Pro or a later Pro). "
                + "Not available on this device; Sheet photo still works."
        }
        if !roomPlanSupported && !again {
            return "Room scan needs an iPhone with LiDAR (12 Pro or a later Pro)."
        }
        return nil
    }

    // MARK: For the homeowner app

    /// The system's model identifier ("iPhone16,1"); in the simulator, the simulated phone's.
    static var modelIdentifier: String {
        #if targetEnvironment(simulator)
        return ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] ?? "iPhone"
        #else
        var info = utsname()
        uname(&info)
        return withUnsafePointer(to: &info.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
        }
        #endif
    }

    /// What the three measuring methods need, as this phone has it, in the words of the screens.
    static var measureCapabilities: MeasureCapabilities {
        let name = DeviceNames.name(identifier: modelIdentifier)
        #if DEBUG
        // The simulator has no camera or LiDAR: -debugCaps lidar | corners | card | none pretends, so every screen can be
        // looked at (the measuring screens themselves still show their "needs an iPhone" page).
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-debugCaps"), i + 1 < args.count {
            switch args[i + 1] {
            case "lidar": return .depthSensorPhone(name == "iPhone" ? "iPhone 15 Pro" : name)
            case "corners": return MeasureCapabilities(deviceName: name, corners: true, depthSensor: false, roomScan: false, camera: true)
            case "card": return MeasureCapabilities(deviceName: name, corners: false, depthSensor: false, roomScan: false, camera: true)
            default: return .none
            }
        }
        #endif
        return MeasureCapabilities(deviceName: name, corners: arSupported, depthSensor: hasLiDAR, roomScan: roomPlanSupported, camera: cameraAvailable)
    }
}
