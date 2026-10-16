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
        VStack(spacing: 0) {
            WCNavBar(title: "Rooms", onBack: { store.pop() })
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    WCHeadline(text: "Go room by room", subtitle: "Pick a room, then measure each window in it. We count as you go.")
                    GroupHeader(text: "Your rooms").padding(.top, 24)
                    GroupCard {
                        ForEach(Array(store.rooms.enumerated()), id: \.offset) { i, room in
                            RoomRow(room: room, line: store.roomLine(room), done: store.roomHasWindows(room), suggested: room == target) { store.measure(room: room) }
                            if i < store.rooms.count - 1 { RowDivider(inset: 56) }
                        }
                    }
                    GroupHeader(text: "Add a room").padding(.top, 20)
                    GroupCard {
                        ForEach(Array(store.roomSuggestions.enumerated()), id: \.offset) { i, name in
                            Button {
                                if let added = store.addRoom(name) { Haptics.tap(); _ = added }
                            } label: {
                                HStack {
                                    Text(name).wc(17, relativeTo: .body).foregroundStyle(Theme.ink)
                                    Spacer()
                                    IconView(icon: .plus, size: 20, weight: 1.9).foregroundStyle(Theme.blue)
                                }
                                .padding(.horizontal, 14)
                                .frame(minHeight: 42)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Add \(name)")
                            RowDivider()
                        }
                        TextField("", text: $typed, prompt: Text("Type a room name…").foregroundColor(Theme.ink3))
                            .wc(17, relativeTo: .body)
                            .foregroundStyle(Theme.ink)
                            .focused($typing)
                            .submitLabel(.done)
                            .padding(.horizontal, 14)
                            .frame(minHeight: 46)
                            .onSubmit { addTyped() }
                            .accessibilityLabel("Type a room name")
                    }
                    WCScrollFooter()
                }
                .padding(.horizontal, Theme.gutter)
                .padding(.bottom, 24)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .wcFooter {
            if let target = target {
                WCPrimaryButton(title: "Measure \(target)") {
                    // A room typed but not added yet is added first
                    if let name = store.addRoom(typed) { typed = ""; store.measure(room: name) } else { store.measure(room: target) }
                }
            }
        }
        .wcScreenChrome()
    }

    private func addTyped() {
        if store.addRoom(typed) != nil {
            typed = ""
            Haptics.tap()
        }
        typing = false
    }
}

private struct RoomRow: View {
    let room: String
    let line: String
    let done: Bool
    let suggested: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                IconView(icon: done ? .check : .win, size: 18, weight: done ? 2 : 1.7)
                    .foregroundStyle(done ? Theme.ok : Theme.ink)
                    .frame(width: 30, height: 30)
                    .background(done ? Theme.okTint : Theme.surface2, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                VStack(alignment: .leading, spacing: 1) {
                    Text(room).wc(17, .semibold, relativeTo: .body).foregroundStyle(Theme.ink)
                    Text(line).wc(14, relativeTo: .subheadline).foregroundStyle(Theme.ink3)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if suggested && !done {
                    Text("Measure").wc(16, relativeTo: .body).foregroundStyle(Theme.ink3)
                }
                IconView(icon: .chevRight, size: 16, weight: 2).foregroundStyle(Theme.ink3)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .frame(minHeight: 60)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(room). \(line)")
        .accessibilityHint("Measure the windows in this room")
        .accessibilityAddTraits(.isButton)
    }
}
