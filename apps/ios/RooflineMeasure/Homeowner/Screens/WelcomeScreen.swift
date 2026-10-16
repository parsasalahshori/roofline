import RooflineCore
import SwiftUI

/// 01 Welcome: what are you looking for (ios-hw-01-welcome). A navy hero with the WinChoice wordmark, then one card per
/// service. Continue is the screen's one red button.
struct WelcomeScreen: View {
    @Environment(HomeownerStore.self) private var store
    @State private var showServerSetting = false

    var body: some View {
        // It scrolls when the text is large (it sits still when everything fits)
        ScrollView {
            VStack(spacing: 0) {
                hero
                VStack(alignment: .leading, spacing: 10) {
                    Text("What are you looking for? Pick one or more.")
                        .wc(15, .semibold, relativeTo: .subheadline)
                        .foregroundStyle(Theme.ink2)
                        .padding(.horizontal, 2)
                        .accessibilityAddTraits(.isHeader)
                    ForEach(store.offeredServices, id: \.self) { service in
                        ServiceOption(service: service, isOn: store.selectedServices.contains(service)) { store.toggle(service) }
                    }
                }
                .padding(Theme.gutter)
                WCScrollFooter().padding(.horizontal, Theme.gutter)
            }
            .frame(maxWidth: .infinity, alignment: .top)
        }
        .scrollBounceBehavior(.basedOnSize)
        .wcNoTopScrollFade()
        .background(Theme.ground.ignoresSafeArea())
        .ignoresSafeArea(edges: .top)
        .wcFooter {
            WCPrimaryButton(title: "Continue", icon: .arrow, isEnabled: !store.selectedServices.isEmpty) { store.continueFromWelcome() }
            HStack(spacing: 8) {
                IconView(icon: .factory, size: 16)
                Text(store.brand.madeIn).wc(12, .medium, relativeTo: .caption)
            }
            .foregroundStyle(Theme.ink3)
            .padding(.bottom, 2)
            .accessibilityElement(children: .combine)
        }
        // A navy hero under the status bar: its text must be white whatever the phone's appearance
        .toolbar(.visible, for: .navigationBar)
        .toolbarBackground(.hidden, for: .navigationBar)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .navigationBarBackButtonHidden(true)
        .sheet(isPresented: $showServerSetting) { ServerSettingSheet() }
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(store.brand.wordmark)
                .wcHeading(20, .heavy, relativeTo: .title3)
                .foregroundStyle(.white)
                .padding(.top, 10)
                .padding(.bottom, 26)
                .onLongPressGesture(minimumDuration: 1.5) {
                    // The server address is a tester's setting, never shown in the App Store build
                    if BuildEnvironment.isTesterBuild { showServerSetting = true }
                }
                .accessibilityAddTraits(.isHeader)
            Text("Measure your windows. Get your price tonight.")
                .wcHeading(30, .heavy, relativeTo: .largeTitle)
                .foregroundStyle(.white)
                .lineSpacing(-1)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 330, alignment: .leading)
                .accessibilityAddTraits(.isHeader)
            Text("Your iPhone measures each window in about a minute. A WinChoice rep checks every size before anything is built.")
                .wc(15, relativeTo: .subheadline)
                .foregroundStyle(Theme.heroText)
                .lineSpacing(3)
                .padding(.top, 10)
                .frame(maxWidth: 340, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 22)
        .padding(.top, StatusBar.height)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.navy)
        .accessibilityElement(children: .contain)
    }
}

/// One service card: icon tile, title, one line, a checkbox. Selected: blue ring and tint (the mockup's `.selc`).
struct ServiceOption: View {
    let service: HomeownerService
    let isOn: Bool
    let action: () -> Void

    private var icon: WCIcon {
        switch service {
        case .windows: return .win
        case .roof: return .roof
        case .gutters: return .gutter
        }
    }

    private var title: String {
        switch service {
        case .windows: return "Windows"
        case .roof: return "Roof"
        case .gutters: return "Gutters"
        }
    }

    private var line: String {
        switch service {
        case .windows: return "Measure with this app, instant quote"
        case .roof: return "Price range from above, then a free visit"
        case .gutters: return "Priced at your free visit"
        }
    }

    var body: some View {
        Button(action: {
            Haptics.tap()
            action()
        }) {
            HStack(spacing: 12) {
                IconTile(icon: icon, size: 44, iconSize: 22, selected: isOn, tint: isOn ? Color.clear : nil)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).wc(17, .semibold, relativeTo: .headline).foregroundStyle(Theme.ink)
                    Text(line).wc(13, relativeTo: .footnote).foregroundStyle(Theme.ink3).fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                WCCheckbox(isOn: isOn)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(minHeight: 68)
            .wcCard(selected: isOn)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title). \(line)")
        .accessibilityValue(isOn ? "Selected" : "Not selected")
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Double tap to \(isOn ? "unselect" : "select")")
    }
}

/// The status bar's height (the Dynamic Island area), for drawing a hero under it by hand.
enum StatusBar {
    @MainActor
    static var height: CGFloat {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        return scene?.statusBarManager?.statusBarFrame.height ?? 54
    }
}

/// The tester's hidden setting: where the server is (a TestFlight or Debug build only; takes effect after a restart).
struct ServerSettingSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var text = UserDefaults.standard.string(forKey: ServerSetting.key) ?? ""
    @State private var saved = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://example.com", text: $text)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                } header: {
                    Text("Server address")
                } footer: {
                    Text("For testers. Leave empty to use the built-in address. Close and reopen the app after changing it.")
                }
                if saved { Text("Saved. Close and reopen the app.").foregroundStyle(.secondary) }
            }
            .navigationTitle("Server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        ServerSetting.save(text)
                        saved = true
                    }
                }
            }
        }
        .presentationDetents([.medium])
    }
}

enum ServerSetting {
    static let key = "winchoice.serverURL"

    static func save(_ typed: String) {
        let trimmed = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            UserDefaults.standard.removeObject(forKey: key)
        } else if let normalized = ServerAddress.normalize(trimmed) {
            UserDefaults.standard.set(normalized, forKey: key)
        }
    }

    static var saved: String? { UserDefaults.standard.string(forKey: key) }
}
