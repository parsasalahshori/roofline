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
                        GroupCard {
                            ForEach(Array(rows.enumerated()), id: \.element.id) { i, row in
                                WindowListRow(row: row) { actionRow = row }
                                if i < rows.count - 1 { RowDivider(inset: 56) }
                            }
                        }
                        .padding(.top, 12)
                    }
                    if store.unsentCount > 0 || !store.failedItems.isEmpty { sendingNote.padding(.top, 12) }
                }
                .padding(.horizontal, Theme.gutter)
                .padding(.bottom, 24)
            }
        }
        .wcFooter {
            missPanel
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
            Text(row.needsCheck ? (row.reasons.first ?? "This size needs a check.") : "Measure it again, or take it off your list.")
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
        HStack(alignment: .center, spacing: 10) {
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

    private var sendingNote: some View {
        let failed = store.failedItems
        return VStack(alignment: .leading, spacing: 8) {
            if let first = failed.first {
                HStack(alignment: .top, spacing: 10) {
                    IconView(icon: .alert, size: 18).foregroundStyle(Theme.warn)
                    Text(first.lastError ?? "A window could not be sent.").wc(14, relativeTo: .subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
                }
            } else {
                HStack(spacing: 10) {
                    ProgressView()
                    Text(store.offline ? "Saved on this phone. They send when you're back online." : "Sending \(store.unsentCount) window\(store.unsentCount == 1 ? "" : "s")…")
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

/// "6 sure, 1 to check" with a bar of one segment per window.
private struct SummaryCard: View {
    let rows: [WindowRow]

    var body: some View {
        let checks = rows.filter { $0.flagged }.count
        VStack(spacing: 8) {
            HStack {
                Text(checks == 0 ? "\(rows.count) sure" : "\(rows.count - checks) sure, \(checks) to check")
                    .wc(16, .semibold, relativeTo: .headline).foregroundStyle(Theme.ink)
                Spacer()
                Text("Ready for a quote").wc(16, .semibold, relativeTo: .headline).foregroundStyle(Theme.ok)
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
        .accessibilityLabel(checks == 0 ? "\(rows.count) windows, all sure. Ready for a quote." : "\(rows.count - checks) windows sure, \(checks) to check. Ready for a quote.")
    }
}

struct WindowListRow: View {
    let row: WindowRow
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Text("\(row.number)")
                    .wcMono(16, .bold, relativeTo: .body)
                    .foregroundStyle(Theme.blue)
                    .frame(width: 30, height: 30)
                    .background(Theme.blueTint, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title).wc(17, .semibold, relativeTo: .body).foregroundStyle(Theme.ink).lineLimit(1)
                    secondLine
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if row.hasSize, let w = row.widthIn, let h = row.heightIn {
                    SizeText(widthIn: w, heightIn: h, size: 17, weight: .bold, relativeTo: .body)
                        .fixedSize()
                } else {
                    Text("Size after upload").wc(13, relativeTo: .footnote).foregroundStyle(Theme.ink3)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .frame(minHeight: 54)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Window \(row.number), \(row.title). \(row.spokenSize). \(row.flagged ? "Needs a check. " : "")\(statusWords)")
        .accessibilityHint("Opens options for this window")
        .accessibilityAddTraits(.isButton)
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
                HStack(spacing: 6) {
                    WCTag(text: "Check", kind: .warn, icon: .alert)
                    Text("measure again").wc(15, relativeTo: .subheadline).foregroundStyle(Theme.ink3)
                }
            } else {
                Text(row.methodLine).wc(14, relativeTo: .subheadline).foregroundStyle(Theme.ink3).lineLimit(1)
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
