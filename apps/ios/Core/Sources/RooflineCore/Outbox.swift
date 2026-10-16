import Foundation

// The sync outbox. A measured window is saved on the phone first (its JPEG and its window JSON, on disk), then sent:
// 1. the JPEG to POST /api/window-measurements/:id/uploads -> upload id and the photo's size,
// 2. the window (with that upload id) to POST /api/window-measurements/:id/photo-windows.
// Each step is recorded on disk before the next, so a killed app or a dead signal resumes where it stopped. A failure
// the server explains (4xx) waits for the person's Retry; a network failure or 5xx is tried again on the next sync. A 429
// (too many calls, or too many photos at once) carries Retry-After: the item waits at least that long, so the outbox does not
// keep knocking while the server is telling it to stop.
//
// The homeowner app (WinChoice) uses the same outbox over its own endpoints: `measurementId` is then the REQUEST id,
// the photo goes to POST /requests/:id/uploads and the window to POST /requests/:id/windows (idempotent on the window
// id), both with the homeowner's bearer token (HomeownerOutboxTransport in the app). A window can be HELD: its photo
// uploads at once, but the window itself waits until the homeowner has picked its style (the server needs one), then
// `release` lets it go.

public enum OutboxState: String, Codable, Sendable {
    /// Not sent yet, or a step failed in a way worth trying again by itself.
    case waiting
    case sending
    case done
    /// The server refused it: needs the person's Retry (after fixing what the error says).
    case failed
}

public enum OutboxStage: String, Codable, Sendable {
    case photo
    case window
}

public struct OutboxItem: Codable, Equatable, Sendable, Identifiable {
    /// The window's id (PhotoWindowInput.id).
    public var id: String
    public var measurementId: String
    public var address: String?
    public var createdAt: Date
    /// The JPEG next to the outbox file; nil for a RoomPlan window saved without a photo.
    public var jpegFileName: String?
    /// The JPEG's size: the window's corners are in these pixels.
    public var imageWidthPx: Int
    public var imageHeightPx: Int
    /// The window; its uploadId is filled in once the photo is up.
    public var window: PhotoWindowInput
    public var uploadId: String?
    public var state: OutboxState
    public var attempts: Int
    public var lastError: String?
    public var lastErrorStage: OutboxStage?
    /// A window save was attempted and its answer never came: check before sending again.
    public var windowSendUncertain: Bool
    /// The homeowner app: the window is complete on the phone but not ready to send (its style is not picked yet). The
    /// photo still uploads. Optional so an outbox written before this existed still decodes.
    public var held: Bool?
    /// The server said "not before" (429's Retry-After): `syncAll` leaves the item alone until then. Optional so an outbox
    /// written before this existed still decodes.
    public var retryNotBefore: Date?

    public init(window: PhotoWindowInput, measurementId: String, address: String?, jpegFileName: String?, imageWidthPx: Int, imageHeightPx: Int, createdAt: Date = Date()) {
        id = window.id
        self.measurementId = measurementId
        self.address = address
        self.createdAt = createdAt
        self.jpegFileName = jpegFileName
        self.imageWidthPx = imageWidthPx
        self.imageHeightPx = imageHeightPx
        self.window = window
        uploadId = nil
        state = .waiting
        attempts = 0
        lastError = nil
        lastErrorStage = nil
        windowSendUncertain = false
        held = nil
    }

    /// Complete on the phone, waiting for the homeowner (see `held`).
    public var isHeld: Bool { held == true }

    /// What to do next, or nil when there is nothing (done, held back, or waiting for Retry).
    public var nextStage: OutboxStage? {
        switch state {
        case .done, .failed: return nil
        case .waiting, .sending:
            if uploadId == nil && jpegFileName != nil { return .photo }
            return isHeld ? nil : .window
        }
    }
}

/// An answer the server gave, or no answer at all (status nil).
public struct TransportError: Error, Equatable, Sendable {
    public var status: Int?
    public var message: String
    /// Seconds the server asked us to wait before trying again (429's Retry-After).
    public var retryAfter: Double?

    public init(status: Int?, message: String, retryAfter: Double? = nil) {
        self.status = status
        self.message = message
        self.retryAfter = retryAfter
    }

    /// Worth trying again by itself: no answer, a timeout, rate limiting, or the server's own failure.
    public var isRetryable: Bool {
        guard let s = status else { return true }
        return s == 408 || s == 429 || s >= 500
    }
}

/// What the outbox needs from the network (the app's API client; a fake in the checks).
public protocol OutboxTransport: Sendable {
    func uploadPhoto(measurementId: String, jpeg: Data) async throws -> WindowPhotoUpload
    func appendWindow(measurementId: String, window: PhotoWindowInput) async throws
    /// Is a window with this id already saved on the measurement?
    func windowExists(measurementId: String, windowId: String) async throws -> Bool
}

/// The pure step transitions, so they can be checked without disk or network.
public enum OutboxMachine {
    public static func started(_ item: OutboxItem, _ stage: OutboxStage) -> OutboxItem {
        var i = item
        i.state = .sending
        i.attempts += 1
        if stage == .window { i.windowSendUncertain = true }
        return i
    }

    public static func photoUploaded(_ item: OutboxItem, _ upload: WindowPhotoUpload) -> OutboxItem {
        var i = item
        i.uploadId = upload.id
        i.window.uploadId = upload.id
        // The corners are in the JPEG's pixels; if the server reads the photo at another size, follow it
        if upload.widthPx != i.imageWidthPx || upload.heightPx != i.imageHeightPx, upload.widthPx > 0, upload.heightPx > 0 {
            let from = (Double(i.imageWidthPx), Double(i.imageHeightPx)), to = (Double(upload.widthPx), Double(upload.heightPx))
            i.window.corners = i.window.corners.map { ImageMapping.rescale($0, from: from, to: to) }
            // A card window has a second set of corners in the same photo
            if case .card(let c) = i.window.scale {
                i.window.scale = .card(CardScale(cardCorners: ImageMapping.rescale(c.cardCorners, from: from, to: to), card: c.card))
            }
            i.imageWidthPx = upload.widthPx
            i.imageHeightPx = upload.heightPx
        }
        i.state = .waiting
        i.lastError = nil
        i.lastErrorStage = nil
        i.retryNotBefore = nil
        return i
    }

    public static func windowSaved(_ item: OutboxItem) -> OutboxItem {
        var i = item
        i.retryNotBefore = nil
        i.state = .done
        i.windowSendUncertain = false
        i.lastError = nil
        i.lastErrorStage = nil
        return i
    }

    public static func failed(_ item: OutboxItem, _ stage: OutboxStage, _ error: TransportError, now: Date = Date()) -> OutboxItem {
        var i = item
        i.state = error.isRetryable ? .waiting : .failed
        i.lastError = error.message
        i.lastErrorStage = stage
        // "Try again in N seconds": not before then (only for what is worth retrying by itself)
        i.retryNotBefore = error.isRetryable ? error.retryAfter.map { now.addingTimeInterval(max($0, 0)) } : nil
        // A refused window was not saved: no doubt left about it
        if stage == .window, !error.isRetryable { i.windowSendUncertain = false }
        return i
    }

    /// The person tapped Retry: a refused upload is sent again from scratch (a new photo upload).
    public static func retried(_ item: OutboxItem) -> OutboxItem {
        var i = item
        guard i.state == .failed || i.state == .waiting else { return i }
        if i.lastErrorStage == .photo { i.uploadId = nil }
        i.state = .waiting
        // The person asked: do not hold it back for an earlier "not before"
        i.retryNotBefore = nil
        return i
    }
}

/// The outbox on disk: `outbox.json` and one JPEG per window in `directory`.
public actor Outbox {
    public let directory: URL
    private let transport: OutboxTransport
    private let now: @Sendable () -> Date
    public private(set) var items: [OutboxItem] = []
    private var syncing = false
    private var observer: (@Sendable ([OutboxItem]) -> Void)?

    /// `now` is the clock the Retry-After waits are measured on (a check can move it).
    public init(directory: URL, transport: OutboxTransport, now: @escaping @Sendable () -> Date = { Date() }) {
        self.directory = directory
        self.transport = transport
        self.now = now
    }

    private var fileURL: URL { directory.appendingPathComponent("outbox.json") }

    public func setObserver(_ f: (@Sendable ([OutboxItem]) -> Void)?) {
        observer = f
        f?(items)
    }

    public func load() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            items = []
            return
        }
        let data = try Data(contentsOf: fileURL)
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        items = try d.decode([OutboxItem].self, from: data)
        // An item caught mid-send by a killed app goes back to waiting (its step will be redone safely)
        items = items.map { var i = $0; if i.state == .sending { i.state = .waiting }; return i }
        observer?(items)
    }

    private func persist() throws {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        e.outputFormatting = [.sortedKeys]
        try e.encode(items).write(to: fileURL, options: [.atomic])
        observer?(items)
    }

    public func jpegURL(for item: OutboxItem) -> URL? { item.jpegFileName.map { directory.appendingPathComponent($0) } }

    /// Saves a measured window and its photo on disk. Nothing is sent yet. A RoomPlan window may come without a photo
    /// (no frame saw all four corners): it skips the upload and is sent with no uploadId and no corners.
    public func enqueue(window: PhotoWindowInput, measurementId: String, address: String?, jpeg: Data?, imageWidthPx: Int, imageHeightPx: Int, held: Bool = false) throws -> OutboxItem {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var name: String?
        if let jpeg = jpeg {
            name = "\(window.id).jpg"
            try jpeg.write(to: directory.appendingPathComponent("\(window.id).jpg"), options: [.atomic])
        }
        var item = OutboxItem(window: window, measurementId: measurementId, address: address, jpegFileName: name, imageWidthPx: imageWidthPx, imageHeightPx: imageHeightPx)
        if held { item.held = true }
        items.removeAll { $0.id == item.id }
        items.append(item)
        try persist()
        return item
    }

    /// Changes a window that has not been sent yet (the homeowner's room, name or style) and, with `release`, lets it go.
    /// A window already on the server is not touched: the server refuses a second, different body for the same id.
    @discardableResult
    public func updateWindow(id: String, release: Bool = false, _ change: (inout PhotoWindowInput) -> Void) throws -> Bool {
        guard let k = items.firstIndex(where: { $0.id == id }), items[k].state != .done, items[k].windowSendUncertain == false else { return false }
        change(&items[k].window)
        if release { items[k].held = nil }
        try persist()
        return true
    }

    /// Lets a held window go (its style is picked).
    public func release(id: String) throws {
        guard let k = items.firstIndex(where: { $0.id == id }) else { return }
        items[k].held = nil
        try persist()
    }

    /// Drops every item of one request, with its photo (the homeowner started over, or the saved request expired).
    public func removeAll(measurementId: String) throws {
        for i in items where i.measurementId == measurementId { if let u = jpegURL(for: i) { try? FileManager.default.removeItem(at: u) } }
        items.removeAll { $0.measurementId == measurementId }
        try persist()
    }

    public func retry(id: String) throws {
        guard let k = items.firstIndex(where: { $0.id == id }) else { return }
        items[k] = OutboxMachine.retried(items[k])
        try persist()
    }

    /// Removes an item and its photo (a sent one, or one the person gave up on).
    public func remove(id: String) throws {
        guard let k = items.firstIndex(where: { $0.id == id }) else { return }
        if let u = jpegURL(for: items[k]) { try? FileManager.default.removeItem(at: u) }
        items.remove(at: k)
        try persist()
    }

    /// Drops the finished items (and their photos).
    public func clearDone() throws {
        for i in items where i.state == .done { if let u = jpegURL(for: i) { try? FileManager.default.removeItem(at: u) } }
        items.removeAll { $0.state == .done }
        try persist()
    }

    public var pendingCount: Int { items.filter { $0.state != .done }.count }

    /// When the earliest held-back item may be tried again (the server's Retry-After), nil when nothing is held back.
    public func nextRetryDate() -> Date? {
        items.filter { $0.state == .waiting && !$0.isHeld }.compactMap { $0.retryNotBefore }.filter { $0 > now() }.min()
    }

    /// Sends everything that can be sent, one item at a time, oldest first. Returns how many finished.
    @discardableResult
    public func syncAll() async -> Int {
        guard !syncing else { return 0 }
        syncing = true
        defer { syncing = false }
        var finished = 0
        for id in items.sorted(by: { $0.createdAt < $1.createdAt }).map({ $0.id }) {
            if await send(id: id) { finished += 1 }
        }
        return finished
    }

    /// Takes one item as far as it goes. True when it ended done.
    @discardableResult
    public func send(id: String) async -> Bool {
        while let k = items.firstIndex(where: { $0.id == id }), let stage = items[k].nextStage {
            // The server said to wait (Retry-After): not before then
            if let notBefore = items[k].retryNotBefore, notBefore > now() { return false }
            let item = items[k]
            update(OutboxMachine.started(item, stage))
            do {
                switch stage {
                case .photo:
                    guard let url = jpegURL(for: item) else { throw CocoaError(.fileNoSuchFile) }
                    let data = try Data(contentsOf: url)
                    let up = try await transport.uploadPhoto(measurementId: item.measurementId, jpeg: data)
                    update(OutboxMachine.photoUploaded(current(id) ?? item, up))
                case .window:
                    // A save whose answer was lost may have gone through: look before sending it again
                    if item.windowSendUncertain, item.attempts > 0, try await transport.windowExists(measurementId: item.measurementId, windowId: item.id) {
                        update(OutboxMachine.windowSaved(current(id) ?? item))
                        continue
                    }
                    try await transport.appendWindow(measurementId: item.measurementId, window: (current(id) ?? item).window)
                    update(OutboxMachine.windowSaved(current(id) ?? item))
                }
            } catch let e as TransportError {
                update(OutboxMachine.failed(current(id) ?? item, stage, e, now: now()))
                return false
            } catch {
                let e = TransportError(status: nil, message: (error as NSError).localizedDescription)
                // The JPEG is gone from disk: nothing to retry with
                let fileMissing = stage == .photo && !(jpegURL(for: item).map { FileManager.default.fileExists(atPath: $0.path) } ?? false)
                update(OutboxMachine.failed(current(id) ?? item, stage, fileMissing ? TransportError(status: 410, message: "The photo is missing on this phone. Measure this window again.") : e))
                return false
            }
        }
        return current(id)?.state == .done
    }

    private func current(_ id: String) -> OutboxItem? { items.first { $0.id == id } }

    private func update(_ item: OutboxItem) {
        guard let k = items.firstIndex(where: { $0.id == item.id }) else { return }
        items[k] = item
        try? persist()
    }
}
