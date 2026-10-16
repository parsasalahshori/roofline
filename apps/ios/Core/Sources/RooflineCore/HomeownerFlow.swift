import Foundation

// The homeowner journey as data: which screen comes after which, and where a returning homeowner lands. Pure, so the
// rules are checked on a Mac (HomeownerChecks.swift) without a simulator.

/// The screens of the WinChoice journey (the storyboard in ~/RooflineWork/design/mockups/app-flow.html).
public enum HomeownerStep: String, Codable, CaseIterable, Sendable, Hashable {
    /// 01: what are you looking for (the root, never on the back stack).
    case welcome
    /// 02: the address and its pin.
    case address
    /// 03: what we found about the home, per service.
    case results
    /// 03b: the doubtful-home branch ("We'll call you with your price").
    case callback
    /// 03b, after sending: we will call.
    case callbackSent
    /// 04: four tips for a good size.
    case coaching
    /// 05: room by room.
    case rooms
    /// 10: every measured window, "Did we miss any?".
    case list
    /// 09: a style and colour for each window.
    case styles
    /// 11: Good / Better / Best.
    case quote
    /// 12: who to send it to, and consent.
    case contact
    /// 13: pick a visit time, or ask for a call.
    case book
    /// 14: booked.
    case booked
    /// 15: My order.
    case status

    /// A screen that is a state of the whole app rather than a step on the stack (no back button, no swipe back).
    public var isTerminal: Bool { self == .booked || self == .status || self == .callbackSent }
}

/// What is known about the request when the app opens, to decide where to resume.
public struct ResumeSnapshot: Equatable, Sendable {
    public var requestStatus: HomeownerRequestStatus
    public var services: Set<HomeownerService>
    /// Windows measured so far: on the server plus saved on the phone.
    public var windowCount: Int
    /// Windows saved on the phone that still need a style.
    public var unstyledCount: Int
    /// A visit was booked, or a call was asked for.
    public var hasBooking: Bool
    /// The contact form was sent.
    public var hasContact: Bool

    public init(requestStatus: HomeownerRequestStatus = .ready, services: Set<HomeownerService> = [.windows], windowCount: Int = 0,
                unstyledCount: Int = 0, hasBooking: Bool = false, hasContact: Bool = false) {
        self.requestStatus = requestStatus
        self.services = services
        self.windowCount = windowCount
        self.unstyledCount = unstyledCount
        self.hasBooking = hasBooking
        self.hasContact = hasContact
    }
}

public enum ResumeRouter {
    /// Where a homeowner with a saved request lands: the last screen they were on, but only if what that screen needs is
    /// there (no quote without windows, no booking before contact details). Without a saved request: the welcome.
    public static func target(saved: HomeownerStep?, hasSession: Bool, snapshot s: ResumeSnapshot) -> HomeownerStep {
        guard hasSession else { return .welcome }
        // Booked: the confirmation once, then My order
        if s.hasBooking { return saved == .booked ? .booked : .status }
        if s.requestStatus == .callback { return saved == .callbackSent ? .callbackSent : .callback }

        let windows = s.services.contains(.windows)
        let hasWindows = s.windowCount > 0
        var allowed: Set<HomeownerStep> = [.results]
        if windows {
            allowed.formUnion([.coaching, .rooms])
            if hasWindows {
                allowed.formUnion([.list, .styles, .quote, .contact, .book])
            }
        } else {
            allowed.formUnion([.contact, .book])
        }
        let fallback: HomeownerStep = windows && hasWindows ? .list : .results
        guard let saved = saved, allowed.contains(saved) else { return fallback }
        switch saved {
        case .quote where s.unstyledCount > 0: return .styles
        case .book where !s.hasContact: return .contact
        default: return saved
        }
    }
}

public enum HomeownerFlow {
    /// The back stack that leads to `step` (without the welcome, which is the root): back from the list goes to the rooms,
    /// back from the rooms to the tips, and so on. Terminal screens have no stack.
    public static func path(to step: HomeownerStep, services: Set<HomeownerService>) -> [HomeownerStep] {
        let windows = services.contains(.windows)
        switch step {
        case .welcome, .booked, .status, .callbackSent: return []
        case .address: return [.address]
        case .callback: return [.address, .callback]
        case .results: return [.address, .results]
        case .coaching: return [.address, .results, .coaching]
        case .rooms: return [.address, .results, .coaching, .rooms]
        case .list: return [.address, .results, .coaching, .rooms, .list]
        case .styles: return [.address, .results, .coaching, .rooms, .list, .styles]
        case .quote: return [.address, .results, .coaching, .rooms, .list, .quote]
        case .contact: return windows ? [.address, .results, .coaching, .rooms, .list, .quote, .contact] : [.address, .results, .contact]
        case .book: return windows ? [.address, .results, .coaching, .rooms, .list, .quote, .contact, .book] : [.address, .results, .contact, .book]
        }
    }

    /// The first screen after the results: windows go on to the tips, roof and gutters straight to the contact form.
    public static func afterResults(services: Set<HomeownerService>) -> HomeownerStep {
        services.contains(.windows) ? .coaching : .contact
    }

    /// Dots at the top of the first screens (02, 03, 04 of the storyboard): how far along, out of 4. Zero: no dots.
    public static func progressDots(_ step: HomeownerStep) -> Int {
        switch step {
        case .address: return 1
        case .results, .coaching: return 2
        default: return 0
        }
    }
}

/// "Did we miss any?": how the homeowner's count compares with what homes like theirs usually have.
public enum WindowCountHint {
    public enum Verdict: Equatable, Sendable {
        case unknown
        case fewerThanUsual
        case usual
        case moreThanUsual
    }

    public static func verdict(measured: Int, estimate: HomeownerWindowEstimate?) -> Verdict {
        guard let e = estimate else { return .unknown }
        if measured < e.low { return .fewerThanUsual }
        if measured > e.high { return .moreThanUsual }
        return .usual
    }

    /// "Homes like yours usually have 7 to 9 windows. You measured 7."
    public static func detail(measured: Int, estimate: HomeownerWindowEstimate?) -> String {
        guard let e = estimate else { return "You measured \(measured). Tell us if there are more." }
        let range = e.low == e.high ? "\(e.low)" : "\(e.low) to \(e.high)"
        let base = "Homes like yours usually have \(range) windows. You measured \(measured)."
        return verdict(measured: measured, estimate: e) == .fewerThanUsual ? base + " A few may be missing." : base
    }

    /// "Homes like yours usually have 7 to 9 windows." (the results screen, before any window is measured)
    public static func usually(_ estimate: HomeownerWindowEstimate) -> String {
        let range = estimate.low == estimate.high ? "\(estimate.low)" : "\(estimate.low) to \(estimate.high)"
        return "Homes like yours usually have \(range) windows."
    }

    /// The count in the measuring screen's title: "WINDOW 4 OF 7" while the number is within what was expected, else "WINDOW 9".
    public static func hudTitle(number: Int, estimate: HomeownerWindowEstimate?) -> String {
        guard let e = estimate, number <= max(e.likely, e.high) else { return "WINDOW \(number)" }
        return "WINDOW \(number) OF \(e.likely)"
    }
}

/// A homeowner's own total ("I have 18 windows"): within what the server accepts.
public enum WindowTotal {
    public static let min = 1
    public static let max = 80

    public static func clamp(_ n: Int) -> Int { Swift.min(Self.max, Swift.max(Self.min, n)) }
}
