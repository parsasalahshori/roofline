#if STAFF_APP
#if DEBUG
import Foundation

/// DEBUG ONLY (compiled out of Release / TestFlight builds): launch arguments that drive the app without taps, for the
/// simulator and screenshots. Example:
///
///     xcrun simctl launch booted com.premjeetech.roofline.measure \
///       -debugSignIn owner@summitridge.test:summit-ridge-demo -debugSearch Ridgeway -debugOpenFirst \
///       -debugMeasure add -debugMethod roomplan
///
/// - `-debugServer URL`: server address for this launch (not saved).
/// - `-debugSignIn email:password`: sign in at launch when not signed in.
/// - `-debugSearch text`: type this into the Jobs search.
/// - `-debugOpenFirst`: open the first address the search returns.
/// - `-debugMeasurement id`: on the Windows screen, open this measurement when the server has no
///   `GET ?propertyId=` route (the demo on main), instead of offering a new one.
/// - `-debugStart`: tap "Start measuring windows" when the address has none (creates one on the server; prints its id).
/// - `-debugMeasure add|again`: open the measure chooser on the Windows screen (new window / the first window again).
/// - `-debugMethod ar|roomplan|sheet`: then open that method.
/// - `-debugSettings`: open Settings on the Jobs screen.
enum DebugLaunch {
    private static let args = ProcessInfo.processInfo.arguments

    private static func value(_ flag: String) -> String? {
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    static var server: String? { value("-debugServer") }

    static var signIn: (email: String, password: String)? {
        guard let v = value("-debugSignIn"), let colon = v.firstIndex(of: ":") else { return nil }
        return (String(v[..<colon]), String(v[v.index(after: colon)...]))
    }

    static var search: String? { value("-debugSearch") }
    static var openFirst: Bool { args.contains("-debugOpenFirst") }
    static var measure: String? { value("-debugMeasure") }
    static var method: String? { value("-debugMethod") }
    static var measurementId: String? { value("-debugMeasurement") }
    static var start: Bool { args.contains("-debugStart") }
    static var settings: Bool { args.contains("-debugSettings") }

    /// Each step runs once per launch (views re-appear when navigating back).
    @MainActor private static var done: Set<String> = []
    @MainActor static func once(_ step: String) -> Bool { done.insert(step).inserted }
}
#endif
#endif
