import XCTest
import RooflineCoreCheckSuite

/// `swift test` (or Xcode): every RooflineCore check, plus the server-parity fixture when it is there.
final class RooflineCoreTests: XCTestCase {
    func testAllCoreChecks() async throws {
        // apps/ios/Core/Tests/RooflineCoreTests/ -> apps/ios/RooflineMeasureTests/Fixtures/ar-sizing.json
        let fixture = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("RooflineMeasureTests/Fixtures/ar-sizing.json").path
        let report = await CoreChecks.run(fixturePath: fixture) { print($0) }
        for s in report.skipped { print("skip \(s)") }
        XCTAssertEqual(report.failures, [], "\(report.failures.count) of \(report.assertions) assertions failed")
    }
}
