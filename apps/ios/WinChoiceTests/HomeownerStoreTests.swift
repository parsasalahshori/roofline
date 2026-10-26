import Foundation
import RooflineCore
import XCTest
@testable import WinChoice

/// The homeowner journey as the screens drive it: request, windows, styles, quote, contact, visit, resume.
@MainActor
final class HomeownerStoreTests: XCTestCase {
    // MARK: Request

    func testNewRequestIsSavedAndTheResultsAreShown() async throws {
        let h = StoreHarness()
        await h.store.loadCompany()
        h.store.addressText = "305 Ridgeway Dr, Little Rock, AR 72205"
        h.store.startMeasuring()
        XCTAssertEqual(h.store.path.last, .step(.address), "Measure goes straight to the address: windows are the only thing to measure")
        await h.store.confirmAddress()
        let saved = try XCTUnwrap(h.store.session)
        XCTAssertEqual(h.vault.load()?.requestId, saved.requestId, "the request id and token are kept for the next launch")
        XCTAssertEqual(h.store.path.last, .step(.results))
        XCTAssertEqual(h.store.requestStatus, .ready)
        XCTAssertNotNil(h.store.windowEstimate)
        XCTAssertNotNil(h.store.home?.outline, "the home's outline for the map")
        XCTAssertEqual(h.store.services, [.windows])
    }

    func testAnApartmentGoesToTheCallBackBranchAndOnePhoneNumberIsEnough() async throws {
        let h = StoreHarness()
        await h.store.loadCompany()
        h.store.selectedServices = [.windows]
        h.store.addressText = "2210 Leavenworth St Apt 5, Little Rock, AR"
        h.store.startMeasuring()
        await h.store.confirmAddress()
        XCTAssertEqual(h.store.requestStatus, .callback)
        XCTAssertEqual(h.store.path.last, .step(.callback))
        h.store.continueFromCallback(phone: "(501) 555-0142")
        XCTAssertEqual(h.store.path.last, .step(.contact))
        XCTAssertEqual(h.store.contactDraft.phone, "(501) 555-0142", "the number typed on the call-back screen is not asked for again")
        h.store.contactDraft = HomeownerContact(firstName: "Tia", lastName: "Bell", phone: "(501) 555-0142", email: "tia@example.com", zip: "72205", contactConsent: true)
        await h.store.prepareContact()
        await h.store.submitContact()
        XCTAssertEqual(h.store.root, .callbackSent)
        let calls = await h.fake.calls()
        XCTAssertTrue(calls.contains("POST contact") && calls.contains("POST book"), "the details, then the ask to call: \(calls)")
        XCTAssertEqual(h.store.view?.booking?.callMe, true)
    }

    func testTheSameAddressAgainKeepsTheRequestInHand() async throws {
        let h = StoreHarness()
        await h.store.loadCompany()
        h.store.addressText = "305 Ridgeway Dr, Little Rock, AR 72205"
        h.store.startMeasuring()
        await h.store.confirmAddress()
        let first = h.store.session?.requestId
        XCTAssertNotNil(first)
        h.store.pop()
        await h.store.confirmAddress()
        XCTAssertEqual(h.store.session?.requestId, first, "going back and forward does not make a second request")
        let made = await h.fake.calls().filter { $0 == "POST requests" }.count
        XCTAssertEqual(made, 1)
    }

    func testABadAddressShowsTheServersSentenceAndMakesNothing() async throws {
        let h = StoreHarness()
        h.store.addressText = "asdf"
        await h.store.confirmAddress()
        XCTAssertEqual(h.store.addressError, "Please enter your street address.")
        XCTAssertNil(h.store.session)
        await h.fake.failNext(serverError(422, "address_not_found", "We couldn't find that address. Please check the street, city and ZIP.", field: "address"))
        h.store.addressText = "1 Nowhere Rd, Little Rock, AR"
        await h.store.confirmAddress()
        XCTAssertEqual(h.store.addressError, "We couldn't find that address. Please check the street, city and ZIP.")
        XCTAssertNil(h.vault.load())
        XCTAssertNil(h.store.session)
    }

    func testNoConnectionOnTheAddressSaysSoInPlainWords() async throws {
        let h = StoreHarness()
        h.api.offline = true
        h.store.addressText = "305 Ridgeway Dr, Little Rock, AR 72205"
        await h.store.confirmAddress()
        XCTAssertEqual(h.store.addressError, LiveHomeownerAPI.offlineMessage)
        XCTAssertNil(h.store.session)
    }

    func testARefusingKeychainStillLetsTheRequestFinish() async throws {
        let h = StoreHarness(vault: RefusingVault())
        await h.store.loadCompany()
        h.store.addressText = "305 Ridgeway Dr, Little Rock, AR 72205"
        h.store.startMeasuring()
        await h.store.confirmAddress()
        XCTAssertNotNil(h.store.session)
        XCTAssertNotNil(h.store.notice, "the homeowner is told the request cannot be reopened later")
        await h.capture(room: "Kitchen")
        await h.store.setStyleForAll("double-hung")
        await h.settle()
        await h.store.refresh()
        XCTAssertEqual(h.store.windowRows.first?.send, .sent, "the outbox still has the token for this run")
    }

    // MARK: Windows

    func testAWindowWaitsForItsStyleThenGoes() async throws {
        let h = StoreHarness()
        try await h.open()
        await h.capture(room: "Kitchen")
        var calls = await h.fake.calls()
        XCTAssertEqual(calls.filter { $0 == "POST uploads" }.count, 1, "the photo goes up at once")
        XCTAssertEqual(calls.filter { $0.hasPrefix("POST windows") }.count, 0, "the window waits: the server wants a style with it")
        XCTAssertEqual(h.store.windowRows.count, 1)
        XCTAssertEqual(h.store.windowRows[0].send, .needsStyle)
        XCTAssertEqual(h.store.unstyledCount, 1)
        let id = h.store.windowRows[0].id
        await h.store.setStyle("slider-2", for: id)
        await h.settle()
        await h.store.refresh()
        calls = await h.fake.calls()
        XCTAssertEqual(calls.filter { $0.hasPrefix("POST windows") }.count, 1)
        XCTAssertEqual(h.store.windowRows[0].send, .sent)
        XCTAssertEqual(h.store.windowRows[0].style, "slider-2")
        XCTAssertEqual(h.store.windowRows[0].sizeText, "35 5/8 × 59 5/8")
    }

    func testABathroomWindowIsSentFrostedAndTheQuoteShowsTheCompanysLevels() async throws {
        let h = StoreHarness()
        try await h.open()
        let bathId = await h.capture(room: "Bathroom", frosted: true)
        let kitchenId = await h.capture(room: "Kitchen")
        let bayId = await h.capture(room: "Front room")
        let bath = try XCTUnwrap(bathId), kitchen = try XCTUnwrap(kitchenId), bay = try XCTUnwrap(bayId)
        await h.store.setStyle("double-hung", for: bath)
        await h.store.setStyle("double-hung", for: kitchen)
        await h.store.setStyle("arch", for: bay)
        await h.settle()
        await h.store.refresh()
        let windows = try XCTUnwrap(h.store.view?.windows)
        XCTAssertEqual(windows.first { $0.id == bath }?.input.frosted, true, "the bathroom answer reaches the server")
        XCTAssertNil(windows.first { $0.id == kitchen }?.input.frosted, "clear glass sends nothing")
        await h.store.prepareQuote()
        let quote = try XCTUnwrap(h.store.quote)
        // The company's own names and notes
        XCTAssertEqual(quote.tiers.map { $0.label }, ["Replenish", "Refine", "Renew"])
        XCTAssertEqual(quote.tiers.map { $0.note }, ["1-year warranty", "Lifetime warranty", "Lifetime warranty"])
        // Frosted costs more than clear; a bay or odd shape has no instant price and is counted as such
        let good = try XCTUnwrap(quote.tier("good"))
        let price = { (id: String) in good.perWindow.first { $0.windowId == id } }
        XCTAssertGreaterThan(try XCTUnwrap(price(bath)).price, try XCTUnwrap(price(kitchen)).price)
        XCTAssertEqual(price(bay)?.atVisit, true)
        XCTAssertEqual(price(bay)?.price, 0)
        XCTAssertEqual(quote.atVisitCount, 1)
        XCTAssertEqual(h.store.company.catalog.included.first, "Argon gas fill")
    }

    func testTheStylePassReleasesEveryWindowAndOpensTheQuote() async throws {
        let h = StoreHarness()
        try await h.open()
        await h.capture(room: "Kitchen")
        await h.capture(room: "Bedroom 1")
        XCTAssertEqual(h.store.unstyledCount, 2)
        await h.store.finishStyles()
        await h.settle()
        await h.store.refresh()
        XCTAssertEqual(h.store.path.last, .step(.quote))
        XCTAssertEqual(h.store.path.dropLast().last, .step(.list), "back from the quote is the list, not the style pass")
        XCTAssertEqual(h.store.unstyledCount, 0, "a window left without a style takes the likeliest one for its shape")
        let quote = try XCTUnwrap(h.store.quote)
        XCTAssertEqual(quote.measuredCount, 2)
        XCTAssertEqual(Set(quote.tiers.map { $0.key }), ["good", "better", "best"])
    }

    func testPickingAStyleOnASentWindowReplacesItWithACopy() async throws {
        let h = StoreHarness()
        try await h.open(windows: Array(FakeWindowSpec.mockupSeven.prefix(2)))
        let old = h.store.windowRows[0]
        XCTAssertNotEqual(old.style, "arch")
        await h.store.setStyle("arch", for: old.id)
        await h.store.refresh()
        XCTAssertEqual(h.store.windowRows.count, 2, "the same number of windows")
        XCTAssertFalse(h.store.windowRows.contains { $0.id == old.id }, "the old one is gone")
        XCTAssertEqual(h.store.windowRows.filter { $0.style == "arch" }.count, 1)
    }

    func testARefusedWindowShowsTheServersSentenceInTheList() async throws {
        let h = StoreHarness()
        try await h.open()
        await h.capture(room: "Kitchen")
        let id = try XCTUnwrap(h.store.windowRows.first?.id)
        await h.fake.failNext(serverError(422, "window_unsizable", "The window corners cross over each other. Mark them in order."))
        await h.store.setStyle("double-hung", for: id)
        await h.settle()
        guard case .failed(let message) = h.store.windowRows[0].send else { return XCTFail("expected a failed window, got \(h.store.windowRows[0].send)") }
        XCTAssertTrue(message.contains("cross over each other"), message)
        XCTAssertEqual(h.store.failedItems.count, 1)
        await h.store.removeWindow(id)
        await h.settle()
        XCTAssertEqual(h.store.windowRows.count, 0)
    }

    func testNoConnectionKeepsTheWindowOnThePhoneAndItGoesLater() async throws {
        let h = StoreHarness()
        try await h.open()
        await h.capture(room: "Kitchen")
        let id = try XCTUnwrap(h.store.windowRows.first?.id)
        h.api.offline = true
        await h.store.setStyle("double-hung", for: id)
        await h.settle()
        XCTAssertEqual(h.store.windowRows.count, 1, "the window is still there")
        XCTAssertEqual(h.store.windowRows[0].send, .waiting)
        XCTAssertEqual(h.store.unsentCount, 1)
        h.api.offline = false
        await h.settle()
        await h.store.refresh()
        XCTAssertEqual(h.store.unsentCount, 0)
        XCTAssertEqual(h.store.windowRows.first?.send, .sent)
    }

    func testTheSameWindowSentTwiceIsOneWindow() async throws {
        let h = StoreHarness()
        let session = await h.fake.seed()
        let scale = WindowPhotoScale.roomplan(RoomPlanScale(widthM: 1.2, heightM: 1.4, confidence: .medium))
        let input = PhotoWindowInput(id: WindowIds.new(), uploadId: nil, label: nil, windowKey: nil, corners: nil, scale: scale, room: "Kitchen", style: "double-hung")
        let first = try await h.api.addWindow(session, window: input)
        let again = try await h.api.addWindow(session, window: input)
        XCTAssertEqual(first.windows.count, 1)
        XCTAssertEqual(again.windows.count, 1, "a retry after a lost answer changes nothing")
        var different = input
        different.room = "Hall"
        do {
            _ = try await h.api.addWindow(session, window: different)
            XCTFail("a different window with the same id must be refused")
        } catch let e as HomeownerAPIError {
            XCTAssertEqual(e.code, "window_id_taken")
        }
    }

    func testWindowsOnTheServerAndWindowsOnThePhoneAreOneList() async throws {
        let h = StoreHarness()
        try await h.open(windows: Array(FakeWindowSpec.mockupSeven.prefix(3)))
        await h.capture(room: "Hall")
        XCTAssertEqual(h.store.windowRows.map { $0.number }, [1, 2, 3, 4])
        XCTAssertEqual(h.store.windowRows.last?.room, "Hall")
        XCTAssertEqual(h.store.windowRows.last?.send, .needsStyle)
    }

    func testIHaveMoreChangesTheEstimateAndDropsTheHint() async throws {
        let h = StoreHarness()
        try await h.open(windows: Array(FakeWindowSpec.mockupSeven.prefix(3)))
        XCTAssertNotNil(h.store.quote?.missingHint, "3 measured of the 7 to 9 we expect")
        await h.store.setTotalWindows(18)
        XCTAssertEqual(h.store.quote?.estimatedCount, 15)
        XCTAssertNil(h.store.quote?.missingHint)
        await h.store.setTotalWindows(500)
        XCTAssertEqual(h.store.quote?.estimatedCount, 77, "the count is held to the 80 the server accepts: 80 less the 3 measured")
    }

    // MARK: Contact and visit

    func testContactNeedsTheBoxTickedAndSendsTheServersVersion() async throws {
        let h = StoreHarness()
        try await h.open(windows: FakeWindowSpec.mockupSeven)
        await h.store.prepareContact()
        h.store.contactDraft = HomeownerContact(firstName: "Tia", lastName: "Bell", phone: "(501) 555-0177", email: "tia.bell@example.com", zip: "72205")
        await h.store.submitContact()
        XCTAssertNotNil(h.store.contactErrors[.consent], "the required box is not ticked")
        var calls = await h.fake.calls()
        XCTAssertFalse(calls.contains("POST contact"), "nothing is sent until the form is right")
        h.store.contactDraft.contactConsent = true
        await h.store.submitContact()
        calls = await h.fake.calls()
        XCTAssertTrue(calls.contains("POST contact"))
        XCTAssertTrue(calls.contains("POST book"), "the interest form asks WinChoice to call: no visit time is forced")
        XCTAssertEqual(h.store.root, .callbackSent, "the thanks screen")
        XCTAssertNotEqual(h.store.path.last, .step(.book))
        XCTAssertEqual(h.store.view?.booking?.callMe, true)
        XCTAssertTrue(h.store.hasContact)
    }

    func testMeasureThenEstimateThenSkipToTheFormThenThanks() async throws {
        let h = StoreHarness()
        try await h.open(windows: [], step: .list)
        await h.capture(room: "Kitchen")
        await h.capture(room: "Bedroom 1")
        XCTAssertEqual(h.store.unstyledCount, 2)
        // Done adding windows: straight to the estimate, styles are not asked for
        await h.store.continueFromList()
        await h.settle()
        await h.store.refresh()
        XCTAssertEqual(h.store.path.last, .step(.quote))
        XCTAssertFalse(h.store.path.contains(.step(.styles)), "the style picker does not stand in the way")
        XCTAssertEqual(h.store.unstyledCount, 0)
        let quote = try XCTUnwrap(h.store.quote)
        XCTAssertEqual(quote.measuredCount, 2)
        XCTAssertFalse(quote.tiers.isEmpty)
        // "Skip and get my estimate": the interest form, with nothing customized
        h.store.requestCallFromEstimate()
        XCTAssertEqual(h.store.path.last, .step(.contact))
        await h.store.prepareContact()
        h.store.contactDraft = HomeownerContact(firstName: "Tia", lastName: "Bell", phone: "(501) 555-0177", email: "tia.bell@example.com", zip: "72205", contactConsent: true)
        await h.store.submitContact()
        // Thanks: no visit-booking step in between
        XCTAssertEqual(h.store.root, .callbackSent)
        XCTAssertTrue(h.store.path.isEmpty)
        XCTAssertEqual(h.store.view?.booking?.callMe, true)
        XCTAssertNotEqual(h.store.requestStatus, .callback, "the thanks of the estimate path, not the doubtful-home screen")
        let calls = await h.fake.calls()
        XCTAssertFalse(calls.contains { $0.hasSuffix("look") }, "nothing was customized, so no look is sent: \(calls)")
    }

    // MARK: Customize your windows

    private func twoWindowsOnTheEstimate() async throws -> StoreHarness {
        let h = StoreHarness()
        try await h.open(windows: [], step: .list)
        await h.capture(room: "Kitchen")
        await h.capture(room: "Bedroom 1")
        await h.store.continueFromList()
        await h.settle()
        await h.store.refresh()
        XCTAssertEqual(h.store.path.last, .step(.quote))
        return h
    }

    func testCustomizeWalksTheWindowsOneByOneThenShowsTheReadyScreen() async throws {
        let h = try await twoWindowsOnTheEstimate()
        let ids = h.store.windowRows.map { $0.id }
        XCTAssertEqual(ids.count, 2)
        h.store.startCustomizing()
        XCTAssertEqual(h.store.path.last, .visualize(windowId: ids[0], from: .customize))
        XCTAssertEqual(h.store.customizePlace(of: ids[0])?.number, 1)
        XCTAssertEqual(h.store.customizePlace(of: ids[0])?.count, 2)
        // Next keeps the first window's choice on the phone and shows the second
        let first = WindowVisualLook(type: .casement, grid: .prairie, glass: .lowE)
        await h.store.customizeNext(after: ids[0], look: first, colorKey: "black")
        XCTAssertEqual(h.store.path.last, .visualize(windowId: ids[1], from: .customize))
        XCTAssertEqual(h.store.progress.visuals[ids[0]], first)
        XCTAssertEqual(h.store.progress.colors[ids[0]], "black")
        // Done on the last window: the ready screen, with the estimate behind it (the walk is gone from the stack)
        let second = WindowVisualLook(type: .picture, grid: .none, glass: .frosted)
        await h.store.customizeNext(after: ids[1], look: second, colorKey: "white")
        XCTAssertEqual(h.store.path.last, .step(.ready))
        XCTAssertEqual(h.store.path.suffix(2), [.step(.quote), .step(.ready)])
        XCTAssertFalse(h.store.path.contains { if case .visualize = $0 { return true } else { return false } })
        XCTAssertEqual(h.store.progress.step, .ready)
        XCTAssertNotNil(h.store.quote)
        // Each window now has the style its kind is quoted under
        XCTAssertEqual(h.store.windowRows.compactMap { $0.style }.count, 2)
        // "Get my estimate": the interest form
        h.store.requestCallFromEstimate()
        XCTAssertEqual(h.store.path.last, .step(.contact))
    }

    func testTheCustomizedLooksReachTheCRMBeforeTheContactIsFiled() async throws {
        let h = try await twoWindowsOnTheEstimate()
        h.store.startCustomizing()
        let ids = h.store.windowRows.map { $0.id }
        let first = WindowVisualLook(type: .casement, grid: .prairie, glass: .lowE)
        await h.store.customizeNext(after: ids[0], look: first, colorKey: "black")
        await h.store.customizeAll(look: WindowVisualLook(type: .picture, grid: .colonial, glass: .clear), colorKey: "bronze")
        XCTAssertEqual(h.store.path.last, .step(.ready))
        // "Use for all": the same look for both windows, and sent to the server (the windows may have new ids after the style change)
        let held = await h.fake.looks(for: try XCTUnwrap(h.store.requestId))
        XCTAssertEqual(held.count, 2)
        XCTAssertEqual(Set(held.values.map { $0.kind }), [.picture])
        XCTAssertEqual(Set(held.values.map { $0.grid }), [.colonial])
        XCTAssertEqual(Set(held.values.map { $0.color }), ["bronze"])
        let serverIds = Set((h.store.view?.windows ?? []).map { $0.id })
        XCTAssertEqual(Set(held.keys), serverIds, "each look is on a window the server holds")
        XCTAssertEqual(Set(h.store.progress.looksSent.keys), serverIds, "the phone remembers what was sent")
        // The contact: a look that changed since goes first, then the details
        let id = try XCTUnwrap(h.store.windowRows.first?.id)
        h.store.keepLook(WindowVisualLook(type: .awning, grid: .diamond, glass: .frosted), colorKey: "beige", for: id)
        h.store.requestCallFromEstimate()
        await h.store.prepareContact()
        h.store.contactDraft = HomeownerContact(firstName: "Tia", lastName: "Bell", phone: "(501) 555-0177", email: "tia.bell@example.com", zip: "72205", contactConsent: true)
        await h.store.submitContact()
        XCTAssertEqual(h.store.root, .callbackSent)
        let calls = await h.fake.calls()
        let lookCalls = calls.indices.filter { calls[$0].hasSuffix("look") }
        let contactCall = try XCTUnwrap(calls.firstIndex(of: "POST contact"))
        XCTAssertFalse(lookCalls.isEmpty)
        XCTAssertTrue(lookCalls.allSatisfy { $0 < contactCall }, "every look is sent before the contact is filed: \(calls)")
        let after = await h.fake.looks(for: try XCTUnwrap(h.store.requestId))
        XCTAssertEqual(after[id]?.kind, .awning, "the changed look replaced the one before")
    }

    func testALookThatCannotBeSentHoldsTheContactBackUntilThePhoneIsOnline() async throws {
        let h = try await twoWindowsOnTheEstimate()
        let id = try XCTUnwrap(h.store.windowRows.first?.id)
        h.store.keepLook(WindowVisualLook(type: .bay, grid: .none, glass: .clear), colorKey: "white", for: id)
        h.store.requestCallFromEstimate()
        await h.store.prepareContact()
        h.store.contactDraft = HomeownerContact(firstName: "Tia", lastName: "Bell", phone: "(501) 555-0177", email: "tia.bell@example.com", zip: "72205", contactConsent: true)
        h.api.offline = true
        await h.store.submitContact()
        XCTAssertEqual(h.store.contactError, LiveHomeownerAPI.offlineMessage)
        XCTAssertNotEqual(h.store.root, .callbackSent)
        h.api.offline = false
        await h.store.submitContact()
        XCTAssertEqual(h.store.root, .callbackSent, "online again: the look goes, then the contact")
        let held = await h.fake.looks(for: try XCTUnwrap(h.store.requestId))
        XCTAssertEqual(held[id]?.kind, .bay)
    }

    func testTheReadyThumbnailIsDrawnFromTheWindowsSavedLook() async throws {
        let h = try await twoWindowsOnTheEstimate()
        let id = try XCTUnwrap(h.store.windowRows.first?.id)
        let casement = WindowVisualLook(type: .casement, grid: .prairie, glass: .lowE)
        h.store.keepLook(casement, colorKey: "black", for: id)
        let spec = h.store.thumbnailSpec(for: id)
        XCTAssertEqual(spec.look, casement, "the renderer is given the saved look, not the style's starting one")
        XCTAssertEqual(spec.colorKey, "black")
        XCTAssertEqual(spec.colorHex, h.store.brand.windowColors.first { $0.key == "black" }?.hex)
        let photo = await h.store.visualPhoto(for: id)
        let maybeDrawn = await ThumbnailRenderer.image(for: spec, source: photo)
        let drawn = try XCTUnwrap(maybeDrawn)
        XCTAssertEqual(ThumbnailRenderer.lastLook, casement, "the drawing was made from that look")
        // A different look gives a different picture, and a window with no photo still gets a drawn thumbnail of its look
        var other = spec
        other.look = WindowVisualLook(type: .doubleHung, grid: .colonial, glass: .clear)
        let hung = try XCTUnwrap(ThumbnailRenderer.render(other, source: photo))
        XCTAssertNotEqual(drawn.pngData(), hung.pngData())
        XCTAssertEqual(ThumbnailRenderer.lastLook, other.look)
        let wall = try XCTUnwrap(ThumbnailRenderer.render(spec, source: nil))
        XCTAssertEqual(wall.size, CGSize(width: 216, height: 216))
    }

    func testTheChosenLooksSurviveARestart() async throws {
        let h = try await twoWindowsOnTheEstimate()
        let id = try XCTUnwrap(h.store.windowRows.first?.id)
        h.store.keepLook(WindowVisualLook(type: .hopper, grid: .topOnly, glass: .lowE), colorKey: "sandstone", for: id)
        h.store.progress.looksSent[id] = HomeownerWindowLookBody(look: WindowVisualLook(type: .hopper, grid: .topOnly, glass: .lowE), colorKey: "sandstone")
        h.store.saveProgress()
        let saved = h.progress.load(requestId: try XCTUnwrap(h.store.requestId))
        XCTAssertEqual(saved.visuals[id]?.type, .hopper)
        XCTAssertEqual(saved.colors[id], "sandstone")
        XCTAssertEqual(saved.looksSent[id]?.grid, .topOnly)
    }

    func testAChangedConsentWordingReloadsTheWordsAndAsksAgain() async throws {
        let h = StoreHarness()
        try await h.open(windows: FakeWindowSpec.mockupSeven)
        await h.store.prepareContact()
        h.store.contactDraft = HomeownerContact(firstName: "Tia", lastName: "Bell", phone: "(501) 555-0177", email: "tia.bell@example.com", zip: "72205", contactConsent: true)
        let before = await h.fake.calls().filter { $0 == "GET company" }.count
        await h.fake.failNext(serverError(409, "consent_changed", "The wording on this screen was updated. Please go back and try again."))
        await h.store.submitContact()
        XCTAssertEqual(h.store.contactError, "The wording on this screen was updated. Please go back and try again.")
        XCTAssertNotEqual(h.store.root, .callbackSent)
        let after = await h.fake.calls().filter { $0 == "GET company" }.count
        XCTAssertEqual(after, before + 1, "the company's words are fetched again")
        await h.store.submitContact()
        XCTAssertEqual(h.store.root, .callbackSent, "sending again with the fresh words goes through")
    }

    func testAFieldTheServerRefusesLandsOnThatField() async throws {
        let h = StoreHarness()
        try await h.open(windows: FakeWindowSpec.mockupSeven)
        await h.store.prepareContact()
        h.store.contactDraft = HomeownerContact(firstName: "Tia", lastName: "Bell", phone: "(501) 555-0177", email: "tia.bell@example.com", zip: "72205", contactConsent: true)
        await h.fake.failNext(serverError(400, "invalid_request", "That email address doesn't look right.", field: "email"))
        await h.store.submitContact()
        XCTAssertEqual(h.store.contactErrors[.email], "That email address doesn't look right.")
        XCTAssertNil(h.store.contactError)
    }

    func testBookingAVisitShowsTheConfirmationAndMyOrderLater() async throws {
        let h = StoreHarness()
        try await h.open(windows: FakeWindowSpec.mockupSeven, contact: true)
        await h.store.loadSlots()
        XCTAssertFalse(h.store.visitDays.isEmpty)
        XCTAssertEqual(h.store.pickedSlot, h.store.slots?.slots.first)
        await h.store.bookPicked()
        XCTAssertEqual(h.store.root, .booked)
        XCTAssertNotNil(h.store.visitStart)
        XCTAssertNotNil(h.store.repName, "the rep is named once a visit is booked")
        let id = try XCTUnwrap(h.store.requestId)
        // Opening the app again right away shows the confirmation once; after "My order" it opens there
        let again = StoreHarness(fake: h.fake, vault: h.vault, progress: h.progress)
        await again.store.bootstrap()
        XCTAssertEqual(again.store.root, .booked)
        again.store.showStatus()
        XCTAssertEqual(again.progress.load(requestId: id).step, .status)
        let third = StoreHarness(fake: h.fake, vault: h.vault, progress: h.progress)
        await third.store.bootstrap()
        XCTAssertEqual(third.store.root, .status)
    }

    func testATakenTimeReloadsTheTimesAndKeepsTheRequest() async throws {
        let h = StoreHarness()
        try await h.open(windows: FakeWindowSpec.mockupSeven, contact: true)
        await h.store.loadSlots()
        await h.fake.failNext(serverError(409, "slot_taken", "That time was just taken. Please pick another."))
        await h.store.bookPicked()
        XCTAssertEqual(h.store.bookError, "That time was just taken. Please pick another.")
        XCTAssertNotEqual(h.store.root, .booked)
        XCTAssertNotNil(h.store.session)
        await h.store.bookPicked()
        XCTAssertEqual(h.store.root, .booked)
    }

    func testCallMeToPickATime() async throws {
        let h = StoreHarness()
        try await h.open(windows: FakeWindowSpec.mockupSeven, contact: true)
        await h.store.askForCall()
        XCTAssertEqual(h.store.root, .callbackSent)
        XCTAssertEqual(h.store.view?.booking?.callMe, true)
    }

    func testAddingWindowsAfterBookingStartsAtTheRooms() async throws {
        let h = StoreHarness()
        try await h.open(windows: FakeWindowSpec.mockupSeven, contact: true, booked: true)
        XCTAssertEqual(h.store.root, .status)
        let stack = h.store.stack(to: .list)
        XCTAssertEqual(stack.first, .step(.rooms), "the back stack after booking begins at the rooms")
        XCTAssertEqual(stack.last, .step(.list))
    }

    func testMyOrderShowsWhatTheServerSaysAndNothingItDoesNotSay() async throws {
        let h = StoreHarness(fake: FakeHomeownerAPI(features: .contract))
        try await h.open(windows: FakeWindowSpec.mockupSeven, contact: true, booked: true)
        await h.store.loadStatus()
        let status = try XCTUnwrap(h.store.status)
        XCTAssertEqual(status.stage, .visitBooked)
        XCTAssertNil(status.orderNumber, "no order number or delivery date unless the server sends them")
        XCTAssertNil(status.eta)
        XCTAssertFalse(h.store.features.windowColor)
        XCTAssertFalse(h.store.features.bestTime)
    }

    func testMeasureGoesStraightToTheAddressForWindowsOnly() async throws {
        let h = StoreHarness()
        h.store.startMeasuring()
        XCTAssertEqual(h.store.path.last, .step(.address), "no what-to-measure choice: this app measures windows")
        XCTAssertEqual(h.store.path.count, 1)
        XCTAssertEqual(h.store.services, [.windows])
    }

    // MARK: Resume

    func testAReturningHomeownerLandsWhereTheyLeft() async throws {
        let h = StoreHarness()
        try await h.open(windows: FakeWindowSpec.mockupSeven, step: .styles)
        XCTAssertEqual(h.store.root, .welcome)
        XCTAssertEqual(h.store.path.last, .step(.styles))
        XCTAssertEqual(h.store.path.first, .step(.address), "the back stack leads home, through the address")
    }

    func testAReturningHomeownerWithNoWindowsLandsOnTheResults() async throws {
        let h = StoreHarness()
        try await h.open(step: .list)
        XCTAssertEqual(h.store.path.last, .step(.results), "no list without windows")
    }

    func testAReturningHomeownerWithoutContactDetailsNeverSkipsToBooking() async throws {
        let h = StoreHarness()
        try await h.open(windows: FakeWindowSpec.mockupSeven, step: .book)
        XCTAssertEqual(h.store.path.last, .step(.contact))
    }

    func testASavedRequestPastItsSixtyDaysIsDropped() async throws {
        let h = StoreHarness()
        var old = await h.fake.seed()
        old.expiresAt = Date().addingTimeInterval(-86_400)
        try h.vault.save(old)
        await h.store.bootstrap()
        XCTAssertNil(h.store.session)
        XCTAssertNil(h.vault.load())
        XCTAssertEqual(h.store.root, .welcome)
        XCTAssertNotNil(h.store.notice)
    }

    func testTheServerNoLongerKnowingTheTokenEndsTheSavedRequest() async throws {
        let h = StoreHarness()
        var session = await h.fake.seed()
        session.token = "a-token-the-server-never-gave"
        try h.vault.save(session)
        await h.store.bootstrap()
        XCTAssertNil(h.store.session)
        XCTAssertNil(h.vault.load(), "the token the server no longer accepts is not kept")
        XCTAssertEqual(h.store.root, .welcome)
    }

    func testNoConnectionOnLaunchKeepsTheRequestAndShowsWhatThePhoneKnows() async throws {
        let h = StoreHarness()
        let session = await h.fake.seed(windows: FakeWindowSpec.mockupSeven)
        try h.vault.save(session)
        var saved = HomeownerProgress()
        saved.step = .list
        saved.windowCount = 7
        h.progress.save(saved, requestId: session.requestId)
        h.api.offline = true
        await h.store.bootstrap()
        XCTAssertNotNil(h.store.session, "being offline does not lose the request")
        XCTAssertTrue(h.store.offline)
        XCTAssertEqual(h.store.path.last, .step(.list), "the saved screen is where they land")
        XCTAssertNotNil(h.vault.load())
    }

    func testStartingOverForgetsTheRequestAndItsWindows() async throws {
        let h = StoreHarness()
        try await h.open()
        await h.capture(room: "Kitchen")
        XCTAssertEqual(h.store.windowRows.count, 1)
        let id = try XCTUnwrap(h.store.requestId)
        h.store.startOver()
        XCTAssertNil(h.store.session)
        XCTAssertNil(h.vault.load())
        XCTAssertEqual(h.store.root, .welcome)
        XCTAssertTrue(h.store.path.isEmpty)
        try await Task.sleep(nanoseconds: 300_000_000)
        let items = await h.store.outbox.items
        XCTAssertTrue(items.isEmpty, "the windows saved on the phone go with it")
        XCTAssertEqual(h.progress.load(requestId: id), HomeownerProgress(), "and what the phone remembered about it")
    }

    // MARK: Rooms

    func testRoomsKeepTheirNamesAndSuggestTheNextOne() async throws {
        let h = StoreHarness()
        try await h.open(windows: [FakeWindowSpec.mockupSeven[1]])
        XCTAssertEqual(h.store.addRoom("  Guest   bedroom "), "Guest bedroom")
        XCTAssertEqual(h.store.addRoom("guest bedroom"), "Guest bedroom", "the same room is not added twice")
        XCTAssertNil(h.store.addRoom("   "))
        XCTAssertEqual(h.store.roomLine("Kitchen"), "1 window measured · tap to add another")
        XCTAssertEqual(h.store.roomLine("Guest bedroom"), "Not started")
        XCTAssertNotEqual(h.store.suggestedRoom, "Kitchen", "the main button offers a room that has no window yet")
    }

    // MARK: Saving (the owner's priority: measured means saved)

    private func pendingSession(_ h: StoreHarness, room: String = "Kitchen", replacing: String? = nil) -> MeasureSession {
        MeasureSession(method: .corners, room: room, number: h.store.nextWindowNumber, replacing: replacing)
    }

    private func capturePending(_ h: StoreHarness, room: String = "Kitchen", replacing: String? = nil) {
        let scene = SampleScene.small
        let photo = PhotoPreparation.prepare(scene.image(withCard: false))
        let w = SampleScene.widthIn / inchesPerMetre, hh = SampleScene.heightIn / inchesPerMetre
        let scale = WindowPhotoScale.ar(ArScale(pointsM: [Vec3(0, hh, -1.5), Vec3(w, hh, -1.5), Vec3(w, 0, -1.5), Vec3(0, 0, -1.5)], trackingLostCount: 0, device: .arkitLidar, cornerSpreadM: [0.001, 0.001, 0.001, 0.001]))
        h.store.capture(scale: scale, corners: scene.frameCorners.map { Vec2(Double($0.x), Double($0.y)) }, jpeg: photo?.jpeg, widthPx: photo?.widthPx ?? 0, heightPx: photo?.heightPx ?? 0,
                        in: pendingSession(h, room: room, replacing: replacing))
    }

    func testMeasureAgainKeepsTheOldWindowUntilTheNewOneIsSaved() async throws {
        let h = StoreHarness()
        try await h.open(windows: [FakeWindowSpec.mockupSeven[1]])
        let old = try XCTUnwrap(h.store.windowRows.first)
        // No method used yet on this phone: the method screen comes, and still remembers which window it is for
        await h.store.measureAgain(old)
        XCTAssertEqual(h.store.replaceTarget, old.id)
        h.store.startMeasuring(room: old.room)
        XCTAssertEqual(h.store.measureSession?.replacing, old.id)
        h.store.measureSession = nil
        await h.store.measureAgain(old)
        XCTAssertEqual(h.store.windowRows.map { $0.id }, [old.id], "nothing is deleted when the camera opens")
        let calls = await h.fake.calls()
        XCTAssertFalse(calls.contains { $0.hasPrefix("DELETE") }, "and nothing is asked of the server")
        XCTAssertEqual(h.store.measureSession?.replacing, old.id, "the session carries the window it replaces")
        // The homeowner closes the camera: the old size is still there
        h.store.measureSession = nil
        XCTAssertEqual(h.store.windowRows.map { $0.id }, [old.id])
        // Measuring again and saving: now the old one goes
        capturePending(h, room: old.room, replacing: old.id)
        XCTAssertEqual(h.store.windowRows.count, 1, "a pending window is not a row yet")
        await h.store.savePending(room: old.room, name: "")
        await h.settle()
        await h.store.refresh()
        XCTAssertFalse(h.store.windowRows.contains { $0.id == old.id }, "the old window is removed once the new one is saved")
        XCTAssertEqual(h.store.windowRows.count, 1)
    }

    func testAPendingWindowSurvivesClosingTheApp() async throws {
        let fake = FakeHomeownerAPI()
        let progress = MemoryProgressStore()
        let first = StoreHarness(fake: fake, progress: progress)
        try await first.open()
        capturePending(first)
        let id = try XCTUnwrap(first.store.pending?.id)
        // The app is closed here; a new store opens the same request and the same folder on the next launch
        let second = HomeownerStore(api: first.api, vault: first.vault, progressStore: progress, outboxDirectory: first.directory, capabilities: .depthSensorPhone("iPhone 15 Pro"))
        await second.bootstrap()
        let back = try XCTUnwrap(second.pending, "the measured window comes back")
        XCTAssertEqual(back.id, id)
        XCTAssertEqual(back.room, "Kitchen")
        XCTAssertNotNil(back.jpeg)
        XCTAssertEqual(back.corners?.count, 4)
        XCTAssertEqual(back.preview.map { SizeWording.text($0.widthIn) }, "35 5/8", "with the same size")
        XCTAssertTrue(second.pendingRestored)
        XCTAssertNotNil(second.measureSession, "the label sheet opens for it")
        // Saving it clears the copy on disk
        await second.savePending(room: "Kitchen", name: "")
        XCTAssertEqual(second.windowRows.count, 1)
        let third = HomeownerStore(api: first.api, vault: first.vault, progressStore: progress, outboxDirectory: first.directory, capabilities: .depthSensorPhone("iPhone 15 Pro"))
        await third.bootstrap()
        XCTAssertNil(third.pending, "a saved window is not offered again")
    }

    func testDiscardingDropsThePendingWindowAndKeepsTheOldOne() async throws {
        let h = StoreHarness()
        try await h.open(windows: [FakeWindowSpec.mockupSeven[1]])
        let old = try XCTUnwrap(h.store.windowRows.first)
        capturePending(h, room: old.room, replacing: old.id)
        h.store.discardPending()
        XCTAssertNil(h.store.pending)
        XCTAssertNil(h.store.measureSession)
        XCTAssertEqual(h.store.windowRows.map { $0.id }, [old.id])
        let again = HomeownerStore(api: h.api, vault: h.vault, progressStore: h.progress, outboxDirectory: h.directory, capabilities: .depthSensorPhone("iPhone 15 Pro"))
        await again.bootstrap()
        XCTAssertNil(again.pending, "a discarded window does not come back")
    }

    func testSavingGoesToTheListWithTheNewRowMarkedAndANotice() async throws {
        let h = StoreHarness()
        try await h.open()
        let captured = await h.capture(room: "Kitchen")
        let id = try XCTUnwrap(captured)
        XCTAssertEqual(h.store.justSavedId, id)
        XCTAssertEqual(h.store.notice?.text, "Saved: Kitchen, 35 5/8 × 59 5/8 in")
        XCTAssertEqual(h.store.heldCount, 1, "waiting for its style")
        XCTAssertEqual(h.store.progress.step, .list)
    }

    func testTheMethodScreenComesForTheFirstWindowOnlyThenTheLastMethodIsUsed() async throws {
        let h = StoreHarness()
        try await h.open()
        h.store.measure(room: "Kitchen")
        XCTAssertEqual(h.store.path.last, .method(room: "Kitchen"), "the first window asks how")
        XCTAssertNil(h.store.measureSession)
        h.store.method = .card
        h.store.startMeasuring(room: "Kitchen")
        XCTAssertEqual(h.store.lastMethod, .card)
        h.store.measureSession = nil
        let before = h.store.path
        h.store.measure(room: "Hall")
        XCTAssertEqual(h.store.measureSession?.method, .card, "then it goes straight to the last method")
        XCTAssertEqual(h.store.path, before)
        h.store.measureSession = nil
        h.store.changeMethod(room: "Hall")
        XCTAssertNil(h.store.lastMethod)
        XCTAssertEqual(h.store.path.last, .method(room: "Hall"), "\"Change how I measure\" brings the method screen back")
    }

    // MARK: Nothing measured is ever lost

    func testAStaleRequestKeepsTheMeasuredWindowsAndTheNewRequestTakesThem() async throws {
        let h = StoreHarness()
        try await h.open()
        await h.capture(room: "Kitchen")
        let window = try XCTUnwrap(h.store.windowRows.first)
        let oldId = try XCTUnwrap(h.store.requestId)
        let address = h.store.address
        // The server stops knowing the request
        var bad = try XCTUnwrap(h.store.session)
        bad.token = "a-token-the-server-never-gave"
        h.store.setSession(bad)
        await h.store.refresh()
        XCTAssertNil(h.store.session)
        let kept = await h.store.outbox.items
        XCTAssertEqual(kept.map { $0.id }, [window.id], "the measured window stays on the phone")
        XCTAssertEqual(h.store.addressText, address, "the address is ready to confirm again")
        XCTAssertTrue(h.store.notice?.text.contains("still on this phone") == true)
        // Confirming the address makes a new request and the window moves to it
        h.store.addressText = address
        await h.store.confirmAddress()
        let newId = try XCTUnwrap(h.store.requestId)
        XCTAssertNotEqual(newId, oldId)
        await h.settle()
        XCTAssertEqual(h.store.windowRows.map { $0.id }, [window.id])
        XCTAssertEqual(h.store.windowRows.first?.send, .needsStyle, "held for its style, photo sent again to the new request")
        await h.store.setStyle("double-hung", for: window.id)
        await h.settle()
        await h.store.refresh()
        XCTAssertEqual(h.store.view?.windows.map { $0.id }, [window.id], "and the new request has it")
    }

    func testAStyleChosenWhileTheSendIsUncertainIsKeptAndAppliedLater() async throws {
        let h = StoreHarness()
        try await h.open()
        await h.capture(room: "Kitchen")
        let id = try XCTUnwrap(h.store.windowRows.first?.id)
        h.api.offline = true
        await h.store.setStyle("double-hung", for: id)   // released, goes out, the answer never comes
        await h.settle()
        var items = await h.store.outbox.items
        XCTAssertEqual(items.first?.windowSendUncertain, true)
        await h.store.setStyle("slider-2", for: id)       // cannot be changed now: kept
        XCTAssertEqual(h.store.progress.pendingStyles[id], "slider-2")
        XCTAssertEqual(h.store.windowRows.first?.style, "slider-2", "the choice shows at once")
        h.api.offline = false
        for _ in 0..<3 {
            await h.store.syncWindows()
            await h.settle()
        }
        items = await h.store.outbox.items
        XCTAssertTrue(h.store.progress.pendingStyles.isEmpty, "applied on a later sync")
        XCTAssertEqual(h.store.windowRows.first?.style, "slider-2")
        XCTAssertEqual(h.store.view?.windows.count, 1)
        XCTAssertEqual(h.store.view?.windows.first?.input.style, "slider-2")
    }

    func testAPhoneWithoutADepthSensorIsOfferedTheBankCardFirst() async throws {
        let h = StoreHarness(capabilities: MeasureCapabilities(deviceName: "iPhone 13", corners: true, depthSensor: false, roomScan: false, camera: true))
        XCTAssertEqual(h.store.defaultMethod, .card)
        XCTAssertEqual(h.store.methodTag(.card).text, "Recommended for your iPhone")
        XCTAssertEqual(h.store.methodTag(.corners).text, "About 3/8 inch · good for a quote")
    }

    // MARK: Changing the address

    func testGoingBackToChangeTheAddressStartsANewQuoteAndKeepsTheName() async throws {
        let h = StoreHarness()
        await h.store.loadCompany()
        h.store.startMeasuring()
        h.store.addressText = "305 Ridgeway Dr, Little Rock, AR 72205"
        await h.store.confirmAddress()
        let first = try XCTUnwrap(h.store.session?.requestId)
        h.store.contactDraft.firstName = "Pat"
        h.store.pop()
        XCTAssertFalse(h.store.addressLocked, "the address can be changed")
        h.store.addressText = "12 Oak St, Little Rock, AR 72205"
        h.store.addressPlace = nil
        await h.store.confirmAddress()
        let second = try XCTUnwrap(h.store.session?.requestId)
        XCTAssertNotEqual(first, second, "a new address is a new quote")
        XCTAssertEqual(h.store.session?.address.hasPrefix("12 Oak St"), true)
        XCTAssertEqual(h.store.contactDraft.firstName, "Pat", "the person's details stay filled in")
        XCTAssertNil(h.store.pendingAddressChange, "nothing measured, so no question")
    }

    func testANewAddressAfterMeasuringAsksBeforeDroppingTheWindows() async throws {
        let h = StoreHarness()
        await h.store.loadCompany()
        h.store.startMeasuring()
        h.store.addressText = "305 Ridgeway Dr, Little Rock, AR 72205"
        await h.store.confirmAddress()
        let first = try XCTUnwrap(h.store.session?.requestId)
        await h.capture(room: "Kitchen")
        XCTAssertGreaterThan(h.store.windowCount, 0)
        h.store.addressText = "12 Oak St, Little Rock, AR 72205"
        h.store.addressPlace = nil
        await h.store.confirmAddress()
        XCTAssertEqual(h.store.session?.requestId, first, "nothing changes until they say yes")
        XCTAssertNotNil(h.store.pendingAddressChange)
        await h.store.confirmAddressChange()
        XCTAssertNotEqual(h.store.session?.requestId, first)
        XCTAssertNil(h.store.pendingAddressChange)
    }

    // MARK: Settings: delete all data

    func testDeleteAllDataClearsTheRequestWindowsAndProgressButKeepsTheServer() async throws {
        let h = StoreHarness()
        await h.store.loadCompany()
        h.store.startMeasuring()
        h.store.addressText = "305 Ridgeway Dr, Little Rock, AR 72205"
        await h.store.confirmAddress()
        await h.capture(room: "Kitchen")
        XCTAssertNotNil(h.store.session)
        XCTAssertGreaterThan(h.store.windowCount, 0)
        UserDefaults.standard.set(true, forKey: "winchoice.howto.test")
        UserDefaults.standard.set("https://example.test", forKey: ServerSetting.key)
        await h.store.deleteAllData()
        XCTAssertNil(h.store.session, "the saved request is gone")
        XCTAssertNil(h.vault.load(), "the Keychain item is gone")
        XCTAssertEqual(h.store.windowCount, 0, "no measured windows left")
        let left = await h.store.outbox.items
        XCTAssertTrue(left.isEmpty, "nothing waiting to upload")
        XCTAssertFalse(UserDefaults.standard.bool(forKey: "winchoice.howto.test"), "how-to flags reset")
        XCTAssertEqual(UserDefaults.standard.string(forKey: ServerSetting.key), "https://example.test", "the tester's server stays")
        XCTAssertEqual(h.store.root, .welcome)
        XCTAssertNotNil(h.store.notice)
        UserDefaults.standard.removeObject(forKey: ServerSetting.key)
    }
}
