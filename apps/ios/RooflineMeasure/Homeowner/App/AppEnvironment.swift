import Foundation
import RooflineCore

/// Builds the store the app runs on: the real server and the Keychain, or (DEBUG, tests) the in-memory fake.
@MainActor
enum AppEnvironment {
    static var isRunningTests: Bool { ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil }

    /// Where the saved windows and their photos live: Application Support, not backed up (a lost phone's photos should not follow it).
    static func outboxDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("WinChoice", isDirectory: true)
        var dir = base.appendingPathComponent("outbox", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? dir.setResourceValues(values)
        return dir
    }

    /// The server's address: a tester's saved setting (Debug or TestFlight only), else the brand's for this build.
    static func serverURL(brand: Brand) -> URL? {
        if BuildEnvironment.isTesterBuild, let saved = ServerSetting.saved, let url = URL(string: saved) { return url }
        guard let s = brand.serverURL, let url = URL(string: s) else { return nil }
        return url
    }

    static func makeStore() -> HomeownerStore {
        let brand = Brand.current
        #if DEBUG
        let options = HomeownerDebug.Options(arguments: ProcessInfo.processInfo.arguments)
        if isRunningTests || options.fake { return HomeownerDebug.makeFakeStore(options, brand: brand) }
        if let server = options.server, let url = URL(string: server) {
            let store = makeLive(url: url, brand: brand, features: options.features)
            if options.e2e {
                let address = options.e2eAddress, services = options.e2eServices
                store.debugAfterLaunch = { store in await HomeownerE2E.run(store: store, address: address, services: services) }
            }
            if let go = options.go, let step = HomeownerStep(rawValue: go) { store.debugGo = step }
            return store
        }
        #endif
        // A build with no server address cannot work: point at an address that fails plainly ("couldn't reach WinChoice")
        let url = serverURL(brand: brand) ?? URL(string: "https://invalid.winchoice.example")!
        return makeLive(url: url, brand: brand, features: .contract)
    }

    private static func makeLive(url: URL, brand: Brand, features: HomeownerFeatures) -> HomeownerStore {
        let api = LiveHomeownerAPI(baseURL: url, slug: brand.slug, features: features)
        return HomeownerStore(api: api, vault: KeychainSessionVault(), progressStore: DefaultsProgressStore(), outboxDirectory: outboxDirectory(),
                              brand: brand, capabilities: DeviceCaps.measureCapabilities)
    }
}
