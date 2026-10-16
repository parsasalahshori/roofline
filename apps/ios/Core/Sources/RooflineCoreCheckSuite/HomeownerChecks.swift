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
        ctx.equal(pro.methodsSentence, "Your iPhone 15 Pro can use all three.")
        ctx.equal(pro.depthSentence, "Your iPhone 15 Pro has a depth sensor, so sizes come out accurate to about 1/8 inch.")
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
            scale: .card(CardScale(cardCorners: [Vec2(1, 2), Vec2(3, 2), Vec2(3, 4), Vec2(1, 4)])), room: "Kitchen", style: "slider")))
        ctx.equal(back.scale.kind, "card")
        ctx.equal(back.room, "Kitchen")
        ctx.equal(back.style, "slider")
    },
    Check("Homeowner API: the request view decodes, and a bad item is skipped, not fatal") { ctx in
        let view = try decodeView("""
        { "request": { "id": "r1", "status": "ready", "services": ["windows", "roof", "bogus"], "contactSubmitted": true,
                       "estimatedTotalOverride": 9, "home": { "address": "305 Ridgeway Dr, Little Rock, AR 72205", "floors": 1 },
                       "estimate": { "windows": { "low": 7, "high": 9, "likely": 8 }, "roof": { "low": 9800, "high": 12100, "squares": 23 }, "gutters": "at-visit" } },
          "windows": [
            { "id": "w1", "room": "Kitchen", "style": "double-hung", "uploadId": "u1", "corners": [[1,1],[9,1],[9,9],[1,9]],
              "scale": { "kind": "ar", "pointsM": [[0,1,-1],[1,1,-1],[1,0,-1],[0,0,-1]], "trackingLostCount": 0, "device": "arkit-lidar" },
              "widthIn": 35.625, "heightIn": 59.625, "uncertaintyIn": 0.125, "quality": "good", "reasons": [], "sizeLabel": "35 5/8 x 59 5/8" },
            { "id": "broken", "scale": { "kind": "ar" } },
            { "id": "w2", "room": "Hall", "style": "slider",
              "scale": { "kind": "roomplan", "widthM": 0.9, "heightM": 1.2, "confidence": "medium" },
              "widthIn": 35.4, "heightIn": 47.2, "uncertaintyIn": { "width": 1, "height": 1.5 }, "quality": "check", "reasons": ["a scan"] }
          ],
          "rooms": ["Kitchen", "Hall"],
          "quote": { "tiers": [
              { "key": "good", "label": "Good", "total": 4200, "perWindow": [ { "windowId": "w1", "price": 600 } ], "estimatedCount": 0, "estimatedTotal": 0 },
              { "key": "better", "label": "Better", "totalCents": 560000, "estimatedCount": 2, "estimatedTotalCents": 160000 } ],
            "measuredCount": 7, "estimatedCount": 0, "missingHint": "Homes like yours usually have 7 to 9." },
          "booking": { "slotStart": "2026-10-20T12:30:00-05:00", "slotEnd": "2026-10-20T13:00:00-05:00", "rep": { "name": "Casey Moreno", "city": "Little Rock" } },
          "status": { "stage": "visit-booked", "dates": { "visit-booked": "2026-10-16" }, "orderNumber": "24-1187" } }
        """)
        ctx.equal(view.request.services, [.windows, .roof], "an unknown service is dropped")
        ctx.expect(view.request.contacted)
        ctx.equal(view.request.estimatedTotalOverride, 9)
        ctx.equal(view.request.estimate?.windows?.likely, 8)
        ctx.near(view.request.estimate?.roof?.low, 9800)
        ctx.equal(view.request.estimate?.gutters, "at-visit")
        ctx.equal(view.windows.map { $0.id }, ["w1", "w2"], "the broken window is skipped")
        ctx.near(view.windows[0].uncertaintyIn, 0.125)
        ctx.near(view.windows[1].uncertaintyIn, 1.5, 1e-9, "{width, height} reads as the larger one")
        ctx.expect(view.windows[1].needsCheck && !view.windows[0].needsCheck)
        ctx.equal(view.windows[0].room, "Kitchen")
        ctx.equal(view.windows[0].sizeLabel, "35 5/8 x 59 5/8")
        ctx.equal(view.quote?.tiers.count, 2)
        ctx.near(view.quote?.tier("better")?.total, 5600, 1e-9, "cents read as dollars")
        ctx.equal(view.quote?.tier("better")?.estimatedCount, 2)
        ctx.near(view.quote?.tier("good")?.perWindow.first?.price, 600)
        ctx.equal(view.quote?.windowCount, 7)
        ctx.equal(view.booking?.isVisit, true)
        ctx.equal(view.booking?.rep?.area, "Little Rock", "city reads as the rep's area")
        ctx.equal(view.status?.stage, .visitBooked)
        ctx.equal(view.status?.orderNumber, "24-1187")
        // Nothing but an empty object still decodes (a newer or older server)
        let empty = try decodeView("{}")
        ctx.equal(empty.windows.count, 0)
        ctx.expect(empty.quote == nil && empty.booking == nil && empty.status == nil)
    },
    Check("Homeowner API: created request, company, slots and booking bodies") { ctx in
        let created = try JSONDecoder().decode(HomeownerCreated.self, from: Data("""
        { "requestId": "req-1", "token": "tok", "status": "callback", "callbackReason": "unit",
          "home": { "address": "2210 Leavenworth St, Little Rock, AR", "floors": 2, "photoUrl": "https://x/y.jpg" },
          "estimate": { "windows": null, "roof": null, "gutters": "at-visit" } }
        """.utf8))
        ctx.equal(created.status, .callback)
        ctx.equal(created.callbackReason, "unit")
        ctx.equal(created.home.floors, 2)
        ctx.expect(created.estimate.windows == nil && created.estimate.roof == nil)
        let body = try json(HomeownerCreateBody(address: "305 Ridgeway Dr", services: [.roof, .windows]))
        ctx.equal(body["services"] as? [String], ["windows", "roof"], "services are sent in the screen order")
        ctx.equal(Set(body.keys), ["address", "services"])

        let company = try JSONDecoder().decode(HomeownerCompany.self, from: Data("""
        { "name": "Summit Ridge", "brandColor": "#ED3A2B", "phone": "+15015550100", "services": ["roof", "windows", "gutters"],
          "privacyUrl": "https://p", "termsUrl": "https://t",
          "windowStyles": [ { "key": "double-hung", "label": "Double-hung" }, { "bad": 1 } ], "trust": { "reviews": 4.9, "since": 2004 } }
        """.utf8))
        ctx.equal(company.services, [.roof, .windows, .gutters])
        ctx.equal(company.windowStyles, [HomeownerStyleOption(key: "double-hung", label: "Double-hung")])
        ctx.equal(company.trust?.since, "2004", "a number the company typed reads as text")
        ctx.equal(company.trust?.reviews, "4.9")

        let slots = HomeownerSlots.decode(Data("""
        { "timeZone": "America/Chicago", "slots": [ { "id": "a", "start": "2026-10-20T12:30:00-05:00", "end": "2026-10-20T13:00:00-05:00" }, { "x": 1 } ] }
        """.utf8))
        ctx.equal(slots?.slots.count, 1)
        ctx.equal(slots?.timeZone, "America/Chicago")
        let bare = HomeownerSlots.decode(Data(#"[ { "start": "2026-10-21T09:00:00-05:00" } ]"#.utf8))
        ctx.equal(bare?.slots.first?.id, "2026-10-21T09:00:00-05:00", "no id: the start is the id")

        let slot = HomeownerSlot(id: "a", start: "2026-10-20T12:30:00-05:00")
        ctx.equal(Set(try json(HomeownerBookBody(.slot(slot))).keys), ["slotStart"])
        ctx.equal(Set(try json(HomeownerBookBody(.callMe(bestTime: "afternoon"))).keys), ["callMe"], "the best time is not sent unless the server takes it")
        ctx.equal(Set(try json(HomeownerBookBody(.callMe(bestTime: "afternoon"), sendBestTime: true)).keys), ["callMe", "bestTime"])
    },
    Check("HomeownerSession and errors") { ctx in
        let s = HomeownerSession(requestId: "r", token: "t", slug: "summit-ridge", address: "305 Ridgeway Dr", services: [.windows], createdAt: Date(timeIntervalSince1970: 1_000_000))
        ctx.expect(!s.isExpired(now: Date(timeIntervalSince1970: 1_000_000 + 59 * 86_400)))
        ctx.expect(s.isExpired(now: Date(timeIntervalSince1970: 1_000_000 + 61 * 86_400)), "tokens last 60 days")
        let back = try JSONDecoder().decode(HomeownerSession.self, from: JSONEncoder().encode(s))
        ctx.equal(back, s)
        ctx.expect(HomeownerAPIError(status: 401, message: "").isUnauthorized)
        ctx.expect(HomeownerAPIError(status: 410, message: "").isGone && HomeownerAPIError(status: 404, message: "").isGone)
        ctx.expect(HomeownerAPIError(status: nil, message: "offline").isNetwork)
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
        ctx.equal(ResumeRouter.target(saved: .quote, hasSession: true, snapshot: ResumeSnapshot(windowCount: 3, unstyledCount: 2)), .styles, "windows without a style cannot be priced")
        ctx.equal(ResumeRouter.target(saved: .book, hasSession: true, snapshot: measured), .contact, "no booking before contact details")
        ctx.equal(ResumeRouter.target(saved: .book, hasSession: true, snapshot: ResumeSnapshot(windowCount: 3, hasContact: true)), .book)
        // Roof and gutters only: results, then straight to contact and booking
        let roof = ResumeSnapshot(services: [.roof])
        ctx.equal(ResumeRouter.target(saved: .coaching, hasSession: true, snapshot: roof), .results, "no measuring tips without windows")
        ctx.equal(ResumeRouter.target(saved: .contact, hasSession: true, snapshot: roof), .contact)
        ctx.equal(ResumeRouter.target(saved: .book, hasSession: true, snapshot: ResumeSnapshot(services: [.roof, .gutters], hasContact: true)), .book)
    },
    Check("HomeownerFlow: the back stack that leads to a screen") { ctx in
        let w: Set<HomeownerService> = [.windows, .roof]
        ctx.equal(HomeownerFlow.path(to: .welcome, services: w), [])
        ctx.equal(HomeownerFlow.path(to: .results, services: w), [.address, .results])
        ctx.equal(HomeownerFlow.path(to: .rooms, services: w), [.address, .results, .coaching, .rooms])
        ctx.equal(HomeownerFlow.path(to: .list, services: w).last, .list)
        ctx.equal(HomeownerFlow.path(to: .quote, services: w), [.address, .results, .coaching, .rooms, .list, .quote])
        ctx.equal(HomeownerFlow.path(to: .book, services: w).suffix(3), [.quote, .contact, .book])
        ctx.equal(HomeownerFlow.path(to: .contact, services: [.roof]), [.address, .results, .contact], "roof only skips the measuring")
        ctx.equal(HomeownerFlow.path(to: .status, services: w), [], "My order has no back stack")
        ctx.equal(HomeownerFlow.afterResults(services: [.windows]), .coaching)
        ctx.equal(HomeownerFlow.afterResults(services: [.roof, .gutters]), .contact)
        ctx.equal(HomeownerFlow.progressDots(.address), 1)
        ctx.equal(HomeownerFlow.progressDots(.results), 2)
        ctx.equal(HomeownerFlow.progressDots(.coaching), 2)
        ctx.equal(HomeownerFlow.progressDots(.list), 0)
        ctx.expect(HomeownerStep.booked.isTerminal && HomeownerStep.status.isTerminal && !HomeownerStep.list.isTerminal)
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
        for code in ["unit", "not-rooftop", "street-changed", "roof-review", "too-big", "flat-unmeasured", nil, "something-new"] {
            let r = CallbackCopy.reason(code)
            ctx.expect(!r.lead.isEmpty && !r.rest.isEmpty)
            ctx.expect(!(r.lead + r.rest).lowercased().contains("error"), "a call-back is not an error")
        }
        ctx.equal(CallbackCopy.button(bestTime: "afternoon"), "Call me this afternoon")
        ctx.equal(CallbackCopy.button(bestTime: nil), "Call me")
        ctx.equal(OrderTimeline.headline(.ordered), "Being built")
        ctx.equal(OrderTimeline.subhead(.ordered), "Your windows are on the line in Mountain Pine, Arkansas.")
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
        ctx.equal(RoomNames.seed, ["Living room", "Kitchen", "Bedroom 1"])
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
        let offered = ["double-hung", "single-hung", "slider", "picture", "casement-awning", "bay-bow"]
        let wide = StyleGuess.suggestion(widthIn: 71.25, heightIn: 59.375, offered: offered)
        ctx.equal(wide.keys, ["slider", "picture"])
        ctx.equal(wide.hint, "wide, so most homes use a slider or picture")
        ctx.equal(StyleGuess.suggestion(widthIn: 35.625, heightIn: 59.625, offered: offered).keys.first, "double-hung")
        ctx.equal(StyleGuess.suggestion(widthIn: 36, heightIn: 36, offered: offered).keys.first, "double-hung")
        ctx.equal(StyleGuess.suggestion(widthIn: 71, heightIn: 59, offered: ["picture", "bay-bow"]).keys, ["picture"], "only styles the company offers")
        ctx.equal(StyleGuess.suggestion(widthIn: 71, heightIn: 59, offered: ["bay-bow"]).keys, ["bay-bow"], "nothing likely offered: the company's first")
    },
]
