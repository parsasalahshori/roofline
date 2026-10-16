import RooflineCore
import SwiftUI

/// Everything saved on this phone and where it is: waiting, sending, sent, or refused (with the server's reason and
/// Retry). Windows stay here, photos and all, until the server has them.
struct OutboxView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var syncing = false

    var body: some View {
        List {
            if model.outboxItems.isEmpty {
                Text("Nothing waiting. Measured windows are sent as soon as they are saved.").foregroundStyle(.secondary)
            }
            ForEach(model.outboxItems.sorted { $0.createdAt > $1.createdAt }) { item in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(item.window.label ?? "Window").font(.headline)
                        Spacer()
                        stateIcon(item)
                    }
                    if let a = item.address { Text(a).font(.footnote).foregroundStyle(.secondary) }
                    Text(Self.status(item)).font(.footnote).foregroundStyle(item.state == .failed ? Color.red : Color.secondary)
                    if item.state == .failed || (item.state == .waiting && item.lastError != nil) {
                        HStack {
                            Button("Retry") { Task { await model.retry(item.id) } }
                                .buttonStyle(.borderedProminent)
                            if item.state == .failed {
                                Button("Discard", role: .destructive) { Task { await model.removeFromOutbox(item.id) } }
                                    .buttonStyle(.bordered)
                            }
                        }
                        .padding(.top, 4)
                    }
                }
                .padding(.vertical, 2)
            }
        }
        .navigationTitle("Outbox")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button {
                    Task {
                        syncing = true
                        await model.sync()
                        syncing = false
                    }
                } label: {
                    if syncing { ProgressView() } else { Text("Send now") }
                }
                .disabled(syncing || model.pendingCount == 0)
            }
            ToolbarItem(placement: .bottomBar) {
                Button("Clear sent") { Task { await model.clearSent() } }
                    .disabled(!model.outboxItems.contains { $0.state == .done })
            }
        }
    }

    @ViewBuilder
    private func stateIcon(_ item: OutboxItem) -> some View {
        switch item.state {
        case .done: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .failed: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
        case .sending: ProgressView()
        case .waiting: Image(systemName: "clock").foregroundStyle(.secondary)
        }
    }

    static func status(_ item: OutboxItem) -> String {
        switch item.state {
        case .done:
            return "Sent."
        case .sending:
            return item.uploadId == nil ? "Sending the photo…" : "Saving the window…"
        case .waiting:
            if let e = item.lastError { return "Not sent yet: \(e)" }
            return item.uploadId == nil ? "Waiting to send the photo." : "Photo sent; waiting to save the window."
        case .failed:
            let stage = item.lastErrorStage == .photo ? "The photo was refused" : "The window was refused"
            return "\(stage): \(item.lastError ?? "no reason given")"
        }
    }
}

/// Hidden: every measuring pass as CSV for the field accuracy test (points, device, LiDAR, tracking losses, ±).
struct ExportTestDataView: View {
    @Environment(AppModel.self) private var model
    @State private var passes: [TestPass] = []
    @State private var fileURL: URL?
    @State private var confirmClear = false

    var body: some View {
        List {
            Section {
                Text("\(passes.count) pass(es) recorded on this phone.")
                if let url = fileURL {
                    ShareLink(item: url) { Label("Export CSV", systemImage: "square.and.arrow.up") }
                }
            } footer: {
                Text("One row per AR or scan pass: the four corners (metres, AR world), each corner's spread, LiDAR, tracking losses and restarts, the size and its ±. Compare against a tape on the same windows.")
            }
            Section("Latest") {
                ForEach(passes.suffix(20).reversed()) { p in
                    VStack(alignment: .leading) {
                        Text("\(p.label ?? "Window") · \(p.device)").font(.subheadline)
                        Text("\(Eighths.size(widthIn: p.widthIn, heightIn: p.heightIn)) ± \(Eighths.formatUncertainty(max(p.uncertaintyWidthIn ?? 0, p.uncertaintyHeightIn ?? 0)))")
                            .font(.footnote.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                }
            }
            Section {
                Button("Delete test data", role: .destructive) { confirmClear = true }
            }
        }
        .navigationTitle("Export test data")
        .task { await refresh() }
        .confirmationDialog("Delete every recorded pass?", isPresented: $confirmClear, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                Task {
                    try? await model.passes.clear()
                    await refresh()
                }
            }
        }
    }

    private func refresh() async {
        passes = await model.passes.all()
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("roofline-measure-passes-\(stamp).csv")
        do {
            try TestDataCSV.make(passes).write(to: url, atomically: true, encoding: .utf8)
            fileURL = url
        } catch {
            fileURL = nil
        }
    }
}
