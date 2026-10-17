import Foundation
import ImageIO
import RooflineCore

/// The homeowner server in memory: realistic data from the mockups (305 Ridgeway Dr, Little Rock, AR), the contract's
/// rules (windows idempotent on id, 409 for a different window with the same id, contact before booking, 60 windows,
/// quote tiers from measured plus estimated windows). Used by previews, the logic tests and the DEBUG launch argument
/// `-debugFake`; never reachable in a Release build's normal run.
actor FakeHomeownerAPI: HomeownerAPI {
    nonisolated let features: HomeownerFeatures

    struct Config: Sendable {
        var company = FakeHomeownerAPI.defaultCompany
        /// Seconds each call takes (a few tenths make the loading states visible; tests use 0).
        var latency: Double = 0
        /// Addresses that go to the call-back path: a substring and the reason.
        var callbackRules: [(match: String, reason: String)] = [("leavenworth", "unit"), (" apt", "unit"), ("unit ", "unit"), ("#", "unit"), ("busy", "busy"), ("roof only faded photo", "satellite-unusable")]
        var pricePerWindow: [String: Double] = ["good": 600, "better": 800, "best": 1200]
        /// Today, for the open visit times (tests pin it).
        var now: @Sendable () -> Date = { Date() }
    }

    private struct Stored {
        var id: String
        var token: String
        var address: String
        var services: [HomeownerService]
        var status: HomeownerRequestStatus
        var callbackReason: String?
        var home: HomeownerHome
        var estimate: HomeownerEstimate
        var windows: [HomeownerWindow] = []
        var uploads: [String: (w: Int, h: Int)] = [:]
        var override: Int?
        var contact: HomeownerContact?
        var booking: HomeownerBooking?
        var createdAt: Date
        var stage: HomeownerStage = .requested
    }

    private var config: Config
    private var requests: [String: Stored] = [:]
    private var queuedFailures: [HomeownerAPIError] = []
    private var uploadCounter = 0
    /// Every call, in order, for tests ("POST windows w-1").
    private(set) var log: [String] = []

    init(config: Config = Config(), features: HomeownerFeatures = .all) {
        self.config = config
        self.features = features
    }

    static let defaultCompany = HomeownerCompany(
        name: "WinChoice", brandColor: "#ED3A2B", phone: "+15015550100", services: [.windows, .roof], booking: true,
        privacyUrl: "https://winchoice.example/privacy", termsUrl: "https://winchoice.example/terms",
        consent: HomeownerConsent(
            version: "2026-10-16",
            text: "By checking this box and clicking \"Send my request\", I agree that WinChoice may contact me about my estimate and appointment by phone call and email at the phone number and email I provided, including calls that may use automated technology or a prerecorded or artificial voice. Consent is not a condition of purchase. I agree to the Privacy Policy and Terms.",
            textingText: "Text me too: WinChoice may send text messages about my estimate and appointment to the phone number I provided, which may be sent using automated technology. Consent is not a condition of purchase. Message frequency varies. Message and data rates may apply. Reply STOP to stop texts or HELP for help."
        ),
        // The four plain choices and WinChoice's own words, as the server sends them (the prices are the fake's, not WinChoice's)
        windowStyles: HomeownerStyleOption.plain,
        trust: HomeownerTrust(since: "2012", rating: HomeownerRating(value: 4.9, count: 2400, plus: true, source: "homeowners"), badges: ["A+ BBB", "Made in USA", "Lifetime warranty"]),
        catalog: HomeownerCatalog(
            tiers: [
                HomeownerCatalogTier(key: "good", label: "Replenish", note: "1-year warranty"),
                HomeownerCatalogTier(key: "better", label: "Refine", note: "Lifetime warranty"),
                HomeownerCatalogTier(key: "best", label: "Renew", note: "Lifetime warranty"),
            ],
            included: ["Argon gas fill", "Low-E glass (Cardinal LoE366)", "ENERGY STAR® certified", "FlexScreen"],
            offer: HomeownerOffer(title: "October special on windows and roofing. Ask about it at your visit.", termsUrl: "https://winchoice.com/promotional-terms-conditions/"),
            financing: HomeownerFinancing(text: "Financing available through our partner Skeps. Optional, with no obligation.", url: "https://winchoice.com/financing/")
        )
    )

    // MARK: Test and debug controls

    /// The next calls fail with these (in order), before doing anything.
    func failNext(_ errors: HomeownerAPIError...) {
        queuedFailures.append(contentsOf: errors)
    }

    func setConfig(_ change: (inout Config) -> Void) {
        change(&config)
    }

    func calls() -> [String] { log }

    /// A request that already has windows, a contact and so on: the starting point of a screenshot or a test. The token is
    /// the fake's own ("fake-token-<id>"); the returned session works with every call.
    func seed(address: String = "305 Ridgeway Dr, Little Rock, AR 72205", services: [HomeownerService] = [.windows, .roof],
              windows: [FakeWindowSpec] = [], contact: Bool = false, booked: Bool = false, slotIndex: Int = 2, callMe: Bool = false,
              stage: HomeownerStage? = nil, estimatedOverride: Int? = nil) -> HomeownerSession {
        let id = "fake-req-\(requests.count + 1)"
        var stored = makeStored(id: id, address: address, services: services)
        for (i, spec) in windows.enumerated() {
            stored.windows.append(spec.window(id: "w-\(i + 1)"))
        }
        stored.override = estimatedOverride
        if contact {
            stored.contact = HomeownerContact(firstName: "Tia", lastName: "Bell", phone: "(501) 555-0177", email: "tia.bell@example.com", zip: "72205", contactConsent: true, consentVersion: config.company.consent?.version ?? "")
            stored.stage = .requested
        }
        if booked || callMe {
            if stored.contact == nil { stored.contact = HomeownerContact(firstName: "Tia", lastName: "Bell", phone: "(501) 555-0177", email: "tia.bell@example.com", zip: "72205", contactConsent: true, consentVersion: config.company.consent?.version ?? "") }
            if callMe {
                stored.booking = HomeownerBooking(callMe: true)
            } else {
                let slots = openSlots(now: config.now())
                let slot = slots[min(slotIndex, slots.count - 1)]
                stored.booking = HomeownerBooking(slotStart: slot.start, slotEnd: slot.end, callMe: false, timeZone: "America/Chicago")
                stored.stage = .visitBooked
            }
        }
        if let stage = stage { stored.stage = stage }
        requests[id] = stored
        return HomeownerSession(requestId: id, token: "fake-token-\(id)", slug: "summit-ridge", address: address, services: services, createdAt: config.now(), expiresAt: config.now().addingTimeInterval(60 * 86_400))
    }

    // MARK: HomeownerAPI

    func company() async throws -> HomeownerCompany {
        try await enter("GET company")
        return config.company
    }

    func createRequest(address: String, services: [HomeownerService]) async throws -> HomeownerCreated {
        try await enter("POST requests")
        let trimmed = address.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= 5, trimmed.count <= 200 else { throw HomeownerAPIError(status: 400, message: "Please enter your street address.", field: "address", code: "invalid_request") }
        guard !services.isEmpty else { throw HomeownerAPIError(status: 400, message: "Pick at least one thing you're looking for.", field: "services", code: "invalid_request") }
        let id = "fake-req-\(requests.count + 1)"
        let stored = makeStored(id: id, address: trimmed, services: services)
        requests[id] = stored
        return HomeownerCreated(
            requestId: id, token: "fake-token-\(id)", expiresAt: config.now().addingTimeInterval(60 * 86_400), status: stored.status, callbackReason: stored.callbackReason,
            home: stored.home, estimate: stored.estimate, services: services.sorted()
        )
    }

    func view(_ s: HomeownerSession) async throws -> HomeownerRequestView {
        try await enter("GET requests")
        return try render(try stored(s))
    }

    func uploadPhoto(_ s: HomeownerSession, jpeg: Data) async throws -> WindowPhotoUpload {
        try await enter("POST uploads")
        var r = try stored(s)
        guard r.status == .ready else { throw HomeownerAPIError(status: 409, message: "This request goes to a call-back, so windows can't be added.", code: "callback_only") }
        guard jpeg.count <= config.company.limits.maxPhotoBytes else { throw HomeownerAPIError(status: 413, message: "That photo is too large.", code: "too_large") }
        uploadCounter += 1
        let id = "fake-upload-\(uploadCounter)"
        let size = Self.imageSize(jpeg) ?? (1440, 1920)
        r.uploads[id] = size
        requests[r.id] = r
        return WindowPhotoUpload(id: id, widthPx: size.0, heightPx: size.1)
    }

    func addWindow(_ s: HomeownerSession, window: PhotoWindowInput) async throws -> HomeownerRequestView {
        try await enter("POST windows \(window.id)")
        var r = try stored(s)
        guard r.status == .ready else { throw HomeownerAPIError(status: 409, message: "This request goes to a call-back, so windows can't be added.", code: "callback_only") }
        guard r.services.contains(.windows) else { throw HomeownerAPIError(status: 409, message: "This request is not about windows.", code: "windows_not_requested") }
        guard WindowIds.isValid(window.id) else { throw HomeownerAPIError(status: 400, message: "That window id is not valid.", field: "id", code: "invalid_request") }
        guard let room = window.room, !room.isEmpty, room.count <= config.company.limits.maxRoomLength else {
            throw HomeownerAPIError(status: 400, message: "Please say which room this window is in.", field: "room", code: "invalid_request")
        }
        guard let style = window.style, config.company.windowStyles.contains(where: { $0.key == style }) else {
            throw HomeownerAPIError(status: 400, message: "Please pick a style for this window.", field: "style", code: "invalid_request")
        }
        if let existing = r.windows.first(where: { $0.id == window.id }) {
            // Same window again: nothing changes. A different one with this id: refused.
            guard existing.input == window else { throw HomeownerAPIError(status: 409, message: "A different window already uses that id.", code: "window_id_taken") }
            return try render(r)
        }
        guard r.windows.count < config.company.limits.maxWindows else { throw HomeownerAPIError(status: 409, message: "This request already has \(config.company.limits.maxWindows) windows.", code: "windows_full") }
        if let up = window.uploadId, r.uploads[up] == nil {
            throw HomeownerAPIError(status: 400, message: "That photo is not one of this request's photos.", field: "uploadId", code: "invalid_request")
        }
        let size = window.uploadId.flatMap { r.uploads[$0] } ?? (0, 0)
        guard let sized = Self.size(window, imageWidthPx: size.0, imageHeightPx: size.1) else {
            throw HomeownerAPIError(status: 422, message: "We couldn't work out this window's size from that photo. Please measure it again.", code: "window_unsizable")
        }
        r.windows.append(HomeownerWindow(
            input: window, widthIn: sized.widthIn, heightIn: sized.heightIn, uncertaintyIn: sized.uncertaintyIn,
            quality: sized.needsCheck ? "check" : "good", reasons: sized.reasons,
            sizeLabel: "\(SizeWording.text(sized.widthIn)) x \(SizeWording.text(sized.heightIn))", uncertaintyLabel: sized.uncertaintyIn.map { SizeWording.plusMinus($0) }
        ))
        requests[r.id] = r
        return try render(r)
    }

    func deleteWindow(_ s: HomeownerSession, windowId: String) async throws -> HomeownerRequestView {
        try await enter("DELETE windows \(windowId)")
        var r = try stored(s)
        r.windows.removeAll { $0.id == windowId }
        requests[r.id] = r
        return try render(r)
    }

    func setEstimatedTotal(_ s: HomeownerSession, total: Int?) async throws -> HomeownerRequestView {
        try await enter("PATCH requests")
        var r = try stored(s)
        if let t = total, !(1...80).contains(t) { throw HomeownerAPIError(status: 400, message: "Please enter a number from 1 to 80.", field: "estimatedTotalOverride", code: "invalid_request") }
        r.override = total
        requests[r.id] = r
        return try render(r)
    }

    func fileContact(_ s: HomeownerSession, contact: HomeownerContact) async throws -> HomeownerRequestView {
        try await enter("POST contact")
        var r = try stored(s)
        let errors = ContactValidation.errors(contact)
        if let (field, message) = errors.first(where: { $0.key != .consent }) ?? errors.first {
            throw HomeownerAPIError(status: 400, message: message, field: field.rawValue, code: "invalid_request")
        }
        guard contact.consentVersion == config.company.consent?.version else {
            throw HomeownerAPIError(status: 409, message: "Our consent wording changed. Please read it again and send once more.", code: "consent_changed")
        }
        if let existing = r.contact, PhoneFormat.digits(existing.phone) != PhoneFormat.digits(contact.phone) {
            throw HomeownerAPIError(status: 409, message: "This request is already filed with a different phone number.", code: "contact_filed")
        }
        r.contact = contact
        requests[r.id] = r
        return try render(r)
    }

    func slots(_ s: HomeownerSession) async throws -> HomeownerSlots {
        try await enter("GET slots")
        _ = try stored(s)
        guard config.company.booking else { return HomeownerSlots(timeZone: "America/Chicago", slots: []) }
        return HomeownerSlots(timeZone: "America/Chicago", slots: openSlots(now: config.now()))
    }

    func book(_ s: HomeownerSession, choice: HomeownerBookingChoice) async throws -> HomeownerRequestView {
        try await enter("POST book")
        var r = try stored(s)
        guard r.contact != nil else { throw HomeownerAPIError(status: 409, message: "Please send your details first.", code: "contact_needed") }
        switch choice {
        case .slot(let slot):
            guard config.company.booking else { throw HomeownerAPIError(status: 409, message: "Online booking is off. Please ask us to call you.", code: "booking_off") }
            if let b = r.booking, b.isVisit { return try render(r) }
            guard let open = openSlots(now: config.now()).first(where: { $0.start == slot.start }) else {
                throw HomeownerAPIError(status: 409, message: "That time was just taken. Please pick another.", code: "slot_taken")
            }
            r.booking = HomeownerBooking(slotStart: open.start, slotEnd: open.end, callMe: false, timeZone: "America/Chicago")
            r.stage = .visitBooked
        case .callMe:
            if r.booking?.isVisit != true { r.booking = HomeownerBooking(callMe: true) }
        }
        requests[r.id] = r
        return try render(r)
    }

    func status(_ s: HomeownerSession) async throws -> HomeownerStatus {
        try await enter("GET status")
        return statusBody(try stored(s))
    }

    // MARK: Building the answers

    private func enter(_ call: String) async throws {
        log.append(call)
        if config.latency > 0 { try? await Task.sleep(nanoseconds: UInt64(config.latency * 1_000_000_000)) }
        if !queuedFailures.isEmpty { throw queuedFailures.removeFirst() }
    }

    private func stored(_ s: HomeownerSession) throws -> Stored {
        guard let r = requests[s.requestId], s.token == "fake-token-\(r.id)" else {
            throw HomeownerAPIError(status: 401, message: "Your saved request is no longer valid. Please start a new one.", code: "unauthorized")
        }
        return r
    }

    private func makeStored(id: String, address: String, services: [HomeownerService]) -> Stored {
        let lower = address.lowercased()
        if let rule = config.callbackRules.first(where: { lower.contains($0.match) }) {
            return Stored(id: id, token: "fake-token-\(id)", address: address, services: services, status: .callback, callbackReason: rule.reason,
                          home: HomeownerHome(address: address, floors: nil, outline: nil),
                          estimate: HomeownerEstimate(windows: nil, roof: nil, roofNote: rule.reason == "satellite-unusable" && services.contains(.roof) ? HomeownerRoofNote() : nil), createdAt: config.now())
        }
        // A home whose satellite pictures are old: windows are counted, the roof gets the sentence and no price
        let satellite = lower.contains("faded photo") && services.contains(.roof)
        let estimate = HomeownerEstimate(
            windows: services.contains(.windows) ? HomeownerWindowEstimate(low: 7, high: 9, likely: 7) : nil,
            roof: services.contains(.roof) && !satellite ? HomeownerRoofEstimate(low: 9800, high: 12100, squares: 23) : nil,
            roofNote: satellite ? HomeownerRoofNote() : nil
        )
        // A small house outline near the address (longitude, latitude), as the real server's roof ring would give
        let lon = -92.3926, lat = 34.7449
        let dx = 0.000063, dy = 0.000036
        let ring = [[lon - dx, lat - dy], [lon + dx, lat - dy], [lon + dx, lat + dy], [lon - dx, lat + dy]]
        return Stored(id: id, token: "fake-token-\(id)", address: address, services: services, status: .ready, callbackReason: nil,
                      home: HomeownerHome(address: address, floors: 1, outline: HomeownerOutline(center: [lon, lat], ring: ring)), estimate: estimate, createdAt: config.now())
    }

    private func render(_ r: Stored) throws -> HomeownerRequestView {
        let info = HomeownerRequestInfo(
            id: r.id, status: r.status, address: r.address, services: r.services.sorted(), home: r.home, estimate: r.estimate, callbackReason: r.callbackReason,
            estimatedTotalOverride: r.override, contacted: r.contact != nil, createdAt: r.createdAt, expiresAt: r.createdAt.addingTimeInterval(60 * 86_400)
        )
        var rooms: [String] = []
        for w in r.windows where !rooms.contains(w.room) { rooms.append(w.room) }
        let quote: HomeownerQuote? = r.status == .ready && r.services.contains(.windows) ? quoteBody(r) : nil
        return HomeownerRequestView(request: info, windows: r.windows, rooms: rooms, quote: quote, booking: r.booking, status: r.contact == nil ? nil : statusBody(r))
    }

    private func quoteBody(_ r: Stored) -> HomeownerQuote {
        let expected = r.override ?? r.estimate.windows?.likely ?? 0
        let measured = r.windows.count
        let estimatedCount = max(0, expected - measured)
        let catalog = config.company.catalog
        let bathroomAdder = 45.0   // the fake's own number, like the other prices
        let atVisitKeys = Set(config.company.windowStyles.filter { $0.atVisit }.map { $0.key })
        let tiers: [HomeownerTier] = [
            ("good", "Good", "Vinyl double-hung and sliders", "Double-pane, Low-E glass, standard install"),
            ("better", "Better", "LoE366 glass with argon", "Full-frame install, lifetime warranty"),
            ("best", "Best", "Triple-pane glass", "Full-frame install"),
        ].map { key, label, name, detail in
            let price = config.pricePerWindow[key] ?? 0
            let own = catalog.tier(key)
            let per = r.windows.map { w -> HomeownerWindowPrice in
                if let style = w.input.style, atVisitKeys.contains(style) { return HomeownerWindowPrice(windowId: w.id, price: 0, atVisit: true) }
                return HomeownerWindowPrice(windowId: w.id, price: price + (w.input.frosted == true ? bathroomAdder : 0))
            }
            let est = price * Double(estimatedCount)
            return HomeownerTier(key: key, label: own?.label ?? label, name: name, detail: detail, note: own?.note ?? "", total: per.reduce(0) { $0 + $1.price } + est, perWindow: per, estimatedCount: estimatedCount, estimatedTotal: est)
        }
        var hint: HomeownerMissingHint?
        if r.override == nil, let e = r.estimate.windows, measured < e.low {
            hint = HomeownerMissingHint(measured: measured, expectedLow: e.low, expectedHigh: e.high, expectedLikely: e.likely,
                                        text: "We think your home has about \(e.low) to \(e.high) windows and you have measured \(measured). Did we miss any?")
        }
        let atVisit = r.windows.filter { $0.input.style.map(atVisitKeys.contains) ?? false }.count
        return HomeownerQuote(tiers: tiers, measuredCount: measured, estimatedCount: estimatedCount, atVisitCount: atVisit, missingHint: hint)
    }

    private func statusBody(_ r: Stored) -> HomeownerStatus {
        var dates: [String: String] = ["requested": iso(r.createdAt)]
        if let b = r.booking, let start = b.slotStart { dates["visit"] = start }
        var status = HomeownerStatus(stage: r.stage, dates: dates, rep: r.booking?.isVisit == true ? HomeownerRep(name: "Casey") : nil, timeZone: "America/Chicago")
        // Not in the contract (draft or final): only the full-design fake shows them, to see the screens as designed
        if features.windowColor, r.stage >= .ordered {
            status.orderNumber = "24-1187"
            status.eta = iso(r.createdAt.addingTimeInterval(12 * 86_400))
        }
        return status
    }

    private func iso(_ d: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: d)
    }

    /// The next open visit times: from tomorrow, weekdays, at 9:00, 12:30 and 16:00 in Little Rock, two a day, eight in all.
    func openSlots(now: Date) -> [HomeownerSlot] {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "America/Chicago")!
        var out: [HomeownerSlot] = []
        var day = cal.startOfDay(for: now)
        var guardRail = 0
        while out.count < 8, guardRail < 30 {
            guardRail += 1
            day = cal.date(byAdding: .day, value: 1, to: day)!
            let weekday = cal.component(.weekday, from: day)
            if weekday == 1 || weekday == 7 { continue }
            for (h, m) in [(9, 0), (12, 30), (16, 0)] where out.count < 8 {
                guard let start = cal.date(bySettingHour: h, minute: m, second: 0, of: day), let end = cal.date(byAdding: .minute, value: 60, to: start) else { continue }
                // two a day: the mockup's three chips come from the Chicago day, so offer all three for the first days
                out.append(HomeownerSlot(id: iso(start), start: iso(start), end: iso(end)))
            }
        }
        return out
    }

    // MARK: Sizing in the fake

    struct Sized {
        var widthIn: Double
        var heightIn: Double
        var uncertaintyIn: Double?
        var needsCheck: Bool
        var reasons: [String]
    }

    static func size(_ w: PhotoWindowInput, imageWidthPx: Int, imageHeightPx: Int) -> Sized? {
        if let p = LocalWindowPreview.of(w, imageWidthPx: imageWidthPx, imageHeightPx: imageHeightPx) {
            return Sized(widthIn: p.widthIn, heightIn: p.heightIn, uncertaintyIn: p.uncertaintyIn, needsCheck: p.needsCheck, reasons: p.reasons)
        }
        // Scales the phone cannot size on its own: a plausible window
        return Sized(widthIn: 35.625, heightIn: 59.625, uncertaintyIn: 0.25, needsCheck: false, reasons: [])
    }

    static func imageSize(_ jpeg: Data) -> (Int, Int)? {
        guard let src = CGImageSourceCreateWithData(jpeg as CFData, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
              let w = props[kCGImagePropertyPixelWidth] as? Int, let h = props[kCGImagePropertyPixelHeight] as? Int else { return nil }
        return (w, h)
    }
}

/// A window to put in a seeded request, by its size and how it was measured.
struct FakeWindowSpec: Sendable {
    var room: String
    var name: String?
    var widthIn: Double
    var heightIn: Double
    var uncertaintyIn: Double
    var check = false
    var method: Method = .depth
    var style: String = "double-hung"

    enum Method: Sendable { case depth, phone, card, scan }

    func window(id: String) -> HomeownerWindow {
        let w = widthIn / inchesPerMetre, h = heightIn / inchesPerMetre
        let points = [Vec3(0, h, -1), Vec3(w, h, -1), Vec3(w, 0, -1), Vec3(0, 0, -1)]
        let scale: WindowPhotoScale
        switch method {
        case .depth: scale = .ar(ArScale(pointsM: points, trackingLostCount: 0, device: .arkitLidar, cornerSpreadM: [0.001, 0.001, 0.001, 0.001]))
        case .phone: scale = .ar(ArScale(pointsM: points, trackingLostCount: 0, device: .arkit, cornerSpreadM: nil))
        case .card: scale = .card(CardScale(cardCorners: [Vec2(100, 100), Vec2(400, 100), Vec2(400, 290), Vec2(100, 290)]))
        case .scan: scale = .roomplan(RoomPlanScale(widthM: w, heightM: h, confidence: .medium))
        }
        let input = PhotoWindowInput(id: id, uploadId: nil, label: name, windowKey: nil, corners: nil, scale: scale, room: room, style: style)
        return HomeownerWindow(input: input, widthIn: widthIn, heightIn: heightIn, uncertaintyIn: uncertaintyIn, quality: check ? "check" : "good",
                               reasons: check ? ["The corners were hard to see."] : [], sizeLabel: nil, uncertaintyLabel: nil)
    }

    /// The seven windows of the mockup's list (screen 10).
    static let mockupSeven: [FakeWindowSpec] = [
        FakeWindowSpec(room: "Living room", widthIn: 71.25, heightIn: 59.375, uncertaintyIn: 0.5, check: true, style: "slider-2"),
        FakeWindowSpec(room: "Kitchen", widthIn: 35.625, heightIn: 47.875, uncertaintyIn: 0.1),
        FakeWindowSpec(room: "Bathroom", widthIn: 23.5, heightIn: 35.75, uncertaintyIn: 0.1),
        FakeWindowSpec(room: "Bedroom 1", widthIn: 35.625, heightIn: 59.625, uncertaintyIn: 0.1),
        FakeWindowSpec(room: "Bedroom 2", widthIn: 35.75, heightIn: 59.5, uncertaintyIn: 0.25, method: .card),
        FakeWindowSpec(room: "Bedroom 3", widthIn: 35.625, heightIn: 59.625, uncertaintyIn: 0.1),
        FakeWindowSpec(room: "Hall", widthIn: 29.875, heightIn: 47.75, uncertaintyIn: 0.1),
    ]
}
