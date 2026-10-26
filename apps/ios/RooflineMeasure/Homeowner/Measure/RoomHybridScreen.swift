import RoomPlan
import RooflineCore
import SwiftUI

/// "Scan the room, then close-ups" on a phone with a depth sensor, in the owner's order: PAN the room (Apple's own capture view with its window
/// outlines and the "N windows found" bar), CLOSE-UPS of each window the scan found (the guided scan's close-up step, in any order, skippable),
/// then one prominent button, MEASURE AND CHECK, and the results. The steps are `HybridFlow` (RooflineCore); the work is `RoomHybridModel`.
struct RoomHybridScreen: View {
    @Environment(HomeownerStore.self) private var store
    let session: MeasureSession
    /// Made when the camera is allowed, not with the view (RoomPlan's capture view is heavy, and the simulator has none).
    @State private var model: RoomHybridModel?
    @State private var access: CameraAccess.State?

    var body: some View {
        Group {
            #if DEBUG
            if let mode = store.debugOpen, mode.hasPrefix("hybrid") {
                DebugHybridSample(mode: mode, session: session)
            } else {
                live
            }
            #else
            live
            #endif
        }
    }

    @ViewBuilder private var live: some View {
        if !RoomScanSupport.isSupported {
            UnsupportedMeasureView(reason: DeviceCaps.arSupported ? .noDepth : .noCamera, method: .roomCloseups) { store.measureSession = nil }
        } else if access == .denied {
            UnsupportedMeasureView(reason: .cameraOff, method: .roomCloseups) { store.measureSession = nil }
        } else if access == .restricted {
            UnsupportedMeasureView(reason: .cameraRestricted, method: .roomCloseups) { store.measureSession = nil }
        } else if let model = model {
            HybridFlowView(model: model, session: session)
        } else {
            Color.black.ignoresSafeArea()
                .task {
                    access = await CameraAccess.request()
                    if access == .allowed {
                        let m = RoomHybridModel(room: session.room)
                        _ = m.makeScanner()
                        model = m
                        m.beginPan()
                    }
                }
        }
    }
}

/// Whichever step the hybrid is on.
struct HybridFlowView: View {
    @Environment(HomeownerStore.self) private var store
    let model: RoomHybridModel
    let session: MeasureSession
    @State private var showHowTo = !HowToSeen.isSeen("hybrid")

    var body: some View {
        ZStack {
            switch model.flow.stage {
            case .panning, .building:
                pan
            case .windows:
                HybridWindowList(model: model, onCancel: leave, onRescan: rescan)
            case .closeups(let id):
                HybridCloseupScreen(model: model, windowId: id)
            case .measuring:
                HybridWorkingView(done: model.measuredCount, total: model.flow.measuring.count)
            case .results:
                HybridResultsView(model: model, onAdd: add, onBack: { model.reopenList() }, onCancel: leave)
            case .empty:
                noWindows
            }
        }
        .animation(nil, value: model.flow.stage)
        .overlay {
            if showHowTo && model.flow.stage == .panning { HybridHowTo { HowToSeen.markSeen("hybrid"); showHowTo = false } }
        }
        .onChange(of: model.scanner?.phase) { _, phase in
            if phase == .review { model.panFinished() }
        }
        .onDisappear { model.shutDown() }
    }

    private func leave() { store.measureSession = nil }

    private func rescan() { store.measureSession = MeasureSession(method: session.method, room: session.room, number: session.number) }

    private func add(_ list: [HybridSaveItem]) {
        Task { await store.saveRoomHybrid(list, room: model.room) }
    }

    // MARK: Pan

    @ViewBuilder private var pan: some View {
        if let scanner = model.scanner {
            switch scanner.phase {
            case .scanning, .processing:
                // The capture view stays in the hierarchy while RoomPlan processes: it runs the processing and calls back with the finished room
                ZStack {
                    RoomCaptureContainer(view: scanner.captureView).ignoresSafeArea()
                    if scanner.phase == .processing {
                        VStack(spacing: 16) {
                            ProgressView().tint(.white).scaleEffect(1.3)
                            Text("Building your room…").font(.headline).foregroundStyle(.white)
                        }
                        .padding(28)
                        .hudPanel(cornerRadius: 20)
                        .environment(\.colorScheme, .dark)
                    } else {
                        ScanHud(room: session.room, progress: scanner.progress, windows: scanner.liveWindows,
                                onCancel: leave, onDone: { model.donePanning() },
                                detail: model.camera.panCount > 0 ? HybridWording.panPhotos(model.camera.panCount) : nil)
                    }
                }
            case .review:
                Color.black.ignoresSafeArea()
            case .failed(let message):
                failed(message)
            }
        } else {
            Color.black.ignoresSafeArea()
        }
    }

    private var noWindows: some View {
        VStack(spacing: 18) {
            Text(ScanWording.foundTitle(0)).font(.title.weight(.bold)).foregroundStyle(.white).multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            Text("Pan slowly round the room with every window in view. Or measure them with a photo and a bank card.")
                .font(.body).foregroundStyle(Color.white.opacity(0.9)).multilineTextAlignment(.center)
            WCPrimaryButton(title: "Scan again") { store.measureSession = MeasureSession(method: session.method, room: session.room, number: session.number) }
            if store.isAvailable(.card) {
                WCSecondaryButton(title: "Measure with a photo instead") { photoMethod() }
            }
            closeButton
        }
        .padding(Theme.gutter)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .environment(\.colorScheme, .dark)
    }

    private func failed(_ message: String) -> some View {
        VStack(spacing: 18) {
            Text("The scan didn't finish").font(.title.weight(.bold)).foregroundStyle(.white).multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            Text(message).font(.body).foregroundStyle(Color.white.opacity(0.9)).multilineTextAlignment(.center)
            WCPrimaryButton(title: "Try again") { store.measureSession = MeasureSession(method: session.method, room: session.room, number: session.number) }
            WCSecondaryButton(title: "Measure one window at a time instead") {
                store.method = .corners
                store.measureSession = MeasureSession(method: .corners, room: session.room, number: session.number)
            }
            closeButton
        }
        .padding(Theme.gutter)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .environment(\.colorScheme, .dark)
    }

    private var closeButton: some View {
        Button { leave() } label: {
            Text("Close").font(.body.weight(.semibold)).foregroundStyle(Color.white.opacity(0.9))
                .frame(maxWidth: .infinity, minHeight: Theme.minTap).contentShape(Rectangle())
        }
    }

    private func photoMethod() {
        store.method = .card
        store.measureSession = MeasureSession(method: .card, room: session.room, number: session.number)
    }
}

/// The hybrid's how-to (shown the first time): the three things to do.
struct HybridHowTo: View {
    static let steps = ["Pan slowly round the room, with each whole window in view. Take a step to the side now and then.",
                        "When Apple's scan is done, take a close-up of each corner of each window. Any order, and you can skip a window.",
                        "Tap Measure and check. Windows without close-ups keep Apple's size."]
    let onDone: () -> Void

    var body: some View {
        HowToOverlay(title: "Scan the room", steps: Self.steps, art: .corners, onDone: onDone)
    }
}

// MARK: - The list of windows

/// The windows Apple found, as a standard grouped list: a thumbnail, the window's name and room, Apple's size, how sure Apple is and where its
/// close-ups stand. A row opens that window's close-ups; swipe to skip it (it keeps Apple's size) or leave it out. "Measure and check" is pinned
/// at the bottom, on as soon as one window has close-ups.
struct HybridWindowList: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let model: RoomHybridModel
    let onCancel: () -> Void
    let onRescan: () -> Void
    @State private var askLeave = false
    @State private var askRescan = false

    private var items: [HybridItem] { model.flow.items }

    var body: some View {
        NavigationStack {
            List {
                if model.camera.worldMoved || model.notice != nil {
                    Section {
                        Label {
                            Text(model.notice ?? HybridWording.lostWorld).font(.subheadline).foregroundStyle(Theme.ink)
                        } icon: {
                            Image(systemName: WCIcon.alert.symbol).foregroundStyle(Theme.warn)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
                Section {
                    ForEach(items) { item in
                        if let w = model.window(item.id) { row(item, w) }
                    }
                } header: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(ScanWording.foundTitle(items.count)).font(.title3.weight(.semibold)).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                        Text("Take close-ups of each one, in any order. Then measure and check.").font(.subheadline).foregroundStyle(Theme.ink2)
                    }
                    .textCase(nil)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, 4)
                } footer: {
                    Text(HybridWording.listFooter(canMeasure: model.flow.canMeasure, windows: items.count)).foregroundStyle(Theme.ink2)
                }
                if typeSize.isAccessibilitySize {
                    Section { WCScrollFooter() }
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }
            }
            .listStyle(.insetGrouped)
            .wcFooter {
                WCPrimaryButton(title: "Measure and check", icon: .check, iconLeading: true, isEnabled: model.flow.canMeasure) {
                    Task { await model.measureAndCheck() }
                }
            }
            .navigationTitle(model.room)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Cancel") { askLeave = true } }
                ToolbarItem(placement: .topBarTrailing) { Button("Scan again") { askRescan = true } }
            }
            .confirmationDialog("Leave this scan?", isPresented: $askLeave, titleVisibility: .visible) {
                Button("Discard the scan", role: .destructive, action: onCancel)
                Button("Keep scanning", role: .cancel) {}
            } message: {
                Text("The windows and close-ups from this scan won't be saved.")
            }
            .confirmationDialog("Scan the room again?", isPresented: $askRescan, titleVisibility: .visible) {
                Button("Scan again", role: .destructive, action: onRescan)
                Button("Keep these windows", role: .cancel) {}
            } message: {
                Text("This scan's windows and close-ups are dropped. Pan a little more slowly, with each whole window in view.")
            }
        }
    }

    private func row(_ item: HybridItem, _ w: HybridWindow) -> some View {
        Button {
            // (a window the pan hardly saw does nothing: it keeps Apple's size, and its row says why)
            guard item.measurable else { return }
            Haptics.tap()
            model.openCloseups(item.id)
        } label: {
            HStack(alignment: typeSize.isAccessibilitySize ? .top : .center, spacing: 12) {
                ScanThumb(photo: w.photo, on: item.included)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        Text(item.letter).font(.footnote.weight(.bold)).monospacedDigit().foregroundStyle(item.included ? Theme.ink : Theme.ink2)
                            .frame(width: 26, height: 26).background(Theme.surface2, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                        Text("Window \(item.letter)").font(.headline).foregroundStyle(item.included ? Theme.ink : Theme.ink2).strikethrough(!item.included)
                    }
                    SizeText(widthIn: item.widthIn, heightIn: item.heightIn, size: 20, weight: .bold, unit: true, color: item.included ? Theme.ink : Theme.ink2, relativeTo: .title3)
                    Text("\(model.room) · \(ScanWording.sourceLine(item.confidence))").font(.subheadline).foregroundStyle(Theme.ink2)
                        .lineLimit(typeSize.isAccessibilitySize ? nil : 2)
                    if item.included {
                        Text(HybridWording.rowStatus(item)).font(.subheadline.weight(item.isFinished ? .semibold : .regular))
                            .foregroundStyle(item.isFinished ? Theme.okText : Theme.ink2)
                    } else {
                        Text("Left out").font(.subheadline).foregroundStyle(Theme.ink2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: symbol(item)).font(.title2).foregroundStyle(tint(item)).frame(width: 28, height: 28).accessibilityHidden(true)
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if item.included {
                Button { model.setSkipped(item.id, !item.skipped) } label: { Label(item.skipped ? "Take close-ups" : "Skip", systemImage: item.skipped ? "camera" : "forward.end") }
                    .tint(.orange)
                Button { model.setIncluded(item.id, false) } label: { Label("Leave out", systemImage: "minus.circle") }
                    .tint(.gray)
            } else {
                Button { model.setIncluded(item.id, true) } label: { Label("Add back", systemImage: "plus.circle") }
                    .tint(Theme.red)
            }
        }
        .contextMenu {
            if item.included {
                Button { model.openCloseups(item.id) } label: { Label(item.closeupCount > 0 ? "Redo close-ups" : "Take close-ups", systemImage: "camera") }
                Button { model.setSkipped(item.id, !item.skipped) } label: { Label(item.skipped ? "Don't skip" : "Skip", systemImage: "forward.end") }
                Button(role: .destructive) { model.setIncluded(item.id, false) } label: { Label("Leave out", systemImage: "minus.circle") }
            } else {
                Button { model.setIncluded(item.id, true) } label: { Label("Add back", systemImage: "plus.circle") }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Window \(item.letter), \(model.room). \(SizeWording.spokenSize(widthIn: item.widthIn, heightIn: item.heightIn)). \(ScanWording.sourceLine(item.confidence)). \(item.included ? HybridWording.rowStatus(item) : "Left out")")
        .accessibilityHint(item.included ? "Double tap to take its close-ups" : "Swipe to add it back")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(named: item.skipped ? "Take close-ups" : "Skip") { model.setSkipped(item.id, !item.skipped) }
        .accessibilityAction(named: item.included ? "Leave out" : "Add back") { model.setIncluded(item.id, !item.included) }
    }

    private func symbol(_ i: HybridItem) -> String {
        if !i.included { return "circle" }
        if !i.measurable { return "minus.circle" }
        if i.skipped { return "forward.circle" }
        if i.isFinished { return "checkmark.circle.fill" }
        return i.closeupCount > 0 ? "circle.lefthalf.filled" : "chevron.forward"
    }

    private func tint(_ i: HybridItem) -> Color {
        if !i.included || i.skipped || !i.measurable { return Theme.decor }
        if i.isFinished { return Theme.okText }
        return i.closeupCount > 0 ? Theme.red : Theme.decor
    }
}

// MARK: - A window's close-ups

/// The guided scan's close-up step for one window, over the camera: an arrow (or a ring) to the corner asked for, taken by itself when it is centred,
/// near, steady and sharp; a shutter for taking one by hand, Skip, Redo, and "Done" back to the list. The session is the pan's own, so the photos
/// are in the same world as Apple's windows.
struct HybridCloseupScreen: View {
    let model: RoomHybridModel
    let windowId: String
    @State private var finishing = false

    var body: some View {
        let camera = model.camera
        ZStack {
            preview
            ScanCaptureOverlay(ui: model.closeupUi, shots: model.closeupShots, finding: false, corners: model.window(windowId)?.estimate.cornersM, title: title,
                               onClose: finish, onRedo: { model.redoCloseups() }, onShutter: { camera.manualShutter() }, onNext: {}, onSkip: { camera.skipCorner() }, onStop: finish,
                               closeupsOnly: true, stopTitle: "Done", stopEnabled: true, photoSize: model.panPhotoSize, closeTitle: "Back to the windows")
        }
        .onChange(of: camera.closeupUi.step?.phase) { _, phase in
            // All four corners taken or skipped: a moment to see it, then back to the list
            if phase == .finished {
                Task {
                    try? await Task.sleep(nanoseconds: 900_000_000)
                    finish()
                }
            }
        }
        .onChange(of: camera.closeupUi.interrupted) { _, lost in if lost { finish() } }
        .onChange(of: camera.worldMoved) { _, moved in if moved { finish() } }
    }

    private var title: String { "WINDOW \(model.window(windowId)?.letter ?? "")" }

    @ViewBuilder private var preview: some View {
        #if DEBUG
        if let d = model.debugCloseup {
            d.backdrop
        } else {
            ArSceneContainer(view: model.camera.sceneView()).ignoresSafeArea()
        }
        #else
        ArSceneContainer(view: model.camera.sceneView()).ignoresSafeArea()
        #endif
    }

    private func finish() {
        guard !finishing else { return }
        finishing = true
        model.finishCloseups()
    }
}

// MARK: - Measuring

struct HybridWorkingView: View {
    let done: Int
    let total: Int

    var body: some View {
        VStack(spacing: 14) {
            ProgressView().controlSize(.large)
            Text(HybridWording.measuringLine(done: done, of: total)).font(.headline)
            Text("Finding the corners in every photo and checking them against each other").font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .padding(Theme.gutter)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground).ignoresSafeArea())
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Results

/// What Measure and check found, per window: Measured (green), or "WinChoice will check this one" (amber, never a block); a window nobody measured
/// further keeps Apple's size. A scanned window opens the guided scan's result screen (photos, corners, a mark can be moved).
struct HybridResultsView: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let model: RoomHybridModel
    let onAdd: ([HybridSaveItem]) -> Void
    let onBack: () -> Void
    let onCancel: () -> Void
    @State private var detail: HybridWindow?
    @State private var askLeave = false

    private var items: [HybridItem] { model.flow.items.filter { $0.included } }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(items) { item in
                        if let w = model.window(item.id) { row(item, w) }
                    }
                } header: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Your windows").font(.title3.weight(.semibold)).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                        Text(summary).font(.subheadline).foregroundStyle(Theme.ink2)
                    }
                    .textCase(nil)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, 4)
                } footer: {
                    Text("Tap a measured window to see its photos. We confirm every size at your visit.").foregroundStyle(Theme.ink2)
                }
                if typeSize.isAccessibilitySize {
                    Section { WCScrollFooter() }
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }
            }
            .listStyle(.insetGrouped)
            .wcFooter {
                WCPrimaryButton(title: HybridWording.addTitle(count: items.count, room: model.room), icon: .check, iconLeading: true, isEnabled: !items.isEmpty) {
                    onAdd(model.saveItems())
                }
                WCSecondaryButton(title: "Back to the windows", action: onBack)
            }
            .navigationTitle(model.room)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Cancel") { askLeave = true } }
            }
            .confirmationDialog("Leave this scan?", isPresented: $askLeave, titleVisibility: .visible) {
                Button("Discard the scan", role: .destructive, action: onCancel)
                Button("Keep scanning", role: .cancel) {}
            } message: {
                Text("The windows and close-ups from this scan won't be saved.")
            }
            .sheet(item: $detail, onDismiss: { }) { w in
                if let scan = w.scan {
                    ScanResultView(model: scan, title: "WINDOW \(w.letter)", onUse: { close(w) }, onAgain: {}, onClose: { close(w) },
                                   useTitle: "Done", againTitle: nil, navTitle: "Window \(w.letter)")
                }
            }
        }
    }

    private func close(_ w: HybridWindow) {
        model.refreshOutcome(w.id)
        detail = nil
    }

    private var summary: String {
        let m = model.flow.measuredCount, c = model.flow.checkCount
        var parts: [String] = []
        if m > 0 { parts.append("\(m) measured") }
        if c > 0 { parts.append("\(c) for WinChoice to check") }
        let apple = items.count - m - c
        if apple > 0 { parts.append("\(apple) with Apple's size") }
        return parts.joined(separator: ", ")
    }

    private func row(_ item: HybridItem, _ w: HybridWindow) -> some View {
        let size = model.size(of: w)
        let outcome = item.outcome ?? .appleSize
        return Button {
            if w.scan != nil { detail = w }
        } label: {
            HStack(alignment: typeSize.isAccessibilitySize ? .top : .center, spacing: 12) {
                ScanThumb(photo: w.resultPhoto ?? w.photo, on: true)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        Text(item.letter).font(.footnote.weight(.bold)).monospacedDigit().foregroundStyle(Theme.ink)
                            .frame(width: 26, height: 26).background(Theme.surface2, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                        Text("Window \(item.letter)").font(.headline).foregroundStyle(Theme.ink)
                    }
                    SizeText(widthIn: size.widthIn, heightIn: size.heightIn, size: 20, weight: .bold, unit: true, color: Theme.ink, relativeTo: .title3)
                    Label {
                        Text(HybridWording.outcomeTitle(outcome)).font(.subheadline.weight(.semibold))
                    } icon: {
                        Image(systemName: outcomeSymbol(outcome))
                    }
                    .foregroundStyle(outcomeColor(outcome))
                    Text(detailLine(outcome, fromScan: size.fromScan)).font(.footnote).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if w.scan != nil {
                    Image(systemName: "chevron.forward").font(.footnote.weight(.semibold)).foregroundStyle(Theme.decor).accessibilityHidden(true)
                }
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Window \(item.letter). \(SizeWording.spokenSize(widthIn: size.widthIn, heightIn: size.heightIn)). \(HybridWording.outcomeTitle(outcome)).")
        .accessibilityHint(w.scan != nil ? "Double tap to see its photos and corners" : "")
        .accessibilityAddTraits(.isButton)
    }

    private func detailLine(_ o: HybridOutcome, fromScan: Bool) -> String {
        // A scan that the gates did not pass and that disagreed with Apple's size too much: Apple's size stands, and someone checks
        if o == .check && !fromScan { return "We kept Apple's size. Someone will check it against your photos." }
        return HybridWording.outcomeDetail(o)
    }

    private func outcomeSymbol(_ o: HybridOutcome) -> String {
        switch o {
        case .measured: return "checkmark.seal.fill"
        case .check: return "exclamationmark.triangle.fill"
        case .appleSize: return "ruler"
        }
    }

    private func outcomeColor(_ o: HybridOutcome) -> Color {
        switch o {
        case .measured: return Theme.okText
        case .check: return Theme.warnText
        case .appleSize: return Theme.ink2
        }
    }
}
