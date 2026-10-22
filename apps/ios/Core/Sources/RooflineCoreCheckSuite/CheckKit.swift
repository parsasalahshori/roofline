import Foundation

// A tiny check runner, so the same checks run under XCTest (Xcode) and as a plain executable (a Mac with only the
// Command Line Tools, where XCTest and swift-testing are not installed).

public final class CheckContext {
    public private(set) var failures: [String] = []
    public private(set) var assertions = 0
    public private(set) var skipped: [String] = []
    var current = ""

    public init() {}

    public func expect(_ condition: Bool, _ message: @autoclosure () -> String = "", line: UInt = #line) {
        assertions += 1
        if !condition { failures.append("\(current) (line \(line)): \(message())") }
    }

    public func equal<T: Equatable>(_ a: T, _ b: T, _ message: String = "", line: UInt = #line) {
        expect(a == b, "\(message) expected \(b), got \(a)", line: line)
    }

    public func near(_ a: Double?, _ b: Double, _ tol: Double = 1e-9, _ message: String = "", line: UInt = #line) {
        guard let a = a else {
            expect(false, "\(message) expected \(b), got nil", line: line)
            return
        }
        expect(abs(a - b) <= tol, "\(message) expected \(b) ± \(tol), got \(a)", line: line)
    }

    public func skip(_ why: String) {
        skipped.append("\(current): \(why)")
    }
}

public struct Check {
    public let name: String
    public let body: (CheckContext) async throws -> Void

    public init(_ name: String, _ body: @escaping (CheckContext) async throws -> Void) {
        self.name = name
        self.body = body
    }
}

public struct CheckReport {
    public var checks: Int
    public var assertions: Int
    public var failures: [String]
    public var skipped: [String]

    public var passed: Bool { failures.isEmpty }
}

public enum CoreChecks {
    /// Runs every check. `fixturePath`: apps/ios/RooflineMeasureTests/Fixtures/ar-sizing.json (skipped when absent).
    public static func run(fixturePath: String?, log: (String) -> Void = { _ in }) async -> CheckReport {
        let ctx = CheckContext()
        let list = all(fixturePath: fixturePath)
        for c in list {
            ctx.current = c.name
            let before = ctx.failures.count
            do {
                try await c.body(ctx)
            } catch {
                ctx.expect(false, "threw \(error)")
            }
            log("\(ctx.failures.count == before ? "ok  " : "FAIL") \(c.name)")
        }
        return CheckReport(checks: list.count, assertions: ctx.assertions, failures: ctx.failures, skipped: ctx.skipped)
    }

    public static func all(fixturePath: String?) -> [Check] {
        geometryChecks + sizingChecks + samplingChecks + captureChecks + formatChecks + apiChecks + outboxChecks + miscChecks + cardChecks + autoCornerChecks + homeownerChecks + [arFixtureCheck(path: fixturePath)]
    }
}
