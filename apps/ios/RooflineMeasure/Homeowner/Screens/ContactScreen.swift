import RooflineCore
import SwiftUI

/// 12 Contact (ios-hw-12): where should we send your quote? Name, mobile, email, ZIP, and the two consent boxes whose words
/// come from the company verbatim (the server stores the version and the words as evidence). The button is named in the
/// consent sentence, so it says exactly "Send my request".
struct ContactScreen: View {
    @Environment(HomeownerStore.self) private var store
    @FocusState private var focus: ContactField?

    private var callback: Bool { store.requestStatus == .callback }

    var body: some View {
        @Bindable var store = store
        VStack(spacing: 0) {
            WCNavBar(title: "Your details", onBack: { store.pop() })
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    WCHeadline(text: callback ? "A few details so we can call" : "Where should we send your quote?",
                               subtitle: callback ? "A person calls you about your price. It takes a minute." : nil)
                    HStack(alignment: .top, spacing: 14) {
                        WCField(label: "First name", text: $store.contactDraft.firstName, content: .givenName, capitalization: .words, error: store.contactErrors[.firstName]) { focus = .lastName }
                            .focused($focus, equals: .firstName)
                        WCField(label: "Last name", text: $store.contactDraft.lastName, content: .familyName, capitalization: .words, error: store.contactErrors[.lastName]) { focus = .phone }
                            .focused($focus, equals: .lastName)
                    }
                    WCField(label: "Mobile", text: phoneBinding, prompt: "(501) 555-0177", keyboard: .phonePad, content: .telephoneNumber, capitalization: .never, mono: true, error: store.contactErrors[.phone], submitLabel: .next) { focus = .email }
                        .focused($focus, equals: .phone)
                    HStack(alignment: .top, spacing: 14) {
                        WCField(label: "Email", text: $store.contactDraft.email, keyboard: .emailAddress, content: .emailAddress, capitalization: .never, error: store.contactErrors[.email]) { focus = .zip }
                            .focused($focus, equals: .email)
                        WCField(label: "ZIP code", text: $store.contactDraft.zip, keyboard: .numberPad, content: .postalCode, capitalization: .never, mono: true, error: store.contactErrors[.zip], submitLabel: .done) { focus = nil }
                            .focused($focus, equals: .zip)
                            .frame(maxWidth: 140)
                    }
                    consent
                    HStack(spacing: 4) {
                        Text("We never sell your details.").foregroundStyle(Theme.ink3)
                        if let p = store.company.privacyUrl.flatMap(URL.init) { Link("Privacy", destination: p) }
                        Text("·").foregroundStyle(Theme.ink3)
                        if let t = store.company.termsUrl.flatMap(URL.init) { Link("Terms", destination: t) }
                    }
                    .wc(14, relativeTo: .footnote)
                    .foregroundStyle(Theme.blue)
                    if let e = store.contactError {
                        InfoPanel(icon: .alert, text: e, tint: Theme.warnTint, iconColor: Theme.warn)
                    }
                }
                .padding(.horizontal, Theme.gutter)
                .padding(.bottom, 24)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .wcFooter {
            WCPrimaryButton(title: "Send my request", isLoading: store.sendingContact, isEnabled: store.consent != nil) {
                focus = nil
                Task { await store.submitContact() }
            }
        }
        .wcScreenChrome()
        .task { await store.prepareContact() }
    }

    private var phoneBinding: Binding<String> {
        Binding(
            get: { store.contactDraft.phone },
            set: {
                store.contactDraft.phone = PhoneFormat.progressive($0)
                store.clearContactError(.phone)
            }
        )
    }

    /// The two boxes. The sentences are the company's, word for word.
    private var consent: some View {
        @Bindable var store = store
        return VStack(alignment: .leading, spacing: 14) {
            if let c = store.consent {
                ConsentRow(isOn: $store.contactDraft.contactConsent, text: c.text, note: "Needed to send your request.", strong: true, error: store.contactErrors[.consent]) {
                    store.clearContactError(.consent)
                }
                ConsentRow(isOn: $store.contactDraft.textConsent, text: c.textingText, note: "Optional.", strong: false, error: nil) {}
            } else {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Loading our consent wording…").wc(14, relativeTo: .footnote).foregroundStyle(Theme.ink3)
                    Spacer()
                    Button("Try again") { Task { await store.loadCompany() } }.wc(14, .medium, relativeTo: .footnote)
                }
            }
        }
        .padding(.top, 4)
    }
}

private struct ConsentRow: View {
    @Binding var isOn: Bool
    let text: String
    let note: String
    let strong: Bool
    let error: String?
    let changed: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                isOn.toggle()
                Haptics.tap()
                changed()
            } label: {
                HStack(alignment: .top, spacing: 14) {
                    WCCheckbox(isOn: isOn).padding(.top, 1)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(text).wc(14, .regular, relativeTo: .footnote).foregroundStyle(strong ? Theme.ink : Theme.ink2)
                            .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                        Text(note).wc(13, relativeTo: .footnote).foregroundStyle(Theme.ink3)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(text) \(note)")
            .accessibilityValue(isOn ? "Checked" : "Not checked")
            .accessibilityAddTraits(.isButton)
            if let e = error {
                Text(e).wc(13, .medium, relativeTo: .footnote).foregroundStyle(Theme.bad).padding(.leading, 38)
            }
        }
    }
}
