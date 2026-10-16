import Foundation

// The API's JSON, as Codable. Contract: packages/shared/src/windows.ts and the routes in apps/api/src/routes.
// Decoding is lenient (fields the app does not use are not declared; the server adds fields over time).
// Encoding must be exact: the server's zod schemas are .strict() and refuse unknown keys and nulls for optionals.

/// Any JSON value, kept as-is (scales of other kinds pass through a PATCH unchanged).
public enum JSONValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let b = try? c.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? c.decode(Double.self) {
            self = .number(n)
        } else if let s = try? c.decode(String.self) {
            self = .string(s)
        } else if let a = try? c.decode([JSONValue].self) {
            self = .array(a)
        } else {
            self = .object(try c.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .object(let o): try c.encode(o)
        case .array(let a): try c.encode(a)
        case .null: try c.encodeNil()
        }
    }

    public subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    public var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }
}

/// The 'ar' scale: the frame's four corners in AR world space (metres) and how often tracking was lost.
public struct ArScale: Codable, Equatable, Sendable {
    public var pointsM: [Vec3]
    public var trackingLostCount: Int
    /// 'arkit-lidar' or 'arkit' from this app (optional on the server: older servers do not know it).
    public var device: ArDevice?
    /// The measured spread of each corner's samples, metres, TL, TR, BR, BL.
    public var cornerSpreadM: [Double]?

    public init(pointsM: [Vec3], trackingLostCount: Int, device: ArDevice?, cornerSpreadM: [Double]?) {
        self.pointsM = pointsM
        self.trackingLostCount = trackingLostCount
        self.device = device
        self.cornerSpreadM = cornerSpreadM
    }
}

/// RoomPlan's own confidence in a surface (ROOMPLAN_CONFIDENCES).
public enum RoomPlanConfidence: String, Codable, CaseIterable, Sendable {
    case low, medium, high
}

/// The 'roomplan' scale: a window RoomPlan found, its size from the scan. Never order-grade.
public struct RoomPlanScale: Codable, Equatable, Sendable {
    public var widthM: Double
    public var heightM: Double
    public var confidence: RoomPlanConfidence

    public init(widthM: Double, heightM: Double, confidence: RoomPlanConfidence) {
        self.widthM = widthM
        self.heightM = heightM
        self.confidence = confidence
    }
}

/// A bank card's real size, as the homeowner API wants it next to the card's corners (ISO/IEC 7810 ID-1).
public struct CardDimensions: Codable, Equatable, Sendable {
    public var widthMm: Double
    public var heightMm: Double

    public static let idOne = CardDimensions(widthMm: 85.6, heightMm: 53.98)

    public init(widthMm: Double, heightMm: Double) {
        self.widthMm = widthMm
        self.heightMm = heightMm
    }
}

/// The 'card' scale (the homeowner app): a standard bank card lies on the glass, its four corners in the photo's pixels
/// (TL, TR, BR, BL of the LANDSCAPE card: the first edge is the long side), and the card's real size. The server maps the
/// card to its real rectangle with a homography and sizes the window frame's corners with it.
public struct CardScale: Codable, Equatable, Sendable {
    public var cardCorners: [Vec2]
    public var card: CardDimensions

    public init(cardCorners: [Vec2], card: CardDimensions = .idOne) {
        self.cardCorners = cardCorners
        self.card = card
    }
}

/// How a photographed window is scaled. This app writes 'ar', 'roomplan' and (homeowner app) 'card'; other kinds are kept as JSON.
public enum WindowPhotoScale: Codable, Equatable, Sendable {
    case ar(ArScale)
    case roomplan(RoomPlanScale)
    case card(CardScale)
    case other(JSONValue)

    private enum Key: String, CodingKey { case kind }

    public var kind: String {
        switch self {
        case .ar: return "ar"
        case .roomplan: return "roomplan"
        case .card: return "card"
        case .other(let v): return v["kind"]?.stringValue ?? "?"
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        let kind = try c.decode(String.self, forKey: .kind)
        switch kind {
        case "ar":
            self = .ar(try ArScale(from: decoder))
        case "roomplan":
            self = .roomplan(try RoomPlanScale(from: decoder))
        case "card":
            self = .card(try CardScale(from: decoder))
        default:
            self = .other(try JSONValue(from: decoder))
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .ar(let s):
            var c = encoder.container(keyedBy: Key.self)
            try c.encode("ar", forKey: .kind)
            try s.encode(to: encoder)
        case .roomplan(let s):
            var c = encoder.container(keyedBy: Key.self)
            try c.encode("roomplan", forKey: .kind)
            try s.encode(to: encoder)
        case .card(let s):
            var c = encoder.container(keyedBy: Key.self)
            try c.encode("card", forKey: .kind)
            try s.encode(to: encoder)
        case .other(let v):
            try v.encode(to: encoder)
        }
    }
}

/// What is sent for one photographed window (PhotoWindowInput): corners in the photo's pixels, TL, TR, BR, BL.
/// `uploadId` and `corners` are absent only for a RoomPlan window with no photo (the server refuses that for any other
/// kind); this app always sends a photo.
public struct PhotoWindowInput: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var uploadId: String?
    public var label: String?
    public var windowKey: String?
    public var corners: [Vec2]?
    public var scale: WindowPhotoScale
    /// Homeowner app only (HomeownerWindowInput): the room, 1 to 40 characters. Absent for rep windows.
    public var room: String?
    /// Homeowner app only: the company's window style key (double-hung, slider, ...). Absent for rep windows.
    public var style: String?

    public init(id: String, uploadId: String?, label: String?, windowKey: String?, corners: [Vec2]?, scale: WindowPhotoScale, room: String? = nil, style: String? = nil) {
        self.id = id
        self.uploadId = uploadId
        self.label = label
        self.windowKey = windowKey
        self.corners = corners
        self.scale = scale
        self.room = room
        self.style = style
    }

    /// The window it belongs to: its shared key, else its own id.
    public var groupKey: String { (windowKey?.isEmpty == false ? windowKey : nil) ?? id }

    private enum Keys: String, CodingKey { case id, uploadId, label, windowKey, corners, scale, room, style }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id)
        uploadId = try c.decodeIfPresent(String.self, forKey: .uploadId)
        label = try c.decodeIfPresent(String.self, forKey: .label)
        windowKey = try c.decodeIfPresent(String.self, forKey: .windowKey)
        corners = try c.decodeIfPresent([Vec2].self, forKey: .corners)
        scale = try c.decode(WindowPhotoScale.self, forKey: .scale)
        room = try c.decodeIfPresent(String.self, forKey: .room)
        style = try c.decodeIfPresent(String.self, forKey: .style)
    }

    // Exactly the input's keys: a sized PhotoWindow decoded into this drops widthIn etc. (the server refuses them)
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(id, forKey: .id)
        if let u = uploadId, !u.isEmpty { try c.encode(u, forKey: .uploadId) }
        if let label = label, !label.isEmpty { try c.encode(label, forKey: .label) }
        if let key = windowKey, !key.isEmpty { try c.encode(key, forKey: .windowKey) }
        if let corners = corners { try c.encode(corners, forKey: .corners) }
        try c.encode(scale, forKey: .scale)
        // Homeowner keys: written only when set, so a rep's window encodes exactly as before
        if let room = room, !room.isEmpty { try c.encode(room, forKey: .room) }
        if let style = style, !style.isEmpty { try c.encode(style, forKey: .style) }
    }
}

/// A photographed window as the server sized it (PhotoWindow).
public struct PhotoWindow: Decodable, Equatable, Sendable, Identifiable {
    public var input: PhotoWindowInput
    public var widthIn: Double
    public var heightIn: Double
    public var sizeClass: String
    public var uncertaintyIn: Uncertainty?
    public var quality: String

    public struct Uncertainty: Codable, Equatable, Sendable {
        public var width: Double
        public var height: Double
    }

    public var id: String { input.id }
    public var needsCheck: Bool { quality == "check" }

    private enum Keys: String, CodingKey { case widthIn, heightIn, sizeClass, uncertaintyIn, quality }

    public init(from decoder: Decoder) throws {
        input = try PhotoWindowInput(from: decoder)
        let c = try decoder.container(keyedBy: Keys.self)
        widthIn = try c.decode(Double.self, forKey: .widthIn)
        heightIn = try c.decode(Double.self, forKey: .heightIn)
        sizeClass = try c.decodeIfPresent(String.self, forKey: .sizeClass) ?? ""
        uncertaintyIn = try c.decodeIfPresent(Uncertainty.self, forKey: .uncertaintyIn)
        quality = try c.decodeIfPresent(String.self, forKey: .quality) ?? "good"
    }

    public init(input: PhotoWindowInput, widthIn: Double, heightIn: Double, sizeClass: String, uncertaintyIn: Uncertainty?, quality: String) {
        self.input = input
        self.widthIn = widthIn
        self.heightIn = heightIn
        self.sizeClass = sizeClass
        self.uncertaintyIn = uncertaintyIn
        self.quality = quality
    }
}

public struct WindowPhotoUpload: Codable, Equatable, Sendable {
    public var id: String
    public var widthPx: Int
    public var heightPx: Int

    public init(id: String, widthPx: Int, heightPx: Int) {
        self.id = id
        self.widthPx = widthPx
        self.heightPx = heightPx
    }
}

/// The parts of WindowAdjustments the app reads.
public struct WindowAdjustmentsDTO: Decodable, Equatable, Sendable {
    public var photoWindows: [PhotoWindowInput]?
    public var photosCoverAllWindows: Bool?
    public var excludedWindowIds: [String]?
}

/// GET/POST /api/window-measurements(/:id): the parts the app reads.
public struct WindowMeasurementView: Decodable, Equatable, Sendable, Identifiable {
    public var id: String
    public var propertyId: String
    public var address: String
    public var createdAt: String?
    public var adjustments: WindowAdjustmentsDTO?
    public var photoWindows: [PhotoWindow]?
    public var uploads: [WindowPhotoUpload]?
}

/// GET /api/window-measurements?propertyId=: the latest measurement for the address. Accepts the view itself,
/// `{ measurement: view | null }`, or `{ measurements: [view] }` (the server change decides; all are read).
public func decodeLatestMeasurement(_ data: Data) -> WindowMeasurementView? {
    let d = JSONDecoder()
    if let v = try? d.decode(WindowMeasurementView.self, from: data) { return v }
    struct Many: Decodable { var measurements: [WindowMeasurementView] }
    if let m = try? d.decode(Many.self, from: data) { return m.measurements.first }
    // `{ measurement: null }` is "none yet" (an absent key decodes to nil too: also none)
    struct One: Decodable { var measurement: WindowMeasurementView? }
    if let o = try? d.decode(One.self, from: data) { return o.measurement }
    return nil
}

public struct AuthUser: Codable, Equatable, Sendable {
    public var id: String
    public var email: String
    public var name: String?
}

public struct AuthCompany: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
}

/// POST /api/auth/login and GET /api/auth/me.
public struct AuthMe: Codable, Equatable, Sendable {
    public var user: AuthUser
    public var company: AuthCompany
    public var role: String?
}

public struct Job: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var customerId: String?
    public var propertyId: String?
    public var stage: String
    public var stageLabel: String?
    public var nextStep: String?
    public var nextStepOn: String?
    public var updatedAt: String?
}

public struct JobsResponse: Codable, Sendable {
    public var jobs: [Job]
    public var total: Int?
}

public struct Property: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var customerId: String?
    public var addressLine: String
    public var city: String?
    public var state: String?
    public var zip: String?

    public var oneLine: String {
        let tail = [city, [state, zip].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")]
            .compactMap { $0 }.filter { !$0.isEmpty }
        return ([addressLine] + tail).joined(separator: ", ")
    }
}

public struct PropertiesResponse: Codable, Sendable {
    public var properties: [Property]
    public var total: Int?
}

/// The server's error body: `{ error, field? }`.
public struct ApiErrorBody: Codable, Equatable, Sendable {
    public var error: String
    public var field: String?
}
