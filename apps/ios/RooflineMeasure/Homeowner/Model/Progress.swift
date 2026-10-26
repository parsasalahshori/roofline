import Foundation
import RooflineCore

/// What the phone remembers about one request besides the server's own answer: the last screen (to resume), the rooms the
/// homeowner listed, the tier they leaned to, and a few facts to resume offline. No personal details (they go to the server
/// once and stay in the Keychain-protected session only as far as the token).
struct HomeownerProgress: Codable, Equatable {
    var step: HomeownerStep?
    /// The rooms in the order the homeowner added them (the three nearly every home has to start).
    var rooms: [String] = RoomNames.seed
    /// good | better | best: the tier they looked at last (the booked screen says "Your quote is saved: Better, ...").
    var tierKey: String?
    var tierTotal: Double?
    var tierWindowCount: Int?
    /// A window's colour, by window id, kept here until the server takes one (HomeownerFeatures.windowColor).
    var colors: [String: String] = [:]
    /// Morning / afternoon / evening, for the call-back screen (sent only when the server takes it).
    var bestTime: String?
    /// The facts the resume router needs when the server cannot be reached.
    var requestStatus: HomeownerRequestStatus = .ready
    var hasContact = false
    var hasBooking = false
    var windowCount = 0
    /// The company's callback reason, for the call-back screen after a restart.
    var callbackReason: String?
    var estimateWindows: HomeownerWindowEstimate?
    var floors: Double?
    var perimeterFt: Int?
    /// How the homeowner measured the last window: the method screen is shown for the first window only, then this one is used.
    var lastMethod: String?
    /// A style picked while the window's send was uncertain: kept until it can be applied.
    var pendingStyles: [String: String] = [:]
    /// A photo-measured window's own frame (inside the opening that was sent), by window id: kept here because the server has no place for it.
    var windowFrames: [String: WindowFrameSize] = [:]
    /// What the homeowner chose to see for a window in "See it in your home" (type, grid, glass), by window id. Kept on this phone: the
    /// server's window carries a style (and the quote its price), never a grid or a glass.
    var visuals: [String: WindowVisualLook] = [:]
    /// The look the server last accepted for a window, by window id: what is in `visuals` and `colors` but not here is still to be sent
    /// (it goes before the contact form, and again whenever the phone is online with something unsent).
    var looksSent: [String: HomeownerWindowLookBody] = [:]

    init() {}

    private enum Keys: String, CodingKey {
        case step, rooms, tierKey, tierTotal, tierWindowCount, colors, bestTime, requestStatus, hasContact, hasBooking, windowCount, callbackReason, estimateWindows, floors, perimeterFt, lastMethod, pendingStyles, windowFrames, visuals, looksSent
    }

    // Lenient: a progress record written by an older build still reads
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        step = try? c.decodeIfPresent(HomeownerStep.self, forKey: .step)
        rooms = (try? c.decodeIfPresent([String].self, forKey: .rooms)) ?? RoomNames.seed
        tierKey = try? c.decodeIfPresent(String.self, forKey: .tierKey)
        tierTotal = try? c.decodeIfPresent(Double.self, forKey: .tierTotal)
        tierWindowCount = try? c.decodeIfPresent(Int.self, forKey: .tierWindowCount)
        colors = (try? c.decodeIfPresent([String: String].self, forKey: .colors)) ?? [:]
        bestTime = try? c.decodeIfPresent(String.self, forKey: .bestTime)
        requestStatus = (try? c.decodeIfPresent(HomeownerRequestStatus.self, forKey: .requestStatus)) ?? .ready
        hasContact = (try? c.decodeIfPresent(Bool.self, forKey: .hasContact)) ?? false
        hasBooking = (try? c.decodeIfPresent(Bool.self, forKey: .hasBooking)) ?? false
        windowCount = (try? c.decodeIfPresent(Int.self, forKey: .windowCount)) ?? 0
        callbackReason = try? c.decodeIfPresent(String.self, forKey: .callbackReason)
        estimateWindows = try? c.decodeIfPresent(HomeownerWindowEstimate.self, forKey: .estimateWindows)
        floors = try? c.decodeIfPresent(Double.self, forKey: .floors)
        perimeterFt = try? c.decodeIfPresent(Int.self, forKey: .perimeterFt)
        lastMethod = try? c.decodeIfPresent(String.self, forKey: .lastMethod)
        pendingStyles = (try? c.decodeIfPresent([String: String].self, forKey: .pendingStyles)) ?? [:]
        windowFrames = (try? c.decodeIfPresent([String: WindowFrameSize].self, forKey: .windowFrames)) ?? [:]
        visuals = (try? c.decodeIfPresent([String: WindowVisualLook].self, forKey: .visuals)) ?? [:]
        looksSent = (try? c.decodeIfPresent([String: HomeownerWindowLookBody].self, forKey: .looksSent)) ?? [:]
    }
}

protocol ProgressStore: Sendable {
    func load(requestId: String) -> HomeownerProgress
    func save(_ progress: HomeownerProgress, requestId: String)
    func clear(requestId: String)
}

/// UserDefaults, one JSON value per request.
final class DefaultsProgressStore: ProgressStore, @unchecked Sendable {
    private let defaults: UserDefaults
    private let prefix = "winchoice.progress."

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func load(requestId: String) -> HomeownerProgress {
        guard let data = defaults.data(forKey: prefix + requestId), let p = try? JSONDecoder().decode(HomeownerProgress.self, from: data) else { return HomeownerProgress() }
        return p
    }

    func save(_ progress: HomeownerProgress, requestId: String) {
        if let data = try? JSONEncoder().encode(progress) { defaults.set(data, forKey: prefix + requestId) }
    }

    func clear(requestId: String) {
        defaults.removeObject(forKey: prefix + requestId)
    }
}

final class MemoryProgressStore: ProgressStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: HomeownerProgress] = [:]

    func load(requestId: String) -> HomeownerProgress {
        lock.lock()
        defer { lock.unlock() }
        return values[requestId] ?? HomeownerProgress()
    }

    func save(_ progress: HomeownerProgress, requestId: String) {
        lock.lock()
        defer { lock.unlock() }
        values[requestId] = progress
    }

    func clear(requestId: String) {
        lock.lock()
        defer { lock.unlock() }
        values[requestId] = nil
    }
}
