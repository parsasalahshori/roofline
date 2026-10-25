import SwiftUI

/// WinChoice: the homeowner's app. One store, one navigation stack (RootView).
@main
struct WinChoiceApp: App {
    @State private var store = AppEnvironment.makeStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .tint(Theme.red)
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { store.appBecameActive() }
                }
        }
    }
}
