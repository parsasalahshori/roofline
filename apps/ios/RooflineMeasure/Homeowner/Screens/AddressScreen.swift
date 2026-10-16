import CoreLocation
import SwiftUI

/// 02 Address (ios-hw-02): the address field, a map with the pin, "Yes, this is my home". Suggestions come from MapKit as
/// the homeowner types; the request is created (and the home looked up from above) when they confirm.
struct AddressScreen: View {
    @Environment(HomeownerStore.self) private var store
    @FocusState private var focused: Bool
    @State private var search = AddressSearch()
    @State private var suggestions: [AddressPlace] = []
    @State private var locating = false
    @State private var locator = LocationAddress()

    private var typed: String { store.addressText.trimmingCharacters(in: .whitespaces) }
    private var hasAddress: Bool { typed.count >= 5 }
    private var showCard: Bool { store.addressPlace != nil || store.addressLocked || (hasAddress && !focused) }

    var body: some View {
        @Bindable var store = store
        VStack(spacing: 0) {
            WCNavBar(title: store.brand.wordmark, wordmark: true, onBack: { store.pop() }) { StepDots(filled: 1) }
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    WCHeadline(text: "Where are the windows?", subtitle: "So we send the right local rep and check what your home's windows usually look like.")
                    field.padding(.top, 20)
                    if let error = store.addressError {
                        Text(error).wc(13, .medium, relativeTo: .footnote).foregroundStyle(Theme.bad).padding(.top, 8).padding(.horizontal, 4)
                            .accessibilityLabel("Problem: \(error)")
                    }
                    if !suggestions.isEmpty && focused {
                        suggestionList.padding(.top, 8)
                    } else {
                        mapCard.padding(.top, 12)
                        HStack(spacing: 10) {
                            IconView(icon: .lock, size: 16)
                            Text("We only use your address for this quote and your visit.").wc(13, relativeTo: .footnote)
                        }
                        .foregroundStyle(Theme.ink3)
                        .padding(.top, 12)
                        .padding(.horizontal, 4)
                        .accessibilityElement(children: .combine)
                    }
                }
                .padding(.horizontal, Theme.gutter)
                .padding(.bottom, 24)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .wcFooter {
            WCPrimaryButton(title: "Yes, this is my home", isLoading: store.creating, isEnabled: hasAddress && !store.creating) {
                focused = false
                Task { await store.confirmAddress() }
            }
        }
        .wcScreenChrome()
        .onAppear {
            search.onResults = { suggestions = $0 }
        }
    }

    private var field: some View {
        @Bindable var store = store
        return HStack(spacing: 10) {
            IconView(icon: .pin, size: 20).foregroundStyle(Theme.ink3)
            TextField("", text: $store.addressText, prompt: Text("Street address").foregroundColor(Theme.ink3))
                .wc(18, relativeTo: .body)
                .foregroundStyle(Theme.ink)
                .textContentType(.fullStreetAddress)
                .textInputAutocapitalization(.words)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .focused($focused)
                .disabled(store.addressLocked)
                .onChange(of: store.addressText) { _, text in
                    if store.addressPlace?.oneLine != text { store.addressPlace = nil }
                    store.addressError = nil
                    if focused { search.update(query: text) }
                }
                .onSubmit { focused = false }
                .accessibilityLabel("Street address")
            if locating {
                ProgressView()
            } else if !store.addressLocked {
                Button {
                    Task { await useLocation() }
                } label: {
                    IconView(icon: .target, size: 22).foregroundStyle(Theme.blue).frame(width: Theme.minTap, height: Theme.minTap)
                }
                .accessibilityLabel("Use my current location")
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, 4)
        .frame(minHeight: 54)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).strokeBorder(focused || showCard ? Theme.blue : Theme.line2, lineWidth: focused || showCard ? 2 : 1))
    }

    private var suggestionList: some View {
        VStack(spacing: 0) {
            ForEach(Array(suggestions.enumerated()), id: \.offset) { i, place in
                Button {
                    pick(place)
                } label: {
                    HStack(spacing: 12) {
                        IconView(icon: .pin, size: 18).foregroundStyle(Theme.ink3)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(place.title).wc(16, .semibold, relativeTo: .body).foregroundStyle(Theme.ink)
                            Text(AddressPlace.trimmedSubtitle(place.subtitle)).wc(13, relativeTo: .footnote).foregroundStyle(Theme.ink3)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 14)
                    .frame(minHeight: 56)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(place.title), \(AddressPlace.trimmedSubtitle(place.subtitle))")
                if i < suggestions.count - 1 { Divider().padding(.leading, 44) }
            }
        }
        .wcCard()
    }

    private var mapCard: some View {
        VStack(spacing: 0) {
            Group {
                if let c = store.addressPlace?.coordinate, CLLocationCoordinate2DIsValid(c) {
                    AddressMap(coordinate: c)
                } else {
                    StyledMap(streetName: streetName, showPin: showCard)
                }
            }
            .frame(height: 240)
            HStack(spacing: 12) {
                IconView(icon: .home, size: 22).foregroundStyle(Theme.ok)
                VStack(alignment: .leading, spacing: 1) {
                    Text(cardTitle).wc(17, .semibold, relativeTo: .headline).foregroundStyle(Theme.ink)
                    Text(cardLine).wc(14, relativeTo: .subheadline).foregroundStyle(Theme.ink3)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if !store.addressLocked && showCard {
                    Button("Edit") {
                        store.addressPlace = nil
                        focused = true
                    }
                    .wc(17, .medium, relativeTo: .body)
                    .foregroundStyle(Theme.blue)
                    .frame(minWidth: Theme.minTap, minHeight: Theme.minTap)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Theme.surface)
        }
        .clipShape(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
        .accessibilityElement(children: .contain)
    }

    /// "Ridgeway Dr": the street without its number or its city.
    private var streetName: String {
        let line = (store.addressPlace?.title ?? typed).split(separator: ",").first.map(String.init) ?? typed
        var words = line.split(separator: " ").map(String.init)
        if let first = words.first, first.first?.isNumber == true { words.removeFirst() }
        return words.isEmpty ? "Your street" : words.joined(separator: " ")
    }

    private var cardTitle: String {
        if let p = store.addressPlace { return p.title }
        let first = typed.split(separator: ",").first.map(String.init) ?? typed
        return first.isEmpty ? "Your address" : first
    }

    private var cardLine: String {
        if let p = store.addressPlace { return p.regionLine ?? AddressPlace.trimmedSubtitle(p.subtitle) }
        let rest = typed.split(separator: ",").dropFirst().joined(separator: ",").trimmingCharacters(in: .whitespaces)
        return rest.isEmpty ? "Check the pin is on your home" : rest
    }

    private func pick(_ place: AddressPlace) {
        focused = false
        suggestions = []
        store.addressText = place.oneLine
        store.addressPlace = place
        Task {
            let resolved = await search.resolve(place)
            // The homeowner may have changed their mind while it resolved
            if store.addressPlace == place {
                store.addressText = resolved.oneLine
                store.addressPlace = resolved
            }
        }
    }

    private func useLocation() async {
        locating = true
        defer { locating = false }
        if let place = await locator.find() {
            store.addressText = place.oneLine
            store.addressPlace = place
            suggestions = []
            focused = false
        } else {
            store.addressError = "We couldn't find where you are. Type your address instead."
        }
    }
}
