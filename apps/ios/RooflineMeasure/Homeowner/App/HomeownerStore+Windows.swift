import Foundation
import RooflineCore
import SwiftUI

// Rooms, measuring, saving windows, styles, removing, "I have more": everything about the windows of the request.

extension HomeownerStore {
    // MARK: Rooms (05)

    /// Adds a room to the list (a suggestion, or a typed name). Returns the name it was saved under; nil when it was empty.
    @discardableResult
    func addRoom(_ typed: String) -> String? {
        guard let name = RoomNames.clean(typed) else { return nil }
        if let existing = progress.rooms.first(where: { $0.caseInsensitiveCompare(name) == .orderedSame }) { return existing }
        progress.rooms.append(name)
        saveProgress()
        return name
    }

    var suggestedRoom: String? { RoomSummary.suggested(rooms: rooms, rows: windowRows) }

    func roomLine(_ room: String) -> String { RoomSummary.line(for: room, in: windowRows) }
    func roomHasWindows(_ room: String) -> Bool { RoomSummary.hasWindows(room, in: windowRows) }
    var roomSuggestions: [String] { RoomNames.suggestions(excluding: rooms) }

    /// Measure a window in this room: the method screen for the first window, then straight to the way the last one was measured.
    func measure(room: String) {
        replaceTarget = nil
        if let last = lastMethod, isAvailable(last) {
            method = last
            noteStep(.rooms)
            startMeasuring(room: room)
            return
        }
        path.append(.method(room: room))
        noteStep(.rooms)
    }

    var lastMethod: MeasureMethod? { progress.lastMethod.flatMap(MeasureMethod.init(rawValue:)) }

    /// "Change how I measure": forgets the last method, so the method screen comes again.
    func changeMethod(room: String) {
        progress.lastMethod = nil
        saveProgress()
        measure(room: room)
    }

    // MARK: Methods (06)

    func isAvailable(_ m: MeasureMethod) -> Bool {
        switch m {
        case .corners: return capabilities.corners
        case .roomScan, .quickScan, .roomCloseups: return capabilities.roomScan
        case .card: return capabilities.camera
        }
    }

    /// The method to start on: the most accurate one this phone has.
    var defaultMethod: MeasureMethod {
        // With a depth sensor, the corners are the most exact. Without one, AR is only about 3/8 inch (1% scale error, no depth check
        // on the wall), the bank card is a real ruler in the photo (about 1/4 to 1/2 inch, checked like the server): recommend that.
        // The room scan with close-ups is the most exact way on a depth-sensor phone; Apple's quick scan (sizes only) is one tap away
        if capabilities.roomScan { return .roomCloseups }
        if capabilities.corners && capabilities.depthSensor { return .corners }
        if capabilities.camera { return .card }
        return .corners
    }

    /// The method screen opens on the recommended way the first time (no way remembered), and after that on the one in use; a way this phone
    /// cannot do is never selected.
    func selectStartingMethod() {
        if lastMethod == nil || !isAvailable(method) { method = defaultMethod }
    }

    /// "About 1/4 inch · best": what each method says about itself.
    func methodAccuracy(_ m: MeasureMethod) -> (text: String, best: Bool) {
        switch m {
        case .corners:
            return capabilities.depthSensor ? ("\(SizeWording.accuracyRange(lowIn: 0.25, highIn: 0.25)) · best", true)
                                            : (SizeWording.accuracyRange(lowIn: 0.375, highIn: 0.375), false)
        // Apple publishes no size accuracy for its room scan, so none is claimed here: it is a quote-grade size, confirmed at the visit
        case .roomScan, .quickScan: return ("Good for a quote", false)
        // Measured from photos and close-ups with the app's own checks; no number of inches is claimed before it has been tried on real windows
        case .roomCloseups: return ("Close-ups of every corner", true)
        case .card: return (SizeWording.accuracyRange(lowIn: 0.25, highIn: 0.5), false)
        }
    }

    /// The tag on a method card: why to pick it (the depth-sensor corners are the recommended way).
    func methodTag(_ m: MeasureMethod) -> (text: String, best: Bool) {
        switch m {
        case .corners:
            return capabilities.depthSensor ? ("Most exact (recommended)", true) : ("\(methodAccuracy(m).text) · good for a quote", false)
        case .roomScan: return ("Every window in the room", false)
        case .quickScan: return ("Recommended for speed", false)
        case .roomCloseups: return ("Most exact (recommended)", true)
        case .card: return capabilities.depthSensor ? ("Works on any iPhone", false) : ("Recommended for your iPhone", true)
        }
    }

    func startMeasuring(room: String, replacing: String? = nil) {
        guard isAvailable(method) else { return }
        let target = replacing ?? replaceTarget
        replaceTarget = nil
        progress.lastMethod = method.rawValue
        saveProgress()
        pendingRestored = false
        // A window being measured again keeps its own number
        let number = target.flatMap { id in windowRows.first { $0.id == id }?.number } ?? nextWindowNumber
        measureSession = MeasureSession(method: method, room: room, number: number, replacing: target)
    }

    // MARK: A measured window (08)

    /// A guided scan finished and ready to be saved with its window.
    struct StagedScan {
        var draft: ScanDraft
        /// The native JPEG of each photo, by frame id.
        var jpegs: [String: Data]
    }

    /// A finished measure becomes a pending window with its size from the phone's own math; the label sheet takes it from there.
    func capture(scale: WindowPhotoScale, corners: [Vec2]?, jpeg: Data?, widthPx: Int, heightPx: Int, focal35mm: Double? = nil, windowFrame: WindowFrameSize? = nil,
                 windowId: String? = nil, scan: StagedScan? = nil, in session: MeasureSession) {
        let window = PhotoWindowInput(id: windowId ?? WindowIds.new(), uploadId: nil, label: nil, windowKey: nil, corners: corners, scale: scale, room: session.room, style: nil)
        let preview = LocalWindowPreview.of(window, imageWidthPx: widthPx, imageHeightPx: heightPx, focal35mm: focal35mm)
        let made = PendingWindow(id: window.id, scale: scale, corners: corners, jpeg: jpeg, imageWidthPx: widthPx, imageHeightPx: heightPx, preview: preview,
                                 room: session.room, name: "", number: session.number, replacing: session.replacing, focal35mm: focal35mm, method: session.method, windowFrame: windowFrame)
        pending = made
        pendingRestored = false
        // On disk at once: nothing measured is lost by closing the app before "Save"
        if let id = requestId { pendingDisk.save(made, requestId: id) }
        // A guided scan's photos and marks too: they wait (not sent) until the window is saved
        if let scan = scan, let s = self.session {
            let box = scanOutbox
            scanStaging = Task {
                _ = try? await box.stage(draft: scan.draft, measurementId: s.requestId, jpegs: scan.jpegs, app: Self.appVersionLine, device: DeviceCaps.modelIdentifier)
            }
        }
    }

    /// The pending window of a closed app comes back: the label sheet opens for it, with no camera behind.
    func restorePending() {
        guard pending == nil, measureSession == nil, let id = requestId, let p = pendingDisk.load(requestId: id) else { return }
        // Already saved (the record outlived a save): nothing to restore
        if windowRows.contains(where: { $0.id == p.id }) {
            pendingDisk.clear(requestId: id)
            return
        }
        pending = p
        pendingRestored = true
        measureSession = MeasureSession(method: p.method, room: p.room, number: p.number, replacing: p.replacing)
    }

    /// The label sheet's "Discard": the measured window is dropped (a window it was to replace stays).
    func discardPending() {
        dropStagedScan()
        clearPending()
        measureSession = nil
    }

    /// The window was left out before it was saved: its scan (not armed) goes with it.
    func dropStagedScan() {
        guard let p = pending else { return }
        let box = scanOutbox, id = p.id, staging = scanStaging
        Task {
            await staging?.value
            try? await box.discard(windowId: id)
        }
    }

    /// "Measure it again" on the label sheet: the camera starts over for this one.
    func clearPending() {
        dropStagedScan()
        if let id = requestId { pendingDisk.clear(requestId: id) }
        pending = nil
        pendingRestored = false
    }

    /// "Save window 4": the window and its photo go on disk, the photo uploads at once, the window waits for its style.
    func savePending(room: String, name: String, frosted: Bool = false) async {
        guard let p = pending, let s = session else { return }
        let cleanRoom = RoomNames.clean(room) ?? p.room
        let cleanName = Self.cleanLabel(name, max: company.limits.maxLabelLength)
        // A window measured again keeps the style (and colour) its old one had, so it does not ask for them twice
        let oldRow = p.replacing.flatMap { id in windowRows.first { $0.id == id } }
        let window = PhotoWindowInput(id: p.id, uploadId: nil, label: cleanName, windowKey: nil, corners: p.corners, scale: p.scale, room: cleanRoom, style: oldRow?.style, frosted: frosted ? true : nil)
        do {
            _ = try await outbox.enqueue(window: window, measurementId: s.requestId, address: s.address, jpeg: p.jpeg, imageWidthPx: p.imageWidthPx, imageHeightPx: p.imageHeightPx, held: oldRow?.style == nil)
            if let old = oldRow, let color = progress.colors[old.id] { progress.colors[p.id] = color }
            // The window's own frame stays on this phone, by the window's id (the server has no place for it)
            progress.windowFrames[p.id] = p.windowFrame
            saveProgress()
        } catch {
            notice = Notice(text: "This phone couldn't save the window (\(error.localizedDescription)). Please try again.")
            return
        }
        _ = addRoom(cleanRoom)
        // The window's scan (if it has one) may go once the window does
        await scanStaging?.value
        try? await scanOutbox.arm(windowId: p.id)
        pendingDisk.clear(requestId: s.requestId)
        // "Measure again": the old window goes only now that the new one is safely on the phone
        if let old = p.replacing { await deleteEverywhere(old) }
        Haptics.success()
        showList()
        justSavedId = p.id
        let size = p.preview.flatMap { $0.isShowable ? SizeWording.sizeText(widthIn: $0.widthIn, heightIn: $0.heightIn) : nil }
        notice = Notice(text: "Saved: " + ([cleanRoom] + (size.map { [$0] } ?? [])).joined(separator: ", "), kind: .info)
        let savedId = p.id
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            if self?.justSavedId == savedId { self?.justSavedId = nil }
        }
        Task { await outbox.syncAll() }
    }

    static func cleanLabel(_ typed: String, max: Int) -> String? {
        let words = typed.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
        guard !words.isEmpty else { return nil }
        return String(words.prefix(max))
    }

    /// Saves several windows found by a room scan, all in one room.
    func saveScanned(_ windows: [ScannedWindow], room: String) async {
        guard let s = session else { return }
        let cleanRoom = RoomNames.clean(room) ?? room
        for w in windows {
            let windowRoom = RoomNames.clean(w.room ?? room) ?? cleanRoom
            _ = addRoom(windowRoom)
            let input = PhotoWindowInput(id: WindowIds.new(), uploadId: nil, label: Self.cleanLabel(w.name, max: company.limits.maxLabelLength), windowKey: nil,
                                         corners: w.corners, scale: .roomplan(RoomPlanScale(widthM: w.widthM, heightM: w.heightM, confidence: w.confidence)), room: windowRoom, style: nil)
            do {
                _ = try await outbox.enqueue(window: input, measurementId: s.requestId, address: s.address, jpeg: w.jpeg, imageWidthPx: w.imageWidthPx, imageHeightPx: w.imageHeightPx, held: true)
            } catch {
                notice = Notice(text: "This phone couldn't save a window (\(error.localizedDescription)).")
            }
        }
        _ = addRoom(cleanRoom)
        Haptics.success()
        showList()
        Task { await outbox.syncAll() }
    }

    // MARK: Removing and re-measuring

    func removeWindow(_ id: String) async {
        await deleteEverywhere(id)
        if measureSession == nil { await refresh() }
    }

    /// The window is on the server (delete it there), on this phone (drop it), or both.
    private func deleteEverywhere(_ id: String) async {
        try? await outbox.remove(id: id)
        try? await scanOutbox.discard(windowId: id, includeArmed: true)
        if progress.windowFrames[id] != nil {
            progress.windowFrames[id] = nil
            saveProgress()
        }
        guard let s = session, view?.windows.contains(where: { $0.id == id }) == true else { return }
        do {
            accept(try await api.deleteWindow(s, windowId: id))
        } catch let e as HomeownerAPIError {
            notice = Notice(text: e.message)
        } catch {
            notice = Notice(text: LiveHomeownerAPI.offlineMessage)
        }
    }

    /// "Measure again": the current size is kept until the new one is saved (a closed camera loses nothing).
    func measureAgain(_ row: WindowRow) async {
        let room = row.room.isEmpty ? (suggestedRoom ?? "Living room") : row.room
        if let last = lastMethod, isAvailable(last) {
            method = last
            startMeasuring(room: room, replacing: row.id)
            return
        }
        replaceTarget = row.id
        method = defaultMethod
        path.append(.method(room: room))
    }

    // MARK: Styles (09)

    /// The style a window is shown with while it is picked: its own, or the likeliest for its shape.
    func suggestedStyle(for row: WindowRow) -> StyleGuess.Suggestion? {
        guard let w = row.widthIn, let h = row.heightIn else { return nil }
        return StyleGuess.suggestion(widthIn: w, heightIn: h, offered: styles.map { $0.key })
    }

    func color(for windowId: String) -> String? { progress.colors[windowId] }

    func setColor(_ key: String?, for windowId: String) {
        progress.colors[windowId] = key
        saveProgress()
    }

    /// Picks a window's style. A window still on the phone is released to go; one the server already has is replaced by a
    /// copy with the new style (the server refuses a second, different body for the same window id).
    func setStyle(_ key: String, for windowId: String) async {
        guard let s = session else { return }
        if outboxItems.contains(where: { $0.id == windowId && $0.state != .done }) {
            let changed = try? await outbox.updateWindow(id: windowId, release: true) { $0.style = key }
            if changed == true {
                progress.pendingStyles[windowId] = nil
                Task { await outbox.syncAll() }
                return
            }
            // Its send is under way and the answer has not come: the choice is kept here and applied on a later sync
            progress.pendingStyles[windowId] = key
            saveProgress()
            return
        }
        guard let existing = view?.windows.first(where: { $0.id == windowId }), existing.input.style != key else {
            progress.pendingStyles[windowId] = nil
            return
        }
        progress.pendingStyles[windowId] = nil
        var copy = existing.input
        copy.id = WindowIds.new()
        copy.style = key
        if let color = progress.colors[windowId] { progress.colors[copy.id] = color }
        if let frame = progress.windowFrames[windowId] { progress.windowFrames[copy.id] = frame }
        // The copy keeps what was chosen for it, and its photo (for "See it in your home") when this phone has it
        if let look = progress.visuals[windowId] { progress.visuals[copy.id] = look }
        var keptPhoto: (data: Data, widthPx: Int, heightPx: Int)?
        if let old = outboxItems.first(where: { $0.id == windowId }), let url = await outbox.jpegURL(for: old), let data = try? Data(contentsOf: url) {
            keptPhoto = (data, old.imageWidthPx, old.imageHeightPx)
        }
        do {
            // The photo is already on the server (the copy carries its upload id), so it is kept here only, not sent again
            _ = try await outbox.enqueue(window: copy, measurementId: s.requestId, address: s.address, jpeg: keptPhoto?.data, imageWidthPx: keptPhoto?.widthPx ?? 0, imageHeightPx: keptPhoto?.heightPx ?? 0, held: false)
            await outbox.syncAll()
            accept(try await api.deleteWindow(s, windowId: windowId))
            // The old window's own record goes now that its copy holds the photo (else it would show as a second window)
            try? await outbox.remove(id: windowId)
        } catch let e as HomeownerAPIError {
            notice = Notice(text: e.message)
        } catch {
            notice = Notice(text: "This phone couldn't change that window's style. Please try again.")
        }
    }

    /// Style choices kept while a window's send was uncertain: tried again now (after a sync).
    func applyPendingStyles() async {
        for (id, key) in progress.pendingStyles { await setStyle(key, for: id) }
        saveProgress()
    }

    /// "Use this style for all 7".
    func setStyleForAll(_ key: String) async {
        for row in windowRows where row.style != key { await setStyle(key, for: row.id) }
    }

    /// The pass is done (or the homeowner left it): everything goes out, then the quote.
    func finishStyles() async {
        // A window left without a style takes the likeliest one for its shape: a window cannot go without
        for row in windowRows where row.style == nil {
            let key = suggestedStyle(for: row)?.keys.first ?? styles.first?.key
            if let key = key { await setStyle(key, for: row.id) }
        }
        path = stack(to: .quote)
        noteStep(.quote)
        await prepareQuote()
    }

    // MARK: Quote (11)

    /// Everything on its way is sent, then the server prices it.
    func prepareQuote() async {
        loadingQuote = true
        defer { loadingQuote = false }
        await outbox.syncAll()
        await refresh()
        if quote?.tier(selectedTier) == nil, let first = quote?.tiers.first(where: { $0.key == "better" }) ?? quote?.tiers.first { selectedTier = first.key }
    }

    func selectTier(_ key: String) {
        selectedTier = key
        progress.tierKey = key
        if let t = quote?.tier(key) {
            progress.tierTotal = t.total
            progress.tierWindowCount = quote?.windowCount
        }
        saveProgress()
    }

    /// "Have WinChoice call me": the interest form (the contact step). The visit-booking step is not forced after it.
    func requestCallFromEstimate() {
        selectTier(selectedTier)
        push(.contact)
    }

    /// "See new windows in your home": the visualizer, on the first window (the others are one tap away on the estimate).
    func openVisualizerForFirstWindow(from origin: VisualizeOrigin) {
        guard let first = windowRows.first else { return }
        openVisualizer(first.id, from: origin)
    }

    // MARK: "I have more" (10)

    func setTotalWindows(_ n: Int?) async {
        guard let s = session else { return }
        do {
            accept(try await api.setEstimatedTotal(s, total: n.map(WindowTotal.clamp)))
        } catch let e as HomeownerAPIError {
            notice = Notice(text: e.message)
        } catch {
            notice = Notice(text: LiveHomeownerAPI.offlineMessage)
        }
    }

    /// From the list: after booking, a changed list goes back to My order once everything is styled; otherwise straight to the
    /// estimate. Styles are optional (they are tried in "See it in your home"): a window without one takes the likeliest for its shape.
    func continueFromList() async {
        if hasBooking {
            if unstyledCount > 0 { styleIndex = 0; push(.styles) } else { await syncWindows(); showStatus() }
            return
        }
        await finishStyles()
    }
}

/// A window a room scan found, ready to be saved (its size is the scan's own; the photo is the keyframe that saw it best).
struct ScannedWindow: Identifiable, Equatable {
    var id = UUID()
    var name: String
    var widthM: Double
    var heightM: Double
    var confidence: RoomPlanConfidence
    var jpeg: Data?
    var imageWidthPx: Int
    var imageHeightPx: Int
    var corners: [Vec2]?
    var isDoor = false
    /// The room it goes in, when it is not the one the scan started from.
    var room: String?

    var widthIn: Double { widthM * inchesPerMetre }
    var heightIn: Double { heightM * inchesPerMetre }
}
