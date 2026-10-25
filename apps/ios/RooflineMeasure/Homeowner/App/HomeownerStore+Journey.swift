import Foundation
import RooflineCore
import SwiftUI

// The journey's actions: pick services, confirm the address, the contact form, the visit. Every call to the server in
// the app goes through the store, so each screen only says what the homeowner did.

extension HomeownerStore {
    // MARK: Welcome (01)

    /// The services the company offers a homeowner, in its order (windows and roof until the company answers; never gutters).
    var offeredServices: [HomeownerService] {
        let offered = company.services.isEmpty ? HomeownerService.allCases : company.services
        return HomeownerService.offered(offered)
    }

    func toggle(_ service: HomeownerService) {
        if selectedServices.contains(service) { selectedServices.remove(service) } else { selectedServices.insert(service) }
    }

    /// Welcome -> Measure: what to measure comes next.
    func startMeasuring() {
        push(.service)
        if !companyLoaded { Task { await loadCompany() } }
    }

    /// Windows or roof: one service per request, then the address.
    func chooseService(_ service: HomeownerService) {
        selectedServices = [service]
        continueFromWelcome()
    }

    /// On to the address with the services picked (the windows-or-roof screen; tests set several at once).
    func continueFromWelcome() {
        guard !selectedServices.isEmpty else { return }
        // Only what the company offers goes on
        selectedServices.formIntersection(Set(offeredServices))
        guard !selectedServices.isEmpty else { return }
        push(.address)
        if !companyLoaded { Task { await loadCompany() } }
    }

    // MARK: Tester server

    /// The tester saved a new server or company: the live client switches at once. A request made for another company is dropped.
    func applyServerSettings() async {
        guard let live = api as? ServerSwitchAPI else { return }
        let brand = self.brand
        guard let url = AppEnvironment.serverURL(brand: brand) else { return }
        let slug = AppEnvironment.slug(brand: brand)
        live.swap(baseURL: url, slug: slug)
        if let s = session, s.slug != slug { forgetRequest(message: "Switched to another company. Start a new request.") }
        addressError = nil
        await loadCompany()
    }

    /// Windows kept on the phone from a request the server forgot join the new one (sent again from the photo up).
    func adoptKeptWindows(into s: HomeownerSession) async {
        let items = await outbox.items
        let olds = Set(items.map { $0.measurementId }).subtracting([s.requestId])
        var moved = 0
        for old in olds {
            moved += (try? await outbox.reassign(from: old, to: s.requestId, address: s.address)) ?? 0
            _ = try? await scanOutbox.reassign(from: old, to: s.requestId)
        }
        pendingDisk.adopt(into: s.requestId)
        guard moved > 0 || pendingDisk.load(requestId: s.requestId) != nil else { return }
        for item in await outbox.items where item.measurementId == s.requestId { _ = addRoom(item.window.room ?? "") }
        outboxItems = await outbox.items
        Task { await outbox.syncAll() }
    }

    // MARK: Address (02)

    /// The address can always be changed. A new address (or a different choice of services) starts a new request; the only
    /// thing that needs a yes first is dropping windows already measured at the old address.
    var addressLocked: Bool { false }

    /// The request in hand is for exactly this address and these services, so going forward reuses it.
    private func sessionMatches(_ text: String) -> Bool {
        guard let s = session else { return false }
        return s.address.caseInsensitiveCompare(text) == .orderedSame && Set(s.services) == selectedServices
    }

    /// The homeowner said yes to starting over at a new address (their measured windows stay with the old one).
    func confirmAddressChange() async {
        pendingAddressChange = nil
        await confirmAddress(startOver: true)
    }

    func confirmAddress(startOver: Bool = false) async {
        guard !creating else { return }
        let text = (addressPlace?.oneLine ?? addressText).trimmingCharacters(in: .whitespaces)
        guard text.count >= 5 else {
            addressError = "Please enter your street address."
            return
        }
        // The same address and services again (back, then forward): carry on with the request in hand
        if sessionMatches(text) {
            push(requestStatus == .callback ? .callback : .results)
            return
        }
        // A new address after windows were measured: ask first, they belong to the old address
        if session != nil && windowCount > 0 && !startOver {
            pendingAddressChange = text
            return
        }
        creating = true
        addressError = nil
        defer { creating = false }
        do {
            let created = try await api.createRequest(address: text, services: Array(selectedServices))
            let saved = HomeownerSession(
                requestId: created.requestId, token: created.token, slug: AppEnvironment.slug(brand: brand),
                address: created.home.address.isEmpty ? text : created.home.address,
                services: created.services.isEmpty ? Array(selectedServices).sorted() : created.services, createdAt: now(), expiresAt: created.expiresAt
            )
            do {
                try vault.save(saved)
            } catch {
                // Without the token the request cannot be reopened later: say so, but let them carry on this once
                notice = Notice(text: "Your phone wouldn't save this request for later. You can still finish it now.", kind: .info)
            }
            if let old = session, old.requestId != saved.requestId {
                progressStore.clear(requestId: old.requestId)
                Task { try? await outbox.removeAll(measurementId: old.requestId); try? await scanOutbox.removeAll(measurementId: old.requestId) }
            }
            setSession(saved)
            selectedServices = Set(saved.services)
            view = nil
            home = created.home
            estimate = created.estimate
            callbackReason = created.callbackReason
            requestStatus = created.status
            progress = HomeownerProgress()
            await adoptKeptWindows(into: saved)
            status = nil
            slots = nil
            // The name and phone stay filled in: it is the same person, only the house changed
            progress.perimeterFt = created.home.outline.flatMap { RoofOutline.perimeterFeet($0) }
            if created.status == .callback {
                push(.callback)
            } else {
                push(.results)
            }
            saveProgress()
        } catch let e as HomeownerAPIError {
            addressError = e.message
        } catch {
            addressError = LiveHomeownerAPI.offlineMessage
        }
    }

    // MARK: Results (03) and the call-back branch (03b)

    func continueFromResults() {
        push(HomeownerFlow.afterResults(services: services))
    }

    /// 03b: the phone number goes on to the contact form, which the server needs before anyone can call.
    func continueFromCallback(phone: String) {
        contactDraft.phone = phone
        push(.contact)
    }

    // MARK: Contact (12)

    var consent: HomeownerConsent? { company.consent }

    func prepareContact() async {
        if company.consent == nil { await loadCompany() }
    }

    func clearContactError(_ field: ContactField) {
        contactErrors[field] = nil
        contactError = nil
    }

    func submitContact() async {
        guard let s = session, !sendingContact else { return }
        var draft = contactDraft
        guard let consent = company.consent else {
            contactError = "We couldn't load our consent wording. Check your connection and try again."
            await loadCompany()
            return
        }
        draft.consentVersion = consent.version
        contactErrors = ContactValidation.errors(draft)
        guard contactErrors.isEmpty else {
            Haptics.warning()
            return
        }
        sendingContact = true
        contactError = nil
        defer { sendingContact = false }
        do {
            var v = try await api.fileContact(s, contact: ContactValidation.prepared(draft))
            accept(v)
            if requestStatus == .callback {
                v = try await api.book(s, choice: .callMe(bestTime: bestTime))
                accept(v)
                Haptics.success()
                root = .callbackSent
                path = []
                noteStep(.callbackSent)
            } else {
                push(.book)
                Task { await loadSlots() }
            }
        } catch let e as HomeownerAPIError {
            if e.isConsentChanged {
                await loadCompany()
                contactError = e.message
            } else if let f = e.field, let field = Self.contactField(f) {
                contactErrors[field] = e.message
            } else if e.isUnauthorized || e.isGone {
                forgetRequest(message: e.message)
            } else {
                contactError = e.message
            }
        } catch {
            contactError = LiveHomeownerAPI.offlineMessage
        }
    }

    static func contactField(_ name: String) -> ContactField? {
        switch name {
        case "contactConsent", "consent", "textConsent": return .consent
        default: return ContactField(rawValue: name)
        }
    }

    // MARK: Visit (13, 14)

    /// The visit times, grouped by day in the company's time zone.
    var visitDays: [VisitTimes.Day] {
        VisitTimes.days(slots?.slots ?? [], timeZone: timeZone)
    }

    func loadSlots() async {
        guard let s = session else { return }
        loadingSlots = true
        bookError = nil
        defer { loadingSlots = false }
        do {
            slots = try await api.slots(s)
            if let picked = pickedSlot, slots?.slots.contains(where: { $0.start == picked.start }) != true { pickedSlot = nil }
            if pickedSlot == nil { pickedSlot = slots?.slots.first }
        } catch let e as HomeownerAPIError {
            bookError = e.message
        } catch {
            bookError = LiveHomeownerAPI.offlineMessage
        }
    }

    func bookPicked() async {
        guard let s = session, let slot = pickedSlot, !booking else { return }
        booking = true
        bookError = nil
        defer { booking = false }
        do {
            let v = try await api.book(s, choice: .slot(slot))
            accept(v)
            Haptics.success()
            root = .booked
            path = []
            noteStep(.booked)
            await loadStatus()
        } catch let e as HomeownerAPIError {
            if e.isSlotTaken {
                // Fetch the times again (it clears the message), then say what happened: the picked time is gone
                await loadSlots()
            }
            bookError = e.message
        } catch {
            bookError = LiveHomeownerAPI.offlineMessage
        }
    }

    /// "Call me to pick a time".
    func askForCall() async {
        guard let s = session, !booking else { return }
        booking = true
        bookError = nil
        defer { booking = false }
        do {
            let v = try await api.book(s, choice: .callMe(bestTime: bestTime))
            accept(v)
            Haptics.success()
            root = .callbackSent
            path = []
            noteStep(.callbackSent)
        } catch let e as HomeownerAPIError {
            bookError = e.message
        } catch {
            bookError = LiveHomeownerAPI.offlineMessage
        }
    }

    func loadStatus() async {
        guard let s = session else { return }
        if let st = try? await api.status(s) {
            status = st
            offline = false
        }
    }

    func showStatus() {
        root = .status
        path = []
        noteStep(.status)
        Task { await loadStatus() }
    }

    // MARK: What the screens say

    /// The booking's start as a date, when a visit is booked.
    var visitStart: Date? { view?.booking?.slotStart.flatMap(VisitTimes.parse) }
    var visitEnd: Date? { view?.booking?.slotEnd.flatMap(VisitTimes.parse) }

    /// The rep's first name, once one is on the visit.
    var repName: String? { status?.rep?.name ?? view?.status?.rep?.name }

    var quoteTotalForSelectedTier: Double? { quote?.tier(selectedTier)?.total }
}

/// The roof outline's length around, in feet, from its ring of longitude/latitude points ("about 128 ft of outside wall").
enum RoofOutline {
    static func perimeterFeet(_ outline: HomeownerOutline) -> Int? {
        let pts = outline.points
        guard pts.count >= 3 else { return nil }
        var metres = 0.0
        for i in 0..<pts.count {
            let a = pts[i], b = pts[(i + 1) % pts.count]
            metres += distance(a, b)
        }
        let feet = metres * 3.28084
        // To the nearest 5 ft: "about" means it
        return Int((feet / 5).rounded() * 5)
    }

    private static func distance(_ a: (lon: Double, lat: Double), _ b: (lon: Double, lat: Double)) -> Double {
        let r = 6_371_000.0
        let dLat = (b.lat - a.lat) * .pi / 180
        let dLon = (b.lon - a.lon) * .pi / 180
        let lat1 = a.lat * .pi / 180, lat2 = b.lat * .pi / 180
        let h = sin(dLat / 2) * sin(dLat / 2) + cos(lat1) * cos(lat2) * sin(dLon / 2) * sin(dLon / 2)
        return 2 * r * asin(min(1, h.squareRoot()))
    }
}
