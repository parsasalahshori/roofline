#if STAFF_APP
import RooflineCore
import SwiftUI

/// One address's windows: every window photographed or scanned (photos of one window grouped by windowKey), its
/// size in eighths with its ±, a 'check' badge, and what is still waiting in the outbox.
struct WindowsListView: View {
    let route: WindowsRoute
    @Environment(AppModel.self) private var model
    @State private var measurement: WindowMeasurementView?
    @State private var looked = false
    @State private var loading = false
    @State private var creating = false
    @State private var error: String?
    @State private var measuring: MeasureContext?
    @State private var confirmDelete: MeasuredWindowGroup?

    private var groups: [MeasuredWindowGroup] {
        WindowGrouping.groups(measurement?.photoWindows ?? [], excluded: Set(measurement?.adjustments?.excludedWindowIds ?? []))
    }

    private var waiting: [OutboxItem] {
        guard let id = measurement?.id else { return [] }
        return model.outboxItems.filter { $0.measurementId == id && $0.state != .done }
    }

    private var allMeasured: Bool { measurement?.adjustments?.photosCoverAllWindows == true }

    var body: some View {
        List {
            if let error = error {
                Section { Text(error).foregroundStyle(.red) }
            }
            if measurement == nil {
                Section {
                    if !looked || loading {
                        ProgressView()
                    } else {
                        Text("No windows measured at this address yet.")
                        Button {
                            Task { await create() }
                        } label: {
                            HStack {
                                Text("Start measuring windows")
                                if creating { Spacer(); ProgressView() }
                            }
                        }
                        .disabled(creating)
                    }
                }
            } else {
                if !waiting.isEmpty {
                    Section("Waiting to send") {
                        ForEach(waiting) { item in WaitingRow(item: item) }
                    }
                }
                Section {
                    if groups.isEmpty && waiting.isEmpty {
                        Text("No windows yet. Tap Add window.").foregroundStyle(.secondary)
                    }
                    ForEach(groups) { g in
                        WindowRow(group: g)
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) { confirmDelete = g } label: { Label("Delete", systemImage: "trash") }
                                Button { measureAgain(g) } label: { Label("Measure again", systemImage: "camera.metering.matrix") }
                                    .tint(.blue)
                            }
                            .contextMenu {
                                Button { measureAgain(g) } label: { Label("Measure again", systemImage: "camera.metering.matrix") }
                            }
                    }
                } header: {
                    Text("\(groups.count) window\(groups.count == 1 ? "" : "s")")
                } footer: {
                    Text("Sizes are frame sizes to the nearest 1/8 in, ± about one standard deviation. 'Check' means the corners were not a clean rectangle, or the size came from a room scan: measure it again before ordering.")
                }
                Section {
                    Button { addWindow() } label: { Label("Add window", systemImage: "plus.viewfinder") }
                    Button {
                        Task { await setAllMeasured(!allMeasured) }
                    } label: {
                        Label(allMeasured ? "All windows measured (tap to undo)" : "All windows measured", systemImage: allMeasured ? "checkmark.seal.fill" : "checkmark.seal")
                    }
                    .disabled(groups.isEmpty)
                }
            }
        }
        .navigationTitle(route.address)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task {
            await load()
            #if DEBUG
            if measurement == nil, let id = DebugLaunch.measurementId, DebugLaunch.once("measurementId") {
                measurement = try? await model.api.measurement(id: id)
            }
            if measurement == nil, DebugLaunch.start, DebugLaunch.once("start") {
                await create()
                print("[DebugLaunch] created measurement \(measurement?.id ?? "-") (pass -debugMeasurement <id> next time)")
            }
            if let m = DebugLaunch.measure, DebugLaunch.once("measure") {
                if m == "again", let g = groups.first { measureAgain(g) } else { addWindow() }
            }
            #endif
        }
        // A window from this address finished sending: show the server's size
        .onChange(of: model.outboxItems.filter { $0.measurementId == measurement?.id && $0.state == .done }.count) { _, _ in
            Task { await load() }
        }
        .sheet(item: $measuring) { ctx in
            MeasureChooserView(context: ctx)
        }
        .confirmationDialog("Delete \(confirmDelete?.name ?? "this window")?", isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }), titleVisibility: .visible) {
            Button("Delete window", role: .destructive) {
                if let g = confirmDelete { Task { await delete(g) } }
            }
        } message: {
            Text("Every photo of it is taken off the measurement.")
        }
    }

    private func load() async {
        loading = true
        defer {
            loading = false
            looked = true
        }
        do {
            if let id = measurement?.id {
                measurement = try await model.api.measurement(id: id)
            } else {
                measurement = try await model.api.latestMeasurement(propertyId: route.propertyId)
            }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func create() async {
        creating = true
        defer { creating = false }
        do {
            measurement = try await model.api.createMeasurement(propertyId: route.propertyId)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func addWindow() {
        guard let m = measurement else { return }
        let n = groups.count + Set(waiting.map { $0.window.groupKey }).subtracting(groups.map { $0.key }).count + 1
        measuring = MeasureContext(measurementId: m.id, address: m.address, windowKey: WindowIds.new(), label: "Window \(n)", again: false)
    }

    private func measureAgain(_ g: MeasuredWindowGroup) {
        guard let m = measurement else { return }
        measuring = MeasureContext(measurementId: m.id, address: m.address, windowKey: g.key, label: g.name, again: true)
    }

    private func delete(_ g: MeasuredWindowGroup) async {
        guard let m = measurement else { return }
        do {
            for p in g.photos { try await model.api.deleteWindow(measurementId: m.id, windowId: p.id) }
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func setAllMeasured(_ value: Bool) async {
        guard let m = measurement else { return }
        do {
            measurement = try await model.api.setAllWindowsMeasured(measurementId: m.id, value)
        } catch {
            self.error = error.localizedDescription
        }
    }
}

private struct WindowRow: View {
    let group: MeasuredWindowGroup

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(group.name).font(.headline)
                if group.needsCheck { CheckBadge(text: group.scanOnly ? "scan · check" : "check") }
                Spacer()
                if group.photos.count > 1 {
                    Text("\(group.photos.count) passes").font(.caption).foregroundStyle(.secondary)
                }
            }
            Text(Eighths.size(widthIn: group.widthIn, heightIn: group.heightIn))
                .font(.title3.monospacedDigit())
            if let u = group.uncertaintyIn {
                Text("± \(Eighths.formatUncertainty(u)) in").font(.footnote).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

struct CheckBadge: View {
    var text = "check"

    var body: some View {
        Text(text)
            .font(.caption.bold())
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color.orange.opacity(0.2), in: Capsule())
            .foregroundStyle(.orange)
    }
}

/// A window saved on the phone, not yet on the server: its preview size and where it is in sending.
private struct WaitingRow: View {
    let item: OutboxItem

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(item.window.label ?? "Window").font(.headline)
            if let s = previewSize(item.window) {
                Text("\(Eighths.size(widthIn: s.0, heightIn: s.1)) (preview)").font(.footnote.monospacedDigit())
            }
            Text(OutboxView.status(item)).font(.footnote).foregroundStyle(item.state == .failed ? Color.red : Color.secondary)
        }
    }
}

/// The phone's own size for a saved window, before the server sizes it.
func previewSize(_ w: PhotoWindowInput) -> (Double, Double)? {
    switch w.scale {
    case .ar(let s):
        guard let size = previewArSize(s.pointsM, device: s.device ?? .arkit, cornerSpreadM: s.cornerSpreadM) else { return nil }
        return (size.widthIn, size.heightIn)
    case .roomplan(let s):
        return (s.widthM * inchesPerMetre, s.heightM * inchesPerMetre)
    case .card, .other:
        // The bank-card scale is the homeowner app's; the rep app never writes it
        return nil
    }
}
#endif
