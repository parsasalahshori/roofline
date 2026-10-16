import Foundation

/// One measuring pass, kept on the phone for the field accuracy test (tape-measured windows against the app).
public struct TestPass: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var at: Date
    public var measurementId: String
    public var windowId: String
    public var windowKey: String?
    public var label: String?
    /// 'ar' or 'roomplan'.
    public var method: String
    /// 'arkit-lidar', 'arkit', or 'roomplan'.
    public var device: String
    public var lidar: Bool
    /// TL, TR, BR, BL, metres (AR passes).
    public var pointsM: [Vec3]?
    public var cornerSpreadM: [Double]?
    public var trackingLostCount: Int
    public var restartsForTracking: Int
    public var wallPlaneLocked: Bool
    public var maxOffPlaneMm: Double?
    public var widthIn: Double
    public var heightIn: Double
    public var uncertaintyWidthIn: Double?
    public var uncertaintyHeightIn: Double?
    public var quality: String
    public var reasons: [String]
    public var durationS: Double

    public init(id: String = UUID().uuidString.lowercased(), at: Date = Date(), measurementId: String, windowId: String, windowKey: String?, label: String?, method: String, device: String, lidar: Bool, pointsM: [Vec3]?, cornerSpreadM: [Double]?, trackingLostCount: Int, restartsForTracking: Int, wallPlaneLocked: Bool, maxOffPlaneMm: Double?, widthIn: Double, heightIn: Double, uncertaintyWidthIn: Double?, uncertaintyHeightIn: Double?, quality: String, reasons: [String], durationS: Double) {
        self.id = id
        self.at = at
        self.measurementId = measurementId
        self.windowId = windowId
        self.windowKey = windowKey
        self.label = label
        self.method = method
        self.device = device
        self.lidar = lidar
        self.pointsM = pointsM
        self.cornerSpreadM = cornerSpreadM
        self.trackingLostCount = trackingLostCount
        self.restartsForTracking = restartsForTracking
        self.wallPlaneLocked = wallPlaneLocked
        self.maxOffPlaneMm = maxOffPlaneMm
        self.widthIn = widthIn
        self.heightIn = heightIn
        self.uncertaintyWidthIn = uncertaintyWidthIn
        self.uncertaintyHeightIn = uncertaintyHeightIn
        self.quality = quality
        self.reasons = reasons
        self.durationS = durationS
    }
}

public enum TestDataCSV {
    public static let header: [String] = {
        var h = ["at", "measurement_id", "window_id", "window_key", "label", "method", "device", "lidar"]
        for c in ["tl", "tr", "br", "bl"] { h += ["\(c)_x_m", "\(c)_y_m", "\(c)_z_m"] }
        h += ["spread_tl_mm", "spread_tr_mm", "spread_br_mm", "spread_bl_mm"]
        h += ["tracking_lost", "restarts", "wall_plane", "max_off_plane_mm", "width_in", "height_in", "plus_minus_width_in", "plus_minus_height_in", "width_eighths", "height_eighths", "quality", "reasons", "duration_s"]
        return h
    }()

    /// Every pass as CSV (RFC 4180 quoting), oldest first.
    public static func make(_ passes: [TestPass]) -> String {
        let iso = ISO8601DateFormatter()
        var lines = [header.joined(separator: ",")]
        for p in passes.sorted(by: { $0.at < $1.at }) {
            var row: [String] = [iso.string(from: p.at), p.measurementId, p.windowId, p.windowKey ?? "", p.label ?? "", p.method, p.device, p.lidar ? "1" : "0"]
            let pts = p.pointsM ?? []
            for i in 0..<4 {
                if i < pts.count { row += [num(pts[i].x, 5), num(pts[i].y, 5), num(pts[i].z, 5)] } else { row += ["", "", ""] }
            }
            let sp = p.cornerSpreadM ?? []
            for i in 0..<4 { row.append(i < sp.count ? num(sp[i] * 1000, 2) : "") }
            row += [
                "\(p.trackingLostCount)", "\(p.restartsForTracking)", p.wallPlaneLocked ? "1" : "0",
                p.maxOffPlaneMm.map { num($0, 1) } ?? "",
                num(p.widthIn, 3), num(p.heightIn, 3),
                p.uncertaintyWidthIn.map { num($0, 3) } ?? "", p.uncertaintyHeightIn.map { num($0, 3) } ?? "",
                Eighths.format(p.widthIn), Eighths.format(p.heightIn),
                p.quality, p.reasons.joined(separator: "; "), num(p.durationS, 1),
            ]
            lines.append(row.map(quote).joined(separator: ","))
        }
        return lines.joined(separator: "\r\n") + "\r\n"
    }

    static func num(_ v: Double, _ digits: Int) -> String { String(format: "%.\(digits)f", v) }

    static func quote(_ s: String) -> String {
        guard s.contains(where: { $0 == "," || $0 == "\"" || $0 == "\n" || $0 == "\r" }) else { return s }
        return "\"" + s.replacingOccurrences(of: "\"", with: "\"\"") + "\""
    }
}

/// The passes on disk (`passes.json`), appended to after every save.
public actor TestPassLog {
    public let fileURL: URL

    public init(fileURL: URL) {
        self.fileURL = fileURL
    }

    public func all() -> [TestPass] {
        guard let data = try? Data(contentsOf: fileURL) else { return [] }
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return (try? d.decode([TestPass].self, from: data)) ?? []
    }

    public func append(_ pass: TestPass) throws {
        var list = all()
        list.append(pass)
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        try e.encode(list).write(to: fileURL, options: [.atomic])
    }

    public func clear() throws {
        try? FileManager.default.removeItem(at: fileURL)
    }
}
