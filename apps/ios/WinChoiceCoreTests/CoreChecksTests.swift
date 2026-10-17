import RooflineCore
import RooflineCoreCheckSuite
import XCTest

/// The RooflineCore check suite (the pure logic of the app: sizes, wording, outbox, resume, forms) runs here too, so a
/// change that breaks a homeowner rule fails the WinChoice scheme's tests as well as `Core/scripts/check.sh`.
final class CoreChecksTests: XCTestCase {
    func testAllCoreChecks() async {
        let report = await CoreChecks.run(fixturePath: nil)
        XCTAssertEqual(report.failures, [])
        XCTAssertGreaterThan(report.assertions, 1000)
    }
}
