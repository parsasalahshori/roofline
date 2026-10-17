import Foundation

// Words the screens use that depend on what the server said. Plain, calm, no countdowns (REDESIGN.md 7.1, 7.3). The
// fixed copy of each screen lives in the screens; these are the sentences that change with the data.

/// "We'll call you with your price": why, in one bold sentence and one explaining it. The server's reason codes are
/// the quote gates' (apps/api/src/quote/gates.ts); any other code gets the general sentence.
public enum CallbackCopy {
    public struct Reason: Equatable, Sendable {
        public var lead: String
        public var rest: String
    }

    public static func reason(_ code: String?) -> Reason {
        switch code {
        case "unit", "multi-unit":
            return Reason(lead: "This building looks like it has more than one home.",
                          rest: "Measuring from a phone could give the wrong price for apartments and duplexes, so a person will help you instead.")
        case "address", "not-rooftop", "street-changed":
            return Reason(lead: "We could not place your address on one house.",
                          rest: "We would rather not guess your price, so a person will check it with you instead.")
        case "home", "roof-review", "too-big", "flat-unmeasured":
            return Reason(lead: "This home needs a person to look at it.",
                          rest: "It looks large, flat or hard to see from above, and a phone could give the wrong price. A person will help you instead.")
        case "satellite-unusable":
            // One sentence, in two parts so the first can be bold: together they are SatelliteCopy.message
            return Reason(lead: "We can't measure your roof from satellite images —",
                          rest: "the pictures of your home aren't clear or recent enough. We'll measure it at your free visit.")
        case "busy":
            return Reason(lead: "We can't price this one from the app right now.",
                          rest: "A person will help you with it instead, usually the same day.")
        default:
            return Reason(lead: "We can't price this one from the app right now.",
                          rest: "A person will help you with it instead, usually the same day.")
        }
    }

    /// The call-back screen's button: "Call me this afternoon".
    public static func button(bestTime: String?) -> String {
        switch bestTime {
        case "morning": return "Call me this morning"
        case "afternoon": return "Call me this afternoon"
        case "evening": return "Call me this evening"
        default: return "Call me"
        }
    }
}

/// My order (screen 15): the five steps and where the homeowner is in them.
public enum OrderTimeline {
    public enum State: Equatable, Sendable {
        case done, now, pending
    }

    public struct Step: Equatable, Sendable, Identifiable {
        public var id: String
        public var title: String
        public var detail: String
        /// ISO date when known (shown as "Oct 3"), else a few words ("now", "you pick").
        public var date: String?
        public var state: State
    }

    /// The big headline for a stage.
    public static func headline(_ stage: HomeownerStage) -> String {
        switch stage {
        case .requested: return "We have your request"
        case .visitBooked: return "Your visit is booked"
        case .measured: return "Sizes confirmed"
        case .ordered: return "Being built"
        case .built: return "Built, shipping soon"
        case .shipped: return "On its way"
        case .installed: return "Installed"
        }
    }

    /// The sentence under the headline.
    public static func subhead(_ stage: HomeownerStage) -> String {
        switch stage {
        case .requested: return "A WinChoice rep will re-measure your windows before anything is built."
        case .visitBooked: return "A WinChoice rep re-measures your windows by hand on the day."
        case .measured: return "Your sizes are locked in. Next we order your windows."
        case .ordered: return "Your windows are on the line in Mountain Pine, Arkansas."
        case .built: return "Your windows are built and waiting for a truck."
        case .shipped: return "Your windows are on a truck. We text you the install dates."
        case .installed: return "All done. Thank you for choosing WinChoice."
        }
    }

    /// The five steps for the stage. `city` names the place windows ship to ("Little Rock").
    public static func steps(stage: HomeownerStage, dates: [String: String], windowCount: Int, city: String?, visitDate: String?) -> [Step] {
        func date(_ keys: [String]) -> String? { keys.compactMap { dates[$0] }.first }
        let rank = stage
        func state(doneAt: HomeownerStage, nowAt: [HomeownerStage]) -> State {
            if rank >= doneAt { return .done }
            if nowAt.contains(rank) { return .now }
            return .pending
        }
        let measuredDetail = windowCount > 0 ? "\(windowCount) window\(windowCount == 1 ? "" : "s") with your iPhone" : "Your windows, with your iPhone"
        let confirmState: State = rank >= .measured ? .done : .now
        let confirmDetail: String
        if rank >= .measured {
            confirmDetail = "A rep re-measured by hand"
        } else if let v = visitDate {
            confirmDetail = "Visit \(v)"
        } else {
            confirmDetail = "We pick a visit time with you"
        }
        return [
            Step(id: "measured", title: "You measured", detail: measuredDetail, date: date(["requested"]), state: .done),
            Step(id: "confirmed", title: "Rep confirmed sizes", detail: confirmDetail, date: date(["measured"]), state: confirmState),
            Step(id: "built", title: "Being built", detail: rank >= .built ? "Built in Mountain Pine, Arkansas" : "Made to your sizes in Mountain Pine", date: rank == .ordered ? "now" : date(["ordered", "built"]),
                 state: rank >= .built ? .done : (rank == .ordered ? .now : .pending)),
            Step(id: "shipped", title: city.map { "Shipped to \($0)" } ?? "Shipped", detail: "We text you the install dates", date: date(["shipped"]),
                 state: state(doneAt: .shipped, nowAt: [.built])),
            Step(id: "installed", title: "Installed", detail: "One day, crew of 2", date: rank >= .installed ? date(["installed"]) : "you pick",
                 state: rank >= .installed ? .done : (rank == .shipped ? .now : .pending)),
        ]
    }
}
