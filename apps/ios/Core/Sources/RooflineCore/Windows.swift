import Foundation

/// A window on the list: every photo of it (a shared windowKey), its size from the median of them.
public struct MeasuredWindowGroup: Equatable, Sendable, Identifiable {
    public var key: String
    public var name: String
    public var photos: [PhotoWindow]
    public var widthIn: Double
    public var heightIn: Double
    /// The largest ± among its photos (nil when no photo says).
    public var uncertaintyIn: Double?
    /// Any photo needs a check, or it was only scanned (RoomPlan is never order-grade).
    public var needsCheck: Bool
    /// Sized only from RoomPlan scans.
    public var scanOnly: Bool

    public var id: String { key }
}

public enum WindowGrouping {
    /// The windows photographed so far, in the order first seen, named by their label or "Window N".
    public static func groups(_ windows: [PhotoWindow], excluded: Set<String> = []) -> [MeasuredWindowGroup] {
        var order: [String] = []
        var byKey: [String: [PhotoWindow]] = [:]
        for w in windows where !excluded.contains(w.id) {
            let k = w.input.groupKey
            if byKey[k] == nil { order.append(k) }
            byKey[k, default: []].append(w)
        }
        return order.enumerated().map { n, k in
            let ps = byKey[k]!
            let name = ps.compactMap { $0.input.label }.first { !$0.trimmingCharacters(in: .whitespaces).isEmpty } ?? "Window \(n + 1)"
            let us = ps.compactMap { $0.uncertaintyIn.map { max($0.width, $0.height) } }
            let scanOnly = ps.allSatisfy { $0.input.scale.kind == "roomplan" }
            return MeasuredWindowGroup(
                key: k,
                name: name,
                photos: ps,
                widthIn: median(ps.map { $0.widthIn }) ?? 0,
                heightIn: median(ps.map { $0.heightIn }) ?? 0,
                uncertaintyIn: us.max(),
                needsCheck: ps.contains { $0.needsCheck } || scanOnly,
                scanOnly: scanOnly
            )
        }
    }
}

/// Ids the server accepts for windows (`^[A-Za-z0-9_-]{1,64}$`).
public enum WindowIds {
    public static func new() -> String { UUID().uuidString.lowercased() }

    public static func isValid(_ id: String) -> Bool {
        !id.isEmpty && id.count <= 64 && id.allSatisfy { ($0.isASCII && ($0.isLetter || $0.isNumber)) || $0 == "-" || $0 == "_" }
    }
}

/// The server address a person types into the hidden setting.
public enum ServerAddress {
    public static let defaultURL = "http://localhost:4500"

    /// "localhost:4500" -> "http://localhost:4500"; "https://x.ts.net/" -> "https://x.ts.net". Nil when not a
    /// usable http(s) address.
    public static func normalize(_ text: String) -> String? {
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if !s.lowercased().hasPrefix("http://") && !s.lowercased().hasPrefix("https://") { s = "http://" + s }
        while s.hasSuffix("/") { s.removeLast() }
        guard let u = URL(string: s), let scheme = u.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = u.host, !host.isEmpty else { return nil }
        // Only scheme, host and port: a path would break every API call
        guard u.path.isEmpty || u.path == "/" else { return nil }
        var out = "\(scheme)://\(host)"
        if let port = u.port { out += ":\(port)" }
        return out
    }
}
