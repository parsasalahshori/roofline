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

    /// The room's method screen.
    func measure(room: String) {
        path.append(.method(room: room))
        noteStep(.rooms)
    }

    // MARK: Methods (06)

    func isAvailable(_ m: MeasureMethod) -> Bool {
        switch m {
        case .corners: return capabilities.corners
        case .roomScan: return capabilities.roomScan
        case .card: return capabilities.camera
        }
    }

    /// The method to start on: the most accurate one this phone has.
    var defaultMethod: MeasureMethod {
        if capabilities.corners { return .corners }
        if capabilities.camera { return .card }
        return .corners
    }

    /// "About 1/4 inch · best": what each method says about itself.
    func methodAccuracy(_ m: MeasureMethod) -> (text: String, best: Bool) {
        switch m {
        case .corners:
            return capabilities.depthSensor ? ("\(SizeWording.accuracyRange(lowIn: 0.25, highIn: 0.25)) · best", true)
                                            : (SizeWording.accuracyRange(lowIn: 0.375, highIn: 0.375), false)
        case .roomScan: return ("\(SizeWording.accuracyRange(lowIn: 1, highIn: 1)) · good for a quote", false)
        case .card: return (SizeWording.accuracyRange(lowIn: 0.25, highIn: 0.5), false)
        }
    }

    func startMeasuring(room: String, replacing: String? = nil) {
        guard isAvailable(method) else { return }
        measureSession = MeasureSession(method: method, room: room, number: nextWindowNumber, replacing: replacing)
    }

    // MARK: A measured window (08)

    /// A finished measure becomes a pending window with its size from the phone's own math; the label sheet takes it from there.
    func capture(scale: WindowPhotoScale, corners: [Vec2]?, jpeg: Data?, widthPx: Int, heightPx: Int, focal35mm: Double? = nil, in session: MeasureSession) {
        let window = PhotoWindowInput(id: WindowIds.new(), uploadId: nil, label: nil, windowKey: nil, corners: corners, scale: scale, room: session.room, style: nil)
        let preview = LocalWindowPreview.of(window, imageWidthPx: widthPx, imageHeightPx: heightPx, focal35mm: focal35mm)
        pending = PendingWindow(id: window.id, scale: scale, corners: corners, jpeg: jpeg, imageWidthPx: widthPx, imageHeightPx: heightPx, preview: preview,
                                room: session.room, name: "", number: session.number, replacing: session.replacing)
    }

    /// "Save window 4": the window and its photo go on disk, the photo uploads at once, the window waits for its style.
    func savePending(room: String, name: String) async {
        guard let p = pending, let s = session else { return }
        let cleanRoom = RoomNames.clean(room) ?? p.room
        let cleanName = Self.cleanLabel(name, max: company.limits.maxLabelLength)
        let window = PhotoWindowInput(id: p.id, uploadId: nil, label: cleanName, windowKey: nil, corners: p.corners, scale: p.scale, room: cleanRoom, style: nil)
        do {
            _ = try await outbox.enqueue(window: window, measurementId: s.requestId, address: s.address, jpeg: p.jpeg, imageWidthPx: p.imageWidthPx, imageHeightPx: p.imageHeightPx, held: true)
        } catch {
            notice = Notice(text: "This phone couldn't save the window (\(error.localizedDescription)). Please try again.")
            return
        }
        _ = addRoom(cleanRoom)
        if let old = p.replacing { await deleteEverywhere(old) }
        Haptics.success()
        showList()
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
        guard let s = session, view?.windows.contains(where: { $0.id == id }) == true else { return }
        do {
            accept(try await api.deleteWindow(s, windowId: id))
        } catch let e as HomeownerAPIError {
            notice = Notice(text: e.message)
        } catch {
            notice = Notice(text: LiveHomeownerAPI.offlineMessage)
        }
    }

    func measureAgain(_ row: WindowRow) async {
        await deleteEverywhere(row.id)
        let room = row.room.isEmpty ? (suggestedRoom ?? "Living room") : row.room
        path = stack(to: .rooms) + [.method(room: room)]
        method = defaultMethod
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
                Task { await outbox.syncAll() }
                return
            }
        }
        guard let existing = view?.windows.first(where: { $0.id == windowId }), existing.input.style != key else { return }
        var copy = existing.input
        copy.id = WindowIds.new()
        copy.style = key
        if let color = progress.colors[windowId] { progress.colors[copy.id] = color }
        do {
            _ = try await outbox.enqueue(window: copy, measurementId: s.requestId, address: s.address, jpeg: nil, imageWidthPx: 0, imageHeightPx: 0, held: false)
            await outbox.syncAll()
            accept(try await api.deleteWindow(s, windowId: windowId))
        } catch let e as HomeownerAPIError {
            notice = Notice(text: e.message)
        } catch {
            notice = Notice(text: "This phone couldn't change that window's style. Please try again.")
        }
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

    func bookFromQuote() {
        selectTier(selectedTier)
        push(.contact)
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

    /// From the list: styles to pick (any window without one, or a first look), else straight on.
    func continueFromList() async {
        if hasBooking {
            // After booking, a changed list goes back to My order once everything is styled
            if unstyledCount > 0 { styleIndex = 0; push(.styles) } else { await syncWindows(); showStatus() }
            return
        }
        styleIndex = 0
        push(.styles)
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
