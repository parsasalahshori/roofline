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

    /// "Living room", or the name the homeowner gave ("Bedroom 1, front").
    var title: String {
        if let n = name?.trimmingCharacters(in: .whitespaces), !n.isEmpty { return n }
        return room
    }

    var hasSize: Bool { widthIn != nil && heightIn != nil }

    /// A window the homeowner is asked to look at again. The server marks every room-scan and card window "check" (they are
    /// quote-grade by design: the free visit measures every window again), and that alone is not a problem to show, so for
    /// those only a clearly poor one counts (a low-confidence scan, a card too small next to the window).
    var flagged: Bool {
        guard needsCheck else { return false }
        switch scale {
        case .roomplan: return (uncertaintyIn ?? 0) >= 2
        case .card: return (uncertaintyIn ?? 0) > 2
        default: return true
        }
    }

    /// "35 5/8 × 59 5/8" (no unit: the list says "in" once at the top).
    var sizeText: String {
        guard let w = widthIn, let h = heightIn else { return "Size after upload" }
        return "\(SizeWording.text(w)) × \(SizeWording.text(h))"
    }

    var sizeTextWithUnit: String {
        guard let w = widthIn, let h = heightIn else { return "Size after upload" }
        return SizeWording.sizeText(widthIn: w, heightIn: h)
    }

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
                needsCheck: w.needsCheck, reasons: w.reasons, scale: w.input.scale, send: .sent
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

/// What a room row says: "Not started", "1 window measured", "2 windows · 1 to check".
enum RoomSummary {
    static func line(for room: String, in rows: [WindowRow]) -> String {
        let mine = rows.filter { $0.room.caseInsensitiveCompare(room) == .orderedSame }
        guard !mine.isEmpty else { return "Not started" }
        let checks = mine.filter { $0.flagged }.count
        let count = "\(mine.count) window\(mine.count == 1 ? "" : "s")"
        if checks == 0 { return "\(count) measured" }
        return "\(count) · \(checks) to check"
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
