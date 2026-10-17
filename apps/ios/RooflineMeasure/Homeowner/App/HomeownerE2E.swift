#if DEBUG
import Foundation
import RooflineCore
import UIKit

/// `-debugServer <url> -debugE2E`: walks the whole journey against the server the app is pointed at, with synthetic windows (a
/// drawn window, no camera), and prints what each step got ("E2E ..." lines on stdout). It is the way to try the app against the
/// real API without a camera or a person: the same store calls the screens make, the real HTTP, the real Keychain. The request it
/// makes stays saved (where the Keychain allows), so the next launch opens on it (use `-debugGo list|styles|quote|contact|book|status`
/// to look at a screen). With `-debugE2EPause <seconds>` it holds each main screen that long and prints "E2E show <screen>" when it
/// is up, so a script can take a screenshot of the app running on the real server's data.
enum HomeownerE2E {
    @MainActor
    static func run(store: HomeownerStore, address: String, services: Set<HomeownerService> = [.windows, .roof], pause: Double = 0) async {
        func say(_ line: String) { fputs("E2E \(line)\n", stderr) }
        func beat(_ screen: String) async {
            guard pause > 0 else { return }
            say("show \(screen)")
            try? await Task.sleep(nanoseconds: UInt64(pause * 1_000_000_000))
        }
        func rows() -> String { store.windowRows.map { "\($0.number):\($0.room):\($0.sizeText):\(describe($0.send))" }.joined(separator: " | ") }
        func describe(_ s: WindowRow.Send) -> String {
            switch s {
            case .sent: return "sent"
            case .sending: return "sending"
            case .waiting: return "waiting"
            case .needsStyle: return "needsStyle"
            case .failed(let m): return "failed(\(m))"
            }
        }

        say("start \(address)")
        store.selectedServices = services
        store.addressText = address
        await store.loadCompany()
        say("company name=\(store.company.name) services=\(store.company.services.map { $0.rawValue }) booking=\(store.company.booking) consent=\(store.company.consent?.version ?? "none") styles=\(store.company.windowStyles.count) phone=\(store.company.phone ?? "none")")
        await store.confirmAddress()
        guard let session = store.session else {
            say("FAIL no request: \(store.addressError ?? "unknown")")
            return
        }
        say("keychain saved=\(store.vault.load() != nil) notice=\(store.notice?.text ?? "none")")
        say("request \(session.requestId) status=\(store.requestStatus.rawValue) reason=\(store.callbackReason ?? "-") address=\(store.address)")
        await beat("results")
        say("estimate windows=\(store.windowEstimate.map { "\($0.low)-\($0.high) likely \($0.likely)" } ?? "none") roof=\(store.roofEstimate.map { "$\($0.low)-\($0.high) \($0.squares.map { String($0) } ?? "?") sq" } ?? "none") roofNote=\(store.roofNote?.reason ?? "none") floors=\(store.home?.floors.map { String($0) } ?? "nil") outline=\(store.home?.outline == nil ? "none" : "yes")")
        let contact = HomeownerContact(firstName: "Alex", lastName: "Rivera", phone: "(402) 555-0147", email: "alex@example.com", zip: "68132", contactConsent: true, textConsent: false)
        guard store.requestStatus == .ready else {
            // The call-back branch: the phone number, then the contact form, then "we will call"
            store.continueFromCallback(phone: contact.phone)
            store.contactDraft = contact
            await store.prepareContact()
            await store.submitContact()
            say("call-back path: root=\(store.root) error=\(store.contactError ?? "none") booking=\(store.view?.booking.map { "callMe=\($0.callMe)" } ?? "none") done")
            return
        }
        guard services.contains(.windows) else {
            // Roof only: no windows, straight to the contact form and the visit
            store.continueFromResults()
            store.contactDraft = contact
            await store.prepareContact()
            await store.submitContact()
            await store.loadSlots()
            store.pickedSlot = store.slots?.slots.first
            await store.bookPicked()
            await store.loadStatus()
            say("roof-only path: path=\(store.path) root=\(store.root) stage=\(store.status?.stage.rawValue ?? "none") done")
            return
        }

        // Three windows by the three methods, from one drawn photo
        let scene = SampleScene.photo
        let plain = PhotoPreparation.prepare(scene.image(withCard: false))
        let withCard = PhotoPreparation.prepare(scene.image(withCard: true))
        guard let plainPhoto = plain, let cardPhoto = withCard else {
            say("FAIL the sample photo could not be made")
            return
        }
        let corners = scene.frameCorners.map { Vec2(Double($0.x), Double($0.y)) }
        let w = SampleScene.widthIn / inchesPerMetre, h = SampleScene.heightIn / inchesPerMetre
        let arScale = WindowPhotoScale.ar(ArScale(pointsM: [Vec3(0, h, -1.5), Vec3(w, h, -1.5), Vec3(w, 0, -1.5), Vec3(0, 0, -1.5)], trackingLostCount: 0, device: .arkitLidar, cornerSpreadM: [0.001, 0.001, 0.001, 0.001]))
        let cardCorners = CardSizing.cardCornersForAPI(scene.cardCorners.map { Vec2(Double($0.x), Double($0.y)) }) ?? []

        func save(_ method: MeasureMethod, room: String, name: String, scale: WindowPhotoScale, corners: [Vec2]?, photo: PreparedPhoto?) async {
            let measure = MeasureSession(method: method, room: room, number: store.nextWindowNumber)
            store.capture(scale: scale, corners: corners, jpeg: photo?.jpeg, widthPx: photo?.widthPx ?? 0, heightPx: photo?.heightPx ?? 0, focal35mm: photo?.focal35mm, in: measure)
            say("preview \(room) \(store.pending?.preview.map { "\(SizeWording.sizeText(widthIn: $0.widthIn, heightIn: $0.heightIn)) u=\($0.uncertaintyIn ?? -1) check=\($0.needsCheck) showable=\($0.isShowable)" } ?? "none")")
            await store.savePending(room: room, name: name)
        }
        await save(.corners, room: "Kitchen", name: "Over the sink", scale: arScale, corners: corners, photo: plainPhoto)
        await save(.card, room: "Bedroom 1", name: "", scale: .card(CardScale(cardCorners: cardCorners)), corners: corners, photo: cardPhoto)
        await save(.roomScan, room: "Living room", name: "", scale: .roomplan(RoomPlanScale(widthM: 1.8, heightM: 1.2, confidence: .medium)), corners: nil, photo: nil)
        await store.outbox.syncAll()
        await store.refresh()
        say("windows after save (held for style): \(rows())")

        // A window the server cannot size: its sentence must reach the list
        let crossed = [Vec2(100, 100), Vec2(900, 900), Vec2(900, 100), Vec2(100, 900)]
        await save(.card, room: "Hall", name: "Mistap", scale: .card(CardScale(cardCorners: cardCorners)), corners: crossed, photo: cardPhoto)
        if let id = store.windowRows.last?.id { await store.setStyle("picture", for: id) }
        await store.outbox.syncAll()
        store.outboxChanged(await store.outbox.items)
        say("a refused window: \(rows())")
        await beat("list-refused")
        if let bad = store.windowRows.last(where: { if case .failed = $0.send { return true } else { return false } }) {
            await store.removeWindow(bad.id)
        }

        store.showList()
        await store.refresh()
        await beat("list")

        // Styles: everything released, then the quote
        let kinds: [String: String] = ["Kitchen": "double-hung", "Bedroom 1": "slider-2", "Living room": "picture"]
        for row in store.windowRows { await store.setStyle(kinds[row.room] ?? "double-hung", for: row.id) }
        await store.outbox.syncAll()
        await store.finishStyles()
        say("windows after styles: \(rows())")
        await beat("quote")
        if let q = store.quote {
            say("quote measured=\(q.measuredCount) estimated=\(q.estimatedCount) tiers=\(q.tiers.map { "\($0.key):\(Int($0.total))" }) hint=\(q.missingHint?.text ?? "none")")
        } else {
            say("FAIL no quote")
        }
        await store.setTotalWindows(18)
        say("after 'I have 18': estimated=\(store.quote?.estimatedCount ?? -1) hint=\(store.quote?.missingHint?.text ?? "none")")

        // Contact, visit, status
        store.contactDraft = contact
        await store.prepareContact()
        store.bookFromQuote()
        await beat("contact")
        await store.submitContact()
        say("contact filed=\(store.hasContact) error=\(store.contactError ?? "none") errors=\(store.contactErrors.keys.map { $0.rawValue })")
        await store.loadSlots()
        await beat("book")
        say("slots \(store.slots?.slots.count ?? 0) zone=\(store.slots?.timeZone ?? "?") first=\(store.slots?.slots.first?.start ?? "none")")
        store.pickedSlot = store.slots?.slots.first
        await store.bookPicked()
        await beat("booked")
        say("booked root=\(store.root) visit=\(store.visitStart.map { "\($0)" } ?? "none") error=\(store.bookError ?? "none")")
        await store.loadStatus()
        store.showStatus()
        await beat("status")
        say("status stage=\(store.status?.stage.rawValue ?? "none") rep=\(store.repName ?? "none") dates=\(store.status?.dates ?? [:])")
        say("done")
    }
}
#endif
