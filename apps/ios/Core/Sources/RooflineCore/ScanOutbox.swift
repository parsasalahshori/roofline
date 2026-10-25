import Foundation

// The scan's own outbox. A finished scan is saved on the phone first (its photos as JPEG files, its frames and marks as JSON), then sent:
//   1. each photo to the EXISTING upload route -> an upload id (recorded on disk after each, so a killed app resumes where it stopped),
//   2. POST .../requests/:id/scans with the contract's body, only AFTER the window itself is on the server (the scan names its window id).
// A scan waits ("staged") until the person has saved the window; leaving the window out removes the scan with it. A server that does not
// know the route yet (404) keeps the scan queued without a word: the window itself is already sent and priced, the scan is extra evidence.
// Same rules as the window outbox: a network failure or 5xx is tried again, a 429 waits its Retry-After, a refusal (4xx) stops the scan.

public struct ScanItem: Codable, Equatable, Sendable, Identifiable {
    /// The scan's id (WindowScanPayload.scanId).
    public var id: String
    public var windowId: String
    /// The request id.
    public var measurementId: String
    public var createdAt: Date
    public var draft: ScanDraft
    /// The JPEG file of each photo, by frame id (next to the outbox file).
    public var frameFiles: [String: String]
    /// The upload ids so far, by frame id.
    public var uploadIds: [String: String]
    public var app: String
    public var device: String
    /// False while the window is still being named and saved on the phone: nothing is sent.
    public var armed: Bool
    public var state: OutboxState
    public var attempts: Int
    public var lastError: String?
    public var retryNotBefore: Date?
    /// What the server answered (its status and its own result, which wins over the phone's).
    public var serverStatus: String?
    public var serverResult: ScanResultPayload?

    public var isDone: Bool { state == .done }

    /// The next frame to upload, or nil when all are up.
    public var nextUpload: String? { draft.frames.first { uploadIds[$0.frameId] == nil }?.frameId }
}

/// What the scan outbox needs from the network.
public protocol ScanTransport: Sendable {
    func uploadFrame(measurementId: String, jpeg: Data) async throws -> WindowPhotoUpload
    func postScan(measurementId: String, body: Data) async throws -> WindowScanAnswer
}

public enum ScanOutboxMachine {
    /// A scan older than this is let go (a request this old is gone from the server anyway).
    public static let maxAgeDays = 14.0
    /// A server that does not know the scans route yet is asked again after this long (seconds).
    public static let notDeployedWaitS = 600.0

    public static func frameUploaded(_ item: ScanItem, frameId: String, upload: WindowPhotoUpload) -> ScanItem {
        var i = item
        i.uploadIds[frameId] = upload.id
        i.state = .waiting
        i.lastError = nil
        i.retryNotBefore = nil
        return i
    }

    public static func posted(_ item: ScanItem, answer: WindowScanAnswer) -> ScanItem {
        var i = item
        i.state = .done
        i.serverStatus = answer.status
        i.serverResult = answer.result
        i.lastError = nil
        i.retryNotBefore = nil
        return i
    }

    public static func failed(_ item: ScanItem, _ error: TransportError, now: Date) -> ScanItem {
        var i = item
        // 404: the route (or the window) is not on the server yet. Quiet: no error recorded, tried again later.
        if error.status == 404 {
            i.state = .waiting
            i.lastError = nil
            i.retryNotBefore = now.addingTimeInterval(notDeployedWaitS)
            return i
        }
        i.state = error.isRetryable ? .waiting : .failed
        i.lastError = error.message
        i.retryNotBefore = error.isRetryable ? error.retryAfter.map { now.addingTimeInterval(max($0, 0)) } : nil
        return i
    }
}

public actor ScanOutbox {
    public let directory: URL
    private let transport: ScanTransport
    private let now: @Sendable () -> Date
    public private(set) var items: [ScanItem] = []
    private var syncing = false
    private var observer: (@Sendable ([ScanItem]) -> Void)?
    private var windowSent: (@Sendable (String) async -> Bool)?

    public init(directory: URL, transport: ScanTransport, now: @escaping @Sendable () -> Date = { Date() }) {
        self.directory = directory
        self.transport = transport
        self.now = now
    }

    private var fileURL: URL { directory.appendingPathComponent("scans.json") }

    public func setObserver(_ f: (@Sendable ([ScanItem]) -> Void)?) {
        observer = f
        f?(items)
    }

    /// Says whether a window is already on the server (the scan is sent only after it).
    public func setWindowGate(_ f: (@Sendable (String) async -> Bool)?) { windowSent = f }

    public func load() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            items = []
            return
        }
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        items = try d.decode([ScanItem].self, from: Data(contentsOf: fileURL))
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

    private func jpegURL(_ name: String) -> URL { directory.appendingPathComponent(name) }

    /// Saves a finished scan and its photos on disk, not yet to be sent (the window it belongs to is still being saved).
    @discardableResult
    public func stage(draft: ScanDraft, measurementId: String, jpegs: [String: Data], app: String, device: String) throws -> ScanItem {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var files: [String: String] = [:]
        for f in draft.frames {
            guard let data = jpegs[f.frameId] else { throw CocoaError(.fileNoSuchFile) }
            let name = "scan-\(draft.scanId)-\(f.frameId).jpg"
            try data.write(to: jpegURL(name), options: [.atomic])
            files[f.frameId] = name
        }
        let item = ScanItem(id: draft.scanId, windowId: draft.windowId, measurementId: measurementId, createdAt: now(), draft: draft, frameFiles: files, uploadIds: [:],
                            app: app, device: device, armed: false, state: .waiting, attempts: 0, lastError: nil, retryNotBefore: nil, serverStatus: nil, serverResult: nil)
        removeFiles(of: items.filter { $0.id == item.id })
        items.removeAll { $0.id == item.id }
        items.append(item)
        try persist()
        return item
    }

    /// The window is saved: its scan may go.
    public func arm(windowId: String) throws {
        var changed = false
        for k in items.indices where items[k].windowId == windowId && !items[k].armed {
            items[k].armed = true
            changed = true
        }
        if changed { try persist() }
    }

    /// The window was left out: its scan (not yet sent) goes with it, photos and all.
    public func discard(windowId: String) throws {
        let gone = items.filter { $0.windowId == windowId && $0.state != .done }
        guard !gone.isEmpty else { return }
        removeFiles(of: gone)
        items.removeAll { $0.windowId == windowId && $0.state != .done }
        try persist()
    }

    /// Every scan of one request (the person started over).
    public func removeAll(measurementId: String) throws {
        removeFiles(of: items.filter { $0.measurementId == measurementId })
        items.removeAll { $0.measurementId == measurementId }
        try persist()
    }

    /// The request was replaced by a new one: unsent scans move to it and upload again from the photos.
    @discardableResult
    public func reassign(from old: String, to new: String) throws -> Int {
        var moved = 0
        for k in items.indices where items[k].measurementId == old && items[k].state != .done {
            items[k].measurementId = new
            items[k].uploadIds = [:]
            items[k].state = .waiting
            items[k].attempts = 0
            items[k].lastError = nil
            items[k].retryNotBefore = nil
            moved += 1
        }
        if moved > 0 { try persist() }
        return moved
    }

    private func removeFiles(of list: [ScanItem]) {
        for i in list { for name in i.frameFiles.values { try? FileManager.default.removeItem(at: jpegURL(name)) } }
    }

    public func item(forWindow windowId: String) -> ScanItem? { items.first { $0.windowId == windowId } }

    public var pendingCount: Int { items.filter { $0.armed && $0.state != .done && $0.state != .failed }.count }

    /// Sends everything that can be sent, one scan at a time, oldest first. Returns how many finished.
    @discardableResult
    public func syncAll() async -> Int {
        guard !syncing else { return 0 }
        syncing = true
        defer { syncing = false }
        purgeOld()
        var finished = 0
        for id in items.sorted(by: { $0.createdAt < $1.createdAt }).map({ $0.id }) {
            if await send(id: id) { finished += 1 }
        }
        return finished
    }

    private func purgeOld() {
        let limit = now().addingTimeInterval(-ScanOutboxMachine.maxAgeDays * 86_400)
        let old = items.filter { $0.createdAt < limit }
        guard !old.isEmpty else { return }
        removeFiles(of: old)
        items.removeAll { $0.createdAt < limit }
        try? persist()
    }

    /// Takes one scan as far as it goes. True when it ended done.
    @discardableResult
    public func send(id: String) async -> Bool {
        while let k = items.firstIndex(where: { $0.id == id }), items[k].armed, items[k].state == .waiting || items[k].state == .sending {
            if let notBefore = items[k].retryNotBefore, notBefore > now() { return false }
            let item = items[k]
            if let frameId = item.nextUpload {
                // 1. the photos
                var started = item
                started.state = .sending
                started.attempts += 1
                update(started)
                do {
                    guard let name = item.frameFiles[frameId], let data = try? Data(contentsOf: jpegURL(name)) else { throw CocoaError(.fileNoSuchFile) }
                    let up = try await transport.uploadFrame(measurementId: item.measurementId, jpeg: data)
                    update(ScanOutboxMachine.frameUploaded(current(id) ?? started, frameId: frameId, upload: up))
                } catch let e as TransportError {
                    update(ScanOutboxMachine.failed(current(id) ?? started, e, now: now()))
                    return false
                } catch {
                    let missing = !(item.frameFiles[frameId].map { FileManager.default.fileExists(atPath: jpegURL($0).path) } ?? false)
                    let e = missing ? TransportError(status: 410, message: "A scan photo is missing on this phone.") : TransportError(status: nil, message: (error as NSError).localizedDescription)
                    update(ScanOutboxMachine.failed(current(id) ?? started, e, now: now()))
                    return false
                }
            } else {
                // 2. the scan itself, after its window
                if let gate = windowSent, !(await gate(item.windowId)) { return false }
                guard let payload = item.draft.payload(uploadIds: item.uploadIds, app: item.app, device: item.device), payload.problem == nil,
                      let body = try? payload.json() else {
                    var bad = item
                    bad.state = .failed
                    bad.lastError = "The scan could not be put together."
                    update(bad)
                    return false
                }
                var started = item
                started.state = .sending
                started.attempts += 1
                update(started)
                do {
                    let answer = try await transport.postScan(measurementId: item.measurementId, body: body)
                    let done = ScanOutboxMachine.posted(current(id) ?? started, answer: answer)
                    update(done)
                    removeFiles(of: [done])
                } catch let e as TransportError {
                    update(ScanOutboxMachine.failed(current(id) ?? started, e, now: now()))
                    return false
                } catch {
                    update(ScanOutboxMachine.failed(current(id) ?? started, TransportError(status: nil, message: (error as NSError).localizedDescription), now: now()))
                    return false
                }
            }
        }
        return current(id)?.state == .done
    }

    private func current(_ id: String) -> ScanItem? { items.first { $0.id == id } }

    private func update(_ item: ScanItem) {
        guard let k = items.firstIndex(where: { $0.id == item.id }) else { return }
        items[k] = item
        try? persist()
    }
}
