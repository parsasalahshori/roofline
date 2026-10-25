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

    /// The question this screen asks, and why: the lead under the title.
    private var question: String { store.services.contains(.windows) ? "Where are the windows?" : "Where's your home?" }

    private var subtitle: String {
        store.services.contains(.windows)
            ? "So we send the right local rep and check what your home's windows usually look like."
            : "So we can measure your roof from above and send the right local rep."
    }

    private var showingSuggestions: Bool { !suggestions.isEmpty && focused }

    var body: some View {
        List {
            Section {
                field
                if let error = store.addressError { errorRows(error) }
                if showingSuggestions {
                    ForEach(Array(suggestions.enumerated()), id: \.offset) { _, place in suggestionRow(place) }
                }
            } header: {
                JourneyHeader {
                    VStack(alignment: .leading, spacing: 4) {
                        JourneyLead(question, heading: true)
                        JourneyLead(subtitle)
                    }
                    StepProgress(step: 2)
                }
            }
            if !showingSuggestions {
                Section {
                    mapRow
                    addressRow
                } footer: {
                    Label("We only use your address for this quote and your visit.", systemImage: WCIcon.lock.symbol)
                        .font(.footnote)
                        .foregroundStyle(Theme.ink2)
                }
            }
            JourneyListFooter()
        }
        .listStyle(.insetGrouped)
        .scrollDismissesKeyboard(.interactively)
        .hiNav(title: "Your address", display: .large)
        .wcFooter {
            WCPrimaryButton(title: "Yes, this is my home", isLoading: store.creating, isEnabled: hasAddress && !store.creating) {
                focused = false
                Task { await store.confirmAddress() }
            }
        }
        .alert(
            "Start over at this address?",
            isPresented: Binding(get: { store.pendingAddressChange != nil }, set: { if !$0 { store.pendingAddressChange = nil } })
        ) {
            Button("Start over") { Task { await store.confirmAddressChange() } }
            Button("Keep my windows", role: .cancel) {}
        } message: {
            Text("The \(store.windowCount) windows you measured are for your old address. A new address starts a new quote.")
        }
        .onAppear {
            search.onResults = { suggestions = $0 }
        }
    }

    /// The address row: a pin, the field (a long address wraps to three lines instead of being cut off) and "use my location".
    private var field: some View {
        @Bindable var store = store
        return HStack(spacing: 10) {
            Image(systemName: WCIcon.pin.symbol)
                .symbolRenderingMode(.hierarchical)
                .font(.title3)
                .foregroundStyle(Theme.ink2)
                .accessibilityHidden(true)
            TextField("", text: $store.addressText, prompt: Text("Street address").foregroundColor(Theme.ink2), axis: .vertical)
                .lineLimit(1...3)
                .font(.body)
                .foregroundStyle(Theme.ink)
                .textContentType(.fullStreetAddress)
                .textInputAutocapitalization(.words)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .focused($focused)
                .disabled(store.addressLocked)
                .onChange(of: store.addressText) { _, text in
                    // Return ends the entry (the field is several lines tall, so it would add a line break)
                    if text.contains("\n") {
                        store.addressText = text.replacingOccurrences(of: "\n", with: "")
                        focused = false
                        return
                    }
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
                    Image(systemName: "location")
                        .font(.title3)
                        .frame(width: Theme.minTap, height: Theme.minTap)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Use my current location")
            }
        }
        .frame(minHeight: Theme.minTap)
    }

    /// A problem with the address, in words, under the field; "Try again" when the phone was offline.
    @ViewBuilder private func errorRows(_ error: String) -> some View {
        Text(error)
            .font(.footnote.weight(.medium))
            .foregroundStyle(Theme.badText)
            .accessibilityLabel("Problem: \(error)")
        if error == LiveHomeownerAPI.offlineMessage {
            Button("Try again") {
                focused = false
                Task {
                    if !store.companyLoaded { await store.loadCompany() }
                    await store.confirmAddress()
                }
            }
            .buttonStyle(.borderless)
            .frame(minHeight: Theme.minTap, alignment: .leading)
        }
    }

    private func suggestionRow(_ place: AddressPlace) -> some View {
        Button {
            pick(place)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: WCIcon.pin.symbol)
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(Theme.ink2)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(place.title).font(.body.weight(.semibold)).foregroundStyle(Theme.ink)
                    Text(AddressPlace.trimmedSubtitle(place.subtitle)).font(.footnote).foregroundStyle(Theme.ink2)
                }
                Spacer(minLength: 0)
            }
            .frame(minHeight: Theme.minTap)
            .contentShape(Rectangle())
        }
        .accessibilityLabel("\(place.title), \(AddressPlace.trimmedSubtitle(place.subtitle))")
    }

    /// The map with the pin, edge to edge in its group.
    private var mapRow: some View {
        Group {
            if let c = store.addressPlace?.coordinate, CLLocationCoordinate2DIsValid(c) {
                AddressMap(coordinate: c)
            } else {
                StyledMap(streetName: streetName, showPin: showCard)
            }
        }
        .frame(height: 240)
        .listRowInsets(EdgeInsets())
    }

    /// Under the map: the home found, with "Edit".
    private var addressRow: some View {
        HStack(spacing: 12) {
            Image(systemName: WCIcon.home.symbol)
                .symbolRenderingMode(.hierarchical)
                .font(.title2)
                .foregroundStyle(Theme.ok)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(cardTitle).font(.headline).foregroundStyle(Theme.ink)
                Text(cardLine).font(.subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if !store.addressLocked && showCard {
                Button("Edit") {
                    store.addressPlace = nil
                    focused = true
                }
                .buttonStyle(.borderless)
                .frame(minWidth: Theme.minTap, minHeight: Theme.minTap)
            }
        }
        .frame(minHeight: Theme.minTap)
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
