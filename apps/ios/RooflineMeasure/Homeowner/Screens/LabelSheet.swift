import RooflineCore
import SwiftUI

/// 08 Label (ios-hw-08): the window just measured, its size, "Which room is it in?" and an optional name. Every method ends
/// here. A bottom sheet over the frozen camera picture.
/// A native sheet (medium-to-large detents) with a grouped list: the size, the room (a menu picker), the optional name and the
/// bathroom switch; Save, Measure it again and Discard (which asks first) at the bottom.
struct LabelSheet: View {
    @Environment(HomeownerStore.self) private var store
    @Environment(\.dynamicTypeSize) private var typeSize
    let pending: PendingWindow
    /// "Measure it again": the caller discards this one and starts the measure over.
    let onAgain: () -> Void
    @State private var room: String
    @State private var name = ""
    /// "Bathroom window?": frosted glass. Starts on when the room is a bathroom, and the homeowner can still change it.
    @State private var frosted: Bool
    @State private var frostedTouched = false
    @State private var saving = false
    @State private var confirmDiscard = false
    @State private var detent: PresentationDetent = .fraction(0.9)
    @FocusState private var nameFocused: Bool

    init(pending: PendingWindow, onAgain: @escaping () -> Void) {
        self.pending = pending
        self.onAgain = onAgain
        _room = State(initialValue: pending.room)
        _frosted = State(initialValue: RoomNames.type(of: pending.room) == .bathroom)
    }

    private var showable: WindowPreview? {
        guard let p = pending.preview, p.isShowable else { return nil }
        return p
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                List {
                    Section { sizeRow }
                    Section {
                        Picker("Which room is it in?", selection: roomType) {
                            ForEach(RoomType.allCases, id: \.self) { Text($0.chip).tag($0) }
                        }
                        .pickerStyle(.menu)
                        TextField("Name", text: $name, prompt: Text("Optional name, like \"\(room), front\"").foregroundColor(Theme.ink2))
                            .focused($nameFocused)
                            .submitLabel(.done)
                            .accessibilityLabel("Optional name for this window")
                    }
                    Section { bathroomRow }
                    // With large text the buttons would fill the sheet: they come at the end of what scrolls
                    if typeSize.isAccessibilitySize {
                        Section { VStack(spacing: 12) { buttons } }
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                    }
                }
                .listStyle(.insetGrouped)
                .scrollDismissesKeyboard(.interactively)
                if !typeSize.isAccessibilitySize {
                    // under the list, not over it: no row shows through the bar
                    VStack(spacing: 8) { buttons }
                        .padding(.horizontal, Theme.gutter)
                        .padding(.top, 12)
                        .padding(.bottom, 8)
                        .frame(maxWidth: .infinity)
                        .background(Theme.ground)
                        .overlay(alignment: .top) { Divider() }
                }
            }
            .navigationTitle("Check the size, then save")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.fraction(0.9), .large], selection: $detent)
        .onChange(of: nameFocused) { _, focused in
            if focused { detent = .large }
        }
        .presentationDragIndicator(.visible)
        .presentationBackground(Theme.ground)
        .interactiveDismissDisabled()
    }

    /// The room's type as the picker's choice; picking one names the room the way the chips did.
    private var roomType: Binding<RoomType> {
        Binding(
            get: { RoomNames.type(of: room) },
            set: { type in
                room = RoomNames.room(for: type, current: room, existing: store.rooms)
                if !frostedTouched { frosted = type == .bathroom }
            }
        )
    }

    /// "Bathroom window?": yes means frosted (privacy) glass, which adds to the price.
    private var bathroomRow: some View {
        Toggle(isOn: Binding(get: { frosted }, set: { frosted = $0; frostedTouched = true; Haptics.tap() })) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Bathroom window?").font(.body).foregroundStyle(Theme.ink)
                Text("Frosted glass, so no one can see in.").font(.footnote).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
            }
        }
        .tint(Color(.systemGreen))
        .accessibilityIdentifier("bathroom-toggle")
    }

    @ViewBuilder private var buttons: some View {
        WCPrimaryButton(title: "Save window \(pending.number)", isLoading: saving) {
            saving = true
            Task {
                await store.savePending(room: room, name: name, frosted: frosted)
                saving = false
            }
        }
        WCSecondaryButton(title: "Measure it again") { onAgain() }
        Button(role: .destructive) { confirmDiscard = true } label: {
            // the full-width, 44 pt area is the button's own, not just its word
            Text("Discard")
                .font(.body.weight(.medium))
                .foregroundStyle(Theme.badText)
                .frame(maxWidth: .infinity, minHeight: Theme.minTap)
                .contentShape(Rectangle())
        }
        .accessibilityHint("Throws this measured window away")
            .confirmationDialog("Discard this window?", isPresented: $confirmDiscard, titleVisibility: .visible) {
                Button("Discard", role: .destructive) {
                    Haptics.tap()
                    store.discardPending()
                }
                Button("Keep it", role: .cancel) {}
            } message: {
                Text("The size is lost.")
            }
    }

    /// The size just measured, as the first row: a status symbol and the size to the eighth, with what it is good for.
    private var sizeRow: some View {
        HStack(alignment: typeSize.isAccessibilitySize ? .top : .center, spacing: 14) {
            Image(systemName: showable == nil ? "clock.fill" : "checkmark.circle.fill")
                .font(.title)
                .foregroundStyle(showable == nil ? Theme.ink2 : Theme.ok)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                if let p = showable {
                    if pending.windowFrame != nil { Text("Opening").font(.footnote.weight(.medium)).foregroundStyle(Theme.ink2) }
                    SizeText(widthIn: p.widthIn, heightIn: p.heightIn, size: 34, weight: .semibold, unit: true)
                    if let frame = pending.windowFrame {
                        Text(frame.line).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
                    }
                    Text(subtitle(p)).font(.footnote).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
                    // A window's nominal size is its frame's: keyed to the window's own size when it was found, else to the opening's
                    if let line = pending.windowFrame.map({ StandardWindowSizes.line(widthIn: $0.widthIn, heightIn: $0.heightIn) }) ?? StandardWindowSizes.line(widthIn: p.widthIn, heightIn: p.heightIn) {
                        Text(line).font(.footnote.weight(.medium)).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
                    }
                } else {
                    Text("Window \(pending.number) measured").font(.headline).foregroundStyle(Theme.ink)
                    Text("The size comes after we upload your photo. A rep checks every size anyway.").font(.footnote).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    private func subtitle(_ p: WindowPreview) -> String {
        var s = "Window \(pending.number) measured"
        if let u = p.uncertaintyIn {
            if case .roomplan = pending.scale { s += " · \(SizeWording.plusMinus(u))" } else { s += " · accurate to \(SizeWording.accuracy(u))" }
        }
        if p.needsCheck { s += ". We confirm it at your free visit." }
        return s
    }
}
