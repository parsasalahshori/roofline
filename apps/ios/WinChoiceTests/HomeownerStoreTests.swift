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
        h.store.selectedServices = [.windows, .roof]
        h.store.addressText = "305 Ridgeway Dr, Little Rock, AR 72205"
        h.store.continueFromWelcome()
        XCTAssertEqual(h.store.path.last, .step(.address))
        await h.store.confirmAddress()
        let saved = try XCTUnwrap(h.store.session)
        XCTAssertEqual(h.vault.load()?.requestId, saved.requestId, "the request id and token are kept for the next launch")
        XCTAssertEqual(h.store.path.last, .step(.results))
        XCTAssertEqual(h.store.requestStatus, .ready)
        XCTAssertNotNil(h.store.windowEstimate)
        XCTAssertNotNil(h.store.roofEstimate)
        XCTAssertNotNil(h.store.home?.outline, "the roof outline for the map")
    }

    func testAnApartmentGoesToTheCallBackBranchAndOnePhoneNumberIsEnough() async throws {
        let h = StoreHarness()
        await h.store.loadCompany()
        h.store.selectedServices = [.windows]
        h.store.addressText = "2210 Leavenworth St Apt 5, Little Rock, AR"
        h.store.continueFromWelcome()
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
        h.store.continueFromWelcome()
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
        h.store.continueFromWelcome()
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
        XCTAssertNotEqual(old.style, "casement")
        await h.store.setStyle("casement", for: old.id)
        await h.store.refresh()
        XCTAssertEqual(h.store.windowRows.count, 2, "the same number of windows")
        XCTAssertFalse(h.store.windowRows.contains { $0.id == old.id }, "the old one is gone")
        XCTAssertEqual(h.store.windowRows.filter { $0.style == "casement" }.count, 1)
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
        XCTAssertEqual(h.store.path.last, .step(.book))
        XCTAssertTrue(h.store.hasContact)
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
        XCTAssertNotEqual(h.store.path.last, .step(.book))
        let after = await h.fake.calls().filter { $0 == "GET company" }.count
        XCTAssertEqual(after, before + 1, "the company's words are fetched again")
        await h.store.submitContact()
        XCTAssertEqual(h.store.path.last, .step(.book), "sending again with the fresh words goes through")
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

    // MARK: Resume

    func testAReturningHomeownerLandsWhereTheyLeft() async throws {
        let h = StoreHarness()
        try await h.open(windows: FakeWindowSpec.mockupSeven, step: .styles)
        XCTAssertEqual(h.store.root, .welcome)
        XCTAssertEqual(h.store.path.last, .step(.styles))
        XCTAssertEqual(h.store.path.first, .step(.address), "the back stack leads home")
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
        XCTAssertEqual(h.store.roomLine("Kitchen"), "1 window measured")
        XCTAssertEqual(h.store.roomLine("Guest bedroom"), "Not started")
        XCTAssertNotEqual(h.store.suggestedRoom, "Kitchen", "the main button offers a room that has no window yet")
    }
}
