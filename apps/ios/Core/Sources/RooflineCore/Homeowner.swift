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
    /// Staff-only: gutters are never offered to a homeowner (the server refuses them). The case stays so an older
    /// server's or saved answer still reads.
    case gutters

    public static func < (a: HomeownerService, b: HomeownerService) -> Bool {
        (allCases.firstIndex(of: a) ?? 0) < (allCases.firstIndex(of: b) ?? 0)
    }

    /// What a homeowner can pick: windows and roof, whatever else a server lists.
    public static func offered(_ services: [HomeownerService]) -> [HomeownerService] {
        services.filter { $0 != .gutters }
    }
}

/// One plain choice on the window-style step ("Opens up and down"). `key` is the style the app sends for a window that picks it.
public struct HomeownerStyleOption: Codable, Equatable, Sendable, Hashable, Identifiable {
    public var key: String
    public var label: String
    /// A few words under the label ("Double-hung"); nil when the company gave none.
    public var hint: String?
    /// The tile's id on the server ("up-down", "sideways", "fixed", "special"); nil from an older server.
    public var tile: String?
    /// True: the window is counted but has no instant price (bay, bow, odd shapes): "we price it at your visit".
    public var atVisit: Bool
    public var id: String { key }

    public init(key: String, label: String, hint: String? = nil, tile: String? = nil, atVisit: Bool = false) {
        self.key = key
        self.label = label
        self.hint = hint
        self.tile = tile
        self.atVisit = atVisit
    }

    private enum Keys: String, CodingKey { case key, label, hint, tile, atVisit }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        key = try c.decode(String.self, forKey: .key)
        label = try c.decode(String.self, forKey: .label)
        hint = c.soft(String.self, .hint).flatMap { $0.isEmpty ? nil : $0 }
        tile = c.soft(String.self, .tile)
        atVisit = c.soft(Bool.self, .atVisit) ?? false
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(key, forKey: .key)
        try c.encode(label, forKey: .label)
        try c.encodeIfPresent(hint, forKey: .hint)
        try c.encodeIfPresent(tile, forKey: .tile)
        try c.encode(atVisit, forKey: .atVisit)
    }
}

extension HomeownerStyleOption {
    /// The four plain choices every company starts with (until its own list arrives): the server's own keys and wording.
    public static let plain: [HomeownerStyleOption] = [
        HomeownerStyleOption(key: "double-hung", label: "Opens up and down", hint: "Double-hung", tile: "up-down"),
        HomeownerStyleOption(key: "slider-2", label: "Slides sideways", hint: "Slider", tile: "sideways"),
        HomeownerStyleOption(key: "picture", label: "Doesn't open", hint: "Picture window", tile: "fixed"),
        HomeownerStyleOption(key: "arch", label: "Bay, bow or odd shape", hint: "We quote it at your visit", tile: "special", atVisit: true),
    ]
}

/// "4.9 from 2,400+ homeowners": a rating over a count with the company's own words after the count.
public struct HomeownerRating: Codable, Equatable, Sendable {
    public var value: Double
    public var count: Int
    /// Shown as "2,400+".
    public var plus: Bool
    public var source: String

    public init(value: Double, count: Int, plus: Bool = false, source: String) {
        self.value = value
        self.count = count
        self.plus = plus
        self.source = source
    }

    /// "2,400+ homeowners", or "212 Google reviews" when the source is only a name.
    public var caption: String {
        let n = HomeownerRating.grouped(count) + (plus ? "+" : "")
        let named = source.range(of: "\\b(reviews?|ratings?|homeowners?|customers?|clients?|families)\\b", options: [.regularExpression, .caseInsensitive]) != nil
        return named ? "\(n) \(source)" : "\(n) \(source) \(count == 1 && !plus ? "review" : "reviews")"
    }

    /// "4.9 from 2,400+ homeowners".
    public var line: String { String(format: "%.1f", value) + " from " + caption }

    private static func grouped(_ n: Int) -> String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.locale = Locale(identifier: "en_US")
        return f.string(from: NSNumber(value: n)) ?? String(n)
    }
}

/// What the company says about itself: a rating, the year it started, a licence and up to three short badges; every item
/// optional, nothing invented. (An older server sent `reviews`, `since` and `license` as plain text.)
public struct HomeownerTrust: Codable, Equatable, Sendable {
    public var reviews: String?
    public var since: String?
    public var license: String?
    public var rating: HomeownerRating?
    public var badges: [String]

    public init(reviews: String? = nil, since: String? = nil, license: String? = nil, rating: HomeownerRating? = nil, badges: [String] = []) {
        self.reviews = reviews
        self.since = since
        self.license = license
        self.rating = rating
        self.badges = badges
    }

    private enum Keys: String, CodingKey { case reviews, since, sinceYear, license, rating, badges }
    private enum LicenseKeys: String, CodingKey { case state, number }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        // Numbers or words, whichever the company entered
        func text(_ k: Keys) -> String? {
            if let s = c.soft(String.self, k), !s.isEmpty { return s }
            if let n = c.soft(Double.self, k) { return n == n.rounded() ? String(Int(n)) : String(n) }
            return nil
        }
        reviews = text(.reviews)
        since = text(.since) ?? text(.sinceYear)
        // "NE #48213" from {state, number}, or the plain text an older server sent
        if let l = try? c.nestedContainer(keyedBy: LicenseKeys.self, forKey: .license), let state = try? l.decode(String.self, forKey: .state), let number = try? l.decode(String.self, forKey: .number) {
            license = "\(state.uppercased()) #\(number.hasPrefix("#") ? String(number.dropFirst()) : number)"
        } else {
            license = text(.license)
        }
        rating = c.soft(HomeownerRating.self, .rating)
        badges = (c.soft([String].self, .badges) ?? []).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.prefix(3).map { $0 }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encodeIfPresent(reviews, forKey: .reviews)
        try c.encodeIfPresent(since, forKey: .since)
        try c.encodeIfPresent(license, forKey: .license)
        try c.encodeIfPresent(rating, forKey: .rating)
        if !badges.isEmpty { try c.encode(badges, forKey: .badges) }
    }
}

/// A company's own name and one-line note for Good, Better or Best ("Replenish", "1-year warranty").
public struct HomeownerCatalogTier: Codable, Equatable, Sendable {
    public var key: String
    public var label: String
    public var note: String

    public init(key: String, label: String, note: String = "") {
        self.key = key
        self.label = label
        self.note = note
    }

    private enum Keys: String, CodingKey { case key, label, note }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        key = try c.decode(String.self, forKey: .key)
        label = c.soft(String.self, .label) ?? key.capitalized
        note = c.soft(String.self, .note) ?? ""
    }
}

public struct HomeownerOffer: Codable, Equatable, Sendable {
    public var title: String
    public var termsUrl: String?

    public init(title: String, termsUrl: String? = nil) {
        self.title = title
        self.termsUrl = termsUrl
    }
}

public struct HomeownerFinancing: Codable, Equatable, Sendable {
    public var text: String
    public var url: String?

    public init(text: String, url: String? = nil) {
        self.text = text
        self.url = url
    }
}

/// The company's window catalog without prices (GET /company `catalog`): level names and notes, what every window
/// includes, the optional offer and financing line. Everything optional; absent from an older server.
public struct HomeownerCatalog: Codable, Equatable, Sendable {
    public var tiers: [HomeownerCatalogTier]
    public var included: [String]
    public var offer: HomeownerOffer?
    public var financing: HomeownerFinancing?

    public init(tiers: [HomeownerCatalogTier] = [], included: [String] = [], offer: HomeownerOffer? = nil, financing: HomeownerFinancing? = nil) {
        self.tiers = tiers
        self.included = included
        self.offer = offer
        self.financing = financing
    }

    private enum Keys: String, CodingKey { case tiers, included, offer, financing }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        tiers = c.lossyList(HomeownerCatalogTier.self, .tiers)
        included = (c.soft([String].self, .included) ?? []).filter { !$0.isEmpty }
        offer = c.soft(HomeownerOffer.self, .offer)
        financing = c.soft(HomeownerFinancing.self, .financing)
    }

    public func tier(_ key: String) -> HomeownerCatalogTier? { tiers.first { $0.key == key } }
}

/// The consent words the contact screen shows verbatim next to its two boxes, and the version the server expects back.
public struct HomeownerConsent: Codable, Equatable, Sendable {
    public var version: String
    /// The required box: calls and email about this request. It names the button "Send my request".
    public var text: String
    /// The optional box: texts.
    public var textingText: String

    public init(version: String, text: String, textingText: String) {
        self.version = version
        self.text = text
        self.textingText = textingText
    }
}

public struct HomeownerLimits: Codable, Equatable, Sendable {
    public var maxWindows: Int
    public var maxPhotoBytes: Int
    public var maxRoomLength: Int
    public var maxLabelLength: Int
    public var tokenDays: Int

    public init(maxWindows: Int = 60, maxPhotoBytes: Int = 12_582_912, maxRoomLength: Int = 40, maxLabelLength: Int = 80, tokenDays: Int = 60) {
        self.maxWindows = maxWindows
        self.maxPhotoBytes = maxPhotoBytes
        self.maxRoomLength = maxRoomLength
        self.maxLabelLength = maxLabelLength
        self.tokenDays = tokenDays
    }

    private enum Keys: String, CodingKey { case maxWindows, maxPhotoBytes, maxRoomLength, maxLabelLength, tokenDays }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let d = HomeownerLimits()
        maxWindows = c.soft(Int.self, .maxWindows) ?? d.maxWindows
        maxPhotoBytes = c.soft(Int.self, .maxPhotoBytes) ?? d.maxPhotoBytes
        maxRoomLength = c.soft(Int.self, .maxRoomLength) ?? d.maxRoomLength
        maxLabelLength = c.soft(Int.self, .maxLabelLength) ?? d.maxLabelLength
        tokenDays = c.soft(Int.self, .tokenDays) ?? d.tokenDays
    }
}

/// GET /company.
public struct HomeownerCompany: Codable, Equatable, Sendable {
    public var name: String
    public var brandColor: String?
    public var phone: String?
    public var services: [HomeownerService]
    /// False: the company has no online visit times; offer only "Call me".
    public var booking: Bool
    public var privacyUrl: String?
    public var termsUrl: String?
    public var consent: HomeownerConsent?
    public var windowStyles: [HomeownerStyleOption]
    public var trust: HomeownerTrust?
    public var catalog: HomeownerCatalog
    public var limits: HomeownerLimits

    public init(name: String, brandColor: String? = nil, phone: String? = nil, services: [HomeownerService] = HomeownerService.allCases, booking: Bool = true,
                privacyUrl: String? = nil, termsUrl: String? = nil, consent: HomeownerConsent? = nil, windowStyles: [HomeownerStyleOption] = [],
                trust: HomeownerTrust? = nil, catalog: HomeownerCatalog = HomeownerCatalog(), limits: HomeownerLimits = HomeownerLimits()) {
        self.name = name
        self.brandColor = brandColor
        self.phone = phone
        self.services = services
        self.booking = booking
        self.privacyUrl = privacyUrl
        self.termsUrl = termsUrl
        self.consent = consent
        self.windowStyles = windowStyles
        self.trust = trust
        self.catalog = catalog
        self.limits = limits
    }

    private enum Keys: String, CodingKey { case name, brandColor, phone, services, booking, privacyUrl, termsUrl, consent, windowStyles, trust, catalog, limits, apiVersion }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        name = c.soft(String.self, .name) ?? ""
        brandColor = c.soft(String.self, .brandColor)
        phone = c.soft(String.self, .phone)
        services = (c.soft([String].self, .services) ?? []).compactMap(HomeownerService.init(rawValue:))
        booking = c.soft(Bool.self, .booking) ?? true
        privacyUrl = c.soft(String.self, .privacyUrl)
        termsUrl = c.soft(String.self, .termsUrl)
        consent = c.soft(HomeownerConsent.self, .consent)
        windowStyles = c.lossyList(HomeownerStyleOption.self, .windowStyles)
        trust = c.soft(HomeownerTrust.self, .trust)
        catalog = c.soft(HomeownerCatalog.self, .catalog) ?? HomeownerCatalog()
        limits = c.soft(HomeownerLimits.self, .limits) ?? HomeownerLimits()
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(name, forKey: .name)
        try c.encodeIfPresent(brandColor, forKey: .brandColor)
        try c.encodeIfPresent(phone, forKey: .phone)
        try c.encode(services.map { $0.rawValue }, forKey: .services)
        try c.encode(booking, forKey: .booking)
        try c.encodeIfPresent(privacyUrl, forKey: .privacyUrl)
        try c.encodeIfPresent(termsUrl, forKey: .termsUrl)
        try c.encodeIfPresent(consent, forKey: .consent)
        try c.encode(windowStyles, forKey: .windowStyles)
        try c.encodeIfPresent(trust, forKey: .trust)
        try c.encode(catalog, forKey: .catalog)
        try c.encode(limits, forKey: .limits)
    }
}

// MARK: - A new request

public enum HomeownerRequestStatus: String, Codable, Sendable {
    /// Priced from above: the app goes on to the services.
    case ready
    /// A person calls instead (an apartment, a doubtful home, a daily limit).
    case callback
}

/// The main roof's corners as [longitude, latitude], to draw on the app's own map.
public struct HomeownerOutline: Codable, Equatable, Sendable {
    public var center: [Double]
    public var ring: [[Double]]

    public init(center: [Double], ring: [[Double]]) {
        self.center = center
        self.ring = ring
    }

    /// The ring as (longitude, latitude) pairs, skipping any point that is not two numbers.
    public var points: [(lon: Double, lat: Double)] {
        ring.compactMap { $0.count >= 2 ? (lon: $0[0], lat: $0[1]) : nil }
    }

    public var centerPoint: (lon: Double, lat: Double)? {
        center.count >= 2 ? (lon: center[0], lat: center[1]) : nil
    }
}

public struct HomeownerHome: Codable, Equatable, Sendable {
    public var address: String
    /// 1, 1.5, 2 or 3; nil when the height is not known.
    public var floors: Double?
    public var outline: HomeownerOutline?

    public init(address: String, floors: Double? = nil, outline: HomeownerOutline? = nil) {
        self.address = address
        self.floors = floors
        self.outline = outline
    }

    private enum Keys: String, CodingKey { case address, floors, outline }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        address = c.soft(String.self, .address) ?? ""
        floors = c.soft(Double.self, .floors)
        outline = c.soft(HomeownerOutline.self, .outline)
    }

    /// "2 floors", "1 floor", "1 1/2 floors" for the results screen; nil when unknown.
    public var floorsText: String? {
        guard let f = floors, f > 0 else { return nil }
        if f == 1 { return "1 floor" }
        if f == f.rounded() { return "\(Int(f)) floors" }
        return "\(Int(f.rounded(.down))) 1/2 floors"
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

/// Why the roof has no price: 'satellite-unusable', and the sentence for it (the server's own words).
public struct HomeownerRoofNote: Codable, Equatable, Sendable {
    public var reason: String
    public var message: String

    public init(reason: String = "satellite-unusable", message: String = SatelliteCopy.message) {
        self.reason = reason
        self.message = message
    }
}

/// What a homeowner is told when the satellite pictures cannot be trusted to measure the roof.
public enum SatelliteCopy {
    public static let message = "We can't measure your roof from satellite images — the pictures of your home aren't clear or recent enough. We'll measure it at your free visit."
}

/// What was worked out from the address alone (no windows measured yet).
public struct HomeownerEstimate: Codable, Equatable, Sendable {
    public var windows: HomeownerWindowEstimate?
    public var roof: HomeownerRoofEstimate?
    /// Present when the roof was asked about but the satellite pictures cannot be trusted: `roof` is nil and `message` is
    /// the sentence to show in its place.
    public var roofNote: HomeownerRoofNote?

    public init(windows: HomeownerWindowEstimate? = nil, roof: HomeownerRoofEstimate? = nil, roofNote: HomeownerRoofNote? = nil) {
        self.windows = windows
        self.roof = roof
        self.roofNote = roofNote
    }

    private enum Keys: String, CodingKey { case windows, roof, roofNote }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        windows = c.soft(HomeownerWindowEstimate.self, .windows)
        roof = c.soft(HomeownerRoofEstimate.self, .roof)
        roofNote = c.soft(HomeownerRoofNote.self, .roofNote)
    }
}

/// POST /requests {address, services}.
public struct HomeownerCreated: Decodable, Equatable, Sendable {
    public var requestId: String
    public var token: String
    public var expiresAt: Date?
    public var status: HomeownerRequestStatus
    /// Why a person calls instead: unit, address, home or busy.
    public var callbackReason: String?
    public var home: HomeownerHome
    public var estimate: HomeownerEstimate
    public var services: [HomeownerService]

    public init(requestId: String, token: String, expiresAt: Date? = nil, status: HomeownerRequestStatus, callbackReason: String? = nil,
                home: HomeownerHome, estimate: HomeownerEstimate, services: [HomeownerService] = []) {
        self.requestId = requestId
        self.token = token
        self.expiresAt = expiresAt
        self.status = status
        self.callbackReason = callbackReason
        self.home = home
        self.estimate = estimate
        self.services = services
    }

    private enum Keys: String, CodingKey { case requestId, token, expiresAt, status, callbackReason, home, estimate, services }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        requestId = try c.decode(String.self, forKey: .requestId)
        token = try c.decode(String.self, forKey: .token)
        expiresAt = c.soft(String.self, .expiresAt).flatMap(VisitTimes.parse)
        status = c.soft(HomeownerRequestStatus.self, .status) ?? .ready
        callbackReason = c.soft(String.self, .callbackReason)
        home = c.soft(HomeownerHome.self, .home) ?? HomeownerHome(address: "")
        estimate = c.soft(HomeownerEstimate.self, .estimate) ?? HomeownerEstimate()
        services = (c.soft([String].self, .services) ?? []).compactMap(HomeownerService.init(rawValue:))
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
    /// The server's own wording for how far off it may be, e.g. "about ±1/2 in" (the larger of the two, rounded up).
    public var uncertaintyLabel: String?
    public var sizeClass: String?
    /// The plain name of the window's style choice ("Opens up and down"), when the server gives it.
    public var styleLabel: String?

    public var id: String { input.id }
    public var room: String { input.room ?? "" }
    public var needsCheck: Bool { quality == "check" }

    private enum Keys: String, CodingKey { case widthIn, heightIn, uncertaintyIn, quality, reasons, sizeLabel, uncertaintyLabel, sizeClass, styleLabel }

    public init(input: PhotoWindowInput, widthIn: Double, heightIn: Double, uncertaintyIn: Double?, quality: String = "good", reasons: [String] = [],
                sizeLabel: String? = nil, uncertaintyLabel: String? = nil, sizeClass: String? = nil, styleLabel: String? = nil) {
        self.input = input
        self.widthIn = widthIn
        self.heightIn = heightIn
        self.uncertaintyIn = uncertaintyIn
        self.quality = quality
        self.reasons = reasons
        self.sizeLabel = sizeLabel
        self.uncertaintyLabel = uncertaintyLabel
        self.sizeClass = sizeClass
        self.styleLabel = styleLabel
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
        uncertaintyLabel = c.soft(String.self, .uncertaintyLabel)
        sizeClass = c.soft(String.self, .sizeClass)
        styleLabel = c.soft(String.self, .styleLabel)
    }
}

public struct HomeownerWindowPrice: Codable, Equatable, Sendable {
    public var windowId: String
    public var price: Double
    /// True: no instant price for this window (bay, bow, odd shape); its price is 0 and it is left out of the total.
    public var atVisit: Bool

    public init(windowId: String, price: Double, atVisit: Bool = false) {
        self.windowId = windowId
        self.price = price
        self.atVisit = atVisit
    }

    private enum Keys: String, CodingKey { case windowId, price, priceCents, atVisit }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        windowId = try c.decode(String.self, forKey: .windowId)
        price = c.dollars(.price, cents: .priceCents) ?? 0
        atVisit = c.soft(Bool.self, .atVisit) ?? false
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(windowId, forKey: .windowId)
        try c.encode(price, forKey: .price)
        if atVisit { try c.encode(true, forKey: .atVisit) }
    }
}

/// Good, Better or Best for the windows measured so far and an estimate for the rest.
public struct HomeownerTier: Codable, Equatable, Sendable, Identifiable {
    public var key: String
    public var label: String
    /// The company's name for it ("Vinyl double-hung") and a line about what it is, when the server gives them.
    public var name: String?
    public var detail: String?
    /// One line about the level ("Lifetime warranty"); empty when the company set none.
    public var note: String
    /// Whole dollars, measured windows plus estimated ones.
    public var total: Double
    public var perWindow: [HomeownerWindowPrice]
    public var estimatedCount: Int
    public var estimatedTotal: Double

    public var id: String { key }

    public init(key: String, label: String, name: String? = nil, detail: String? = nil, note: String = "", total: Double, perWindow: [HomeownerWindowPrice] = [], estimatedCount: Int = 0, estimatedTotal: Double = 0) {
        self.key = key
        self.label = label
        self.name = name
        self.detail = detail
        self.note = note
        self.total = total
        self.perWindow = perWindow
        self.estimatedCount = estimatedCount
        self.estimatedTotal = estimatedTotal
    }

    private enum Keys: String, CodingKey { case key, label, name, description, note, total, totalCents, perWindow, estimatedCount, estimatedTotal, estimatedTotalCents }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        key = try c.decode(String.self, forKey: .key)
        label = c.soft(String.self, .label) ?? key.capitalized
        name = c.soft(String.self, .name)
        detail = c.soft(String.self, .description)
        note = c.soft(String.self, .note) ?? ""
        total = c.dollars(.total, cents: .totalCents) ?? 0
        perWindow = c.lossyList(HomeownerWindowPrice.self, .perWindow)
        estimatedCount = c.soft(Int.self, .estimatedCount) ?? 0
        estimatedTotal = c.dollars(.estimatedTotal, cents: .estimatedTotalCents) ?? 0
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(key, forKey: .key)
        try c.encode(label, forKey: .label)
        try c.encodeIfPresent(name, forKey: .name)
        try c.encodeIfPresent(detail, forKey: .description)
        if !note.isEmpty { try c.encode(note, forKey: .note) }
        try c.encode(total, forKey: .total)
        try c.encode(perWindow, forKey: .perWindow)
        try c.encode(estimatedCount, forKey: .estimatedCount)
        try c.encode(estimatedTotal, forKey: .estimatedTotal)
    }
}

/// "We think your home has about 12 to 16 windows and you have measured 1. Did we miss any?"
public struct HomeownerMissingHint: Codable, Equatable, Sendable {
    public var measured: Int
    public var expectedLow: Int
    public var expectedHigh: Int
    public var expectedLikely: Int
    public var text: String

    public init(measured: Int, expectedLow: Int, expectedHigh: Int, expectedLikely: Int, text: String) {
        self.measured = measured
        self.expectedLow = expectedLow
        self.expectedHigh = expectedHigh
        self.expectedLikely = expectedLikely
        self.text = text
    }

    private enum Keys: String, CodingKey { case measured, expectedLow, expectedHigh, expectedLikely, text }

    public init(from decoder: Decoder) throws {
        // An older server sent the sentence alone
        if let only = try? decoder.singleValueContainer().decode(String.self) {
            self.init(measured: 0, expectedLow: 0, expectedHigh: 0, expectedLikely: 0, text: only)
            return
        }
        let c = try decoder.container(keyedBy: Keys.self)
        let low = c.soft(Int.self, .expectedLow) ?? 0
        self.init(measured: c.soft(Int.self, .measured) ?? 0, expectedLow: low, expectedHigh: c.soft(Int.self, .expectedHigh) ?? low,
                  expectedLikely: c.soft(Int.self, .expectedLikely) ?? low, text: c.soft(String.self, .text) ?? "")
    }
}

public struct HomeownerQuote: Codable, Equatable, Sendable {
    public var tiers: [HomeownerTier]
    public var measuredCount: Int
    public var estimatedCount: Int
    /// Measured windows with no instant price (bay, bow, odd shapes): counted, priced at the visit.
    public var atVisitCount: Int
    public var missingHint: HomeownerMissingHint?

    public init(tiers: [HomeownerTier], measuredCount: Int, estimatedCount: Int, atVisitCount: Int = 0, missingHint: HomeownerMissingHint? = nil) {
        self.tiers = tiers
        self.measuredCount = measuredCount
        self.estimatedCount = estimatedCount
        self.atVisitCount = atVisitCount
        self.missingHint = missingHint
    }

    private enum Keys: String, CodingKey { case tiers, measuredCount, estimatedCount, atVisitCount, missingHint }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        tiers = c.lossyList(HomeownerTier.self, .tiers)
        measuredCount = c.soft(Int.self, .measuredCount) ?? 0
        estimatedCount = c.soft(Int.self, .estimatedCount) ?? 0
        atVisitCount = c.soft(Int.self, .atVisitCount) ?? 0
        missingHint = c.soft(HomeownerMissingHint.self, .missingHint)
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
    /// The version of the consent words that were on the screen (GET /company, consent.version): the server stores it
    /// with the exact words as evidence, and refuses (409 consent_changed) a version that is no longer current.
    public var consentVersion: String

    public init(firstName: String = "", lastName: String = "", phone: String = "", email: String = "", zip: String = "",
                contactConsent: Bool = false, textConsent: Bool = false, consentVersion: String = "") {
        self.firstName = firstName
        self.lastName = lastName
        self.phone = phone
        self.email = email
        self.zip = zip
        self.contactConsent = contactConsent
        self.textConsent = textConsent
        self.consentVersion = consentVersion
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

/// A booked visit, or "we will call you". The server says `{ visit: { start, end, timeZone } | null, callMe }`.
public struct HomeownerBooking: Codable, Equatable, Sendable {
    public var slotStart: String?
    public var slotEnd: String?
    public var callMe: Bool
    public var timeZone: String?

    public var isVisit: Bool { slotStart != nil }

    public init(slotStart: String? = nil, slotEnd: String? = nil, callMe: Bool = false, timeZone: String? = nil) {
        self.slotStart = slotStart
        self.slotEnd = slotEnd
        self.callMe = callMe
        self.timeZone = timeZone
    }

    private enum Keys: String, CodingKey { case visit, callMe, slotStart, slotEnd, timeZone }
    private enum VisitKeys: String, CodingKey { case start, end, timeZone }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        callMe = c.soft(Bool.self, .callMe) ?? false
        if let v = try? c.nestedContainer(keyedBy: VisitKeys.self, forKey: .visit) {
            slotStart = v.soft(String.self, .start)
            slotEnd = v.soft(String.self, .end)
            timeZone = v.soft(String.self, .timeZone)
        } else {
            slotStart = c.soft(String.self, .slotStart)
            slotEnd = c.soft(String.self, .slotEnd)
            timeZone = c.soft(String.self, .timeZone)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(callMe, forKey: .callMe)
        if let start = slotStart {
            var v = c.nestedContainer(keyedBy: VisitKeys.self, forKey: .visit)
            try v.encode(start, forKey: .start)
            try v.encodeIfPresent(slotEnd, forKey: .end)
            try v.encodeIfPresent(timeZone, forKey: .timeZone)
        } else {
            try c.encodeNil(forKey: .visit)
        }
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

/// GET /requests/:id/status: `{ stage, dates: { requestedAt, visit, measuredAt, orderedAt, installedAt }, rep: { name }, timeZone }`.
public struct HomeownerStatus: Codable, Equatable, Sendable {
    public var stage: HomeownerStage
    /// ISO times by stage, as far as the server knows them, under the keys requested, visit, measured, ordered, built,
    /// shipped, installed (the server's "measuredAt" is read as "measured").
    public var dates: [String: String]
    public var rep: HomeownerRep?
    public var orderNumber: String?
    /// The expected ship (or install) date, ISO, when the factory has said.
    public var eta: String?
    public var timeZone: String?

    public init(stage: HomeownerStage, dates: [String: String] = [:], rep: HomeownerRep? = nil, orderNumber: String? = nil, eta: String? = nil, timeZone: String? = nil) {
        self.stage = stage
        self.dates = dates
        self.rep = rep
        self.orderNumber = orderNumber
        self.eta = eta
        self.timeZone = timeZone
    }

    private enum Keys: String, CodingKey { case stage, dates, rep, orderNumber, eta, timeZone }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        stage = c.soft(HomeownerStage.self, .stage) ?? .requested
        // Values may be null ("measuredAt": null): those are dropped, the rest read
        var normalized: [String: String] = [:]
        for (key, value) in c.soft([String: Lossy<String>].self, .dates) ?? [:] {
            guard let v = value.value else { continue }
            let k = key.hasSuffix("At") ? String(key.dropLast(2)) : key
            normalized[k] = v
        }
        dates = normalized
        rep = c.soft(HomeownerRep.self, .rep)
        orderNumber = c.soft(String.self, .orderNumber)
        eta = c.soft(String.self, .eta)
        timeZone = c.soft(String.self, .timeZone)
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
    /// The contact form was sent (the request is filed with the company).
    public var contacted: Bool
    public var selectedTier: String?
    public var createdAt: Date?
    public var expiresAt: Date?

    public init(id: String? = nil, status: HomeownerRequestStatus? = nil, address: String? = nil, services: [HomeownerService] = [], home: HomeownerHome? = nil,
                estimate: HomeownerEstimate? = nil, callbackReason: String? = nil, estimatedTotalOverride: Int? = nil, contacted: Bool = false, selectedTier: String? = nil,
                createdAt: Date? = nil, expiresAt: Date? = nil) {
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
        self.createdAt = createdAt
        self.expiresAt = expiresAt
    }

    private enum Keys: String, CodingKey {
        case id, status, address, services, home, estimate, callbackReason, estimatedTotalOverride, contacted, contactFiled, contactSubmitted, selectedTier, tier, createdAt, expiresAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = c.soft(String.self, .id)
        status = c.soft(HomeownerRequestStatus.self, .status)
        services = (c.soft([String].self, .services) ?? []).compactMap(HomeownerService.init(rawValue:))
        home = c.soft(HomeownerHome.self, .home)
        address = c.soft(String.self, .address) ?? home?.address
        estimate = c.soft(HomeownerEstimate.self, .estimate)
        callbackReason = c.soft(String.self, .callbackReason)
        estimatedTotalOverride = c.soft(Int.self, .estimatedTotalOverride)
        contacted = c.soft(Bool.self, .contactFiled) ?? c.soft(Bool.self, .contacted) ?? c.soft(Bool.self, .contactSubmitted) ?? false
        selectedTier = c.soft(String.self, .selectedTier) ?? c.soft(String.self, .tier)
        createdAt = c.soft(String.self, .createdAt).flatMap(VisitTimes.parse)
        expiresAt = c.soft(String.self, .expiresAt).flatMap(VisitTimes.parse)
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
    /// When the server says the token stops working (60 days from the request); nil on a session saved before it was known.
    public var expiresAt: Date?

    public init(requestId: String, token: String, slug: String, address: String, services: [HomeownerService], createdAt: Date = Date(), expiresAt: Date? = nil) {
        self.requestId = requestId
        self.token = token
        self.slug = slug
        self.address = address
        self.services = services
        self.createdAt = createdAt
        self.expiresAt = expiresAt
    }

    /// The server's tokens last 60 days.
    public static let lifetimeDays = 60

    public func isExpired(now: Date = Date()) -> Bool {
        if let e = expiresAt { return now >= e }
        return now.timeIntervalSince(createdAt) > Double(Self.lifetimeDays) * 86_400
    }
}

// MARK: - Errors

/// An error to show a homeowner: the server's own sentence when it gave one, else plain words. The server's body is
/// `{ error, field?, code }`: show `message`, switch on `code`.
public struct HomeownerAPIError: Error, LocalizedError, Equatable, Sendable {
    public var status: Int?
    public var message: String
    public var field: String?
    public var code: String?
    /// Seconds to wait before trying again (429's Retry-After).
    public var retryAfter: Double?

    public init(status: Int?, message: String, field: String? = nil, code: String? = nil, retryAfter: Double? = nil) {
        self.status = status
        self.message = message
        self.field = field
        self.code = code
        self.retryAfter = retryAfter
    }

    public var errorDescription: String? { message }
    /// The token was not accepted (or is past its 60 days): the saved request cannot be used any more.
    public var isUnauthorized: Bool { status == 401 || code == "unauthorized" || code == "token_expired" }
    public var isTokenExpired: Bool { code == "token_expired" }
    /// The request is gone (the server was reset, or it was removed): start over.
    public var isGone: Bool { status == 404 || status == 410 }
    public var isRateLimited: Bool { status == 429 }
    /// No answer at all (offline, timed out).
    public var isNetwork: Bool { status == nil }
    /// The picked visit time is no longer open: fetch the times again.
    public var isSlotTaken: Bool { code == "slot_taken" }
    /// The consent words changed since the screen was loaded: fetch GET /company again.
    public var isConsentChanged: Bool { code == "consent_changed" }
    /// The window cannot be sized from what was sent: its `message` says what to redo.
    public var isWindowUnsizable: Bool { code == "window_unsizable" }

    public var transport: TransportError { TransportError(status: status, message: message, retryAfter: retryAfter) }
}
