import RooflineCore
import SwiftUI

/// 05 Rooms (ios-hw-05): go room by room. The homeowner's rooms with what is measured in each, a few to add, a field for
/// their own name, and one red button for the next room to measure.
struct RoomsScreen: View {
    @Environment(HomeownerStore.self) private var store
    @State private var typed = ""
    @FocusState private var typing: Bool

    var body: some View {
        let target = store.suggestedRoom
        List {
            Section {
                ForEach(Array(store.rooms.enumerated()), id: \.offset) { _, room in
                    RoomRow(room: room, line: store.roomLine(room), done: store.roomHasWindows(room), suggested: room == target) { store.measure(room: room) }
                }
            } header: {
                JourneyHeader {
                    JourneyLead("Pick a room, then measure each window in it. We count as you go.")
                }
            }
            Section {
                ForEach(Array(store.roomSuggestions.enumerated()), id: \.offset) { _, name in
                    Button {
                        if let added = store.addRoom(name) { Haptics.tap(); _ = added }
                    } label: {
                        HStack {
                            Text(name).font(.body).foregroundStyle(Theme.ink)
                            Spacer()
                            Image(systemName: WCIcon.plus.symbol)
                                .font(.body.weight(.semibold))
                                .accessibilityHidden(true)
                        }
                        .frame(minHeight: Theme.minTap)
                        .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Add \(name)")
                }
                TextField("", text: $typed, prompt: Text("Type a room name…").foregroundColor(Theme.ink2))
                    .font(.body)
                    .focused($typing)
                    .submitLabel(.done)
                    .frame(minHeight: Theme.minTap)
                    .onSubmit { addTyped() }
                    .accessibilityLabel("Type a room name")
            } header: {
                Text("Add a room").foregroundStyle(Theme.ink2)
            }
            if store.lastMethod != nil, let room = target ?? store.rooms.first {
                Section {
                    Button("Change how I measure") { store.changeMethod(room: room) }
                        .frame(maxWidth: .infinity, minHeight: Theme.minTap)
                }
            }
            JourneyListFooter()
        }
        .listStyle(.insetGrouped)
        .scrollDismissesKeyboard(.interactively)
        .hiNav(title: "Go room by room", display: .large)
        .wcFooter {
            if let target = target {
                WCPrimaryButton(title: "Measure \(target)") {
                    // A room typed but not added yet is added first
                    if let name = store.addRoom(typed) { typed = ""; store.measure(room: name) } else { store.measure(room: target) }
                }
            }
            // After the first window the way on to the list is one plain button
            if store.windowCount > 0 {
                WCSecondaryButton(title: "I'm done measuring") { store.showList() }
            }
        }
    }

    private func addTyped() {
        if store.addRoom(typed) != nil {
            typed = ""
            Haptics.tap()
        }
        typing = false
    }
}

/// A room, as a row: a symbol (a green check once a window is measured in it), the name, what is measured, a chevron.
private struct RoomRow: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let room: String
    let line: String
    let done: Bool
    let suggested: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            AdaptiveStack(alignment: .center, spacing: 14) {
                Group {
                    if done {
                        FilledSymbol(name: "checkmark.circle.fill", fill: Theme.okText)
                    } else {
                        Image(systemName: WCIcon.win.symbol).symbolRenderingMode(.hierarchical).foregroundStyle(Theme.ink2)
                    }
                }
                .font(.title3)
                .frame(width: 28)
                .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(room).font(.body.weight(.semibold)).foregroundStyle(Theme.ink)
                    Text(line).font(.subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if suggested && !done {
                    Text("Measure").font(.body).foregroundStyle(Theme.ink2)
                }
                if !typeSize.isAccessibilitySize {
                    Image(systemName: WCIcon.chevRight.symbol)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Theme.decor)
                        .accessibilityHidden(true)
                }
            }
            .padding(.vertical, 4)
            .frame(minHeight: Theme.minTap)
            .contentShape(Rectangle())
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(room). \(line)")
        .accessibilityHint("Measure the windows in this room")
        .accessibilityAddTraits(.isButton)
    }
}
