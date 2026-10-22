// swift-tools-version:5.8
// RooflineCore: the pure logic of Roofline Measure (geometry, corner ordering, plane fitting, outlier rejection,
// eighths, the sync outbox, the API's JSON types). No UIKit, ARKit or RoomPlan: it builds and is checked on a Mac.
//
// - The app (project.yml) depends on the library product "RooflineCore".
// - `swift test` runs Tests/RooflineCoreTests (XCTest; needs Xcode, or a toolchain that ships XCTest).
// - `swift run RooflineReplay <capture folder>` replays one capture the phone sent to the server's DEBUG_CAPTURES_DIR.
// - `swift run RooflineCoreChecks` runs the same checks without XCTest (scripts/check.sh does it with swiftc alone,
//   for a Mac with only a bare Command Line Tools install).
//
// Platforms are given as version strings so the manifest also loads with older tools (5.8 has no `.v14`/`.v17`).
import PackageDescription

let package = Package(
    name: "RooflineCore",
    platforms: [.macOS("14.0"), .iOS("17.0")],
    products: [
        .library(name: "RooflineCore", targets: ["RooflineCore"]),
        // For the app's test target (RooflineMeasureTests) to run the same checks
        .library(name: "RooflineCoreCheckSuite", targets: ["RooflineCoreCheckSuite"]),
    ],
    targets: [
        .target(name: "RooflineCore"),
        // The checks, as a library both runners use: one list, no drift between XCTest and the plain runner.
        .target(name: "RooflineCoreCheckSuite", dependencies: ["RooflineCore"]),
        .executableTarget(name: "RooflineCoreChecks", dependencies: ["RooflineCore", "RooflineCoreCheckSuite"]),
        // Mac-side: replays a capture the phone dumped (DebugCapture): depth finder, AI pick and refine, against what the phone did.
        .executableTarget(name: "RooflineReplay", dependencies: ["RooflineCore"]),
        .testTarget(name: "RooflineCoreTests", dependencies: ["RooflineCore", "RooflineCoreCheckSuite"]),
    ]
)
