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
        VStack(spacing: 0) {
            WCNavBar(title: store.brand.wordmark, wordmark: true, onBack: { store.pop() })
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    WCHeadline(text: "We'll call you with your price", subtitle: "\(shortAddress). Usually the same day.")
                    InfoPanel(icon: .home, lead: reason.lead, text: reason.rest, tile: true).padding(.top, 20)
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Phone").wc(15, .semibold, relativeTo: .subheadline).foregroundStyle(Theme.ink2)
                        TextField("", text: $phone, prompt: Text("(501) 555-0142").foregroundColor(Theme.ink3))
                            .keyboardType(.phonePad)
                            .textContentType(.telephoneNumber)
                            .focused($focused)
                            .wc(19, relativeTo: .body)
                            .foregroundStyle(Theme.ink)
                            .padding(.horizontal, 14)
                            .frame(minHeight: 50)
                            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(phoneError == nil ? (focused ? Theme.blue : Theme.line2) : Theme.bad, lineWidth: focused || phoneError != nil ? 2 : 1))
                            .onChange(of: phone) { _, new in
                                let formatted = PhoneFormat.progressive(new)
                                if formatted != new { phone = formatted }
                                phoneError = nil
                            }
                            .accessibilityLabel("Phone number")
                        if let e = phoneError {
                            Text(e).wc(13, .medium, relativeTo: .footnote).foregroundStyle(Theme.badText)
                        }
                    }
                    .padding(.top, 22)
                    if store.features.bestTime { bestTimeRow.padding(.top, 18) }
                    WCScrollFooter()
                }
                .padding(.horizontal, Theme.gutter)
                .padding(.bottom, 24)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .wcFooter {
            WCPrimaryButton(title: CallbackCopy.button(bestTime: store.features.bestTime ? store.bestTime : nil)) { submit() }
            FinePrint(text: "We only call about this request.")
        }
        .wcScreenChrome()
        .onAppear { if phone.isEmpty { phone = store.contactDraft.phone } }
    }

    private var shortAddress: String {
        let parts = store.address.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        return parts.prefix(2).joined(separator: ", ")
    }

    private var bestTimeRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Best time to call").wc(15, .semibold, relativeTo: .subheadline).foregroundStyle(Theme.ink2)
            HStack(spacing: 12) {
                ForEach(["morning", "afternoon", "evening"], id: \.self) { t in
                    Button {
                        store.bestTime = store.bestTime == t ? nil : t
                    } label: {
                        let on = store.bestTime == t
                        Text(t.capitalized)
                            .wc(17, on ? .semibold : .regular, relativeTo: .body)
                            .foregroundStyle(on ? Theme.blue : Theme.ink)
                            .frame(maxWidth: .infinity, minHeight: 48)
                            .background(on ? Theme.blueTint : Theme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(on ? Theme.blue : Theme.line2, lineWidth: on ? 2 : 1))
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(store.bestTime == t ? .isSelected : [])
                }
            }
        }
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
        ScrollView {
        VStack(alignment: .leading, spacing: 0) {
            ZStack {
                Circle().fill(Theme.ok)
                IconView(icon: .phone, size: 24, weight: 1.7).foregroundStyle(.white)
            }
            .frame(width: 56, height: 56)
            .padding(.top, 8)
            .accessibilityHidden(true)
            Text("We'll call you")
                .wcHeading(30, .heavy, relativeTo: .largeTitle)
                .foregroundStyle(Theme.ink)
                .padding(.top, 20)
                .accessibilityAddTraits(.isHeader)
            Text(lead).wc(15, relativeTo: .subheadline).foregroundStyle(Theme.ink2).padding(.top, 6).fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 0) {
                row(icon: .pin, title: store.address, detail: "Your home")
                RowDivider(inset: 60)
                row(icon: .phone, title: phone ?? "The number you gave us", detail: "We only call about this request")
            }
            .wcCard(radius: 16)
            .padding(.top, 20)
            WCScrollFooter()
        }
        .padding(.horizontal, Theme.gutter)
        .padding(.top, 14)
        .padding(.bottom, 16)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .scrollBounceBehavior(.basedOnSize)
        .background(Theme.ground.ignoresSafeArea())
        .wcFooter {
            if let tel = store.companyPhone.flatMap(Self.telURL) {
                Link(destination: tel) {
                    HStack(spacing: 8) {
                        IconView(icon: .phone, size: 16, weight: 1.9)
                        Text("Call us instead").wc(17, .semibold, relativeTo: .headline)
                    }
                    .foregroundStyle(Theme.blue)
                    .frame(maxWidth: .infinity, minHeight: Theme.secondaryButtonHeight)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).strokeBorder(Theme.line2, lineWidth: 1))
                }
            }
            Button {
                confirmStartOver = true
            } label: {
                Text("Start a new request")
                    .wc(15, .medium, relativeTo: .subheadline)
                    .foregroundStyle(Theme.ink3)
                    .frame(maxWidth: .infinity, minHeight: Theme.minTap)
                    .contentShape(Rectangle())
            }
        }
        .confirmationDialog("Start a new request?", isPresented: $confirmStartOver, titleVisibility: .visible) {
            Button("Start a new request", role: .destructive) { store.startOver() }
            Button("Keep this one", role: .cancel) {}
        } message: {
            Text("This one stays with \(store.brand.name); the app will just stop showing it.")
        }
        .toolbar(.hidden, for: .navigationBar)
    }

    private var lead: String {
        "A \(store.brand.name) person will call about \(store.address.split(separator: ",").first.map(String.init) ?? "your home"). Usually the same day."
    }

    private func row(icon: WCIcon, title: String, detail: String) -> some View {
        HStack(spacing: 14) {
            IconTile(icon: icon, size: 36, iconSize: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).wc(16, .semibold, relativeTo: .body).foregroundStyle(Theme.ink)
                Text(detail).wc(13, relativeTo: .footnote).foregroundStyle(Theme.ink3)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .accessibilityElement(children: .combine)
    }

    static func telURL(_ phone: String) -> URL? {
        let digits = phone.filter { $0.isNumber || $0 == "+" }
        return digits.isEmpty ? nil : URL(string: "tel:\(digits)")
    }
}
