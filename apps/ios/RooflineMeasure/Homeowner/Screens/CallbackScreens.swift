import RooflineCore
import SwiftUI

/// 03b Call-back (ios-hw-03b): "We'll call you with your price". For an apartment, a duplex or a home a phone should not
/// price: the reason in plain words, a phone number (and a best time when the server takes one). The details the server
/// needs to file a request come next (the contact screen), then a person calls.
struct CallbackScreen: View {
    @Environment(HomeownerStore.self) private var store
    @State private var phone = ""
    @State private var phoneError: String?
    @FocusState private var focused: Bool

    private var reason: CallbackCopy.Reason { CallbackCopy.reason(store.callbackReason) }

    var body: some View {
        @Bindable var store = store
        Form {
            Section {
                AdaptiveStack(alignment: .top, spacing: 14) {
                    Image(systemName: WCIcon.home.symbol)
                        .symbolRenderingMode(.hierarchical)
                        .font(.title2)
                        .foregroundStyle(Theme.ink2)
                        .frame(minWidth: 32, alignment: .leading)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(reason.lead).font(.headline).foregroundStyle(Theme.ink)
                        Text(reason.rest).font(.subheadline).foregroundStyle(Theme.ink2)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.vertical, 4)
                .accessibilityElement(children: .combine)
            } header: {
                JourneyHeader { JourneyLead("\(shortAddress). Usually the same day.") }
            }
            Section {
                TextField("", text: $phone, prompt: Text("(501) 555-0142").foregroundColor(Theme.ink2))
                    .keyboardType(.phonePad)
                    .textContentType(.telephoneNumber)
                    .focused($focused)
                    .font(.title3)
                    .frame(minHeight: Theme.minTap)
                    .onChange(of: phone) { _, new in
                        let formatted = PhoneFormat.progressive(new)
                        if formatted != new { phone = formatted }
                        phoneError = nil
                    }
                    .accessibilityLabel("Phone number")
            } header: {
                Text("Phone").foregroundStyle(Theme.ink2)
            } footer: {
                if let e = phoneError {
                    Text(e).font(.footnote.weight(.medium)).foregroundStyle(Theme.badText)
                }
            }
            if store.features.bestTime {
                Section {
                    Picker("Best time to call", selection: $store.bestTime) {
                        Text("Any time").tag(String?.none)
                        ForEach(["morning", "afternoon", "evening"], id: \.self) { t in
                            Text(t.capitalized).tag(String?.some(t))
                        }
                    }
                    .frame(minHeight: Theme.minTap)
                }
            }
            JourneyListFooter()
        }
        .scrollDismissesKeyboard(.interactively)
        .hiNav(title: "We'll call you", display: .large)
        .wcFooter {
            WCPrimaryButton(title: CallbackCopy.button(bestTime: store.features.bestTime ? store.bestTime : nil)) { submit() }
            FinePrint(text: "We only call about this request.")
        }
        .onAppear { if phone.isEmpty { phone = store.contactDraft.phone } }
    }

    private var shortAddress: String {
        let parts = store.address.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        return parts.prefix(2).joined(separator: ", ")
    }

    private func submit() {
        guard PhoneFormat.digits(phone) != nil else {
            phoneError = ContactValidation.phoneMessage
            Haptics.warning()
            return
        }
        focused = false
        store.continueFromCallback(phone: phone)
    }
}

/// After the call-back request is sent (or "Call me to pick a time"): what happens next, in a few calm lines. The request
/// stays here when the app is opened again.
struct CallbackSentScreen: View {
    @Environment(HomeownerStore.self) private var store
    @State private var confirmStartOver = false

    private var phone: String? {
        let p = store.contactDraft.phone
        return p.isEmpty ? nil : p
    }

    var body: some View {
        List {
            Section {
                row(icon: .pin, title: store.address, detail: "Your home")
                row(icon: .phone, title: phone ?? "The number you gave us", detail: "We only call about this request")
            } header: {
                JourneyHeader {
                    FilledSymbol(name: "phone.circle.fill", fill: Theme.okText)
                        .font(.system(size: 56))
                    JourneyLead(lead)
                }
            }
            JourneyListFooter()
        }
        .listStyle(.insetGrouped)
        .hiNav(title: "We'll call you", display: .large, showsBack: false)
        .wcFooter {
            if let tel = store.companyPhone.flatMap(Self.telURL) {
                CallUsButton(url: tel)
            }
            Button("Start a new request") {
                confirmStartOver = true
            }
            .frame(maxWidth: .infinity, minHeight: Theme.minTap)
            .contentShape(Rectangle())
        }
        .confirmationDialog("Start a new request?", isPresented: $confirmStartOver, titleVisibility: .visible) {
            Button("Start a new request", role: .destructive) { store.startOver() }
            Button("Keep this one", role: .cancel) {}
        } message: {
            Text("This one stays with \(store.brand.name); the app will just stop showing it.")
        }
    }

    private var lead: String {
        "A \(store.brand.name) person will call about \(store.address.split(separator: ",").first.map(String.init) ?? "your home"). Usually the same day."
    }

    private func row(icon: WCIcon, title: String, detail: String) -> some View {
        HStack(spacing: 14) {
            Image(systemName: icon.symbol)
                .symbolRenderingMode(.hierarchical)
                .font(.title3)
                .foregroundStyle(Theme.ink2)
                .frame(width: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body.weight(.semibold)).foregroundStyle(Theme.ink)
                Text(detail).font(.footnote).foregroundStyle(Theme.ink2)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    static func telURL(_ phone: String) -> URL? {
        let digits = phone.filter { $0.isNumber || $0 == "+" }
        return digits.isEmpty ? nil : URL(string: "tel:\(digits)")
    }
}

/// "Call us instead": a bordered button that opens the phone app.
private struct CallUsButton: View {
    let url: URL

    var body: some View {
        Link(destination: url) {
            Label("Call us instead", systemImage: WCIcon.phone.symbol)
                .font(.headline)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
        .tint(Theme.ink)
    }
}

/// After the interest form on the estimate path: "Thanks, Tia. WinChoice will call you soon." with a way back to the new windows
/// and "Done" (My order). The request stays here when the app is opened again.
struct CallThanksScreen: View {
    @Environment(HomeownerStore.self) private var store

    private var firstName: String? {
        let n = store.contactDraft.firstName.trimmingCharacters(in: .whitespaces)
        return n.isEmpty ? nil : n
    }

    private var phone: String? {
        let p = store.contactDraft.phone
        return p.isEmpty ? nil : p
    }

    private var thanks: String { firstName.map { "Thanks, \($0)." } ?? "Thanks." }

    private var estimateLine: String? {
        guard let total = store.progress.tierTotal, let count = store.progress.tierWindowCount else { return nil }
        return "\(count) window\(count == 1 ? "" : "s"), about \(Money.dollars(total))"
    }

    var body: some View {
        List {
            Section {
                row(icon: .pin, title: store.address, detail: "Your home")
                row(icon: .phone, title: phone ?? "The number you gave us", detail: "We only call about this request")
                if let line = estimateLine { row(icon: .win, title: line, detail: "Your estimate") }
            } header: {
                JourneyHeader {
                    FilledSymbol(name: "checkmark.circle.fill", fill: Theme.okText)
                        .font(.system(size: 56))
                    Text(thanks).font(.title.weight(.bold)).foregroundStyle(Theme.ink)
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityIdentifier("thanks.title")
                    JourneyLead("\(store.brand.name) will call you with your estimate.")
                        .accessibilityIdentifier("thanks.line")
                }
            }
            JourneyListFooter()
        }
        .listStyle(.insetGrouped)
        .hiNav(title: nil, showsBack: false)
        .wcFooter {
            WCPrimaryButton(title: "Done") { store.showStatus() }
                .accessibilityIdentifier("thanks.done")
        }
    }

    private func row(icon: WCIcon, title: String, detail: String) -> some View {
        HStack(spacing: 14) {
            Image(systemName: icon.symbol)
                .symbolRenderingMode(.hierarchical)
                .font(.title3)
                .foregroundStyle(Theme.ink2)
                .frame(width: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body.weight(.semibold)).foregroundStyle(Theme.ink)
                Text(detail).font(.footnote).foregroundStyle(Theme.ink2)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}
