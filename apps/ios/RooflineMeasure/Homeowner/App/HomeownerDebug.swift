#if DEBUG
import Foundation
import RooflineCore

/// DEBUG-only launch arguments, for previews, screenshots and trying the app without the server:
///   -debugFake                  the in-memory fake server (305 Ridgeway Dr, Little Rock) instead of the real one
///   -debugScenario <name>       start at a screen of the journey with a request that already has what it needs
///   -debugServer <url>          the real server at this address (a local demo)
///   -debugStrict                the fake accepts only what the contract does (no window colour, no best time)
///   -debugCaps lidar|corners|card|none   what this phone claims it can measure with (the simulator has no camera)
///   -debugLatency <seconds>     how long each fake call takes
///   -debugE2E                   with -debugServer: walk the whole journey with synthetic windows and print "E2E ..." lines to stderr
///                               (-debugE2EAddress "<address>" and -debugE2EServices windows,roof pick what it asks for,
///                               -debugE2EPause <seconds> holds each main screen for a screenshot; run it with `xcrun simctl launch --console`)
///   -debugGo <step>             show a step of the saved request after opening (welcome address results coaching rooms list styles quote contact book booked status)
///   -debugCaptureDir <path>     write each Capture's debug dump (photo, depth, camera, result) into this folder instead of sending it to the server
///   -debugOpen <name>           open a measuring screen over the scenario's: hud, hud-howto, freeze, freeze-clutter, freeze-off, freeze-two, freeze-ai, freeze-ai-wall, label, scan, needs-iphone, needs-pro,
///                               card, card3, card4, window2, window4, windowdart (use with -debugScenario method)
enum HomeownerDebug {
    struct Options {
        var fake = false
        var scenario: String?
        var server: String?
        var strict = false
        var latency = 0.0
        var open: String?
        /// `-debugCaptureDir <path>`
        var captureDir: String?
        /// `-debugE2E [address]`: walk the whole journey against the server (with `-debugServer`).
        var e2e = false
        var e2eAddress = "4810 Underwood Ave, Omaha, NE 68132"
        /// `-debugGo <step>`: after opening, show this step of the saved request (live or fake).
        var go: String?
        /// `-debugE2EServices windows,roof` (any of them).
        var e2eServices: Set<HomeownerService> = [.windows, .roof]
        /// `-debugE2EPause <seconds>`: hold each main screen that long ("E2E show <screen>" is printed when it is up).
        var e2ePause = 0.0

        init(arguments: [String]) {
            func value(_ name: String) -> String? {
                guard let i = arguments.firstIndex(of: name), i + 1 < arguments.count else { return nil }
                return arguments[i + 1]
            }
            fake = arguments.contains("-debugFake") || value("-debugScenario") != nil
            scenario = value("-debugScenario")
            server = value("-debugServer")
            strict = arguments.contains("-debugStrict")
            latency = value("-debugLatency").flatMap(Double.init) ?? 0
            open = value("-debugOpen")
            captureDir = value("-debugCaptureDir")
            e2e = arguments.contains("-debugE2E")
            if let a = value("-debugE2EAddress") { e2eAddress = a }
            go = value("-debugGo")
            e2ePause = value("-debugE2EPause").flatMap(Double.init) ?? 0
            if let list = value("-debugE2EServices") {
                e2eServices = Set(list.split(separator: ",").compactMap { HomeownerService(rawValue: String($0)) })
            }
        }

        var features: HomeownerFeatures { strict ? .contract : .all }
    }

    @MainActor
    static func makeFakeStore(_ options: Options, brand: Brand) -> HomeownerStore {
        var config = FakeHomeownerAPI.Config()
        config.latency = options.latency
        let api = FakeHomeownerAPI(config: config, features: options.features)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("winchoice-debug-\(UUID().uuidString)", isDirectory: true)
        let store = HomeownerStore(api: api, vault: MemorySessionVault(), progressStore: MemoryProgressStore(), outboxDirectory: dir, brand: brand,
                                   capabilities: AppEnvironment.isRunningTests ? .none : DeviceCaps.measureCapabilities)
        store.debugPlan = { store in await HomeownerDebug.run(options, store: store, api: api) }
        store.debugCaptureFolder = options.captureDir.map { URL(fileURLWithPath: $0, isDirectory: true) }
        return store
    }

    /// Seeds the fake for a scenario and opens the screen.
    @MainActor
    static func run(_ options: Options, store: HomeownerStore, api: FakeHomeownerAPI) async {
        guard let name = options.scenario else { return }
        let seven = FakeWindowSpec.mockupSeven
        let two = [FakeWindowSpec.mockupSeven[1], FakeWindowSpec.mockupSeven[0]]
        let session: HomeownerSession?
        var step: HomeownerStep?
        switch name {
        case "welcome": session = nil
        case "address":
            session = nil
            store.addressText = "305 Ridgeway Dr, Little Rock, AR"
            step = .address
        case "results": session = await api.seed(); step = .results
        case "roofonly": session = await api.seed(services: [.roof]); step = .results
        case "callback":
            session = await api.seed(address: "2210 Leavenworth St, Little Rock, AR", services: [.windows])
            // The mockup shows the number typed and "Afternoon" picked
            store.contactDraft.phone = "(501) 555-0142"
            store.bestTime = "afternoon"
            step = .callback
        case "callbacksent":
            session = await api.seed(address: "2210 Leavenworth St, Little Rock, AR", services: [.windows], contact: true, callMe: true)
            store.contactDraft.phone = "(501) 555-0142"
            step = .callbackSent
        case "coaching": session = await api.seed(); step = .coaching
        case "rooms": session = await api.seed(windows: two); step = .rooms
        case "method": session = await api.seed(windows: two); step = .rooms
        // Two windows, one to look at: the list grouped by room fits above its pinned footer (seven would scroll under it, which the
        // accessibility audit reads as clipped text). `list7` is the long one.
        case "list7": session = await api.seed(windows: seven); step = .list
        case "list": session = await api.seed(windows: Array(seven.prefix(2))); step = .list
        case "styles": session = await api.seed(windows: seven); step = .styles
        case "quote": session = await api.seed(windows: seven); step = .quote
        case "contact":
            session = await api.seed(windows: seven)
            // The mockup shows the form filled in, the first box ticked and the text box not
            store.contactDraft = HomeownerContact(firstName: "Tia", lastName: "Bell", phone: "(501) 555-0177", email: "tia.bell@example.com", zip: "72205", contactConsent: true, textConsent: false)
            step = .contact
        case "book": session = await api.seed(windows: seven, contact: true); step = .book
        case "booked": session = await api.seed(windows: seven, contact: true, booked: true); step = .booked
        case "status": session = await api.seed(windows: seven, contact: true, booked: true, stage: .ordered); step = .status
        default: session = nil
        }
        if let session = session {
            try? store.vault.save(session)
            // What the homeowner picked on the quote screen, for the screens after it
            if ["quote", "contact", "book", "booked", "status"].contains(name) {
                var progress = HomeownerProgress()
                progress.tierKey = "better"
                progress.tierTotal = 5600
                progress.tierWindowCount = 7
                store.progressStore.save(progress, requestId: session.requestId)
            }
        }
        store.debugStep = step
        store.debugRoute = name == "method" ? .method(room: "Bedroom 1") : nil
        store.debugOpen = options.open
    }
}
#endif
