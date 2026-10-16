import RooflineCore
import SwiftUI

/// The rep's jobs (GET /api/jobs?assigned=me) with their addresses, and a search over every address
/// (GET /api/properties?q=). Picking one opens its windows.
struct JobsView: View {
    @Environment(AppModel.self) private var model
    @State private var jobs: [JobRow] = []
    @State private var loading = false
    @State private var error: String?
    @State private var query = ""
    @State private var results: [Property] = []
    @State private var searching = false
    @State private var showOutbox = false
    @State private var showSettings = false
    @State private var debugRoute: WindowsRoute?

    struct JobRow: Identifiable, Equatable {
        var job: Job
        var property: Property?
        var id: String { job.id }
    }

    var body: some View {
        List {
            if model.pendingCount > 0 {
                Section {
                    Button {
                        showOutbox = true
                    } label: {
                        Label(model.failedCount > 0 ? "\(model.failedCount) window(s) need attention" : "\(model.pendingCount) window(s) waiting to send",
                              systemImage: model.failedCount > 0 ? "exclamationmark.triangle.fill" : "arrow.up.circle")
                            .foregroundStyle(model.failedCount > 0 ? Color.red : Color.accentColor)
                    }
                }
            }
            if !query.trimmingCharacters(in: .whitespaces).isEmpty {
                Section("Addresses") {
                    if searching && results.isEmpty { ProgressView() }
                    if !searching && results.isEmpty { Text("No address matches.").foregroundStyle(.secondary) }
                    ForEach(results) { p in
                        NavigationLink(value: WindowsRoute(propertyId: p.id, address: p.oneLine)) {
                            Text(p.oneLine)
                        }
                    }
                }
            } else {
                Section("My jobs") {
                    if loading && jobs.isEmpty { ProgressView() }
                    if let error = error { Text(error).foregroundStyle(.red) }
                    if !loading && jobs.isEmpty && error == nil {
                        Text("No jobs are assigned to you. Search for an address above.").foregroundStyle(.secondary)
                    }
                    ForEach(jobs) { row in
                        if let p = row.property {
                            NavigationLink(value: WindowsRoute(propertyId: p.id, address: p.oneLine)) {
                                JobCell(row: row)
                            }
                        } else {
                            JobCell(row: row).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .navigationTitle("Jobs")
        .navigationDestination(for: WindowsRoute.self) { r in WindowsListView(route: r) }
        #if DEBUG
        .navigationDestination(item: $debugRoute) { r in WindowsListView(route: r) }
        .onAppear {
            if let q = DebugLaunch.search, DebugLaunch.once("search") { query = q }
            if DebugLaunch.settings, DebugLaunch.once("settings") { showSettings = true }
        }
        .onChange(of: results) { _, list in
            if DebugLaunch.openFirst, let p = list.first, DebugLaunch.once("openFirst") {
                debugRoute = WindowsRoute(propertyId: p.id, address: p.oneLine)
            }
        }
        #endif
        .searchable(text: $query, prompt: "Search an address")
        .task(id: query) { await search() }
        .refreshable { await load() }
        .task { await load() }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { showSettings = true } label: { Image(systemName: "gearshape") }
                    .accessibilityLabel("Settings")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { showOutbox = true } label: {
                    Image(systemName: model.pendingCount > 0 ? "tray.full" : "tray")
                }
                .accessibilityLabel("Outbox")
            }
        }
        .sheet(isPresented: $showOutbox) { NavigationStack { OutboxView() } }
        .sheet(isPresented: $showSettings) { NavigationStack { SettingsView() } }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let list = try await model.api.myJobs()
            // Addresses, fetched together (a job without an address cannot be measured)
            let ids = Set(list.compactMap { $0.propertyId })
            var props: [String: Property] = [:]
            let api = model.api
            await withTaskGroup(of: Property?.self) { group in
                for id in ids { group.addTask { try? await api.property(id: id) } }
                for await p in group { if let p = p { props[p.id] = p } }
            }
            jobs = list.map { JobRow(job: $0, property: $0.propertyId.flatMap { props[$0] }) }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func search() async {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else {
            results = []
            return
        }
        searching = true
        defer { searching = false }
        // Wait for the typing to settle
        try? await Task.sleep(nanoseconds: 300_000_000)
        guard !Task.isCancelled else { return }
        results = (try? await model.api.searchProperties(q)) ?? []
    }
}

struct WindowsRoute: Hashable {
    var propertyId: String
    var address: String
}

private struct JobCell: View {
    let row: JobsView.JobRow

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(row.property?.oneLine ?? "No address on this job")
            HStack {
                Text(row.job.stageLabel ?? row.job.stage.capitalized)
                if let next = row.job.nextStep, !next.isEmpty { Text("· \(next)") }
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
    }
}

/// Signed-in settings: who, the server, sign out, and (hidden: tap the version 5 times) the test-data export.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var taps = 0
    @State private var showExport = false
    @State private var showServer = false

    var body: some View {
        Form {
            if let me = model.me {
                Section("Signed in") {
                    Text(me.user.email)
                    Text(me.company.name).foregroundStyle(.secondary)
                }
            }
            Section("Server") {
                Text(model.serverURL).font(.footnote.monospaced())
                Button("Change server address") { showServer = true }
            }
            Section("Device") {
                LabeledContent("LiDAR", value: DeviceCaps.hasLiDAR ? "Yes: order-grade candidate" : "No: quote-grade only")
                LabeledContent("RoomPlan", value: DeviceCaps.roomPlanSupported ? "Available" : "Not on this phone")
            }
            Section {
                Button("Sign out", role: .destructive) {
                    Task {
                        await model.signOut()
                        dismiss()
                    }
                }
            }
            Section {
                Text("Version \(Bundle.main.shortVersion) (\(Bundle.main.buildNumber))")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .onTapGesture {
                        taps += 1
                        if taps >= 5 {
                            taps = 0
                            showExport = true
                        }
                    }
            }
        }
        .navigationTitle("Settings")
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        .navigationDestination(isPresented: $showExport) { ExportTestDataView() }
        .sheet(isPresented: $showServer) { ServerSettingsView() }
    }
}

extension Bundle {
    var shortVersion: String { object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?" }
    var buildNumber: String { object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?" }
}
