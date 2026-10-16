import Foundation
import RooflineCoreCheckSuite

// Runs every RooflineCore check without XCTest. Usage: RooflineCoreChecks [path/to/ar-sizing.json]
// Exit status 0 when all pass.

let args = CommandLine.arguments
let fixture: String? = args.count > 1 ? args[1] : {
    // From apps/ios/Core (swift run) or apps/ios (scripts)
    let candidates = ["../RooflineMeasureTests/Fixtures/ar-sizing.json", "RooflineMeasureTests/Fixtures/ar-sizing.json"]
    return candidates.first { FileManager.default.fileExists(atPath: $0) } ?? candidates[0]
}()

let report = await CoreChecks.run(fixturePath: fixture) { print($0) }
for s in report.skipped { print("skip \(s)") }
for f in report.failures { print("  FAILED: \(f)") }
print("\(report.checks) checks, \(report.assertions) assertions, \(report.failures.count) failures, \(report.skipped.count) skipped")
exit(report.passed ? 0 : 1)
