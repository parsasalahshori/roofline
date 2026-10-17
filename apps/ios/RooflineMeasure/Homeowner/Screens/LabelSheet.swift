import RooflineCore
import SwiftUI

/// 08 Label (ios-hw-08): the window just measured, its size, "Which room is it in?" and an optional name. Every method ends
/// here. A bottom sheet over the frozen camera picture.
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
    @State private var detent: PresentationDetent = .fraction(0.74)
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
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    sizeCard
                    Text("Which room is it in?").wcHeading(22, .heavy, relativeTo: .title2).foregroundStyle(Theme.ink).padding(.top, 22).accessibilityAddTraits(.isHeader)
                    FlowLayout(spacing: 8, lineSpacing: 10) {
                        ForEach(RoomType.allCases, id: \.self) { type in
                            WCChip(title: type.chip, isOn: RoomNames.type(of: room) == type) {
                                room = RoomNames.room(for: type, current: room, existing: store.rooms)
                                if !frostedTouched { frosted = type == .bathroom }
                            }
                        }
                    }
                    .padding(.top, 12)
                    TextField("", text: $name, prompt: Text("Optional name, like \"\(room), front\"").foregroundColor(Theme.ink3))
                        .wc(17, relativeTo: .body)
                        .foregroundStyle(Theme.ink)
                        .focused($nameFocused)
                        .submitLabel(.done)
                        .padding(.horizontal, 14)
                        .frame(minHeight: 50)
                        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(nameFocused ? Theme.blue : Theme.line2, lineWidth: nameFocused ? 2 : 1))
                        .padding(.top, 16)
                        .accessibilityLabel("Optional name for this window")
                    bathroomRow.padding(.top, 16)
                    // With large text the buttons would fill the sheet: they come at the end of what scrolls
                    if typeSize.isAccessibilitySize { buttons.padding(.top, 20) }
                }
                .padding(.horizontal, Theme.gutter)
                .padding(.top, 14)
                .padding(.bottom, 12)
            }
            .scrollDismissesKeyboard(.interactively)
            if !typeSize.isAccessibilitySize {
                buttons
                    .padding(.horizontal, Theme.gutter)
                    .padding(.bottom, 8)
                    .padding(.top, 6)
            }
        }
        .background(Theme.ground)
        .presentationDetents([.fraction(0.74), .large], selection: $detent)
        .onChange(of: nameFocused) { _, focused in
            if focused { detent = .large }
        }
        .presentationDragIndicator(.visible)
        .presentationBackground(Theme.ground)
        .presentationCornerRadius(28)
        .interactiveDismissDisabled()
    }

    /// "Bathroom window?": yes means frosted (privacy) glass, which adds to the price.
    private var bathroomRow: some View {
        Toggle(isOn: Binding(get: { frosted }, set: { frosted = $0; frostedTouched = true; Haptics.tap() })) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Bathroom window?").wc(17, .medium, relativeTo: .body).foregroundStyle(Theme.ink)
                Text("Frosted glass, so no one can see in.").wc(14, relativeTo: .footnote).foregroundStyle(Theme.ink3).fixedSize(horizontal: false, vertical: true)
            }
        }
        .tint(Theme.blue)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(minHeight: 56)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.line2, lineWidth: 1))
        .accessibilityIdentifier("bathroom-toggle")
    }

    private var buttons: some View {
        VStack(spacing: 10) {
            WCPrimaryButton(title: "Save window \(pending.number)", isLoading: saving) {
                saving = true
                Task {
                    await store.savePending(room: room, name: name, frosted: frosted)
                    saving = false
                }
            }
            WCSecondaryButton(title: "Measure it again") { onAgain() }
        }
    }

    private var sizeCard: some View {
        HStack(alignment: .center, spacing: 14) {
            ZStack {
                Circle().fill(showable == nil ? Theme.info : Theme.ok)
                IconView(icon: showable == nil ? .clock : .check, size: 20, weight: 2.2).foregroundStyle(.white)
            }
            .frame(width: 34, height: 34)
            VStack(alignment: .leading, spacing: 3) {
                if let p = showable {
                    SizeText(widthIn: p.widthIn, heightIn: p.heightIn, size: 24, weight: .semibold, unit: true)
                    Text(subtitle(p)).wc(14, relativeTo: .footnote).foregroundStyle(Theme.ink3).fixedSize(horizontal: false, vertical: true)
                } else {
                    Text("Window \(pending.number) measured").wc(18, .semibold, relativeTo: .headline).foregroundStyle(Theme.ink)
                    Text("The size comes after we upload your photo. A rep checks every size anyway.").wc(14, relativeTo: .footnote).foregroundStyle(Theme.ink3).fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(14)
        .wcCard(radius: 14)
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
