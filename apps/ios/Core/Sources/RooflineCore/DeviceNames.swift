import Foundation

/// The name a homeowner knows their phone by ("iPhone 15 Pro"), from the model identifier the system reports
/// ("iPhone16,1"), for sentences like "Your iPhone 15 Pro has a depth sensor". Unknown identifiers say just "iPhone": a
/// wrong model name in a sentence about accuracy is worse than a plain one.
public enum DeviceNames {
    private static let names: [String: String] = [
        "iPhone11,2": "iPhone XS", "iPhone11,4": "iPhone XS Max", "iPhone11,6": "iPhone XS Max", "iPhone11,8": "iPhone XR",
        "iPhone12,1": "iPhone 11", "iPhone12,3": "iPhone 11 Pro", "iPhone12,5": "iPhone 11 Pro Max", "iPhone12,8": "iPhone SE",
        "iPhone13,1": "iPhone 12 mini", "iPhone13,2": "iPhone 12", "iPhone13,3": "iPhone 12 Pro", "iPhone13,4": "iPhone 12 Pro Max",
        "iPhone14,2": "iPhone 13 Pro", "iPhone14,3": "iPhone 13 Pro Max", "iPhone14,4": "iPhone 13 mini", "iPhone14,5": "iPhone 13",
        "iPhone14,6": "iPhone SE", "iPhone14,7": "iPhone 14", "iPhone14,8": "iPhone 14 Plus",
        "iPhone15,2": "iPhone 14 Pro", "iPhone15,3": "iPhone 14 Pro Max", "iPhone15,4": "iPhone 15", "iPhone15,5": "iPhone 15 Plus",
        "iPhone16,1": "iPhone 15 Pro", "iPhone16,2": "iPhone 15 Pro Max",
        "iPhone17,1": "iPhone 16 Pro", "iPhone17,2": "iPhone 16 Pro Max", "iPhone17,3": "iPhone 16", "iPhone17,4": "iPhone 16 Plus", "iPhone17,5": "iPhone 16e",
        "iPhone18,1": "iPhone 17 Pro", "iPhone18,2": "iPhone 17 Pro Max", "iPhone18,3": "iPhone 17", "iPhone18,4": "iPhone Air",
    ]

    public static func name(identifier: String) -> String {
        names[identifier] ?? "iPhone"
    }
}

/// What the phone can measure with, in the words the screens use. The app asks the system (ARKit, RoomPlan, the camera)
/// and fills this in; the sentences come from here so they are the same everywhere.
public struct MeasureCapabilities: Equatable, Sendable {
    public var deviceName: String
    /// Tap-the-corners with AR (any ARKit iPhone).
    public var corners: Bool
    /// LiDAR: the depth sensor behind order-grade corners and the room scan.
    public var depthSensor: Bool
    public var roomScan: Bool
    /// A camera for the bank card photo.
    public var camera: Bool

    public init(deviceName: String = "iPhone", corners: Bool, depthSensor: Bool, roomScan: Bool, camera: Bool) {
        self.deviceName = deviceName
        self.corners = corners
        self.depthSensor = depthSensor
        self.roomScan = roomScan
        self.camera = camera
    }

    /// Everything on: a LiDAR iPhone.
    public static func depthSensorPhone(_ name: String = "iPhone 15 Pro") -> MeasureCapabilities {
        MeasureCapabilities(deviceName: name, corners: true, depthSensor: true, roomScan: true, camera: true)
    }

    /// Nothing the camera needs (the simulator).
    public static let none = MeasureCapabilities(deviceName: "iPhone", corners: false, depthSensor: false, roomScan: false, camera: false)

    /// How many of the methods this phone can use (the room scan is three cards: the room scan with close-ups, the quick scan and the whole room).
    public var methodCount: Int { [corners, roomScan, camera].filter { $0 }.count }

    /// "Your iPhone 15 Pro can use all five." (screen 06's subtitle)
    public var methodsSentence: String {
        switch methodCount {
        case 3: return "Your \(deviceName) can use all five."
        case 0: return "This device can't measure with a camera."
        case 1: return "Your \(deviceName) can use the \(corners ? "four corners" : (roomScan ? "room scan" : "bank card photo"))."
        default:
            var names: [String] = []
            if corners { names.append("four corners") }
            if roomScan { names.append("room scan") }
            if camera { names.append("bank card photo") }
            return "Your \(deviceName) can use the \(names.joined(separator: " and the "))."
        }
    }

    /// Screen 04's blue note about the depth sensor.
    public var depthSentence: String {
        depthSensor
            ? "Your \(deviceName) has a depth sensor, so sizes come out accurate to about 1/4 inch."
            : "Your \(deviceName) has no depth sensor, so sizes come out accurate to about 3/8 inch."
    }
}
