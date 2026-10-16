import RooflineCore
import SwiftUI

/// Email and password. The server address is a hidden setting: press and hold the title.
struct SignInView: View {
    @Environment(AppModel.self) private var model
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?
    @State private var showServer = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Roofline Measure")
                            .font(.largeTitle.bold())
                            .onLongPressGesture(minimumDuration: 1.2) { showServer = true }
                            .accessibilityAction(named: "Server address") { showServer = true }
                        Text("Measure windows on site with the phone's camera.")
                            .foregroundStyle(.secondary)
                    }
                    .listRowBackground(Color.clear)
                }
                Section {
                    TextField("Email", text: $email)
                        .textContentType(.username)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                        .onSubmit { Task { await signIn() } }
                }
                if let error = error {
                    Section {
                        Text(error).foregroundStyle(.red)
                    }
                }
                Section {
                    Button {
                        Task { await signIn() }
                    } label: {
                        HStack {
                            Text("Sign in")
                            if busy { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(busy || email.isEmpty || password.isEmpty)
                }
                if model.pendingCount > 0 {
                    Section {
                        Label("\(model.pendingCount) window(s) are saved on this phone and will be sent after you sign in.", systemImage: "tray.full")
                            .font(.footnote)
                    }
                }
            }
            .sheet(isPresented: $showServer) { ServerSettingsView() }
        }
    }

    private func signIn() async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await model.signIn(email: email, password: password)
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Hidden: the Roofline server's address (default http://localhost:4500; testers use the Tailscale https address).
struct ServerSettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var invalid = false
    @State private var check: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(ServerAddress.defaultURL, text: $text)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Server address")
                } footer: {
                    Text("For example https://your-mac.tailnet-name.ts.net (Tailscale Serve) or http://192.168.1.20:4500 on the same Wi-Fi.")
                }
                if invalid {
                    Text("Enter an http or https address with no path.").foregroundStyle(.red)
                }
                if let check = check {
                    Text(check).font(.footnote)
                }
                Section {
                    Button("Test connection") { Task { await test() } }
                    Button("Reset to \(ServerAddress.defaultURL)") { text = ServerAddress.defaultURL }
                }
            }
            .navigationTitle("Server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        if model.setServer(text) { dismiss() } else { invalid = true }
                    }
                }
            }
            .onAppear { text = model.serverURL }
        }
    }

    private func test() async {
        guard let s = ServerAddress.normalize(text), let url = URL(string: s)?.appendingPathComponent("health") else {
            invalid = true
            return
        }
        invalid = false
        check = "Checking…"
        do {
            let (_, response) = try await URLSession.shared.data(from: url)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            check = code == 200 ? "The server answered." : "The server answered \(code)."
        } catch {
            check = APIClient.networkMessage(error)
        }
    }
}
