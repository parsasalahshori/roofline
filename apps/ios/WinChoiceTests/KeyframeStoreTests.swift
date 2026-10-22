import XCTest
@testable import WinChoice

final class KeyframeStoreTests: XCTestCase {
    func testAFullStoreReplacesItsLowestScoringPhotoInsteadOfStopping() {
        var store = KeyframeStore<String>(capacity: 3)
        XCTAssertEqual(store.add("a", score: 0.5), .added(index: 0))
        XCTAssertEqual(store.add("b", score: 0.2), .added(index: 1))
        XCTAssertEqual(store.add("c", score: 0.9), .added(index: 2))
        XCTAssertEqual(store.add("d", score: 0.6), .replaced(index: 1), "b was the weakest")
        XCTAssertEqual(store.payloads, ["a", "d", "c"])
        XCTAssertEqual(store.add("e", score: 0.1), .dropped, "a photo worse than all the kept ones is not kept")
        XCTAssertEqual(store.payloads, ["a", "d", "c"])
        XCTAssertEqual(store.count, 3)
    }

    func testASteadyPhoneScoresHigherThanAMovingOne() {
        let steady = KeyframeStore<Int>.score(metresPerSecond: 0.05, degreesPerSecond: 3)
        let walking = KeyframeStore<Int>.score(metresPerSecond: 0.8, degreesPerSecond: 40)
        XCTAssertGreaterThan(steady, walking)
        XCTAssertLessThanOrEqual(steady, 1)
    }

    func testTheCardCounterNamesTheCornerToTapNext() {
        XCTAssertEqual(CardPhotoFlow.counter(onCard: true, count: 1), "Card corner 2 of 4")
        XCTAssertEqual(CardPhotoFlow.counter(onCard: false, count: 2), "Window corner 3 of 4")
        XCTAssertEqual(CardPhotoFlow.counter(onCard: false, count: 4), "Window: 4 corners set")
    }
}
