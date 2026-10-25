import RooflineCore
import SwiftUI

/// 10 Your windows (ios-hw-10): every measured window with its size, which are sure and which need a check, "Did we miss
/// any?" against what homes like theirs have, and the way on to styles and the quote.
struct ListScreen: View {
    @Environment(HomeownerStore.self) private var store
    @State private var actionRow: WindowRow?
    @State private var askTotal = false
    @State private var total = 8

    private var rows: [WindowRow] { store.windowRows }

    private func addRoom() {
        store.path = store.stack(to: .rooms)
        store.noteStep(.rooms)
    }

    var body: some View {
        List {
            if !rows.isEmpty {
                Section {
                    SummaryRow(rows: rows)
                } header: {
                    JourneyHeader { JourneyLead("Sizes are the inside of each frame, in inches.") }
                }
                // One group per room, each with its own "add a window" row
                ForEach(WindowGroups.group(rows, roomOrder: store.rooms)) { group in
                    Section {
                        ForEach(group.rows) { row in
                            WindowListRow(row: row, action: { actionRow = row }, onAgain: { Task { await store.measureAgain(row) } })
                                .listRowBackground(rowBackground(highlighted: row.id == store.justSavedId))
                                .animation(.easeOut(duration: 0.4), value: store.justSavedId)
                                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                    Button(role: .destructive) {
                                        Task { await store.removeWindow(row.id) }
                                    } label: {
                                        Label("Remove", systemImage: "trash")
                                    }
                                    Button {
                                        Task { await store.measureAgain(row) }
                                    } label: {
                                        Label("Measure again", systemImage: WCIcon.refresh.symbol)
                                    }
                                    .tint(Color(.systemGray))
                                }
                        }
                        AddRow(title: "Add a window in \(group.room)") { store.measure(room: group.room) }
                    } header: {
                        Text(group.header).foregroundStyle(Theme.ink2)
                    }
                }
                Section {
                    AddRow(title: "Add another room") { addRoom() }
                }
            }
            if store.sendingCount > 0 || !store.failedItems.isEmpty { Section { sendingNote } }
            if store.heldCount > 0 { Section { heldNote } }
            Section {
                missRow
            } header: {
                if rows.isEmpty { JourneyHeader { JourneyLead("Sizes are the inside of each frame, in inches.") } }
            }
            JourneyListFooter()
        }
        .listStyle(.insetGrouped)
        .hiNav(title: rows.isEmpty ? "No windows yet" : "\(rows.count) window\(rows.count == 1 ? "" : "s") measured", display: .large) {
            NavTextButton(title: "Add") { addRoom() }
        }
        .wcFooter {
            WCPrimaryButton(title: footerTitle, icon: .arrow, isEnabled: !rows.isEmpty) {
                Task { await store.continueFromList() }
            }
        }
        .confirmationDialog(actionRow.map { "\($0.title) · \($0.sizeTextWithUnit)" } ?? "", isPresented: Binding(get: { actionRow != nil }, set: { if !$0 { actionRow = nil } }), titleVisibility: .visible, presenting: actionRow) { row in
            Button("Measure again") { Task { await store.measureAgain(row) } }
            Button("Remove this window", role: .destructive) { Task { await store.removeWindow(row.id) } }
            Button("Cancel", role: .cancel) {}
        } message: { row in
            Text((row.flagged ? row.lookReason + ". " : "") + "Your current size is kept until you save the new one.")
        }
        .sheet(isPresented: $askTotal) { TotalSheet(initial: total) { n in Task { await store.setTotalWindows(n) } } }
        .onAppear {
            total = store.quote.map { max($0.windowCount, rows.count + 1) } ?? max(rows.count + 1, store.windowEstimate?.high ?? 8)
        }
    }

    private var footerTitle: String {
        if store.hasBooking { return store.unstyledCount > 0 ? "Choose window styles" : "Back to My order" }
        return "Choose window styles"
    }

    /// The row's ground: the grouped row colour, with a green wash for the window just saved.
    private func rowBackground(highlighted: Bool) -> some View {
        ZStack {
            Theme.surface
            if highlighted { Theme.okTint }
        }
    }

    /// "Did we miss any?": what homes like theirs have, and "I have more" for telling us the real count.
    private var missRow: some View {
        AdaptiveStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Did we miss any?").font(.headline).foregroundStyle(Theme.ink)
                Text(WindowCountHint.detail(measured: rows.count, estimate: store.windowEstimate))
                    .font(.subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button("I have more") { askTotal = true }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .tint(Theme.ink)
                .accessibilityHint("Tell us how many windows your home has")
        }
        .padding(.vertical, 4)
    }

    /// Windows wait on the phone for their style: said plainly, only while there are any.
    private var heldNote: some View {
        Label {
            Text("Saved on this phone. They're sent to WinChoice when you pick styles.")
                .font(.subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: WCIcon.lock.symbol).symbolRenderingMode(.hierarchical).foregroundStyle(Theme.ink2)
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var sendingNote: some View {
        if let first = store.failedItems.first {
            Label {
                Text(first.lastError ?? "A window could not be sent.")
                    .font(.subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: WCIcon.alert.symbol).symbolRenderingMode(.hierarchical).foregroundStyle(Theme.warnText)
            }
            .accessibilityElement(children: .combine)
        } else if let held = store.heldBackNote {
            // The server asked the phone to wait: its sentence, calmly. They go by themselves when the wait is over.
            Label {
                Text("Saved on this phone. \(held)")
                    .font(.subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: WCIcon.clock.symbol).symbolRenderingMode(.hierarchical).foregroundStyle(Theme.ink2)
            }
            .accessibilityElement(children: .combine)
        } else {
            HStack(spacing: 10) {
                ProgressView()
                Text(store.offline ? "Saved on this phone. They send when you're back online." : "Sending \(store.sendingCount) window\(store.sendingCount == 1 ? "" : "s")…")
                    .font(.subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
        }
    }
}

/// "6 ready · 1 needs a look" with a progress bar of how many are ready. "Ready for a quote" only when none needs a look.
private struct SummaryRow: View {
    let rows: [WindowRow]

    var body: some View {
        let checks = rows.filter { $0.flagged }.count
        VStack(alignment: .leading, spacing: 10) {
            AdaptiveStack(spacing: 4) {
                Label {
                    Text(Self.line(count: rows.count, checks: checks)).font(.headline).foregroundStyle(Theme.ink)
                } icon: {
                    FilledSymbol(name: checks == 0 ? "checkmark.circle.fill" : "exclamationmark.triangle.fill",
                                 fill: checks == 0 ? Theme.okText : Theme.warnText)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if checks == 0 { Text("Ready for a quote").font(.headline).foregroundStyle(Theme.okText) }
            }
            ProgressView(value: Double(rows.count - checks), total: Double(max(rows.count, 1)))
                .tint(checks == 0 ? Theme.ok : Theme.warn)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(checks == 0 ? "\(rows.count) windows ready. Ready for a quote." : "\(rows.count - checks) windows ready, \(checks) need a look.")
    }

    static func line(count: Int, checks: Int) -> String {
        checks == 0 ? "\(count) ready" : "\(count - checks) ready · \(checks) need\(checks == 1 ? "s" : "") a look"
    }
}

/// "Add a window in Kitchen": an accent row at the end of a group.
private struct AddRow: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: { Haptics.tap(); action() }) {
            Label {
                Text(title)
            } icon: {
                FilledSymbol(name: "plus.circle.fill", fill: Theme.buttonFill, glyph: .white)
            }
            .frame(maxWidth: .infinity, minHeight: Theme.minTap, alignment: .leading)
            .contentShape(Rectangle())
        }
        .accessibilityLabel(title)
    }
}

/// A measured window as a row: its number, name and how it was measured, its size on the right. A window to look at again says
/// why and has its button right there. Used by the list and by the status screen.
struct WindowListRow: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let row: WindowRow
    var highlighted = false
    let action: () -> Void
    var onAgain: () -> Void = {}

    private var large: Bool { typeSize.isAccessibilitySize }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            rowButton
            // A window to look at again says why, and has its button right there
            if row.flagged, case .failed = row.send {} else if row.flagged {
                Button(action: onAgain) {
                    Text("Measure again")
                        .frame(minHeight: Theme.minTap, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .padding(.leading, 40)
                .accessibilityLabel("Measure window \(row.number) again")
            }
        }
        .background(highlighted ? Theme.okTint : Color.clear)
        .animation(.easeOut(duration: 0.4), value: highlighted)
    }

    /// The window's number in a circle (the system's own numbered symbols to 50): orange when it needs a look.
    @ViewBuilder private var numberBadge: some View {
        if (1...50).contains(row.number) {
            FilledSymbol(name: "\(row.number).circle.fill", fill: row.flagged ? Theme.warnText : Theme.ink2)
                .font(.title2)
                .frame(width: 28)
        } else {
            Text("\(row.number)")
                .font(.footnote.weight(.bold)).monospacedDigit()
                .foregroundStyle(.white)
                .frame(width: 28, height: 28)
                .background(row.flagged ? Theme.warnText : Theme.ink2, in: Circle())
        }
    }

    private var rowButton: some View {
        Button(action: action) {
            HStack(alignment: large ? .top : .center, spacing: 12) {
                numberBadge
                    .padding(.top, large ? 4 : 0)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title).font(.body.weight(.semibold)).foregroundStyle(Theme.ink).lineLimit(nil)
                    secondLine
                    if let line = row.windowSizeLine {
                        Text(line).font(.footnote.weight(.medium)).foregroundStyle(Theme.ink2).lineLimit(nil)
                    }
                    if let line = row.standardSizeLine {
                        Text(line).font(.footnote).foregroundStyle(Theme.ink2).lineLimit(nil)
                    }
                    // With large text the size goes under the name instead of beside it
                    if large { sizeView }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .multilineTextAlignment(.leading)
                if !large { sizeView }
            }
            .padding(.vertical, 6)
            .frame(minHeight: Theme.minTap)
            .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Window \(row.number), \(row.title). \(row.spokenSize). \(row.flagged ? "Needs a look. \(row.lookReason). " : "")\(statusWords)\(row.spokenWindowSize.map { ". \($0)" } ?? "")\(row.standardSizeLine.map { ". \($0)" } ?? "")")
        .accessibilityHint("Opens options for this window")
        .accessibilityAddTraits(.isButton)
    }

    @ViewBuilder private var sizeView: some View {
        if row.hasSize, let w = row.widthIn, let h = row.heightIn {
            if large {
                SizeText(widthIn: w, heightIn: h, size: 17, weight: .bold, relativeTo: .body)
            } else {
                SizeText(widthIn: w, heightIn: h, size: 17, weight: .bold, relativeTo: .body).fixedSize()
            }
        } else {
            Text("Size after upload").font(.footnote).foregroundStyle(Theme.ink2)
        }
    }

    private var statusWords: String {
        switch row.send {
        case .sent: return row.methodLine
        case .sending: return "Sending."
        case .waiting: return "Waiting for a connection."
        case .needsStyle: return "Needs a style."
        case .failed(let m): return "Could not be sent. \(m)"
        }
    }

    @ViewBuilder private var secondLine: some View {
        switch row.send {
        case .failed(let m):
            Label {
                Text("Not sent, measure again").font(.subheadline.weight(.medium)).foregroundStyle(Theme.warnText)
            } icon: {
                Image(systemName: WCIcon.alert.symbol).symbolRenderingMode(.hierarchical).foregroundStyle(Theme.warnText)
            }
            .accessibilityHint(m)
        default:
            if row.flagged {
                Text("Needs a look · \(row.lookReason)").font(.subheadline.weight(.medium)).foregroundStyle(Theme.warnText)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text(row.methodLine).font(.subheadline).foregroundStyle(Theme.ink2).lineLimit(nil)
            }
        }
    }
}

/// "I have more": how many windows does the home have in all? (1 to 80; measured ones included.)
private struct TotalSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State var count: Int
    let onSave: (Int?) -> Void

    init(initial: Int, onSave: @escaping (Int?) -> Void) {
        _count = State(initialValue: initial)
        self.onSave = onSave
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("How many windows does your home have?")
                .font(.title2.weight(.bold)).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Text("Count the ones you measured too. We'll price the rest from your home's size, and a rep checks every window anyway.")
                .font(.subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
            Stepper(value: $count, in: WindowTotal.min...WindowTotal.max) {
                Text("\(count)")
                    .font(.largeTitle.weight(.bold)).monospacedDigit().foregroundStyle(Theme.ink)
                    .accessibilityLabel("\(count) windows")
            }
            .padding(.horizontal, 16).padding(.vertical, 8)
            .wcCard()
            WCPrimaryButton(title: "Save") {
                onSave(count)
                dismiss()
            }
            Button("Use my home's usual count") {
                onSave(nil)
                dismiss()
            }
            .frame(maxWidth: .infinity, minHeight: Theme.minTap)
        }
        .padding(Theme.gutter)
        .padding(.top, 8)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Theme.ground.ignoresSafeArea())
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
    }
}
