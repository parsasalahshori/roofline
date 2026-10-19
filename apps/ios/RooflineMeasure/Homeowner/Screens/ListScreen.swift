import RooflineCore
import SwiftUI

/// 10 Your windows (ios-hw-10): every measured window with its size, which are sure and which need a check, "Did we miss
/// any?" against what homes like theirs have, and the way on to styles and the quote.
struct ListScreen: View {
    @Environment(HomeownerStore.self) private var store
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var actionRow: WindowRow?
    @State private var askTotal = false
    @State private var total = 8

    private var rows: [WindowRow] { store.windowRows }

    var body: some View {
        VStack(spacing: 0) {
            WCNavBar(title: "Your windows", onBack: { store.pop() }) {
                NavTextButton(title: "Add") { store.path = store.stack(to: .rooms); store.noteStep(.rooms) }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    WCHeadline(text: rows.isEmpty ? "No windows yet" : "\(rows.count) window\(rows.count == 1 ? "" : "s") measured", subtitle: "Sizes are the inside of each frame, in inches.")
                    if !rows.isEmpty {
                        SummaryCard(rows: rows).padding(.top, 14)
                        // One group per room, each with its own "add a window" row
                        ForEach(WindowGroups.group(rows, roomOrder: store.rooms)) { group in
                            GroupHeader(text: group.header).padding(.top, 20)
                            GroupCard {
                                ForEach(group.rows) { row in
                                    WindowListRow(row: row, highlighted: row.id == store.justSavedId, action: { actionRow = row },
                                                  onAgain: { Task { await store.measureAgain(row) } })
                                    RowDivider(inset: 56)
                                }
                                AddRow(title: "+ Add a window in \(group.room)") { store.measure(room: group.room) }
                            }
                        }
                        GroupCard {
                            AddRow(title: "+ Add another room") { store.path = store.stack(to: .rooms); store.noteStep(.rooms) }
                        }
                        .padding(.top, 14)
                    }
                    if store.sendingCount > 0 || !store.failedItems.isEmpty { sendingNote.padding(.top, 12) }
                    if store.heldCount > 0 { heldNote.padding(.top, 12) }
                    // With large text the panel would fill the pinned area: it scrolls with the list instead
                    if typeSize.isAccessibilitySize { missPanel.padding(.top, 12) }
                    WCScrollFooter()
                }
                .padding(.horizontal, Theme.gutter)
                .padding(.bottom, 24)
            }
        }
        .wcFooter {
            if !typeSize.isAccessibilitySize { missPanel }
            WCPrimaryButton(title: footerTitle, icon: .arrow, isEnabled: !rows.isEmpty) {
                Task { await store.continueFromList() }
            }
        }
        .wcScreenChrome()
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

    private var missPanel: some View {
        AdaptiveStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Did we miss any?").wc(16, .semibold, relativeTo: .headline).foregroundStyle(Theme.ink)
                Text(WindowCountHint.detail(measured: rows.count, estimate: store.windowEstimate))
                    .wc(14, relativeTo: .subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                askTotal = true
            } label: {
                Text("I have more").wc(15, .semibold, relativeTo: .body).foregroundStyle(Theme.blue)
                    .padding(.horizontal, 12).frame(minHeight: Theme.minTap)
                    .background(Theme.surface, in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Tell us how many windows your home has")
        }
        .padding(12)
        .wcPanel()
    }

    /// Windows wait on the phone for their style: said plainly, only while there are any.
    private var heldNote: some View {
        HStack(alignment: .top, spacing: 10) {
            IconView(icon: .lock, size: 18).foregroundStyle(Theme.ink3)
            Text("Saved on this phone. They're sent to WinChoice when you pick styles.").wc(14, relativeTo: .subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private var sendingNote: some View {
        let failed = store.failedItems
        return VStack(alignment: .leading, spacing: 8) {
            if let first = failed.first {
                HStack(alignment: .top, spacing: 10) {
                    IconView(icon: .alert, size: 18).foregroundStyle(Theme.warn)
                    Text(first.lastError ?? "A window could not be sent.").wc(14, relativeTo: .subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
                }
            } else if let held = store.heldBackNote {
                // The server asked the phone to wait: its sentence, calmly. They go by themselves when the wait is over.
                HStack(alignment: .top, spacing: 10) {
                    IconView(icon: .clock, size: 18).foregroundStyle(Theme.ink3)
                    Text("Saved on this phone. \(held)").wc(14, relativeTo: .subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
                }
            } else {
                HStack(spacing: 10) {
                    ProgressView()
                    Text(store.offline ? "Saved on this phone. They send when you're back online." : "Sending \(store.sendingCount) window\(store.sendingCount == 1 ? "" : "s")…")
                        .wc(14, relativeTo: .subheadline).foregroundStyle(Theme.ink2)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.warnTint.opacity(failed.isEmpty ? 0 : 1), in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// "6 ready · 1 needs a look" with a bar of one segment per window. "Ready for a quote" only when none needs a look.
private struct SummaryCard: View {
    let rows: [WindowRow]

    var body: some View {
        let checks = rows.filter { $0.flagged }.count
        VStack(spacing: 8) {
            AdaptiveStack(spacing: 4) {
                Text(Self.line(count: rows.count, checks: checks))
                    .wc(16, .semibold, relativeTo: .headline).foregroundStyle(Theme.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if checks == 0 { Text("Ready for a quote").wc(16, .semibold, relativeTo: .headline).foregroundStyle(Theme.ok) }
            }
            HStack(spacing: 4) {
                ForEach(rows) { r in
                    Capsule().fill(r.flagged ? Theme.warn : Theme.ok).frame(height: 5)
                }
            }
        }
        .padding(12)
        .wcCard(radius: 16)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(checks == 0 ? "\(rows.count) windows ready. Ready for a quote." : "\(rows.count - checks) windows ready, \(checks) need a look.")
    }

    static func line(count: Int, checks: Int) -> String {
        checks == 0 ? "\(count) ready" : "\(count - checks) ready · \(checks) need\(checks == 1 ? "s" : "") a look"
    }
}

/// "+ Add a window in Kitchen": a blue row at the end of a group.
private struct AddRow: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: { Haptics.tap(); action() }) {
            Text(title).wc(17, .semibold, relativeTo: .body).foregroundStyle(Theme.blue)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 14)
                .frame(minHeight: 50)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title.replacingOccurrences(of: "+ ", with: ""))
    }
}

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
                    Text("Measure again").wc(16, .semibold, relativeTo: .body).foregroundStyle(Theme.blue)
                        .padding(.horizontal, 14).frame(minHeight: Theme.minTap)
                        .background(Theme.blueTint, in: Capsule())
                }
                .buttonStyle(.plain)
                .padding(.leading, 56).padding(.bottom, 8)
                .accessibilityLabel("Measure window \(row.number) again")
            }
        }
        .background(highlighted ? Theme.okTint : Color.clear)
        .animation(.easeOut(duration: 0.4), value: highlighted)
    }

    private var rowButton: some View {
        Button(action: action) {
            HStack(alignment: large ? .top : .center, spacing: 12) {
                Text("\(row.number)")
                    .wcMono(16, .bold, relativeTo: .body)
                    .foregroundStyle(Theme.blue)
                    .frame(width: 30, height: 30)
                    .background(Theme.blueTint, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .padding(.top, large ? 4 : 0)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title).wc(17, .semibold, relativeTo: .body).foregroundStyle(Theme.ink).lineLimit(large ? nil : 2)
                    secondLine
                    // With large text the size goes under the name instead of beside it
                    if large { sizeView }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if !large { sizeView }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .frame(minHeight: 54)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Window \(row.number), \(row.title). \(row.spokenSize). \(row.flagged ? "Needs a look. \(row.lookReason). " : "")\(statusWords)")
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
            Text("Size after upload").wc(13, relativeTo: .footnote).foregroundStyle(Theme.ink3)
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
            HStack(spacing: 6) {
                WCTag(text: "Not sent", kind: .warn, icon: .alert)
                Text("measure again").wc(15, relativeTo: .subheadline).foregroundStyle(Theme.ink3)
            }
            .accessibilityHint(m)
        default:
            if row.flagged {
                Text("Needs a look · \(row.lookReason)").wc(14, .medium, relativeTo: .subheadline).foregroundStyle(Theme.warn)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text(row.methodLine).wc(14, relativeTo: .subheadline).foregroundStyle(Theme.ink3).lineLimit(large ? nil : 2)
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
            Text("How many windows does your home have?").wcHeading(22, .heavy, relativeTo: .title2).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
            Text("Count the ones you measured too. We'll price the rest from your home's size, and a rep checks every window anyway.")
                .wc(15, relativeTo: .subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 24) {
                Spacer()
                stepButton("−", enabled: count > WindowTotal.min) { count = WindowTotal.clamp(count - 1) }
                Text("\(count)").wcMono(44, .bold, relativeTo: .largeTitle).foregroundStyle(Theme.ink).frame(minWidth: 80)
                    .accessibilityLabel("\(count) windows")
                stepButton("+", enabled: count < WindowTotal.max) { count = WindowTotal.clamp(count + 1) }
                Spacer()
            }
            .padding(.vertical, 8)
            WCPrimaryButton(title: "Save") {
                onSave(count)
                dismiss()
            }
            Button("Use my home's usual count") {
                onSave(nil)
                dismiss()
            }
            .wc(16, .medium, relativeTo: .body).foregroundStyle(Theme.blue).frame(maxWidth: .infinity, minHeight: Theme.minTap)
        }
        .padding(Theme.gutter)
        .padding(.top, 8)
        .background(Theme.ground.ignoresSafeArea())
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
    }

    private func stepButton(_ symbol: String, enabled: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: {
            Haptics.tap()
            action()
        }) {
            Text(symbol).wc(28, .semibold, relativeTo: .title).foregroundStyle(Theme.blue)
                .frame(width: 56, height: 56)
                .background(Theme.surface, in: Circle())
                .overlay(Circle().strokeBorder(Theme.line2, lineWidth: 1))
                .opacity(enabled ? 1 : 0.4)
        }
        .disabled(!enabled)
        .accessibilityLabel(symbol == "+" ? "One more window" : "One fewer window")
    }
}
