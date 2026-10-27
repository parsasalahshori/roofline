import Foundation
import RooflineCore

// Checks for the homeowner app's pure logic: how sizes are WRITTEN (the owner's wording rules), the homeowner API's
// JSON, the outbox over the homeowner endpoints, where a returning homeowner resumes, the contact form, visit times,
// rooms and styles, and the live readout.

private func hoWindow(_ id: String = WindowIds.new(), scale: WindowPhotoScale? = nil, room: String? = "Bedroom 1", style: String? = nil) -> PhotoWindowInput {
    PhotoWindowInput(
        id: id, uploadId: nil, label: nil, windowKey: nil,
        corners: [Vec2(100, 100), Vec2(500, 100), Vec2(500, 900), Vec2(100, 900)],
        scale: scale ?? .ar(ArScale(pointsM: rect(w: 0.9, h: 1.5), trackingLostCount: 0, device: .arkitLidar, cornerSpreadM: [0.001, 0.001, 0.001, 0.001])),
        room: room, style: style
    )
}

private func decodeView(_ json: String) throws -> HomeownerRequestView {
    try JSONDecoder().decode(HomeownerRequestView.self, from: Data(json.utf8))
}

let homeownerChecks: [Check] = wordingChecks + homeownerApiChecks + homeownerOutboxChecks + homeownerFlowChecks + homeownerFormChecks

// MARK: - Wording of sizes

private let wordingChecks: [Check] = [
    Check("SizeWording: whole inches and a reduced eighth, never decimals") { ctx in
        ctx.equal(SizeWording.text(35.625), "35 5/8")
        ctx.equal(SizeWording.text(35.5), "35 1/2")
        ctx.equal(SizeWording.text(35.25), "35 1/4")
        ctx.equal(SizeWording.text(35.97), "36", "an eighth carries into the next inch")
        ctx.equal(SizeWording.text(0.5), "1/2")
        ctx.equal(SizeWording.text(0), "0")
        ctx.equal(SizeWording.text(-3), "0", "a negative length is shown as 0, not as nonsense")
        ctx.equal(SizeWording.text(.nan), "0")
        ctx.equal(SizeWording.sizeText(widthIn: 35.625, heightIn: 59.625), "35 5/8 × 59 5/8 in")
        ctx.equal(SizeWording.parts(71.25), SizeWording.Parts(whole: 71, numerator: 1, denominator: 4))
        ctx.equal(SizeWording.parts(36), SizeWording.Parts(whole: 36, numerator: 0, denominator: 1))
        // The same sizes as the staff app's Eighths
        for v in stride(from: 0.0, through: 100.0, by: 0.0625) where v > 0 { ctx.equal(SizeWording.text(v), Eighths.format(v), "at \(v)") }
    },
    Check("SizeWording: accuracy is 'about 1/8 inch', rounded up, never a bare ±") { ctx in
        ctx.equal(SizeWording.accuracy(0.03), "about 1/8 inch")
        ctx.equal(SizeWording.accuracy(0.125), "about 1/8 inch")
        ctx.equal(SizeWording.accuracy(0.13), "about 1/4 inch")
        ctx.equal(SizeWording.accuracy(0.375), "about 3/8 inch")
        ctx.equal(SizeWording.accuracy(0.5), "about 1/2 inch")
        ctx.equal(SizeWording.accuracy(1), "about 1 inch")
        ctx.equal(SizeWording.accuracy(1.5), "about 1 1/2 inches")
        ctx.equal(SizeWording.accuracy(2), "about 2 inches")
        ctx.equal(SizeWording.accuracyShort(0.2), "about 1/4 in")
        ctx.equal(SizeWording.plusMinus(1), "about ±1 in")
        ctx.equal(SizeWording.plusMinusEach(1), "about ±1 in each")
        ctx.equal(SizeWording.plusMinus(1.5), "about ±1 1/2 in")
        ctx.equal(SizeWording.accuracyRange(lowIn: 0.25, highIn: 0.5), "About 1/4 to 1/2 inch")
        ctx.equal(SizeWording.accuracyRange(lowIn: 0.125, highIn: 0.125), "About 1/8 inch")
        // The rule itself: every "±" this module writes follows the word "about"
        for u in [0.01, 0.125, 0.2, 0.5, 1, 1.5, 3] {
            for s in [SizeWording.plusMinus(u), SizeWording.plusMinusEach(u), MethodLabel.listLine(.roomplan(RoomPlanScale(widthM: 1, heightM: 1, confidence: .high)), uncertaintyIn: u)] where s.contains("±") {
                ctx.expect(s.contains("about ±"), "bare ± in '\(s)'")
            }
        }
    },
    Check("SizeWording: the server's label reads back, and sizes are spoken in words for VoiceOver") { ctx in
        let p = SizeWording.parseSizeLabel("35 5/8 x 59 5/8")
        ctx.near(p?.widthIn, 35.625)
        ctx.near(p?.heightIn, 59.625)
        ctx.near(SizeWording.parseSizeLabel("36 × 60 in")?.widthIn, 36)
        ctx.expect(SizeWording.parseSizeLabel("nonsense") == nil)
        ctx.expect(SizeWording.parseSizeLabel("35 5/8") == nil)
        ctx.equal(SizeWording.spoken(35.625), "35 and 5 eighths")
        ctx.equal(SizeWording.spoken(35.5), "35 and a half")
        ctx.equal(SizeWording.spoken(35.25), "35 and a quarter")
        ctx.equal(SizeWording.spoken(35.75), "35 and three quarters")
        ctx.equal(SizeWording.spoken(36), "36")
        ctx.equal(SizeWording.spokenSize(widthIn: 35.625, heightIn: 59.625), "35 and 5 eighths by 59 and 5 eighths inches")
        ctx.equal(SizeWording.spokenAccuracy(0.125), "about an eighth of an inch")
        ctx.equal(SizeWording.spokenAccuracy(1), "about 1 inch")
        ctx.equal(SizeWording.spokenAccuracy(1.5), "about 1 and a half inches")
    },
    Check("MethodLabel: how a window was measured, as the list says it") { ctx in
        let lidar = WindowPhotoScale.ar(ArScale(pointsM: [], trackingLostCount: 0, device: .arkitLidar, cornerSpreadM: nil))
        let plain = WindowPhotoScale.ar(ArScale(pointsM: [], trackingLostCount: 0, device: .arkit, cornerSpreadM: nil))
        ctx.equal(MethodLabel.listLine(lidar, uncertaintyIn: 0.1), "Depth sensor · about 1/8 in")
        ctx.equal(MethodLabel.listLine(plain, uncertaintyIn: 0.3), "Phone camera · about 3/8 in")
        ctx.equal(MethodLabel.listLine(.card(CardScale(cardCorners: [])), uncertaintyIn: 0.25), "Card photo · about 1/4 in")
        ctx.equal(MethodLabel.listLine(.roomplan(RoomPlanScale(widthM: 1, heightM: 1, confidence: .high)), uncertaintyIn: 1), "Room scan · about ±1 in")
        ctx.equal(MethodLabel.listLine(lidar, uncertaintyIn: nil), "Depth sensor")
    },
    Check("DeviceNames and capabilities: the sentences name the phone, never LiDAR") { ctx in
        ctx.equal(DeviceNames.name(identifier: "iPhone16,1"), "iPhone 15 Pro")
        ctx.equal(DeviceNames.name(identifier: "iPhone18,1"), "iPhone 17 Pro")
        ctx.equal(DeviceNames.name(identifier: "iPhone99,9"), "iPhone", "an unknown model is just 'iPhone'")
        let pro = MeasureCapabilities.depthSensorPhone("iPhone 15 Pro")
        ctx.equal(pro.methodsSentence, "Your iPhone 15 Pro can use all five.")
        ctx.equal(pro.depthSentence, "Your iPhone 15 Pro has a depth sensor, so sizes come out accurate to about 1/4 inch.")
        let basic = MeasureCapabilities(deviceName: "iPhone 14", corners: true, depthSensor: false, roomScan: false, camera: true)
        ctx.equal(basic.methodsSentence, "Your iPhone 14 can use the four corners and the bank card photo.")
        ctx.expect(basic.depthSentence.contains("no depth sensor"))
        for s in [pro.methodsSentence, pro.depthSentence, basic.methodsSentence, basic.depthSentence] {
            ctx.expect(!s.lowercased().contains("lidar"), "'LiDAR' in a homeowner sentence: \(s)")
            ctx.expect(!s.contains("ID-1"), "'ID-1' in a homeowner sentence: \(s)")
        }
        ctx.equal(MeasureCapabilities.none.methodCount, 0)
    },
]

// MARK: - The homeowner API's JSON

// The examples are the ones in docs/windows/homeowner-api.md (the contract): if the server's shapes change, these say so.
private let contractView = """
{
  "request": {
    "id": "0b6a3b0e-0000-4000-8000-000000000001", "status": "ready", "services": ["windows", "roof"],
    "home": { "address": "123 Main St, Irvine, CA 92620", "floors": 1.5, "outline": { "center": [-117.8, 33.68], "ring": [[-117.80001, 33.68001], [-117.8, 33.68002]] } },
    "estimate": { "windows": { "low": 12, "high": 16, "likely": 14 }, "roof": { "low": 14000, "high": 18000, "squares": 28.5 }, "gutters": null },
    "estimatedTotalOverride": null, "contactFiled": true, "createdAt": "2026-10-16T20:00:00.000Z", "expiresAt": "2026-12-15T20:00:00.000Z"
  },
  "windows": [
    { "id": "w-kitchen-1", "room": "Kitchen", "label": "Over the sink", "style": "double-hung",
      "scale": { "kind": "card", "cardCorners": [[100, 100], [400, 100], [400, 290], [100, 290]], "card": { "widthMm": 85.6, "heightMm": 53.98 } },
      "uploadId": "7d4e1d3a-0000-4000-8000-000000000002", "corners": [[300, 400], [1300, 400], [1300, 1900], [300, 1900]],
      "widthIn": 35.6, "heightIn": 59.6, "sizeClass": "standard", "uncertaintyIn": { "width": 0.3, "height": 0.4 }, "quality": "good", "reasons": [],
      "sizeLabel": "35 5/8 x 59 5/8", "uncertaintyLabel": "about ±1/2 in" },
    { "id": "broken", "scale": { "kind": "ar" } },
    { "id": "w-hall", "room": "Hall", "style": "slider-2", "scale": { "kind": "roomplan", "widthM": 0.9, "heightM": 1.2, "confidence": "medium" },
      "widthIn": 35.4, "heightIn": 47.2, "uncertaintyIn": 1, "quality": "check", "reasons": ["a scan"] }
  ],
  "rooms": ["Kitchen", "Hall"],
  "quote": {
    "tiers": [
      { "key": "good", "label": "Good", "name": "Vinyl double-hung", "description": "Double-pane, Low-E glass, standard install", "total": 8400,
        "perWindow": [{ "windowId": "w-kitchen-1", "price": 600 }], "estimatedCount": 13, "estimatedTotal": 7800 },
      { "key": "better", "label": "Better", "total": 11200, "perWindow": [], "estimatedCount": 14, "estimatedTotal": 11200 }
    ],
    "measuredCount": 1, "estimatedCount": 13,
    "missingHint": { "measured": 1, "expectedLow": 12, "expectedHigh": 16, "expectedLikely": 14, "text": "We think your home has about 12 to 16 windows and you have measured 1. Did we miss any?" }
  },
  "booking": { "visit": { "start": "2026-10-17T16:00:00.000Z", "end": "2026-10-17T17:00:00.000Z", "timeZone": "America/Los_Angeles" }, "callMe": false },
  "status": { "stage": "visit-booked", "dates": { "requestedAt": "2026-10-16T20:05:00.000Z", "visit": "2026-10-17T16:00:00.000Z", "measuredAt": null, "orderedAt": null, "installedAt": null }, "rep": { "name": "Sam" }, "timeZone": "America/Los_Angeles" }
}
"""

private let homeownerApiChecks: [Check] = [
    Check("HomeownerWindowInput: a card window encodes exactly the server's keys, no nulls") { ctx in
        var w = PhotoWindowInput(
            id: "card1", uploadId: "up9", label: "Bedroom 1, front", windowKey: nil,
            corners: [Vec2(10, 20), Vec2(300, 20), Vec2(300, 500), Vec2(10, 500)],
            scale: .card(CardScale(cardCorners: [Vec2(50, 60), Vec2(130, 60), Vec2(130, 110), Vec2(50, 110)])),
            room: "Bedroom 1", style: "double-hung"
        )
        let o = try json(w)
        ctx.equal(Set(o.keys), ["id", "uploadId", "label", "corners", "scale", "room", "style"])
        let scale = o["scale"] as? [String: Any]
        ctx.equal(scale?["kind"] as? String, "card")
        ctx.equal(Set((scale ?? [:]).keys), ["kind", "cardCorners", "card"])
        let card = scale?["card"] as? [String: Any]
        ctx.near(card?["widthMm"] as? Double, 85.6)
        ctx.near(card?["heightMm"] as? Double, 53.98)
        ctx.equal((scale?["cardCorners"] as? [[Double]])?.count, 4)
        // A rep's window still encodes with neither homeowner key
        w.room = nil
        w.style = nil
        ctx.expect(try json(w)["room"] == nil && json(w)["style"] == nil)
        // And a card window reads back as a card
        let back = try JSONDecoder().decode(PhotoWindowInput.self, from: JSONEncoder().encode(PhotoWindowInput(id: "c", uploadId: "u", label: nil, windowKey: nil, corners: nil,
            scale: .card(CardScale(cardCorners: [Vec2(1, 2), Vec2(3, 2), Vec2(3, 4), Vec2(1, 4)])), room: "Kitchen", style: "slider-2")))
        ctx.equal(back.scale.kind, "card")
        ctx.equal(back.room, "Kitchen")
        ctx.equal(back.style, "slider-2")
    },
    Check("Homeowner API: the contract's request view decodes, and a bad item is skipped, not fatal") { ctx in
        let view = try decodeView(contractView)
        ctx.equal(view.request.services, [.windows], "WinChoice is windows only: a roof in the answer is dropped")
        ctx.expect(view.request.contacted, "contactFiled")
        ctx.equal(view.request.estimatedTotalOverride, nil)
        ctx.equal(view.request.estimate?.windows?.likely, 14)
        ctx.equal(view.request.home?.floors, 1.5)
        ctx.equal(view.request.home?.floorsText, "1 1/2 floors")
        ctx.equal(view.request.home?.outline?.points.count, 2)
        ctx.equal(view.request.address, "123 Main St, Irvine, CA 92620", "the address comes from home when the request has none")
        ctx.expect(view.request.expiresAt != nil && view.request.createdAt != nil)
        ctx.equal(view.windows.map { $0.id }, ["w-kitchen-1", "w-hall"], "the broken window is skipped")
        ctx.near(view.windows[0].uncertaintyIn, 0.4, 1e-9, "{width, height} reads as the larger one")
        ctx.equal(view.windows[0].uncertaintyLabel, "about ±1/2 in")
        ctx.equal(view.windows[0].sizeClass, "standard")
        ctx.equal(view.windows[0].input.scale.kind, "card")
        ctx.expect(view.windows[1].needsCheck && !view.windows[0].needsCheck)
        ctx.near(view.windows[1].uncertaintyIn, 1)
        ctx.equal(view.windows[0].room, "Kitchen")
        ctx.equal(view.windows[0].sizeLabel, "35 5/8 x 59 5/8")
        ctx.equal(view.rooms, ["Kitchen", "Hall"])
        ctx.equal(view.quote?.tiers.count, 2)
        ctx.near(view.quote?.tier("good")?.total, 8400)
        ctx.equal(view.quote?.tier("good")?.name, "Vinyl double-hung")
        ctx.equal(view.quote?.tier("good")?.detail, "Double-pane, Low-E glass, standard install")
        ctx.equal(view.quote?.tier("good")?.estimatedCount, 13)
        ctx.near(view.quote?.tier("good")?.perWindow.first?.price, 600)
        ctx.equal(view.quote?.windowCount, 14)
        ctx.equal(view.quote?.missingHint?.expectedLow, 12)
        ctx.expect(view.quote?.missingHint?.text.hasSuffix("Did we miss any?") == true)
        ctx.equal(view.booking?.isVisit, true)
        ctx.equal(view.booking?.callMe, false)
        ctx.equal(view.booking?.timeZone, "America/Los_Angeles")
        ctx.equal(view.status?.stage, .visitBooked)
        ctx.equal(view.status?.rep?.name, "Sam")
        ctx.equal(view.status?.dates["requested"], "2026-10-16T20:05:00.000Z", "requestedAt reads as requested")
        ctx.equal(view.status?.dates["visit"], "2026-10-17T16:00:00.000Z")
        ctx.expect(view.status?.dates["measured"] == nil, "a null date is dropped")
        // Nothing but an empty object still decodes (a newer or older server)
        let empty = try decodeView("{}")
        ctx.equal(empty.windows.count, 0)
        ctx.expect(empty.quote == nil && empty.booking == nil && empty.status == nil)
        // An older shape of the hint (just a sentence) and of the booking (flat) still read
        let old = try decodeView(#"{ "quote": { "tiers": [], "missingHint": "Did we miss any?" }, "booking": { "slotStart": "2026-10-17T16:00:00Z", "callMe": false } }"#)
        ctx.equal(old.quote?.missingHint?.text, "Did we miss any?")
        ctx.equal(old.booking?.slotStart, "2026-10-17T16:00:00Z")
        // A call-me booking has no visit
        let call = try decodeView(#"{ "booking": { "visit": null, "callMe": true } }"#)
        ctx.equal(call.booking?.isVisit, false)
        ctx.equal(call.booking?.callMe, true)
    },
    Check("Homeowner API: created request, company, slots and booking bodies") { ctx in
        let created = try JSONDecoder().decode(HomeownerCreated.self, from: Data("""
        { "requestId": "req-1", "token": "tok", "expiresAt": "2026-12-15T20:00:00.000Z", "status": "callback", "callbackReason": "unit",
          "home": { "address": "2210 Leavenworth St, Little Rock, AR", "floors": null, "outline": null },
          "estimate": { "windows": null, "roof": null }, "services": ["windows", "bogus"] }
        """.utf8))
        ctx.equal(created.status, .callback)
        ctx.equal(created.callbackReason, "unit")
        ctx.equal(created.home.floors, nil)
        ctx.expect(created.estimate.windows == nil)
        ctx.equal(created.services, [.windows])
        ctx.expect(created.expiresAt != nil)
        let body = try json(HomeownerCreateBody(address: "305 Ridgeway Dr", services: [.windows]))
        ctx.equal(body["services"] as? [String], ["windows"], "only windows are asked for")
        ctx.equal(Set(body.keys), ["address", "services"])

        let company = try JSONDecoder().decode(HomeownerCompany.self, from: Data("""
        { "apiVersion": 1, "name": "Summit Ridge Roofing", "brandColor": "#155EAB", "phone": "+19495550123", "services": ["roof", "windows", "gutters"], "booking": false,
          "privacyUrl": "https://p", "termsUrl": "https://t",
          "consent": { "version": "2026-10-16", "text": "By checking this box and clicking \\"Send my request\\", I agree ...", "textingText": "Text me too ..." },
          "windowStyles": [ { "key": "double-hung", "label": "Double-hung" }, { "bad": 1 } ], "trust": { "reviews": 4.9, "since": 2004 },
          "limits": { "maxWindows": 60, "maxPhotoBytes": 12582912, "maxRoomLength": 40, "maxLabelLength": 80, "tokenDays": 60 } }
        """.utf8))
        ctx.equal(company.services, [.windows], "an older server may still list a roof or gutters; they are dropped")
        ctx.equal(HomeownerService.offered(company.services), [.windows], "a homeowner is only offered windows")
        ctx.equal(company.booking, false)
        ctx.equal(company.consent?.version, "2026-10-16")
        ctx.expect(company.consent?.text.contains("\"Send my request\"") == true)
        ctx.equal(company.windowStyles, [HomeownerStyleOption(key: "double-hung", label: "Double-hung")])
        ctx.equal(company.trust?.since, "2004", "a number the company typed reads as text")
        ctx.equal(company.trust?.reviews, "4.9")
        ctx.equal(company.limits.maxWindows, 60)
        ctx.equal(company.limits.maxRoomLength, 40)
        // Without a consent block or limits (an older server) the defaults hold
        let bare = try JSONDecoder().decode(HomeownerCompany.self, from: Data(#"{ "name": "X" }"#.utf8))
        ctx.equal(bare.booking, true)
        ctx.expect(bare.consent == nil)
        ctx.equal(bare.limits.maxPhotoBytes, 12_582_912)

        let slots = HomeownerSlots.decode(Data("""
        { "timeZone": "America/Chicago", "slots": [ { "id": "a", "start": "2026-10-20T17:30:00.000Z", "end": "2026-10-20T18:30:00.000Z" }, { "x": 1 } ] }
        """.utf8))
        ctx.equal(slots?.slots.count, 1)
        ctx.equal(slots?.timeZone, "America/Chicago")
        let bareSlots = HomeownerSlots.decode(Data(#"[ { "start": "2026-10-21T09:00:00-05:00" } ]"#.utf8))
        ctx.equal(bareSlots?.slots.first?.id, "2026-10-21T09:00:00-05:00", "no id: the start is the id")

        let slot = HomeownerSlot(id: "a", start: "2026-10-20T12:30:00-05:00")
        ctx.equal(Set(try json(HomeownerBookBody(.slot(slot))).keys), ["slotStart"])
        ctx.equal(Set(try json(HomeownerBookBody(.callMe(bestTime: "afternoon"))).keys), ["callMe"], "the best time is not sent unless the server takes it")
        ctx.equal(Set(try json(HomeownerBookBody(.callMe(bestTime: "afternoon"), sendBestTime: true)).keys), ["callMe", "bestTime"])

        // The contact body is exactly the contract's keys
        let contact = HomeownerContact(firstName: "Alex", lastName: "Rivera", phone: "(949) 555-0147", email: "alex@example.com", zip: "92620", contactConsent: true, textConsent: false, consentVersion: "2026-10-16")
        ctx.equal(Set(try json(contact).keys), ["firstName", "lastName", "phone", "email", "zip", "contactConsent", "textConsent", "consentVersion"])
    },
    Check("HomeownerSession and errors") { ctx in
        let s = HomeownerSession(requestId: "r", token: "t", slug: "summit-ridge", address: "305 Ridgeway Dr", services: [.windows], createdAt: Date(timeIntervalSince1970: 1_000_000))
        ctx.expect(!s.isExpired(now: Date(timeIntervalSince1970: 1_000_000 + 59 * 86_400)))
        ctx.expect(s.isExpired(now: Date(timeIntervalSince1970: 1_000_000 + 61 * 86_400)), "tokens last 60 days")
        var withExpiry = s
        withExpiry.expiresAt = Date(timeIntervalSince1970: 1_000_000 + 10 * 86_400)
        ctx.expect(withExpiry.isExpired(now: Date(timeIntervalSince1970: 1_000_000 + 11 * 86_400)), "the server's own expiry wins")
        let back = try JSONDecoder().decode(HomeownerSession.self, from: JSONEncoder().encode(s))
        ctx.equal(back, s)
        // A session saved before expiresAt existed still reads
        let oldJSON = #"{"requestId":"r","token":"t","slug":"x","address":"a","services":["windows"],"createdAt":0}"#
        ctx.expect((try? JSONDecoder().decode(HomeownerSession.self, from: Data(oldJSON.utf8))) != nil)
        ctx.expect(HomeownerAPIError(status: 401, message: "", code: "unauthorized").isUnauthorized)
        ctx.expect(HomeownerAPIError(status: 401, message: "", code: "token_expired").isTokenExpired)
        ctx.expect(HomeownerAPIError(status: 410, message: "").isGone && HomeownerAPIError(status: 404, message: "").isGone)
        ctx.expect(HomeownerAPIError(status: nil, message: "offline").isNetwork)
        ctx.expect(HomeownerAPIError(status: 409, message: "", code: "slot_taken").isSlotTaken)
        ctx.expect(HomeownerAPIError(status: 409, message: "", code: "consent_changed").isConsentChanged)
        ctx.expect(HomeownerAPIError(status: 422, message: "Retake it.", code: "window_unsizable").isWindowUnsizable)
        ctx.expect(HomeownerAPIError(status: 429, message: "").transport.isRetryable)
        ctx.expect(!HomeownerAPIError(status: 422, message: "").transport.isRetryable)
    },
]

// MARK: - The outbox over the homeowner endpoints

private let homeownerOutboxChecks: [Check] = [
    Check("Homeowner outbox: the photo uploads at once, the window waits for its style, then goes (once)") { ctx in
        let t = FakeTransport()
        let ob = Outbox(directory: tempDir(), transport: t)
        try await ob.load()
        let w = hoWindow()
        let item = try await ob.enqueue(window: w, measurementId: "req-1", address: "305 Ridgeway Dr", jpeg: Data([0xFF, 0xD8, 0xFF]), imageWidthPx: 1440, imageHeightPx: 1920, held: true)
        ctx.equal(item.nextStage, .photo)
        await ob.syncAll()
        ctx.equal(t.uploads, 1, "the photo is up before the style is picked")
        ctx.equal(t.appends, 0, "no window without a style")
        let waiting = await ob.items.first!
        ctx.equal(waiting.uploadId, "up-1")
        ctx.expect(waiting.isHeld)
        ctx.equal(waiting.state, .waiting)
        ctx.equal(waiting.nextStage, nil)
        // The style is picked: the window is changed and released
        let changed = try await ob.updateWindow(id: item.id, release: true) { $0.style = "double-hung"; $0.label = "Bedroom 1, front" }
        ctx.expect(changed)
        await ob.syncAll()
        ctx.equal(t.appends, 1)
        let sent = t.saved[item.id]
        ctx.equal(sent?.style, "double-hung")
        ctx.equal(sent?.room, "Bedroom 1")
        ctx.equal(sent?.label, "Bedroom 1, front")
        ctx.equal(sent?.uploadId, "up-1", "the window carries its photo's upload id")
        ctx.equal(sent?.windowKey, nil)
        // Done: a later change is refused (the server would answer 409 for a different body with the same id)
        let late = try await ob.updateWindow(id: item.id) { $0.style = "slider" }
        ctx.expect(!late)
        await ob.syncAll()
        ctx.equal(t.appends, 1, "nothing is sent twice")
    },
    Check("Homeowner outbox: a held window survives a restart, and an outbox from before 'held' still reads") { ctx in
        let dir = tempDir()
        let t = FakeTransport()
        let ob = Outbox(directory: dir, transport: t)
        try await ob.load()
        let item = try await ob.enqueue(window: hoWindow(), measurementId: "req-1", address: nil, jpeg: Data([1]), imageWidthPx: 1440, imageHeightPx: 1920, held: true)
        await ob.syncAll()
        let again = Outbox(directory: dir, transport: t)
        try await again.load()
        let got = await again.items.first!
        ctx.equal(got.id, item.id)
        ctx.expect(got.isHeld)
        ctx.equal(got.uploadId, "up-1")
        ctx.equal(got.window.room, "Bedroom 1")
        // A rep's item has no `held` key at all, and reads as not held
        let plain = OutboxItem(window: sampleWindow(), measurementId: "m", address: nil, jpegFileName: nil, imageWidthPx: 0, imageHeightPx: 0)
        let data = try JSONEncoder().encode(plain)
        let keys = (try JSONSerialization.jsonObject(with: data) as? [String: Any]).map { Set($0.keys) } ?? []
        ctx.expect(!keys.contains("held"), "an unheld item writes no 'held' key")
        let decoded = try JSONDecoder().decode(OutboxItem.self, from: data)
        ctx.expect(!decoded.isHeld)
        ctx.equal(decoded.nextStage, .window)
    },
    Check("Homeowner outbox: release alone, and removing one request's windows with their photos") { ctx in
        let t = FakeTransport()
        let dir = tempDir()
        let ob = Outbox(directory: dir, transport: t)
        try await ob.load()
        let a = try await ob.enqueue(window: hoWindow("a-1", style: "slider"), measurementId: "req-1", address: nil, jpeg: Data([1]), imageWidthPx: 10, imageHeightPx: 10, held: true)
        let b = try await ob.enqueue(window: hoWindow("b-1", style: "slider"), measurementId: "req-2", address: nil, jpeg: Data([2]), imageWidthPx: 10, imageHeightPx: 10, held: true)
        try await ob.release(id: a.id)
        await ob.syncAll()
        ctx.equal(t.appends, 1, "only the released window goes")
        ctx.expect(t.saved["a-1"] != nil && t.saved["b-1"] == nil)
        try await ob.removeAll(measurementId: "req-2")
        let left = await ob.items.map { $0.id }
        ctx.equal(left, ["a-1"])
        ctx.expect(!FileManager.default.fileExists(atPath: dir.appendingPathComponent("\(b.id).jpg").path), "the removed request's photo is gone")
        ctx.equal(await ob.pendingCount, 0, "a-1 is done")
    },
    Check("LocalWindowPreview: a card photo is sized by the server's card model with the photo's focal length, and a size the phone is wildly unsure of is not shown") { ctx in
        // The photos and the server's answers for them are the parity corpus of CardChecks (CardParityData.swift)
        func parity(_ name: String) -> CardParityCase? { cardParityCases.first { $0.name == name } }
        guard let front = parity("front-on photo at 40 px per inch, 2250x3000, a full-size card (the old app check)"),
              let told = parity("26 mm lens told"), let none = parity("no focal length told, shot at 26 mm"),
              let tiny = parity("card tapped at a quarter of its size (the ± is huge)"),
              let wantFront = front.size, let wantTold = told.size, let wantNone = none.size, let wantTiny = tiny.size else {
            ctx.expect(false, "the parity photos are in the corpus")
            return
        }
        func window(_ c: CardParityCase) -> PhotoWindowInput {
            PhotoWindowInput(id: "c1", uploadId: "u", label: nil, windowKey: nil, corners: c.windowCorners, scale: .card(CardScale(cardCorners: c.cardCorners)), room: "Kitchen", style: "double-hung")
        }
        func preview(_ c: CardParityCase, focal35mm: Double?) -> WindowPreview? {
            LocalWindowPreview.of(window(c), imageWidthPx: Int(c.widthPx), imageHeightPx: Int(c.heightPx), focal35mm: focal35mm)
        }
        func agrees(_ p: WindowPreview?, _ want: [Double], _ c: CardParityCase, _ what: String) {
            ctx.near(p?.widthIn, want[0], 1e-6 * want[0], "\(what): the server's width")
            ctx.near(p?.heightIn, want[1], 1e-6 * want[1], "\(what): the server's height")
            ctx.near(p?.uncertaintyIn, max(want[2], want[3]), 1e-6 * max(want[2], want[3]), "\(what): the larger +/-")
            ctx.equal(p?.needsCheck, c.quality == "check", "\(what): needs a check")
            ctx.equal(p?.reasons ?? [], c.reasons, "\(what): the server's reasons")
        }
        // A front-on photo at 40 px per inch: the card is 135 x 85 px, the window 1425 x 2385 px, the photo says nothing about its lens
        let p = preview(front, focal35mm: front.focal35mm)
        agrees(p, wantFront, front, "front-on photo")
        ctx.equal(p?.needsCheck, true, "a 135 px card next to a 36 x 60 in window is a check")
        ctx.expect(p?.isShowable == true, "about 7/8 inch of doubt is worth printing")
        ctx.expect(p.map { $0.widthIn < 35 && $0.heightIn < 58 } == true, "a card tapped at its sharp-corner size makes the window read small, as the server does")
        // The photo's focal length is passed on: 26 mm told and the same photo with nothing told differ only in the doubt
        let withFocal = preview(told, focal35mm: told.focal35mm)
        agrees(withFocal, wantTold, told, "26 mm told")
        let without = preview(none, focal35mm: none.focal35mm)
        agrees(without, wantNone, none, "no focal length")
        ctx.equal(without?.widthIn, withFocal?.widthIn, "the same size")
        ctx.expect((without?.uncertaintyIn ?? 0) > (withFocal?.uncertaintyIn ?? .infinity), "10% of doubt in the lens is more than 3%")
        agrees(preview(none, focal35mm: 26), wantTold, told, "the same photo with 26 mm passed on")
        ctx.equal(preview(none, focal35mm: 700)?.uncertaintyIn, without?.uncertaintyIn, "a focal length the server would not read is not said")
        // A card tapped at a quarter of its size: the phone is wildly unsure, so the size is not printed
        let hopeless = preview(tiny, focal35mm: tiny.focal35mm)
        agrees(hopeless, wantTiny, tiny, "tiny card")
        ctx.expect(hopeless?.isShowable == false, "and the doubt is too big to print")
        // No photo size, or no frame corners: nothing to show
        let w = window(told)
        ctx.expect(LocalWindowPreview.of(w, imageWidthPx: 0, imageHeightPx: 0) == nil)
        var noCorners = w
        noCorners.corners = nil
        ctx.expect(LocalWindowPreview.of(noCorners, imageWidthPx: Int(told.widthPx), imageHeightPx: Int(told.heightPx)) == nil)
        // The limit itself
        ctx.expect(WindowPreview(widthIn: 36, heightIn: 60, uncertaintyIn: 4, needsCheck: true).isShowable)
        ctx.expect(!WindowPreview(widthIn: 36, heightIn: 60, uncertaintyIn: 4.2, needsCheck: true).isShowable)
        ctx.expect(WindowPreview(widthIn: 36, heightIn: 60, uncertaintyIn: nil, needsCheck: false).isShowable)
    },
    Check("LocalWindowPreview: sizes from the phone's own math for AR and room scans") { ctx in
        let ar = hoWindow(scale: .ar(ArScale(pointsM: rect(w: 0.9, h: 1.5), trackingLostCount: 0, device: .arkitLidar, cornerSpreadM: [0.001, 0.001, 0.001, 0.001])))
        let p = LocalWindowPreview.of(ar, imageWidthPx: 1440, imageHeightPx: 1920)
        ctx.near(p?.widthIn, 0.9 * inchesPerMetre, 1e-6)
        ctx.near(p?.heightIn, 1.5 * inchesPerMetre, 1e-6)
        ctx.expect(p?.needsCheck == false)
        ctx.expect((p?.uncertaintyIn ?? 0) > 0)
        let scan = hoWindow(scale: .roomplan(RoomPlanScale(widthM: 0.9, heightM: 1.2, confidence: .low)))
        let q = LocalWindowPreview.of(scan, imageWidthPx: 0, imageHeightPx: 0)
        ctx.near(q?.uncertaintyIn, 2)
        ctx.equal(q?.needsCheck, true, "a scan that was not sure is a check")
        ctx.equal(LocalWindowPreview.of(hoWindow(scale: .roomplan(RoomPlanScale(widthM: 0.9, heightM: 1.2, confidence: .high))), imageWidthPx: 0, imageHeightPx: 0)?.needsCheck, false)
    },
]

// MARK: - The journey: resume, paths, hints

private let homeownerFlowChecks: [Check] = [
    Check("ResumeRouter: no request starts at the welcome; a booked one lands on My order") { ctx in
        ctx.equal(ResumeRouter.target(saved: .quote, hasSession: false, snapshot: ResumeSnapshot()), .welcome)
        let booked = ResumeSnapshot(windowCount: 7, hasBooking: true, hasContact: true)
        ctx.equal(ResumeRouter.target(saved: .book, hasSession: true, snapshot: booked), .status)
        ctx.equal(ResumeRouter.target(saved: nil, hasSession: true, snapshot: booked), .status)
        ctx.equal(ResumeRouter.target(saved: .booked, hasSession: true, snapshot: booked), .booked, "the confirmation is shown until they leave it")
        ctx.equal(ResumeRouter.target(saved: .status, hasSession: true, snapshot: booked), .status)
        let call = ResumeSnapshot(requestStatus: .callback)
        ctx.equal(ResumeRouter.target(saved: nil, hasSession: true, snapshot: call), .callback)
        ctx.equal(ResumeRouter.target(saved: .callbackSent, hasSession: true, snapshot: call), .callbackSent)
        ctx.equal(ResumeRouter.target(saved: .rooms, hasSession: true, snapshot: call), .callback, "a call-back request has no measuring steps")
    },
    Check("ResumeRouter: back to the last screen, but only one that has what it needs") { ctx in
        let fresh = ResumeSnapshot()
        ctx.equal(ResumeRouter.target(saved: nil, hasSession: true, snapshot: fresh), .results)
        ctx.equal(ResumeRouter.target(saved: .address, hasSession: true, snapshot: fresh), .results, "a request exists: the address is done")
        ctx.equal(ResumeRouter.target(saved: .rooms, hasSession: true, snapshot: fresh), .rooms)
        ctx.equal(ResumeRouter.target(saved: .coaching, hasSession: true, snapshot: fresh), .coaching)
        ctx.equal(ResumeRouter.target(saved: .quote, hasSession: true, snapshot: fresh), .results, "no quote without a window")
        ctx.equal(ResumeRouter.target(saved: .list, hasSession: true, snapshot: fresh), .results)
        let measured = ResumeSnapshot(windowCount: 3)
        ctx.equal(ResumeRouter.target(saved: nil, hasSession: true, snapshot: measured), .list, "windows are on the list: open the list")
        ctx.equal(ResumeRouter.target(saved: .rooms, hasSession: true, snapshot: measured), .rooms)
        ctx.equal(ResumeRouter.target(saved: .quote, hasSession: true, snapshot: measured), .quote)
        ctx.equal(ResumeRouter.target(saved: .quote, hasSession: true, snapshot: ResumeSnapshot(windowCount: 3, unstyledCount: 2)), .list, "windows without a style go back to the list, whose button opens the estimate")
        ctx.equal(ResumeRouter.target(saved: .book, hasSession: true, snapshot: measured), .contact, "no booking before contact details")
        ctx.equal(ResumeRouter.target(saved: .book, hasSession: true, snapshot: ResumeSnapshot(windowCount: 3, hasContact: true)), .book)
        // The ready screen needs windows, and goes back to the list while any is without a style
        ctx.equal(ResumeRouter.target(saved: .ready, hasSession: true, snapshot: fresh), .results, "no ready screen without a window")
        ctx.equal(ResumeRouter.target(saved: .ready, hasSession: true, snapshot: measured), .ready)
        ctx.equal(ResumeRouter.target(saved: .ready, hasSession: true, snapshot: ResumeSnapshot(windowCount: 3, unstyledCount: 1)), .list)
    },
    Check("HomeownerFlow: the back stack that leads to a screen") { ctx in
        ctx.equal(HomeownerFlow.path(to: .welcome), [])
        ctx.equal(HomeownerFlow.path(to: .address), [.address], "Measure goes straight to the address")
        ctx.equal(HomeownerFlow.path(to: .results), [.address, .results])
        ctx.equal(HomeownerFlow.path(to: .rooms), [.address, .results, .coaching, .rooms])
        ctx.equal(HomeownerFlow.path(to: .list).last, .list)
        ctx.equal(HomeownerFlow.path(to: .quote), [.address, .results, .coaching, .rooms, .list, .quote])
        ctx.equal(HomeownerFlow.path(to: .ready), [.address, .results, .coaching, .rooms, .list, .ready], "customizing sits between the estimate and the form")
        ctx.equal(HomeownerFlow.path(to: .book).suffix(3), [.ready, .contact, .book])
        ctx.equal(HomeownerFlow.path(to: .status), [], "My order has no back stack")
        ctx.equal(HomeownerFlow.afterResults, .coaching)
        ctx.equal(HomeownerFlow.progressDots(.address), 1)
        ctx.equal(HomeownerFlow.progressDots(.results), 2)
        ctx.equal(HomeownerFlow.progressDots(.coaching), 3)
        ctx.equal(HomeownerFlow.progressDots(.list), 0)
        ctx.expect(HomeownerStep.booked.isTerminal && HomeownerStep.status.isTerminal && !HomeownerStep.list.isTerminal)
    },
    Check("Customize: the look sent to the CRM has exactly four keys, in the server's words, and reads as one line") { ctx in
        let look = WindowVisualLook(type: .casement, grid: .prairie, glass: .lowE)
        let body = try json(HomeownerWindowLookBody(look: look, colorKey: "black"))
        ctx.equal(Set(body.keys), ["kind", "grid", "glass", "color"], "no other key: the server refuses one")
        ctx.equal(body["kind"] as? String, "casement")
        ctx.equal(body["grid"] as? String, "prairie")
        ctx.equal(body["glass"] as? String, "lowE")
        ctx.equal(body["color"] as? String, "black")
        let other = try json(HomeownerWindowLookBody(look: WindowVisualLook(type: .pictureCasements, grid: .queenAnne, glass: .frosted), colorKey: "white"))
        ctx.equal(other["kind"] as? String, "pictureCasements")
        ctx.equal(other["grid"] as? String, "queenAnne")
        ctx.equal(other["glass"] as? String, "frosted")
        ctx.equal(look.oneLine(colorLabel: "Black"), "Casement · Prairie · Black · Low-E")
        ctx.equal(WindowVisualLook().oneLine(colorLabel: "White"), "Double-hung · No grid · White · Clear")
        ctx.equal(look.oneLine(colorLabel: nil), "Casement · Prairie · Low-E")
        // Every kind, grid and glass the app can choose is a word the server accepts (WINDOW_LOOK_* in packages/shared)
        let kinds = ["doubleHung", "singleHung", "slider2", "slider3", "casement", "casementPair", "awning", "hopper", "picture", "pictureCasements", "bay", "bow", "garden", "arch", "halfRound", "circle", "specialty"]
        ctx.equal(VisualWindowType.allCases.map { $0.rawValue }, kinds)
        ctx.equal(VisualGrid.allCases.map { $0.rawValue }, ["none", "colonial", "prairie", "diamond", "queenAnne", "topOnly"])
        ctx.equal(VisualGlass.allCases.map { $0.rawValue }, ["clear", "lowE", "frosted"])
    },
    Check("WindowCountHint: 'Did we miss any?' against what homes like theirs have") { ctx in
        let e = HomeownerWindowEstimate(low: 7, high: 9, likely: 7)
        ctx.equal(WindowCountHint.detail(measured: 7, estimate: e), "Homes like yours usually have 7 to 9 windows. You measured 7.")
        ctx.equal(WindowCountHint.detail(measured: 5, estimate: e), "Homes like yours usually have 7 to 9 windows. You measured 5. A few may be missing.")
        ctx.equal(WindowCountHint.verdict(measured: 5, estimate: e), .fewerThanUsual)
        ctx.equal(WindowCountHint.verdict(measured: 9, estimate: e), .usual)
        ctx.equal(WindowCountHint.verdict(measured: 12, estimate: e), .moreThanUsual)
        ctx.equal(WindowCountHint.verdict(measured: 3, estimate: nil), .unknown)
        ctx.equal(WindowCountHint.usually(e), "Homes like yours usually have 7 to 9 windows.")
        ctx.equal(WindowCountHint.usually(HomeownerWindowEstimate(low: 8, high: 8)), "Homes like yours usually have 8 windows.")
        ctx.equal(WindowCountHint.hudTitle(number: 4, estimate: e), "WINDOW 4 OF 7")
        ctx.equal(WindowCountHint.hudTitle(number: 10, estimate: e), "WINDOW 10")
        ctx.equal(WindowCountHint.hudTitle(number: 2, estimate: nil), "WINDOW 2")
        ctx.equal(WindowTotal.clamp(0), 1)
        ctx.equal(WindowTotal.clamp(200), 80)
    },
    Check("Callback and order copy: plain words for each reason and each stage") { ctx in
        ctx.expect(CallbackCopy.reason("unit").lead.hasPrefix("This building looks like it has more than one home."))
        ctx.expect(CallbackCopy.reason("unit").rest.contains("apartments and duplexes"))
        for code in ["unit", "address", "home", "busy", "not-rooftop", "satellite-unusable", nil, "something-new"] {
            let r = CallbackCopy.reason(code)
            ctx.expect(!r.lead.isEmpty && !r.rest.isEmpty)
            ctx.expect(!(r.lead + r.rest).lowercased().contains("error"), "a call-back is not an error")
        }
        // No call-back wording mentions a roof or satellite pictures (WinChoice is windows only)
        for code in ["unit", "address", "home", "busy", "satellite-unusable", "roof-review", nil] {
            let r = CallbackCopy.reason(code)
            ctx.expect(!(r.lead + r.rest).lowercased().contains("roof") && !(r.lead + r.rest).lowercased().contains("satellite"), "no roof words in the call-back copy")
        }
        ctx.equal(CallbackCopy.button(bestTime: "afternoon"), "Call me this afternoon")
        ctx.equal(CallbackCopy.button(bestTime: nil), "Call me")
        ctx.equal(OrderTimeline.headline(.ordered), "Being built")
        ctx.equal(OrderTimeline.subhead(.ordered), "Your windows are on the line in Mountain Pine, Arkansas.")
        ctx.expect(CallbackCopy.reason("address").lead != CallbackCopy.reason("unit").lead && CallbackCopy.reason("home").lead != CallbackCopy.reason("busy").lead)
        let steps = OrderTimeline.steps(stage: .ordered, dates: ["requested": "2026-10-03", "measured": "2026-10-06"], windowCount: 7, city: "Little Rock", visitDate: nil)
        ctx.equal(steps.map { $0.state }, [.done, .done, .now, .pending, .pending])
        ctx.equal(steps.map { $0.title }, ["You measured", "Rep confirmed sizes", "Being built", "Shipped to Little Rock", "Installed"])
        ctx.equal(steps[0].detail, "7 windows with your iPhone")
        let early = OrderTimeline.steps(stage: .visitBooked, dates: [:], windowCount: 1, city: nil, visitDate: "Tue, Oct 20")
        ctx.equal(early.map { $0.state }, [.done, .now, .pending, .pending, .pending])
        ctx.equal(early[1].detail, "Visit Tue, Oct 20")
        ctx.equal(early[0].detail, "1 window with your iPhone")
        let done = OrderTimeline.steps(stage: .installed, dates: [:], windowCount: 7, city: "Little Rock", visitDate: nil)
        ctx.expect(done.allSatisfy { $0.state == .done })
    },
    Check("LiveReadout: width and height by gravity, whatever order the corners were tapped") { ctx in
        let pts = rect(w: 0.9, h: 1.5)  // TL, TR, BR, BL on a wall
        // TL then TR then BR: the first edge is across (width), the second is up-down (height)
        let three = LiveReadout.from(corners: Array(pts.prefix(3)), aim: nil)
        ctx.near(three.widthIn, 0.9 * inchesPerMetre, 1e-6)
        ctx.near(three.heightIn, 1.5 * inchesPerMetre, 1e-6)
        ctx.equal(three.placed, 3)
        // TL then BL (down first): the edge is a height
        let down = LiveReadout.from(corners: [pts[0], pts[3]], aim: nil)
        ctx.near(down.heightIn, 1.5 * inchesPerMetre, 1e-6)
        ctx.expect(down.widthIn == nil)
        // One corner and the crosshair: the live edge is shown
        let live = LiveReadout.from(corners: [pts[0]], aim: pts[1])
        ctx.near(live.widthIn, 0.9 * inchesPerMetre, 1e-6)
        // Four corners in a scrambled order: the finished size
        let all = LiveReadout.from(corners: [pts[2], pts[0], pts[3], pts[1]], aim: nil, device: .arkitLidar)
        ctx.near(all.widthIn, 0.9 * inchesPerMetre, 1e-6)
        ctx.near(all.heightIn, 1.5 * inchesPerMetre, 1e-6)
        ctx.equal(all.placed, 4)
        ctx.equal(LiveReadout.from(corners: [], aim: nil), LiveReadout())
    },
]

// MARK: - Forms, times, rooms, styles

private let homeownerFormChecks: [Check] = [
    Check("ContactValidation: what is wrong with the form, in the server's words") { ctx in
        var c = HomeownerContact()
        let all = ContactValidation.errors(c)
        ctx.equal(Set(all.keys), Set(ContactField.allCases))
        ctx.equal(all[.consent], "Please check the box so we can call or email you.")
        ctx.equal(all[.zip], "Please enter a 5-digit ZIP code.")
        c = HomeownerContact(firstName: "Tia", lastName: "Bell", phone: "(501) 555-0177", email: "tia.bell@example.com", zip: "72205", contactConsent: true, textConsent: false)
        ctx.equal(ContactValidation.errors(c), [:])
        c.contactConsent = false
        ctx.equal(Set(ContactValidation.errors(c).keys), [.consent], "texts are optional, calls and email are not")
        c.contactConsent = true
        c.email = "tia.bell@example"
        ctx.expect(ContactValidation.errors(c)[.email] != nil)
        for bad in ["", "a@b", "a b@c.com", "@x.com", "a@@x.com", "a@x.", "tia@.com"] { ctx.expect(!ContactValidation.isEmail(bad), "'\(bad)' is not an email") }
        for good in ["a@b.co", "tia.bell+rr@example.com"] { ctx.expect(ContactValidation.isEmail(good), "'\(good)' is an email") }
        ctx.expect(ContactValidation.isZip("72205") && ContactValidation.isZip("72205-1234"))
        for bad in ["7220", "722055", "7220a", "", "72205-12"] { ctx.expect(!ContactValidation.isZip(bad), "'\(bad)' is not a ZIP") }
        let prepared = ContactValidation.prepared(HomeownerContact(firstName: " Tia ", lastName: "Bell ", phone: "501.555.0177", email: " tia@x.com ", zip: "72205-1234", contactConsent: true))
        ctx.equal(prepared.firstName, "Tia")
        ctx.equal(prepared.zip, "72205")
        ctx.equal(prepared.phone, "(501) 555-0177")
        ctx.equal(prepared.email, "tia@x.com")
    },
    Check("PhoneFormat: ten US digits, typed any way, shown as (501) 555-0177") { ctx in
        ctx.equal(PhoneFormat.digits("(501) 555-0177"), "5015550177")
        ctx.equal(PhoneFormat.digits("+1 501 555 0177"), "5015550177")
        ctx.equal(PhoneFormat.digits("501.555.0177"), "5015550177")
        ctx.expect(PhoneFormat.digits("555-0177") == nil)
        ctx.expect(PhoneFormat.digits("(101) 555-0177") == nil, "an area code cannot start with 1")
        ctx.expect(PhoneFormat.digits("(501) 155-0177") == nil, "an exchange cannot start with 1")
        ctx.equal(PhoneFormat.display("5015550177"), "(501) 555-0177")
        ctx.equal(PhoneFormat.progressive("5"), "(5")
        ctx.equal(PhoneFormat.progressive("501"), "(501) ")
        ctx.equal(PhoneFormat.progressive("5015"), "(501) 5")
        ctx.equal(PhoneFormat.progressive("5015550"), "(501) 555-0")
        ctx.equal(PhoneFormat.progressive("501555017799"), "(501) 555-0177", "at most ten digits")
        ctx.equal(PhoneFormat.progressive(""), "")
    },
    Check("VisitTimes: days and times in the company's time zone, in the mockup's words") { ctx in
        let zone = TimeZone(identifier: "America/Chicago")!
        let d = VisitTimes.parse("2026-10-20T12:30:00-05:00")!
        ctx.equal(VisitTimes.clock(d, zone), "12:30")
        ctx.equal(VisitTimes.clockWithPeriod(d, zone), "12:30 PM")
        ctx.equal(VisitTimes.weekdayShort(d, zone), "Tue")
        ctx.equal(VisitTimes.weekdayLong(d, zone), "Tuesday")
        ctx.equal(VisitTimes.dayNumber(d, zone), "20")
        ctx.equal(VisitTimes.monthShortCaps(d, zone), "OCT")
        ctx.equal(VisitTimes.bookButton(d, zone), "Book Tue, Oct 20 at 12:30")
        ctx.equal(VisitTimes.confirmation(d, zone), "Tuesday, 12:30 PM")
        // The same moment read in Pacific time is still the company's 12:30 when the company's zone is given
        ctx.equal(VisitTimes.clock(VisitTimes.parse("2026-10-20T17:30:00Z")!, zone), "12:30")
        ctx.expect(VisitTimes.parse("2026-10-20T17:30:00.000Z") != nil, "fractional seconds read too")
        ctx.expect(VisitTimes.parse("soon") == nil)
        let slots = ["2026-10-21T16:00:00-05:00", "2026-10-20T12:30:00-05:00", "2026-10-20T09:00:00-05:00", "2026-10-19T09:00:00-05:00", "nope"].map { HomeownerSlot(start: $0) }
        let days = VisitTimes.days(slots, timeZone: zone)
        ctx.equal(days.map { $0.id }, ["2026-10-19", "2026-10-20", "2026-10-21"], "days in order, a slot that does not read is dropped")
        ctx.equal(days[1].slots.map { VisitTimes.clock(VisitTimes.parse($0.start)!, zone) }, ["9:00", "12:30"], "times in order within a day")
        // A late slot belongs to the company's day, not the phone's
        let late = VisitTimes.days([HomeownerSlot(start: "2026-10-21T02:00:00Z")], timeZone: zone)
        ctx.equal(late.first?.id, "2026-10-20")
    },
    Check("RoomNames and StyleGuess: rooms the homeowner names, styles the app suggests") { ctx in
        ctx.equal(RoomNames.seed, ["Kitchen", "Living room", "Bedroom 1"])
        ctx.equal(RoomNames.suggestions(excluding: RoomNames.seed), ["Bedroom 2", "Bathroom", "Hall"])
        ctx.equal(RoomNames.suggestions(excluding: ["Bedroom 2", "bathroom"], limit: 2), ["Hall", "Dining room"])
        ctx.equal(RoomNames.clean("  den   upstairs "), "den upstairs")
        ctx.expect(RoomNames.clean("   ") == nil)
        ctx.equal(RoomNames.clean(String(repeating: "a", count: 60))?.count, 40)
        ctx.equal(RoomNames.type(of: "Bedroom 2"), .bedroom)
        ctx.equal(RoomNames.type(of: "Master bath"), .bathroom)
        ctx.equal(RoomNames.type(of: "Master"), .bedroom)
        ctx.equal(RoomNames.type(of: "Kitchen"), .kitchen)
        ctx.equal(RoomNames.type(of: "Family room"), .livingRoom)
        ctx.equal(RoomNames.type(of: "Dining room"), .dining)
        ctx.equal(RoomNames.type(of: "Garden shed"), .other, "'den' inside a word is not a den")
        ctx.equal(RoomNames.room(for: .bedroom, current: "Bedroom 2", existing: ["Kitchen", "Bedroom 2"]), "Bedroom 2")
        ctx.equal(RoomNames.room(for: .kitchen, current: "Bedroom 2", existing: ["Kitchen", "Bedroom 2"]), "Kitchen")
        ctx.equal(RoomNames.room(for: .hall, current: "Bedroom 2", existing: ["Kitchen"]), "Hall")
        ctx.equal(RoomNames.room(for: .bedroom, current: "Kitchen", existing: ["Kitchen"]), "Bedroom 1")
        ctx.equal(RoomNames.nextNumbered("Bedroom", existing: ["Bedroom 1", "bedroom 2"]), "Bedroom 3")
        let offered = StyleGuess.knownKeys
        let wide = StyleGuess.suggestion(widthIn: 71.25, heightIn: 59.375, offered: offered)
        ctx.equal(wide.keys, ["slider-2", "picture", "slider-3"])
        ctx.equal(wide.hint, "wide, so most homes use a slider or picture")
        ctx.equal(StyleGuess.suggestion(widthIn: 35.625, heightIn: 59.625, offered: offered).keys.first, "double-hung")
        ctx.equal(StyleGuess.suggestion(widthIn: 36, heightIn: 36, offered: offered).keys.first, "double-hung")
        ctx.equal(StyleGuess.suggestion(widthIn: 71, heightIn: 59, offered: ["picture", "arch"]).keys, ["picture"], "only styles the company offers")
        ctx.equal(StyleGuess.suggestion(widthIn: 71, heightIn: 59, offered: ["arch"]).keys, ["arch"], "nothing likely offered: the company's first")
    },
    Check("Homeowner API: four plain style choices, the company's catalog and trust, tier names and notes, bathroom windows") { ctx in
        let company = try JSONDecoder().decode(HomeownerCompany.self, from: Data("""
        { "apiVersion": 1, "name": "WinChoice (demo)",
          "windowStyles": [
            { "key": "double-hung", "label": "Opens up and down", "hint": "Double-hung", "tile": "up-down", "atVisit": false },
            { "key": "arch", "label": "Bay, bow or odd shape", "hint": "We quote it at your visit", "tile": "special", "atVisit": true } ],
          "trust": { "rating": { "value": 4.9, "count": 2400, "plus": true, "source": "homeowners" }, "sinceYear": 2012,
                     "license": { "state": "ne", "number": "#48213" }, "badges": ["A+ BBB", "Made in USA", "Lifetime warranty", "A fourth"] },
          "catalog": { "tiers": [ { "key": "good", "label": "Replenish", "note": "1-year warranty" }, { "bad": 1 } ],
                       "included": ["Argon gas fill", "FlexScreen", ""],
                       "offer": { "title": "October special", "termsUrl": "https://winchoice.com/promotional-terms-conditions/" },
                       "financing": { "text": "Financing available.", "url": null } } }
        """.utf8))
        ctx.equal(company.windowStyles.map { $0.label }, ["Opens up and down", "Bay, bow or odd shape"])
        ctx.equal(company.windowStyles[0].hint, "Double-hung")
        ctx.equal(company.windowStyles[1].atVisit, true)
        ctx.equal(company.windowStyles[0].tile, "up-down")
        ctx.equal(company.trust?.rating?.line, "4.9 from 2,400+ homeowners")
        ctx.equal(company.trust?.since, "2012")
        ctx.equal(company.trust?.license, "NE #48213")
        ctx.equal(company.trust?.badges, ["A+ BBB", "Made in USA", "Lifetime warranty"], "up to three badges")
        ctx.equal(HomeownerRating(value: 4.8, count: 212, source: "Google").line, "4.8 from 212 Google reviews", "a source that is only a name gets 'reviews'")
        ctx.equal(HomeownerRating(value: 4.8, count: 150, source: "Google reviews").caption, "150 Google reviews")
        ctx.equal(company.catalog.tiers, [HomeownerCatalogTier(key: "good", label: "Replenish", note: "1-year warranty")], "a bad item in the list is skipped")
        ctx.equal(company.catalog.tier("good")?.label, "Replenish")
        ctx.equal(company.catalog.included, ["Argon gas fill", "FlexScreen"])
        ctx.equal(company.catalog.offer?.title, "October special")
        ctx.equal(company.catalog.financing?.url, nil)
        // An older server sends none of it
        let bare = try JSONDecoder().decode(HomeownerCompany.self, from: Data(#"{ "name": "X" }"#.utf8))
        ctx.expect(bare.catalog.tiers.isEmpty && bare.catalog.included.isEmpty && bare.catalog.offer == nil && bare.trust == nil)

        // The quote: the company's level name and note, and a window with no instant price
        let view = try JSONDecoder().decode(HomeownerQuote.self, from: Data("""
        { "tiers": [ { "key": "good", "label": "Replenish", "note": "1-year warranty", "name": "Economy vinyl series", "description": "d", "total": 1045,
                       "perWindow": [ { "windowId": "a", "price": 535 }, { "windowId": "b", "price": 0, "atVisit": true } ], "estimatedCount": 0, "estimatedTotal": 0 },
                     { "key": "best", "label": "Best", "name": "n", "description": "d", "total": 2000, "perWindow": [], "estimatedCount": 0, "estimatedTotal": 0 } ],
          "measuredCount": 2, "estimatedCount": 0, "atVisitCount": 1 }
        """.utf8))
        ctx.equal(view.tiers[0].label, "Replenish")
        ctx.equal(view.tiers[0].note, "1-year warranty")
        ctx.equal(view.tiers[1].note, "", "no note: empty")
        ctx.equal(view.tiers[0].perWindow.map { $0.atVisit }, [false, true])
        ctx.equal(view.atVisitCount, 1)

        // A bathroom window is sent as frosted: true, and only then
        let scale = WindowPhotoScale.card(CardScale(cardCorners: [Vec2(100, 100), Vec2(400, 100), Vec2(400, 290), Vec2(100, 290)]))
        var w = PhotoWindowInput(id: "w-1", uploadId: "u", label: nil, windowKey: nil, corners: [Vec2(0, 0), Vec2(10, 0), Vec2(10, 10), Vec2(0, 10)], scale: scale, room: "Bathroom", style: "double-hung")
        ctx.equal((try json(w))["frosted"] == nil, true, "clear glass: the key is left out")
        w.frosted = false
        ctx.equal((try json(w))["frosted"] == nil, true, "false is the same as absent")
        w.frosted = true
        ctx.equal((try json(w))["frosted"] as? Bool, true)
        let back = try JSONDecoder().decode(PhotoWindowInput.self, from: JSONEncoder().encode(w))
        ctx.equal(back.frosted, true)

        // With only the four plain choices, the shape's likeliest style is said in the company's own keys
        let plain = HomeownerStyleOption.plain.map { $0.key }
        ctx.equal(plain, ["double-hung", "slider-2", "picture", "arch"])
        ctx.equal(StyleGuess.suggestion(widthIn: 71.25, heightIn: 59.375, offered: plain).keys, ["slider-2", "picture"])
        ctx.equal(StyleGuess.suggestion(widthIn: 35.625, heightIn: 59.625, offered: plain).keys, ["double-hung"])
        ctx.equal(StyleGuess.suggestion(widthIn: 36, heightIn: 36, offered: plain).keys, ["double-hung"], "a square window is never guessed to be a bay or an odd shape")
        ctx.equal(StyleGuess.offeredKey(for: "slider-3", offered: plain), "slider-2")
        ctx.equal(StyleGuess.offeredKey(for: "casement", offered: plain), nil)
    },
]
