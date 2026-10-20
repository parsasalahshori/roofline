import Foundation
import SwiftUI

/// One company's face in the homeowner app: its name, the quote slug the server knows it by, where the server is for each
/// build configuration, and the product words that are the company's (what its tiers include, its colours). The file is
/// Brand/WinChoice/WinChoice.json; another company would be another JSON and another target. The look itself (type,
/// layout, status colours) is Roofline's "Chalk Line" and does not change per company (REDESIGN.md 7.5).
struct Brand: Decodable, Equatable {
    struct Server: Decodable, Equatable {
        var debug: String?
        var release: String?
    }

    struct Colors: Decodable, Equatable {
        var red: String
        var redDark: String
        var navy: String
        var navyDeep: String
        var blue: String
        var blueDark: String
    }

    struct Tier: Decodable, Equatable {
        var summary: String
        var badge: String?
    }

    struct WindowColor: Decodable, Equatable, Identifiable {
        var key: String
        var label: String
        var hex: String
        var id: String { key }
    }

    var name: String
    var appStoreName: String
    /// Text only: no logo image is used (REDESIGN.md 8.1).
    var wordmark: String
    /// The company's instant-quote slug: the homeowner API lives under /api/public/homeowner/:slug.
    var slug: String
    var server: Server
    var colors: Colors
    var madeIn: String
    var factoryPlace: String
    var glassNote: String
    var includes: [String]
    var tiers: [String: Tier]
    var windowColors: [WindowColor]
    var quoteFootnote: String

    /// The server for this build configuration (Debug: the local demo; Release: set in the JSON, or entered on the phone in
    /// a TestFlight build). Nil when there is none.
    var serverURL: String? {
        #if DEBUG
        let s = server.debug ?? server.release
        #else
        let s = server.release
        #endif
        guard let s = s, !s.isEmpty else { return nil }
        return s
    }

    /// The brand of this build.
    static let current: Brand = {
        guard let url = Bundle.main.url(forResource: "WinChoice", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let brand = try? JSONDecoder().decode(Brand.self, from: data) else {
            // A missing or broken brand file is a packaging mistake: say so loudly in Debug, fall back to plain defaults in Release
            assertionFailure("WinChoice.json is missing or does not decode")
            return Brand.fallback
        }
        return brand
    }()

    static let fallback = Brand(
        name: "WinChoice", appStoreName: "WinChoice", wordmark: "WinChoice", slug: "summit-ridge",
        server: Server(debug: "http://localhost:4500", release: ""),
        colors: Colors(red: "#ED3A2B", redDark: "#FF5A4B", navy: "#112337", navyDeep: "#061F3F", blue: "#155EAB", blueDark: "#6EA8EF"),
        madeIn: "Vinyl windows made in Mountain Pine, Arkansas", factoryPlace: "Mountain Pine, Arkansas",
        glassNote: "Every window comes with LoE366 glass with argon and a FlexScreen.",
        includes: ["Made to your sizes in Mountain Pine, Arkansas", "FlexScreen on every window that opens"],
        tiers: [
            "good": Tier(summary: "Vinyl double-hung and sliders, standard install", badge: nil),
            "better": Tier(summary: "LoE366 glass with argon, full-frame install, lifetime warranty", badge: "Most picked"),
            "best": Tier(summary: "Triple-pane glass, full-frame install", badge: nil),
        ],
        windowColors: [
            WindowColor(key: "white", label: "White", hex: "#F7F7F4"), WindowColor(key: "beige", label: "Beige", hex: "#E6DCC6"),
            WindowColor(key: "sandstone", label: "Sandstone", hex: "#CDBB9C"), WindowColor(key: "earthtone", label: "Earthtone", hex: "#7A6650"),
            WindowColor(key: "bronze", label: "Bronze", hex: "#4E3B2C"), WindowColor(key: "black", label: "Black", hex: "#1D1F22"),
        ],
        quoteFootnote: "No payment today."
    )
}

/// Where the build runs, for the few things that differ (the hidden server setting is for testers only).
enum BuildEnvironment {
    /// A Debug build, or one installed from TestFlight (its receipt is called sandboxReceipt). Never the App Store.
    static var isTesterBuild: Bool {
        #if DEBUG
        return true
        #else
        // TestFlight, or an Xcode-installed Release build of a brand with no server in its file (the tester must be able to set one)
        if Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt" { return true }
        return (Brand.current.server.release ?? "").isEmpty
        #endif
    }
}
