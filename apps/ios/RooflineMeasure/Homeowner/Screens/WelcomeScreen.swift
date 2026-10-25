import RooflineCore
import SwiftUI

/// 01 Welcome: what the app does, the way Apple's own "What's New" sheets say it: the name, three feature rows with a
/// symbol each, and one prominent Measure button. What to measure (windows or roof) is the next screen.
struct WelcomeScreen: View {
    @Environment(HomeownerStore.self) private var store
    @State private var showServerSetting = false

    var body: some View {
        // It scrolls when the text is large (it sits still when everything fits)
        ScrollView {
            VStack(alignment: .leading, spacing: 36) {
                header
                VStack(alignment: .leading, spacing: 26) {
                    WelcomeFeature(symbol: WCIcon.lidar.symbol, title: "Your iPhone does the measuring",
                                   line: "Point it at a window and it finds the size in about a minute.")
                    WelcomeFeature(symbol: WCIcon.roof.symbol, title: "Roofs measured from above",
                                   line: "Type your address and we size your roof from satellite pictures.")
                    WelcomeFeature(symbol: "dollarsign.circle", title: "A price range right away",
                                   line: "Good, Better and Best, before anyone comes to your home.")
                }
                WCScrollFooter()
            }
            .padding(.horizontal, 24)
            .padding(.top, 8)
            .padding(.bottom, 24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollBounceBehavior(.basedOnSize)
        .background(Theme.ground.ignoresSafeArea())
        .wcFooter {
            WCPrimaryButton(title: "Measure") { store.startMeasuring() }
            Label(store.brand.madeIn, systemImage: WCIcon.factory.symbol)
                .font(.footnote)
                .foregroundStyle(Theme.ink2)
                .padding(.bottom, 2)
                .accessibilityElement(children: .combine)
        }
        .hiNav(title: nil, showsBack: false)
        .sheet(isPresented: $showServerSetting) { ServerSettingSheet() }
    }

    /// The name, one line on what the app is for, and a sentence under it.
    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(store.brand.wordmark)
                .wcWordmark(.title2)
                .foregroundStyle(Theme.ink)
                .accessibilityAddTraits(.isHeader)
            Text("Measure your home from your phone.")
                .font(.largeTitle.weight(.bold))
                .foregroundStyle(Theme.ink)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Text("Windows or roof: see your price in minutes. A \(store.brand.name) expert confirms every size before anything is built.")
                .font(.body)
                .foregroundStyle(Theme.ink2)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // Held anywhere on the header: the server address is a tester's setting, never shown in the App Store build
        .contentShape(Rectangle())
        .onLongPressGesture(minimumDuration: 1.2) {
            if BuildEnvironment.isTesterBuild { showServerSetting = true }
        }
        .accessibilityElement(children: .contain)
    }
}

/// One line of what the app does, as a "What's New" row: a hierarchical symbol in the accent, a headline and a sentence.
private struct WelcomeFeature: View {
    let symbol: String
    let title: String
    let line: String

    var body: some View {
        HStack(alignment: .top, spacing: 16) {
            Image(systemName: symbol)
                .symbolRenderingMode(.hierarchical)
                .font(.title)
                .foregroundStyle(Theme.red)
                .frame(width: 44)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline).foregroundStyle(Theme.ink)
                Text(line).font(.subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
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
                if saved { Text("Saved. Using it now.").foregroundStyle(Theme.ink2) }
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
