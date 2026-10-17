import Foundation

/// Visit times as the booking screen (13) and the confirmation (14) write them, in the COMPANY's time zone (a rep in
/// Little Rock books Little Rock hours, whatever the phone's own zone says).
public enum VisitTimes {
    /// ISO 8601 with an offset, with or without fractional seconds.
    public static func parse(_ iso: String) -> Date? {
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let d = plain.date(from: iso) { return d }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: iso)
    }

    public static func zone(_ name: String?) -> TimeZone {
        name.flatMap(TimeZone.init(identifier:)) ?? TimeZone.current
    }

    private static func format(_ date: Date, _ pattern: String, _ zone: TimeZone) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = zone
        f.dateFormat = pattern
        return f.string(from: date)
    }

    /// "12:30" (the chip; no AM or PM, as in the mockup: slots are daytime hours).
    public static func clock(_ date: Date, _ zone: TimeZone) -> String { format(date, "h:mm", zone) }
    /// "12:30 PM".
    public static func clockWithPeriod(_ date: Date, _ zone: TimeZone) -> String { format(date, "h:mm a", zone) }
    /// "Tue".
    public static func weekdayShort(_ date: Date, _ zone: TimeZone) -> String { format(date, "EEE", zone) }
    /// "Tuesday".
    public static func weekdayLong(_ date: Date, _ zone: TimeZone) -> String { format(date, "EEEE", zone) }
    /// "20".
    public static func dayNumber(_ date: Date, _ zone: TimeZone) -> String { format(date, "d", zone) }
    /// "OCT".
    public static func monthShortCaps(_ date: Date, _ zone: TimeZone) -> String { format(date, "MMM", zone).uppercased() }
    /// "Oct 20".
    public static func monthDay(_ date: Date, _ zone: TimeZone) -> String { format(date, "MMM d", zone) }
    /// "Tue, Oct 20".
    public static func weekdayMonthDay(_ date: Date, _ zone: TimeZone) -> String { format(date, "EEE, MMM d", zone) }
    /// "Tuesday, 12:30 PM": the confirmation's headline for the visit.
    public static func confirmation(_ date: Date, _ zone: TimeZone) -> String { "\(weekdayLong(date, zone)), \(clockWithPeriod(date, zone))" }
    /// "Book Tue, Oct 20 at 12:30".
    public static func bookButton(_ date: Date, _ zone: TimeZone) -> String { "Book \(weekdayMonthDay(date, zone)) at \(clock(date, zone))" }

    /// A day with its open times, for the day strip.
    public struct Day: Equatable, Sendable, Identifiable {
        public var id: String
        public var date: Date
        public var slots: [HomeownerSlot]
    }

    /// The open slots grouped by local day, days in order, times in order within a day. Slots that do not parse are dropped.
    public static func days(_ slots: [HomeownerSlot], timeZone: TimeZone) -> [Day] {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone
        var byDay: [String: [(Date, HomeownerSlot)]] = [:]
        for s in slots {
            guard let d = parse(s.start) else { continue }
            let c = cal.dateComponents([.year, .month, .day], from: d)
            let key = String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
            byDay[key, default: []].append((d, s))
        }
        return byDay.keys.sorted().map { key in
            let items = byDay[key]!.sorted { $0.0 < $1.0 }
            return Day(id: key, date: items[0].0, slots: items.map { $0.1 })
        }
    }
}
