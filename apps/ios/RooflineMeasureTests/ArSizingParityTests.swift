import RooflineCore
import RooflineCoreCheckSuite
import XCTest

/// The Swift live preview against the server's own numbers: Fixtures/ar-sizing.json is written by the server's vitest
/// from sizeFromArPoints (pointsM + device -> expected sizes). Skipped until that file exists.
final class ArSizingParityTests: XCTestCase {
    /// The fixture, from the test bundle (XcodeGen copies Fixtures/*.json as resources) or next to this file.
    private func fixturePath() -> String? {
        if let url = Bundle(for: Self.self).url(forResource: "ar-sizing", withExtension: "json") { return url.path }
        let local = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/ar-sizing.json").path
        return FileManager.default.fileExists(atPath: local) ? local : nil
    }

    func testSwiftPortMatchesServerFixtures() async throws {
        guard let path = fixturePath() else {
            throw XCTSkip("Fixtures/ar-sizing.json is not there yet (the server change writes it).")
        }
        let cases = try loadArFixture(path: path)
        XCTAssertFalse(cases.isEmpty, "the fixture has cases")
        let ctx = CheckContext()
        try await arFixtureCheck(path: path).body(ctx)
        XCTAssertEqual(ctx.failures, [], "\(ctx.failures.count) mismatches in \(cases.count) cases")
    }

    func testAllCoreChecks() async {
        let report = await CoreChecks.run(fixturePath: fixturePath())
        XCTAssertEqual(report.failures, [])
        XCTAssertGreaterThan(report.assertions, 200)
    }

    func testGravityOrderFixesTapOrder() {
        let inch = 1 / inchesPerMetre
        let tl = Vec3(-18 * inch, 2, -1.5), tr = Vec3(18 * inch, 2, -1.5)
        let br = Vec3(18 * inch, 2 - 48 * inch, -1.5), bl = Vec3(-18 * inch, 2 - 48 * inch, -1.5)
        let size = sizeFromArPoints([br, tl, bl, tr])
        XCTAssertEqual(size?.widthIn ?? 0, 36, accuracy: 1e-9)
        XCTAssertEqual(size?.heightIn ?? 0, 48, accuracy: 1e-9)
        XCTAssertEqual(size?.quality, .good)
    }
}
