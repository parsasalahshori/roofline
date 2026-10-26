import Foundation
import RooflineCore

/// One window as the screens show it: the server's own window when it has it, else the one saved on this phone that is
/// still on its way. The list, the room rows and the style pass all read these.
struct WindowRow: Identifiable, Equatable {
    enum Send: Equatable {
        /// The server has it (and has sized it).
        case sent
        /// On the phone: photo or window on its way.
        case sending
        /// On the phone, no connection or the server asked to wait: it goes by itself.
        case waiting
        /// On the phone, complete, but its style is not picked yet.
        case needsStyle
        /// The server refused it; its sentence says what to redo.
        case failed(String)
    }

    var id: String
    /// 1-based, in the order the windows were measured.
    var number: Int
    var room: String
    var name: String?
    var style: String?
    var widthIn: Double?
    var heightIn: Double?
    var uncertaintyIn: Double?
    var needsCheck: Bool
    var reasons: [String]
    var scale: WindowPhotoScale
    var send: Send
    /// The window's own frame just inside the opening above (photo measure; kept on this phone, never sent).
    var windowFrame: WindowFrameSize? = nil
    /// Where the window's multi-frame scan is, in the server's words (kept for staff; the homeowner screens do not show it); nil without a scan.
    var scanLabel: String? = nil
    var scanState: String? = nil
    /// What the homeowner chose in "See it in your home" (kept on the phone), and the colour picked for the window.
    var look: WindowVisualLook? = nil
    var colorKey: String? = nil

    /// "Living room", or the name the homeowner gave ("Bedroom 1, front").
    var title: String {
        if let n = name?.trimmingCharacters(in: .whitespaces), !n.isEmpty { return n }
        return room
    }

    var hasSize: Bool { widthIn != nil && heightIn != nil }


    /// "35 5/8 × 59 5/8" (no unit: the list says "in" once at the top).
    var sizeText: String {
        guard let w = widthIn, let h = heightIn else { return "Size after upload" }
        return "\(SizeWording.text(w)) × \(SizeWording.text(h))"
    }

    var sizeTextWithUnit: String {
        guard let w = widthIn, let h = heightIn else { return "Size after upload" }
        return SizeWording.sizeText(widthIn: w, heightIn: h)
    }

    /// "Looks like a standard 24 × 36 window", when the measured size lands on a common one (a suggestion on the screen only: what is sent and priced
    /// is the measured size).
    var standardSizeLine: String? {
        // A window's nominal size is its frame's: keyed to the window's own size when it was found, else to the opening's
        if let f = windowFrame, f.estimated != true { return StandardWindowSizes.line(widthIn: f.widthIn, heightIn: f.heightIn) }
        guard let w = widthIn, let h = heightIn else { return nil }
        return StandardWindowSizes.line(widthIn: w, heightIn: h)
    }

    /// "Window about 33 1/4 × 54 3/8 in" under the opening's size, when the photo showed the window's own frame.
    var windowSizeLine: String? { hasSize ? windowFrame?.line : nil }
    var spokenWindowSize: String? { hasSize ? windowFrame.map { TwoSizes.windowSpoken($0) } : nil }

    /// "Depth sensor · about 1/8 in".
    var methodLine: String { MethodLabel.listLine(scale, uncertaintyIn: uncertaintyIn) }

    var spokenSize: String {
        guard let w = widthIn, let h = heightIn else { return "size comes after upload" }
        return SizeWording.spokenSize(widthIn: w, heightIn: h)
    }
}

enum WindowRows {
    /// The server's windows first (in the order it keeps them), then the ones only on this phone, oldest first.
    static func merge(server: [HomeownerWindow], outbox: [OutboxItem], previews: [String: WindowPreview] = [:]) -> [WindowRow] {
        var rows: [WindowRow] = []
        var seen = Set<String>()
        for w in server {
            seen.insert(w.id)
            rows.append(WindowRow(
                id: w.id, number: rows.count + 1, room: w.room, name: w.input.label, style: w.input.style,
                widthIn: w.widthIn, heightIn: w.heightIn, uncertaintyIn: w.uncertaintyIn,
                needsCheck: w.needsCheck, reasons: w.reasons, scale: w.input.scale, send: .sent,
                scanLabel: w.scan?.label, scanState: w.scan?.state
            ))
        }
        for item in outbox.sorted(by: { $0.createdAt < $1.createdAt }) where !seen.contains(item.id) {
            let preview = previews[item.id] ?? LocalWindowPreview.of(item.window, imageWidthPx: item.imageWidthPx, imageHeightPx: item.imageHeightPx)
            let send: WindowRow.Send
            switch item.state {
            case .failed: send = .failed(item.lastError ?? "The server could not take this window. Measure it again.")
            case .sending: send = .sending
            case .done: send = .sending   // sent, the server's list has not caught up yet
            case .waiting: send = item.isHeld ? .needsStyle : (item.lastError != nil ? .waiting : .sending)
            }
            rows.append(WindowRow(
                id: item.id, number: rows.count + 1, room: item.window.room ?? "", name: item.window.label, style: item.window.style,
                widthIn: preview?.widthIn, heightIn: preview?.heightIn, uncertaintyIn: preview?.uncertaintyIn,
                needsCheck: preview?.needsCheck ?? false, reasons: preview?.reasons ?? [], scale: item.window.scale, send: send
            ))
        }
        return rows
    }
}

/// The windows of one room, for the list ("Kitchen · 2 windows").
struct RoomGroup: Equatable, Identifiable {
    var room: String
    var rows: [WindowRow]
    var id: String { room.lowercased() }
    var header: String { "\(room) · \(rows.count) window\(rows.count == 1 ? "" : "s")" }
}

enum WindowGroups {
    /// Windows grouped by room: the rooms in the order the homeowner listed them, then any other room in the order its first window
    /// was measured. A window with no room goes under "Other".
    static func group(_ rows: [WindowRow], roomOrder: [String]) -> [RoomGroup] {
        func key(_ r: String) -> String { r.trimmingCharacters(in: .whitespaces).lowercased() }
        var order: [String] = []
        var names: [String: String] = [:]
        for r in roomOrder where rows.contains(where: { key($0.room) == key(r) }) && !order.contains(key(r)) {
            order.append(key(r))
            names[key(r)] = r
        }
        for row in rows {
            let k = key(row.room)
            if !order.contains(k) {
                order.append(k)
                names[k] = k.isEmpty ? "Other" : row.room
            }
        }
        return order.map { k in RoomGroup(room: names[k] ?? "Other", rows: rows.filter { key($0.room) == k }) }
    }
}

/// What a room row says: "Not started", "1 window measured", "2 windows measured".
enum RoomSummary {
    static func line(for room: String, in rows: [WindowRow]) -> String {
        let mine = rows.filter { $0.room.caseInsensitiveCompare(room) == .orderedSame }
        guard !mine.isEmpty else { return "Not started" }
        let count = "\(mine.count) window\(mine.count == 1 ? "" : "s")"
        return "\(count) measured · tap to add another"
    }

    static func hasWindows(_ room: String, in rows: [WindowRow]) -> Bool {
        rows.contains { $0.room.caseInsensitiveCompare(room) == .orderedSame }
    }

    /// The room the main button offers: the first one with no window yet, else the room measured last.
    static func suggested(rooms: [String], rows: [WindowRow]) -> String? {
        if let empty = rooms.first(where: { !hasWindows($0, in: rows) }) { return empty }
        if let last = rows.last?.room, rooms.contains(where: { $0.caseInsensitiveCompare(last) == .orderedSame }) { return last }
        return rooms.last
    }
}
