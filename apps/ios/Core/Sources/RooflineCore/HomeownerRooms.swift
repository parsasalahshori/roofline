import Foundation

/// Rooms and window styles: what the homeowner names, and what the app suggests. Nothing here knows which windows are in
/// which room (no data source does): the homeowner says.
public enum RoomType: String, CaseIterable, Sendable, Hashable {
    case livingRoom, kitchen, bedroom, bathroom, dining, hall, other

    /// The chip on the label sheet.
    public var chip: String {
        switch self {
        case .livingRoom: return "Living room"
        case .kitchen: return "Kitchen"
        case .bedroom: return "Bedroom"
        case .bathroom: return "Bathroom"
        case .dining: return "Dining"
        case .hall: return "Hall"
        case .other: return "Other"
        }
    }

    /// The room a chip starts when the homeowner has none of that type yet.
    public var firstRoomName: String {
        switch self {
        case .livingRoom: return "Living room"
        case .kitchen: return "Kitchen"
        case .bedroom: return "Bedroom 1"
        case .bathroom: return "Bathroom"
        case .dining: return "Dining room"
        case .hall: return "Hall"
        case .other: return "Other"
        }
    }
}

public enum RoomNames {
    /// The rooms a new request starts with: the three nearly every home has (the third is the mockup's "Not started").
    public static let seed = ["Living room", "Kitchen", "Bedroom 1"]

    /// What "Add a room" offers, in order, after the rooms already in the list are taken out.
    public static let suggestionPool = ["Bedroom 2", "Bathroom", "Hall", "Dining room", "Bedroom 3", "Office", "Bathroom 2", "Laundry", "Basement", "Garage"]

    public static let maxLength = 40

    public static func suggestions(excluding existing: [String], limit: Int = 3) -> [String] {
        let taken = Set(existing.map { $0.lowercased() })
        return Array(suggestionPool.filter { !taken.contains($0.lowercased()) }.prefix(limit))
    }

    /// A typed room name: trimmed, one space between words, at most 40 characters. Nil when empty.
    public static func clean(_ typed: String) -> String? {
        let words = typed.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).map(String.init)
        let joined = words.joined(separator: " ")
        guard !joined.isEmpty else { return nil }
        return String(joined.prefix(maxLength)).trimmingCharacters(in: .whitespaces)
    }

    /// "Bedroom 2" is a bedroom; "Master bath" a bathroom; anything else is other.
    public static func type(of room: String) -> RoomType {
        let r = room.lowercased()
        let words = Set(r.split(whereSeparator: { !$0.isLetter }).map(String.init))
        if r.contains("bath") || r.contains("toilet") || r.contains("powder") { return .bathroom }
        if r.contains("bedroom") || r.contains("nursery") || words.contains("master") || words.contains("bed") { return .bedroom }
        if r.contains("kitchen") { return .kitchen }
        if r.contains("living") || r.contains("family room") || r.contains("great room") || words.contains("den") { return .livingRoom }
        if r.contains("dining") { return .dining }
        if r.contains("hall") || r.contains("entry") || r.contains("foyer") || r.contains("stair") { return .hall }
        return .other
    }

    /// The room a chip means: the room already chosen when it is of that type, else the first existing room of that type,
    /// else the type's first name ("Bedroom 1").
    public static func room(for type: RoomType, current: String, existing: [String]) -> String {
        if Self.type(of: current) == type { return current }
        if let match = existing.first(where: { Self.type(of: $0) == type }) { return match }
        return type.firstRoomName
    }

    /// "Bedroom 3" for a base of "Bedroom" when 1 and 2 exist.
    public static func nextNumbered(_ base: String, existing: [String]) -> String {
        let taken = Set(existing.map { $0.lowercased() })
        var n = 1
        while taken.contains("\(base) \(n)".lowercased()) { n += 1 }
        return "\(base) \(n)"
    }
}

/// Which style to suggest for a window of this shape, in the company's own style keys.
public enum StyleGuess {
    public struct Suggestion: Equatable, Sendable {
        /// Style keys, the likeliest first (only the ones the company offers).
        public var keys: [String]
        /// "wide, so most homes use a slider or picture"
        public var hint: String
    }

    /// The style keys the app knows how to draw. A company's own keys outside this list still work (no icon of their own).
    public static let knownKeys = ["double-hung", "single-hung", "slider", "picture", "casement-awning", "bay-bow"]

    public static func suggestion(widthIn: Double, heightIn: Double, offered: [String]) -> Suggestion {
        let w = max(widthIn, 1), h = max(heightIn, 1)
        let candidates: [String]
        let hint: String
        if w / h >= 1.15 {
            candidates = ["slider", "picture"]
            hint = "wide, so most homes use a slider or picture"
        } else if h / w >= 1.3 {
            candidates = ["double-hung", "single-hung"]
            hint = "tall, so most homes use a double-hung or single-hung"
        } else {
            candidates = ["double-hung", "casement-awning", "single-hung"]
            hint = "close to square, so most homes use a double-hung or casement"
        }
        let available = offered.isEmpty ? candidates : candidates.filter { offered.contains($0) }
        return Suggestion(keys: available.isEmpty ? Array(offered.prefix(1)) : available, hint: hint)
    }
}
