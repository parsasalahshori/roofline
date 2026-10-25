import RooflineCore
import SwiftUI

/// 01 Welcome: the WinChoice hero, what the app does in three lines, and one red Measure button. What to measure (windows
/// or roof) is the next screen.
struct WelcomeScreen: View {
    @Environment(HomeownerStore.self) private var store
    @State private var showServerSetting = false

    var body: some View {
        // It scrolls when the text is large (it sits still when everything fits)
        ScrollView {
            VStack(spacing: 0) {
                hero
                VStack(alignment: .leading, spacing: 10) {
                    WelcomePoint(icon: .lidar, title: "Your iPhone does the measuring",
                                 line: "Point it at a window and it finds the size in about a minute.")
                    WelcomePoint(icon: .roof, title: "Roofs measured from above",
                                 line: "Type your address and we size your roof from satellite pictures.")
                    WelcomePoint(icon: .clock, title: "A price range right away",
                                 line: "Good, Better and Best, before anyone comes to your home.")
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
            WCPrimaryButton(title: "Measure", icon: .arrow) { store.startMeasuring() }
            HStack(spacing: 8) {
                IconView(icon: .factory, size: 16)
                Text(store.brand.madeIn).wc(12, .medium, relativeTo: .caption)
            }
            .foregroundStyle(Theme.ink3)
            .padding(.bottom, 2)
            .accessibilityElement(children: .combine)
        }
        .toolbar(.visible, for: .navigationBar)
        .toolbarBackground(.hidden, for: .navigationBar)
        .navigationBarBackButtonHidden(true)
        .sheet(isPresented: $showServerSetting) { ServerSettingSheet() }
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(store.brand.wordmark)
                .wcWordmark(.title3)
                .foregroundStyle(.primary)
                .padding(.top, 10)
                .padding(.bottom, 30)
                .accessibilityAddTraits(.isHeader)
            HStack(spacing: 10) {
                HeroBadge(icon: .win)
                HeroBadge(icon: .roof)
            }
            .padding(.bottom, 18)
            .accessibilityHidden(true)
            Text("Measure your home from your phone.")
                .wcHeading(32, .bold, relativeTo: .largeTitle)
                .foregroundStyle(.primary)
                .lineSpacing(-1)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 330, alignment: .leading)
                .accessibilityAddTraits(.isHeader)
            Text("Windows or roof: see your price in minutes. A \(store.brand.name) expert confirms every size before anything is built.")
                .wc(15, relativeTo: .subheadline)
                .foregroundStyle(Theme.heroText)
                .lineSpacing(3)
                .padding(.top, 12)
                .frame(maxWidth: 340, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 28)
        .padding(.top, StatusBar.height)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.ground)
        // Held anywhere on the hero, not just the wordmark: the wordmark sits under the transparent navigation
        // bar, which takes its touches, so a hold on it alone never fired on a phone.
        .contentShape(Rectangle())
        .onLongPressGesture(minimumDuration: 1.2) {
            // The server address is a tester's setting, never shown in the App Store build
            if BuildEnvironment.isTesterBuild { showServerSetting = true }
        }
        .accessibilityElement(children: .contain)
    }
}

/// An accent icon on a quiet tile, in the hero.
private struct HeroBadge: View {
    let icon: WCIcon

    var body: some View {
        IconView(icon: icon, size: 26, weight: 1.8)
            .foregroundStyle(Theme.red)
            .frame(width: 52, height: 52)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

/// One line of what the app does: an icon tile, a title and a sentence.
private struct WelcomePoint: View {
    let icon: WCIcon
    let title: String
    let line: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            IconTile(icon: icon, size: 40, iconSize: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).wc(16, .semibold, relativeTo: .headline).foregroundStyle(Theme.ink)
                Text(line).wc(13, relativeTo: .footnote).foregroundStyle(Theme.ink3).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
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

/// The tester's hidden setting: where the server is and which company to ask for (a TestFlight, Debug or server-less Release
/// build only). Saving applies at once: no restart.
struct ServerSettingSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(HomeownerStore.self) private var store
    @State private var text = UserDefaults.standard.string(forKey: ServerSetting.key) ?? ""
    @State private var slug = UserDefaults.standard.string(forKey: ServerSetting.slugKey) ?? ""
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
                    Text("For testers. Leave empty to use the built-in address.")
                }
                Section {
                    TextField(store.brand.slug, text: $slug)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Company")
                } footer: {
                    Text("The company's quote name on that server. Leave empty for \(store.brand.slug).")
                }
                if saved { Text("Saved. Using it now.").foregroundStyle(.secondary) }
            }
            .navigationTitle("Server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        ServerSetting.save(text)
                        ServerSetting.saveSlug(slug)
                        saved = true
                        Task {
                            await store.applyServerSettings()
                            dismiss()
                        }
                    }
                }
            }
        }
        .presentationDetents([.medium])
    }
}

enum ServerSetting {
    static let key = "winchoice.serverURL"
    static let slugKey = "winchoice.companySlug"

    static func save(_ typed: String) {
        let trimmed = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            UserDefaults.standard.removeObject(forKey: key)
        } else if let normalized = ServerAddress.normalize(trimmed) {
            UserDefaults.standard.set(normalized, forKey: key)
        }
    }

    static func saveSlug(_ typed: String) {
        let clean = typed.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            .filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
        if clean.isEmpty { UserDefaults.standard.removeObject(forKey: slugKey) } else { UserDefaults.standard.set(clean, forKey: slugKey) }
    }

    static var saved: String? { UserDefaults.standard.string(forKey: key) }
    static var savedSlug: String? { UserDefaults.standard.string(forKey: slugKey) }
}
