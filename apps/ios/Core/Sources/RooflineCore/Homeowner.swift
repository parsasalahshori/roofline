import Foundation

// The homeowner API as Codable: /api/public/homeowner/:slug (the WinChoice app). Contract: ~/RooflineWork/plans/homeowner-app.md
// and, once written, docs/windows/homeowner-api.md on the homeowner/api branch (that one wins where they differ).
//
// Decoding is LENIENT on purpose: the server adds fields over time, so every type reads what it knows with defaults, a
// bad item in a list is skipped (not the whole answer), and money may arrive as dollars or as `...Cents`. Encoding is
// EXACT: the server's schemas are strict and refuse unknown keys and nulls for optionals.

/// One item of a list that is skipped, not fatal, when it does not decode.
struct Lossy<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

extension KeyedDecodingContainer {
    /// A value that may be missing or of a surprising type: nil either way.
    func soft<T: Decodable>(_ type: T.Type, _ key: Key) -> T? {
        guard let v = try? decodeIfPresent(type, forKey: key) else { return nil }
        return v
    }

    /// A list where each item that does not decode is dropped.
    func lossyList<T: Decodable>(_ type: T.Type, _ key: Key) -> [T] {
        (soft([Lossy<T>].self, key) ?? []).compactMap { $0.value }
    }

    /// Dollars from `key` (as is), or from `centsKey` (divided by 100).
    func dollars(_ key: Key, cents centsKey: Key? = nil) -> Double? {
        if let d = soft(Double.self, key) { return d }
        if let c = centsKey, let cents = soft(Double.self, c) { return cents / 100 }
        return nil
    }
}

// MARK: - Services, company

/// What the homeowner asked about. Declaration order is the screen order (windows first: it is the app's main journey).
public enum HomeownerService: String, Codable, CaseIterable, Sendable, Hashable, Comparable {
    case windows
    case roof
    case gutters

    public static func < (a: HomeownerService, b: HomeownerService) -> Bool {
        (allCases.firstIndex(of: a) ?? 0) < (allCases.firstIndex(of: b) ?? 0)
    }
}

public struct HomeownerStyleOption: Codable, Equatable, Sendable, Hashable, Identifiable {
    public var key: String
    public var label: String
    public var id: String { key }

    public init(key: String, label: String) {
        self.key = key
        self.label = label
    }
}

/// "Reviews", "since" and "license" the company chose to show; every item optional, nothing invented.
public struct HomeownerTrust: Codable, Equatable, Sendable {
    public var reviews: String?
    public var since: String?
    public var license: String?

    public init(reviews: String? = nil, since: String? = nil, license: String? = nil) {
        self.reviews = reviews
        self.since = since
        self.license = license
    }

    private enum Keys: String, CodingKey { case reviews, since, license }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        // Numbers or words, whichever the company entered
        func text(_ k: Keys) -> String? {
            if let s = c.soft(String.self, k), !s.isEmpty { return s }
            if let n = c.soft(Double.self, k) { return n == n.rounded() ? String(Int(n)) : String(n) }
            return nil
        }
        reviews = text(.reviews)
        since = text(.since)
        license = text(.license)
    }
}

/// GET /company.
public struct HomeownerCompany: Codable, Equatable, Sendable {
    public var name: String
    public var brandColor: String?
    public var phone: String?
    public var services: [HomeownerService]
    public var privacyUrl: String?
    public var termsUrl: String?
    public var windowStyles: [HomeownerStyleOption]
    public var trust: HomeownerTrust?

    public init(name: String, brandColor: String? = nil, phone: String? = nil, services: [HomeownerService] = HomeownerService.allCases,
                privacyUrl: String? = nil, termsUrl: String? = nil, windowStyles: [HomeownerStyleOption] = [], trust: HomeownerTrust? = nil) {
        self.name = name
        self.brandColor = brandColor
        self.phone = phone
        self.services = services
        self.privacyUrl = privacyUrl
        self.termsUrl = termsUrl
        self.windowStyles = windowStyles
        self.trust = trust
    }

    private enum Keys: String, CodingKey { case name, brandColor, phone, services, privacyUrl, termsUrl, windowStyles, trust }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        name = c.soft(String.self, .name) ?? ""
        brandColor = c.soft(String.self, .brandColor)
        phone = c.soft(String.self, .phone)
        services = (c.soft([String].self, .services) ?? []).compactMap(HomeownerService.init(rawValue:))
        privacyUrl = c.soft(String.self, .privacyUrl)
        termsUrl = c.soft(String.self, .termsUrl)
        windowStyles = c.lossyList(HomeownerStyleOption.self, .windowStyles)
        trust = c.soft(HomeownerTrust.self, .trust)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(name, forKey: .name)
        try c.encodeIfPresent(brandColor, forKey: .brandColor)
        try c.encodeIfPresent(phone, forKey: .phone)
        try c.encode(services.map { $0.rawValue }, forKey: .services)
        try c.encodeIfPresent(privacyUrl, forKey: .privacyUrl)
        try c.encodeIfPresent(termsUrl, forKey: .termsUrl)
        try c.encode(windowStyles, forKey: .windowStyles)
        try c.encodeIfPresent(trust, forKey: .trust)
    }
}

// MARK: - A new request

public enum HomeownerRequestStatus: String, Codable, Sendable {
    /// Priced from above: the app goes on to the services.
    case ready
    /// A person calls instead (an apartment, a doubtful home, a daily limit).
    case callback
}

public struct HomeownerHome: Codable, Equatable, Sendable {
    public var address: String
    public var floors: Int?
    public var photoUrl: String?

    public init(address: String, floors: Int? = nil, photoUrl: String? = nil) {
        self.address = address
        self.floors = floors
        self.photoUrl = photoUrl
    }

    private enum Keys: String, CodingKey { case address, floors, photoUrl }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        address = c.soft(String.self, .address) ?? ""
        floors = c.soft(Int.self, .floors)
        photoUrl = c.soft(String.self, .photoUrl)
    }
}

/// How many windows homes like this usually have.
public struct HomeownerWindowEstimate: Codable, Equatable, Sendable {
    public var low: Int
    public var high: Int
    public var likely: Int

    public init(low: Int, high: Int, likely: Int? = nil) {
        self.low = low
        self.high = max(low, high)
        self.likely = likely ?? (low + high) / 2
    }

    private enum Keys: String, CodingKey { case low, high, likely }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let low = c.soft(Int.self, .low) ?? c.soft(Int.self, .likely) ?? 0
        let high = c.soft(Int.self, .high) ?? low
        self.init(low: low, high: high, likely: c.soft(Int.self, .likely))
    }
}

public struct HomeownerRoofEstimate: Codable, Equatable, Sendable {
    /// Whole dollars.
    public var low: Double
    public var high: Double
    public var squares: Double?

    public init(low: Double, high: Double, squares: Double? = nil) {
        self.low = low
        self.high = high
        self.squares = squares
    }

    private enum Keys: String, CodingKey { case low, high, squares, lowCents, highCents }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        low = c.dollars(.low, cents: .lowCents) ?? 0
        high = c.dollars(.high, cents: .highCents) ?? low
        squares = c.soft(Double.self, .squares)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(low, forKey: .low)
        try c.encode(high, forKey: .high)
        try c.encodeIfPresent(squares, forKey: .squares)
    }
}

/// What was worked out from the address alone (no windows measured yet).
public struct HomeownerEstimate: Codable, Equatable, Sendable {
    public var windows: HomeownerWindowEstimate?
    public var roof: HomeownerRoofEstimate?
    /// 'at-visit' when gutters are priced at the free visit (they never get an automatic price), else absent.
    public var gutters: String?

    public init(windows: HomeownerWindowEstimate? = nil, roof: HomeownerRoofEstimate? = nil, gutters: String? = nil) {
        self.windows = windows
        self.roof = roof
        self.gutters = gutters
    }

    private enum Keys: String, CodingKey { case windows, roof, gutters }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        windows = c.soft(HomeownerWindowEstimate.self, .windows)
        roof = c.soft(HomeownerRoofEstimate.self, .roof)
        gutters = c.soft(String.self, .gutters)
    }
}

/// POST /requests {address, services}.
public struct HomeownerCreated: Decodable, Equatable, Sendable {
    public var requestId: String
    public var token: String
    public var status: HomeownerRequestStatus
    public var callbackReason: String?
    public var home: HomeownerHome
    public var estimate: HomeownerEstimate

    public init(requestId: String, token: String, status: HomeownerRequestStatus, callbackReason: String? = nil, home: HomeownerHome, estimate: HomeownerEstimate) {
        self.requestId = requestId
        self.token = token
        self.status = status
        self.callbackReason = callbackReason
        self.home = home
        self.estimate = estimate
    }

    private enum Keys: String, CodingKey { case requestId, token, status, callbackReason, home, estimate }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        requestId = try c.decode(String.self, forKey: .requestId)
        token = try c.decode(String.self, forKey: .token)
        status = c.soft(HomeownerRequestStatus.self, .status) ?? .ready
        callbackReason = c.soft(String.self, .callbackReason)
        home = c.soft(HomeownerHome.self, .home) ?? HomeownerHome(address: "")
        estimate = c.soft(HomeownerEstimate.self, .estimate) ?? HomeownerEstimate()
    }
}

/// Body of POST /requests.
public struct HomeownerCreateBody: Encodable, Sendable {
    public var address: String
    public var services: [String]

    public init(address: String, services: [HomeownerService]) {
        self.address = address
        self.services = services.sorted().map { $0.rawValue }
    }
}

// MARK: - Windows and the quote

/// A window as the server sized it (HomeownerWindow): what was sent, plus the size.
public struct HomeownerWindow: Decodable, Equatable, Sendable, Identifiable {
    public var input: PhotoWindowInput
    public var widthIn: Double
    public var heightIn: Double
    /// About 1 sigma, inches (the larger of width and height when the server gives both).
    public var uncertaintyIn: Double?
    public var quality: String
    public var reasons: [String]
    /// The server's own wording, e.g. "35 5/8 x 59 5/8".
    public var sizeLabel: String?

    public var id: String { input.id }
    public var room: String { input.room ?? "" }
    public var needsCheck: Bool { quality == "check" }

    private enum Keys: String, CodingKey { case widthIn, heightIn, uncertaintyIn, quality, reasons, sizeLabel }

    public init(input: PhotoWindowInput, widthIn: Double, heightIn: Double, uncertaintyIn: Double?, quality: String = "good", reasons: [String] = [], sizeLabel: String? = nil) {
        self.input = input
        self.widthIn = widthIn
        self.heightIn = heightIn
        self.uncertaintyIn = uncertaintyIn
        self.quality = quality
        self.reasons = reasons
        self.sizeLabel = sizeLabel
    }

    public init(from decoder: Decoder) throws {
        input = try PhotoWindowInput(from: decoder)
        let c = try decoder.container(keyedBy: Keys.self)
        widthIn = try c.decode(Double.self, forKey: .widthIn)
        heightIn = try c.decode(Double.self, forKey: .heightIn)
        // One number, or {width, height}
        if let n = c.soft(Double.self, .uncertaintyIn) {
            uncertaintyIn = n
        } else if let u = c.soft(PhotoWindow.Uncertainty.self, .uncertaintyIn) {
            uncertaintyIn = max(u.width, u.height)
        } else {
            uncertaintyIn = nil
        }
        quality = c.soft(String.self, .quality) ?? "good"
        reasons = c.soft([String].self, .reasons) ?? []
        sizeLabel = c.soft(String.self, .sizeLabel)
    }
}

public struct HomeownerWindowPrice: Codable, Equatable, Sendable {
    public var windowId: String
    public var price: Double

    public init(windowId: String, price: Double) {
        self.windowId = windowId
        self.price = price
    }

    private enum Keys: String, CodingKey { case windowId, price, priceCents }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        windowId = try c.decode(String.self, forKey: .windowId)
        price = c.dollars(.price, cents: .priceCents) ?? 0
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(windowId, forKey: .windowId)
        try c.encode(price, forKey: .price)
    }
}

/// Good, Better or Best for the windows measured so far and an estimate for the rest.
public struct HomeownerTier: Codable, Equatable, Sendable, Identifiable {
    public var key: String
    public var label: String
    /// Whole dollars, measured windows plus estimated ones.
    public var total: Double
    public var perWindow: [HomeownerWindowPrice]
    public var estimatedCount: Int
    public var estimatedTotal: Double

    public var id: String { key }

    public init(key: String, label: String, total: Double, perWindow: [HomeownerWindowPrice] = [], estimatedCount: Int = 0, estimatedTotal: Double = 0) {
        self.key = key
        self.label = label
        self.total = total
        self.perWindow = perWindow
        self.estimatedCount = estimatedCount
        self.estimatedTotal = estimatedTotal
    }

    private enum Keys: String, CodingKey { case key, label, total, totalCents, perWindow, estimatedCount, estimatedTotal, estimatedTotalCents }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        key = try c.decode(String.self, forKey: .key)
        label = c.soft(String.self, .label) ?? key.capitalized
        total = c.dollars(.total, cents: .totalCents) ?? 0
        perWindow = c.lossyList(HomeownerWindowPrice.self, .perWindow)
        estimatedCount = c.soft(Int.self, .estimatedCount) ?? 0
        estimatedTotal = c.dollars(.estimatedTotal, cents: .estimatedTotalCents) ?? 0
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(key, forKey: .key)
        try c.encode(label, forKey: .label)
        try c.encode(total, forKey: .total)
        try c.encode(perWindow, forKey: .perWindow)
        try c.encode(estimatedCount, forKey: .estimatedCount)
        try c.encode(estimatedTotal, forKey: .estimatedTotal)
    }
}

public struct HomeownerQuote: Codable, Equatable, Sendable {
    public var tiers: [HomeownerTier]
    public var measuredCount: Int
    public var estimatedCount: Int
    public var missingHint: String?

    public init(tiers: [HomeownerTier], measuredCount: Int, estimatedCount: Int, missingHint: String? = nil) {
        self.tiers = tiers
        self.measuredCount = measuredCount
        self.estimatedCount = estimatedCount
        self.missingHint = missingHint
    }

    private enum Keys: String, CodingKey { case tiers, measuredCount, estimatedCount, missingHint }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        tiers = c.lossyList(HomeownerTier.self, .tiers)
        measuredCount = c.soft(Int.self, .measuredCount) ?? 0
        estimatedCount = c.soft(Int.self, .estimatedCount) ?? 0
        missingHint = c.soft(String.self, .missingHint)
    }

    /// Windows the price covers (measured plus estimated).
    public var windowCount: Int { measuredCount + estimatedCount }

    public func tier(_ key: String) -> HomeownerTier? { tiers.first { $0.key == key } }
}

// MARK: - Contact, visit, status

public struct HomeownerRep: Codable, Equatable, Sendable {
    public var name: String
    public var phone: String?
    /// "Little Rock" (the rep's area), for "Your Little Rock rep".
    public var area: String?

    public init(name: String, phone: String? = nil, area: String? = nil) {
        self.name = name
        self.phone = phone
        self.area = area
    }

    private enum Keys: String, CodingKey { case name, phone, area, city }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        name = c.soft(String.self, .name) ?? ""
        phone = c.soft(String.self, .phone)
        area = c.soft(String.self, .area) ?? c.soft(String.self, .city)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(name, forKey: .name)
        try c.encodeIfPresent(phone, forKey: .phone)
        try c.encodeIfPresent(area, forKey: .area)
    }
}

/// POST /requests/:id/contact. Texting consent never turns marketing texts on by itself (Ruling BF: stays 'none').
public struct HomeownerContact: Codable, Equatable, Sendable {
    public var firstName: String
    public var lastName: String
    public var phone: String
    public var email: String
    public var zip: String
    /// Required: the homeowner agreed to be contacted about this request.
    public var contactConsent: Bool
    /// Optional, unchecked to start.
    public var textConsent: Bool

    public init(firstName: String = "", lastName: String = "", phone: String = "", email: String = "", zip: String = "", contactConsent: Bool = false, textConsent: Bool = false) {
        self.firstName = firstName
        self.lastName = lastName
        self.phone = phone
        self.email = email
        self.zip = zip
        self.contactConsent = contactConsent
        self.textConsent = textConsent
    }
}

/// One open visit time.
public struct HomeownerSlot: Codable, Equatable, Sendable, Identifiable, Hashable {
    /// What to send back (the start time unless the server gives an id).
    public var id: String
    /// ISO 8601 with offset.
    public var start: String
    public var end: String?

    public init(id: String? = nil, start: String, end: String? = nil) {
        self.id = id ?? start
        self.start = start
        self.end = end
    }

    private enum Keys: String, CodingKey { case id, start, end, slotStart, slotEnd }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let start = c.soft(String.self, .start) ?? c.soft(String.self, .slotStart) ?? ""
        guard !start.isEmpty else { throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "a slot needs a start")) }
        self.init(id: c.soft(String.self, .id), start: start, end: c.soft(String.self, .end) ?? c.soft(String.self, .slotEnd))
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(id, forKey: .id)
        try c.encode(start, forKey: .start)
        try c.encodeIfPresent(end, forKey: .end)
    }
}

/// GET /requests/:id/slots: the next open visit times (from tomorrow), in the company's time zone.
public struct HomeownerSlots: Equatable, Sendable {
    public var timeZone: String?
    public var slots: [HomeownerSlot]
    /// The rep who would come, when the server says (some companies assign at booking).
    public var rep: HomeownerRep?

    public init(timeZone: String? = nil, slots: [HomeownerSlot], rep: HomeownerRep? = nil) {
        self.timeZone = timeZone
        self.slots = slots
        self.rep = rep
    }

    /// Reads `{ timeZone, slots: [...], rep? }` or a bare array of slots.
    public static func decode(_ data: Data) -> HomeownerSlots? {
        struct Wrapped: Decodable {
            var timeZone: String?
            var slots: [Lossy<HomeownerSlot>]
            var rep: HomeownerRep?
        }
        let d = JSONDecoder()
        if let w = try? d.decode(Wrapped.self, from: data) {
            return HomeownerSlots(timeZone: w.timeZone, slots: w.slots.compactMap { $0.value }, rep: w.rep)
        }
        if let list = try? d.decode([Lossy<HomeownerSlot>].self, from: data) {
            return HomeownerSlots(timeZone: nil, slots: list.compactMap { $0.value })
        }
        return nil
    }
}

/// What the homeowner chose on the booking screen.
public enum HomeownerBookingChoice: Equatable, Sendable {
    case slot(HomeownerSlot)
    /// "Call me to pick a time"; `bestTime` is morning / afternoon / evening when they said (the call-back screen).
    case callMe(bestTime: String?)
}

/// Body of POST /requests/:id/book.
public struct HomeownerBookBody: Encodable, Sendable {
    public var slotStart: String?
    public var callMe: Bool?
    public var bestTime: String?

    public init(_ choice: HomeownerBookingChoice, sendBestTime: Bool = false) {
        switch choice {
        case .slot(let s):
            slotStart = s.start
            callMe = nil
            bestTime = nil
        case .callMe(let t):
            slotStart = nil
            callMe = true
            bestTime = sendBestTime ? t : nil
        }
    }

    private enum Keys: String, CodingKey { case slotStart, callMe, bestTime }

    // Only the keys that are set (a strict server refuses nulls)
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encodeIfPresent(slotStart, forKey: .slotStart)
        try c.encodeIfPresent(callMe, forKey: .callMe)
        try c.encodeIfPresent(bestTime, forKey: .bestTime)
    }
}

/// A booked visit, or "we will call you".
public struct HomeownerBooking: Codable, Equatable, Sendable {
    public var slotStart: String?
    public var slotEnd: String?
    public var callMe: Bool
    public var rep: HomeownerRep?
    public var address: String?
    public var timeZone: String?

    public var isVisit: Bool { slotStart != nil }

    public init(slotStart: String? = nil, slotEnd: String? = nil, callMe: Bool = false, rep: HomeownerRep? = nil, address: String? = nil, timeZone: String? = nil) {
        self.slotStart = slotStart
        self.slotEnd = slotEnd
        self.callMe = callMe
        self.rep = rep
        self.address = address
        self.timeZone = timeZone
    }

    private enum Keys: String, CodingKey { case slotStart, slotEnd, start, end, callMe, rep, address, timeZone }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        slotStart = c.soft(String.self, .slotStart) ?? c.soft(String.self, .start)
        slotEnd = c.soft(String.self, .slotEnd) ?? c.soft(String.self, .end)
        callMe = c.soft(Bool.self, .callMe) ?? false
        rep = c.soft(HomeownerRep.self, .rep)
        address = c.soft(String.self, .address)
        timeZone = c.soft(String.self, .timeZone)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encodeIfPresent(slotStart, forKey: .slotStart)
        try c.encodeIfPresent(slotEnd, forKey: .slotEnd)
        try c.encode(callMe, forKey: .callMe)
        try c.encodeIfPresent(rep, forKey: .rep)
        try c.encodeIfPresent(address, forKey: .address)
        try c.encodeIfPresent(timeZone, forKey: .timeZone)
    }
}

/// Where the order is, in the order it happens.
public enum HomeownerStage: String, Codable, CaseIterable, Sendable, Comparable {
    case requested
    case visitBooked = "visit-booked"
    case measured
    case ordered
    case built
    case shipped
    case installed

    public static func < (a: HomeownerStage, b: HomeownerStage) -> Bool {
        (allCases.firstIndex(of: a) ?? 0) < (allCases.firstIndex(of: b) ?? 0)
    }
}

/// GET /requests/:id/status.
public struct HomeownerStatus: Codable, Equatable, Sendable {
    public var stage: HomeownerStage
    /// ISO dates by stage name ("visit-booked", "measured", "shipped", ...), as far as the server knows them.
    public var dates: [String: String]
    public var rep: HomeownerRep?
    public var orderNumber: String?
    /// The expected ship (or install) date, ISO, when the factory has said.
    public var eta: String?

    public init(stage: HomeownerStage, dates: [String: String] = [:], rep: HomeownerRep? = nil, orderNumber: String? = nil, eta: String? = nil) {
        self.stage = stage
        self.dates = dates
        self.rep = rep
        self.orderNumber = orderNumber
        self.eta = eta
    }

    private enum Keys: String, CodingKey { case stage, dates, rep, orderNumber, eta }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        stage = c.soft(HomeownerStage.self, .stage) ?? .requested
        dates = c.soft([String: String].self, .dates) ?? [:]
        rep = c.soft(HomeownerRep.self, .rep)
        orderNumber = c.soft(String.self, .orderNumber)
        eta = c.soft(String.self, .eta)
    }
}

/// What GET /requests/:id says about the request itself.
public struct HomeownerRequestInfo: Decodable, Equatable, Sendable {
    public var id: String?
    public var status: HomeownerRequestStatus?
    public var address: String?
    public var services: [HomeownerService]
    public var home: HomeownerHome?
    public var estimate: HomeownerEstimate?
    public var callbackReason: String?
    /// "I have 18 windows" (PATCH estimatedTotalOverride).
    public var estimatedTotalOverride: Int?
    /// The contact form was sent.
    public var contacted: Bool
    public var selectedTier: String?

    public init(id: String? = nil, status: HomeownerRequestStatus? = nil, address: String? = nil, services: [HomeownerService] = [], home: HomeownerHome? = nil,
                estimate: HomeownerEstimate? = nil, callbackReason: String? = nil, estimatedTotalOverride: Int? = nil, contacted: Bool = false, selectedTier: String? = nil) {
        self.id = id
        self.status = status
        self.address = address
        self.services = services
        self.home = home
        self.estimate = estimate
        self.callbackReason = callbackReason
        self.estimatedTotalOverride = estimatedTotalOverride
        self.contacted = contacted
        self.selectedTier = selectedTier
    }

    private enum Keys: String, CodingKey { case id, status, address, services, home, estimate, callbackReason, estimatedTotalOverride, contacted, contactSubmitted, selectedTier, tier }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = c.soft(String.self, .id)
        status = c.soft(HomeownerRequestStatus.self, .status)
        address = c.soft(String.self, .address)
        services = (c.soft([String].self, .services) ?? []).compactMap(HomeownerService.init(rawValue:))
        home = c.soft(HomeownerHome.self, .home)
        estimate = c.soft(HomeownerEstimate.self, .estimate)
        callbackReason = c.soft(String.self, .callbackReason)
        estimatedTotalOverride = c.soft(Int.self, .estimatedTotalOverride)
        contacted = c.soft(Bool.self, .contacted) ?? c.soft(Bool.self, .contactSubmitted) ?? false
        selectedTier = c.soft(String.self, .selectedTier) ?? c.soft(String.self, .tier)
    }
}

/// GET /requests/:id: everything the app shows, in one answer.
public struct HomeownerRequestView: Decodable, Equatable, Sendable {
    public var request: HomeownerRequestInfo
    public var windows: [HomeownerWindow]
    public var rooms: [String]
    public var quote: HomeownerQuote?
    public var booking: HomeownerBooking?
    public var status: HomeownerStatus?

    public init(request: HomeownerRequestInfo = HomeownerRequestInfo(), windows: [HomeownerWindow] = [], rooms: [String] = [], quote: HomeownerQuote? = nil,
                booking: HomeownerBooking? = nil, status: HomeownerStatus? = nil) {
        self.request = request
        self.windows = windows
        self.rooms = rooms
        self.quote = quote
        self.booking = booking
        self.status = status
    }

    private enum Keys: String, CodingKey { case request, windows, rooms, quote, booking, status }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        request = c.soft(HomeownerRequestInfo.self, .request) ?? HomeownerRequestInfo()
        windows = c.lossyList(HomeownerWindow.self, .windows)
        rooms = c.soft([String].self, .rooms) ?? []
        quote = c.soft(HomeownerQuote.self, .quote)
        booking = c.soft(HomeownerBooking.self, .booking)
        status = c.soft(HomeownerStatus.self, .status)
    }
}

// MARK: - What the phone keeps

/// The homeowner's request on this phone: its id and bearer token (the Keychain's job), and what the screens need to say.
public struct HomeownerSession: Codable, Equatable, Sendable {
    public var requestId: String
    public var token: String
    /// The company's quote slug this request was made for.
    public var slug: String
    public var address: String
    public var services: [HomeownerService]
    public var createdAt: Date

    public init(requestId: String, token: String, slug: String, address: String, services: [HomeownerService], createdAt: Date = Date()) {
        self.requestId = requestId
        self.token = token
        self.slug = slug
        self.address = address
        self.services = services
        self.createdAt = createdAt
    }

    /// The server's tokens last 60 days.
    public static let lifetimeDays = 60

    public func isExpired(now: Date = Date()) -> Bool {
        now.timeIntervalSince(createdAt) > Double(Self.lifetimeDays) * 86_400
    }
}

// MARK: - Errors

/// An error to show a homeowner: the server's own sentence when it gave one, else plain words.
public struct HomeownerAPIError: Error, LocalizedError, Equatable, Sendable {
    public var status: Int?
    public var message: String
    public var field: String?

    public init(status: Int?, message: String, field: String? = nil) {
        self.status = status
        self.message = message
        self.field = field
    }

    public var errorDescription: String? { message }
    /// The token was not accepted.
    public var isUnauthorized: Bool { status == 401 || status == 403 }
    /// The request is gone (expired, or the server was reset): start over.
    public var isGone: Bool { status == 404 || status == 410 }
    public var isRateLimited: Bool { status == 429 }
    /// No answer at all (offline, timed out).
    public var isNetwork: Bool { status == nil }

    public var transport: TransportError { TransportError(status: status, message: message) }
}
