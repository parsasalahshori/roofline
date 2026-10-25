import RooflineCore
import SwiftUI

/// 12 Contact (ios-hw-12): where should we send your quote? Name, mobile, email, ZIP, and the two consent boxes whose words
/// come from the company verbatim (the server stores the version and the words as evidence). The button is named in the
/// consent sentence, so it says exactly "Send my request".
/// A native `Form`: labelled rows with the right keyboard and content type for each, a switch for each consent and the privacy
/// and terms links in the section's footer.
struct ContactScreen: View {
    @Environment(HomeownerStore.self) private var store
    @Environment(\.dynamicTypeSize) private var typeSize
    @FocusState private var focus: ContactField?

    private var callback: Bool { store.requestStatus == .callback }

    var body: some View {
        @Bindable var store = store
        Form {
            Section {
                ContactFieldRow(label: "First name", text: $store.contactDraft.firstName, content: .givenName, capitalization: .words, error: store.contactErrors[.firstName]) { focus = .lastName }
                    .focused($focus, equals: .firstName)
                ContactFieldRow(label: "Last name", text: $store.contactDraft.lastName, content: .familyName, capitalization: .words, error: store.contactErrors[.lastName]) { focus = .phone }
                    .focused($focus, equals: .lastName)
            } header: {
                HiListHeading(title: callback ? "A few details so we can call" : "Where should we send your quote?",
                              subtitle: callback ? "A person calls you about your price. It takes a minute." : nil)
            }
            Section {
                ContactFieldRow(label: "Mobile", text: phoneBinding, prompt: "(501) 555-0177", keyboard: .phonePad, content: .telephoneNumber, capitalization: .never, error: store.contactErrors[.phone], submitLabel: .next) { focus = .email }
                    .focused($focus, equals: .phone)
                ContactFieldRow(label: "Email", text: $store.contactDraft.email, keyboard: .emailAddress, content: .emailAddress, capitalization: .never, error: store.contactErrors[.email]) { focus = .zip }
                    .focused($focus, equals: .email)
                ContactFieldRow(label: "ZIP code", text: $store.contactDraft.zip, keyboard: .numberPad, content: .postalCode, capitalization: .never, error: store.contactErrors[.zip], submitLabel: .done) { focus = nil }
                    .focused($focus, equals: .zip)
            }
            consent
            if let e = store.contactError {
                Section {
                    Label {
                        Text(e).font(.subheadline).foregroundStyle(Theme.ink)
                    } icon: {
                        Image(systemName: WCIcon.alert.symbol).foregroundStyle(Theme.warn)
                    }
                }
            }
            if typeSize.isAccessibilitySize {
                Section { WCScrollFooter() }
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .wcFooter {
            WCPrimaryButton(title: "Send my request", isLoading: store.sendingContact, isEnabled: store.consent != nil) {
                focus = nil
                Task { await store.submitContact() }
            }
        }
        .hiNav(title: "Your details")
        .task { await store.prepareContact() }
    }

    private var legalLine: AttributedString {
        var out = AttributedString("We never sell your details.")
        out.foregroundColor = Theme.ink2
        func add(_ title: String, _ url: URL) {
            var link = AttributedString(title)
            link.link = url
            link.foregroundColor = Theme.red
            out += AttributedString(" ") + link
        }
        let privacy = store.company.privacyUrl.flatMap(URL.init), terms = store.company.termsUrl.flatMap(URL.init)
        if let p = privacy { add("Privacy", p) }
        if privacy != nil, terms != nil {
            var dot = AttributedString(" \u{00B7}")
            dot.foregroundColor = Theme.ink2
            out += dot
        }
        if let t = terms { add("Terms", t) }
        return out
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

    /// The two switches. The sentences are the company's, word for word.
    @ViewBuilder private var consent: some View {
        let draft = Bindable(store)
        Section {
            if let c = store.consent {
                ConsentToggle(isOn: draft.contactDraft.contactConsent, text: c.text, note: "Needed to send your request.", strong: true, error: store.contactErrors[.consent]) {
                    store.clearContactError(.consent)
                }
                ConsentToggle(isOn: draft.contactDraft.textConsent, text: c.textingText, note: "Optional.", strong: false, error: nil) {}
            } else {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Loading our consent wording…").font(.footnote).foregroundStyle(Theme.ink2)
                    Spacer()
                    Button("Try again") { Task { await store.loadCompany() } }.font(.footnote.weight(.medium)).buttonStyle(.borderless)
                }
            }
        } footer: {
            // One line of text with two links, so it wraps like any sentence at any text size
            Text(legalLine)
        }
    }
}

/// A labelled text row of the form: the label on the leading side, the value after it (under it at the accessibility text sizes,
/// where a phone number or an email would not fit on one line and the value wraps), and the problem, when there is one, in words
/// with a symbol under the row.
private struct ContactFieldRow: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let label: String
    @Binding var text: String
    var prompt = "Required"
    var keyboard: UIKeyboardType = .default
    var content: UITextContentType?
    var capitalization: TextInputAutocapitalization = .sentences
    var error: String?
    var submitLabel: SubmitLabel = .next
    var onSubmit: (() -> Void)?

    private var wraps: Bool { typeSize.isAccessibilitySize }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if wraps {
                // Large text: the label above the value, each at the full width
                VStack(alignment: .leading, spacing: 2) {
                    Text(label).foregroundStyle(Theme.ink)
                    field
                }
            } else {
                LabeledContent {
                    field
                } label: {
                    Text(label)
                }
            }
            if let error = error {
                Label(error, systemImage: "exclamationmark.circle.fill")
                    .font(.footnote)
                    .foregroundStyle(Theme.badText)
                    .accessibilityLabel("\(label): \(error)")
            }
        }
    }

    private var field: some View {
        TextField(label, text: $text, prompt: Text(prompt).foregroundColor(Theme.ink2), axis: wraps ? .vertical : .horizontal)
            .lineLimit(wraps ? 1...6 : 1...1)
            .keyboardType(keyboard)
            .textContentType(content)
            .textInputAutocapitalization(capitalization)
            .autocorrectionDisabled(keyboard != .default)
            .submitLabel(submitLabel)
            .onSubmit { onSubmit?() }
            // Return still submits when the value wraps: the newline it types is taken out
            .onChange(of: text) { _, new in
                if wraps, new.contains("\n") {
                    text = new.replacingOccurrences(of: "\n", with: "")
                    onSubmit?()
                }
            }
            .multilineTextAlignment(wraps ? .leading : .trailing)
            .monospacedDigit()
            .foregroundStyle(Theme.ink)
            .accessibilityLabel(label)
    }
}

/// One consent as a switch row: the company's sentence and a line saying whether it is needed.
private struct ConsentToggle: View {
    @Binding var isOn: Bool
    let text: String
    let note: String
    let strong: Bool
    let error: String?
    let changed: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Toggle(isOn: $isOn) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(text).font(.subheadline).foregroundStyle(strong ? Theme.ink : Theme.ink2).fixedSize(horizontal: false, vertical: true)
                    Text(note).font(.footnote).foregroundStyle(Theme.ink2)
                }
            }
            .tint(Color(.systemGreen))
            .accessibilityLabel("\(text) \(note)")
            .onChange(of: isOn) { _, _ in changed() }
            if let e = error {
                Label(e, systemImage: "exclamationmark.circle.fill").font(.footnote.weight(.medium)).foregroundStyle(Theme.badText)
            }
        }
    }
}
