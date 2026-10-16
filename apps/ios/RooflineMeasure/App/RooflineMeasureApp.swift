import SwiftUI

@main
struct RooflineMeasureApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .task { await model.start() }
                .onChange(of: scenePhase) { _, phase in
                    // Back in the app: send whatever waited for a signal
                    if phase == .active { Task { await model.sync() } }
                }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        switch model.phase {
        case .starting:
            ProgressView("Starting…")
        case .signedOut:
            SignInView()
        case .signedIn:
            NavigationStack {
                JobsView()
            }
        }
    }
}
