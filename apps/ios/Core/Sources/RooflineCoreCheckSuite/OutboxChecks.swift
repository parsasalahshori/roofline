import Foundation
import RooflineCore

/// A server in memory: answers by script, records what it was sent.
final class FakeTransport: OutboxTransport, @unchecked Sendable {
    private let lock = NSLock()
    var uploadAnswers: [Result<WindowPhotoUpload, TransportError>] = []
    var appendAnswers: [TransportError?] = []
    /// Windows the "server" has (an append that failed after saving puts its id here too).
    var saved: [String: PhotoWindowInput] = [:]
    var saveThenFail = false
    var uploads = 0
    var appends = 0
    var existsCalls = 0

    func uploadPhoto(measurementId: String, jpeg: Data) async throws -> WindowPhotoUpload {
        try lock.locked {
            uploads += 1
            let a = uploadAnswers.isEmpty ? .success(WindowPhotoUpload(id: "up-\(uploads)", widthPx: 1440, heightPx: 1920)) : uploadAnswers.removeFirst()
            return try a.get()
        }
    }

    func appendWindow(measurementId: String, window: PhotoWindowInput) async throws {
        try lock.locked {
            appends += 1
            if saveThenFail {
                saveThenFail = false
                saved[window.id] = window
                throw TransportError(status: nil, message: "The network connection was lost.")
            }
            if !appendAnswers.isEmpty, let e = appendAnswers.removeFirst() { throw e }
            saved[window.id] = window
        }
    }

    func windowExists(measurementId: String, windowId: String) async throws -> Bool {
        lock.locked {
            existsCalls += 1
            return saved[windowId] != nil
        }
    }
}

extension NSLock {
    func locked<T>(_ f: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try f()
    }
}

func tempDir() -> URL {
    let u = FileManager.default.temporaryDirectory.appendingPathComponent("roofline-outbox-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
    return u
}

func sampleWindow(_ id: String = WindowIds.new()) -> PhotoWindowInput {
    PhotoWindowInput(id: id, uploadId: "", label: "Kitchen", windowKey: "k1", corners: [Vec2(100, 100), Vec2(500, 100), Vec2(500, 900), Vec2(100, 900)],
                     scale: .ar(ArScale(pointsM: rect(w: 1, h: 1.2), trackingLostCount: 0, device: .arkitLidar, cornerSpreadM: [0.001, 0.001, 0.001, 0.001])))
}

let outboxChecks: [Check] = [
    Check("Outbox: photo then window; the window carries the upload id") { ctx in
        let t = FakeTransport()
        let ob = Outbox(directory: tempDir(), transport: t)
        try await ob.load()
        let item = try await ob.enqueue(window: sampleWindow(), measurementId: "m", address: "1 Main", jpeg: Data([0xFF, 0xD8, 0xFF]), imageWidthPx: 1440, imageHeightPx: 1920)
        ctx.equal(item.nextStage, .photo)
        let done = await ob.syncAll()
        ctx.equal(done, 1)
        ctx.equal(t.uploads, 1)
        ctx.equal(t.appends, 1)
        ctx.equal(t.saved[item.id]?.uploadId, "up-1")
        ctx.equal(await ob.items.first?.state, .done)
        try await ob.clearDone()
        ctx.equal(await ob.items.count, 0)
    },
    Check("Outbox: a RoomPlan window with no photo skips the upload and is sent with no upload id or corners") { ctx in
        let t = FakeTransport()
        let ob = Outbox(directory: tempDir(), transport: t)
        try await ob.load()
        let w = PhotoWindowInput(id: WindowIds.new(), uploadId: nil, label: "Bed 2", windowKey: "k2", corners: nil,
                                 scale: .roomplan(RoomPlanScale(widthM: 0.9, heightM: 1.2, confidence: .high)))
        let item = try await ob.enqueue(window: w, measurementId: "m", address: nil, jpeg: nil, imageWidthPx: 0, imageHeightPx: 0)
        ctx.equal(item.nextStage, .window)
        ctx.equal(await ob.syncAll(), 1)
        ctx.equal(t.uploads, 0)
        ctx.equal(t.appends, 1)
        ctx.equal(t.saved[item.id]?.uploadId, nil)
        ctx.equal(t.saved[item.id]?.corners, nil)
        try await ob.clearDone()
        ctx.equal(await ob.items.count, 0)
    },
    Check("Outbox: a network failure waits and is sent on the next sync; a refusal waits for Retry") { ctx in
        let t = FakeTransport()
        t.uploadAnswers = [.failure(TransportError(status: nil, message: "offline"))]
        t.appendAnswers = [TransportError(status: 422, message: "Window \"Kitchen\" could not be sized.")]
        let ob = Outbox(directory: tempDir(), transport: t)
        try await ob.load()
        let item = try await ob.enqueue(window: sampleWindow(), measurementId: "m", address: nil, jpeg: Data([1]), imageWidthPx: 1440, imageHeightPx: 1920)
        await ob.syncAll()
        var now = await ob.items.first!
        ctx.equal(now.state, .waiting)
        ctx.equal(now.lastErrorStage, .photo)
        await ob.syncAll()
        now = await ob.items.first!
        ctx.equal(now.state, .failed, "422 needs the person")
        ctx.equal(now.lastError, "Window \"Kitchen\" could not be sized.")
        ctx.equal(now.uploadId, "up-2", "the photo stays uploaded")
        await ob.syncAll()
        ctx.equal(t.appends, 1, "a failed item is not sent by itself")
        try await ob.retry(id: item.id)
        await ob.syncAll()
        ctx.equal(await ob.items.first?.state, .done)
        ctx.equal(t.uploads, 2, "no third upload")
    },
    Check("Outbox: a save whose answer was lost is not sent twice") { ctx in
        let t = FakeTransport()
        t.saveThenFail = true
        let ob = Outbox(directory: tempDir(), transport: t)
        try await ob.load()
        _ = try await ob.enqueue(window: sampleWindow(), measurementId: "m", address: nil, jpeg: Data([1]), imageWidthPx: 1440, imageHeightPx: 1920)
        await ob.syncAll()
        ctx.equal(await ob.items.first?.state, .waiting)
        await ob.syncAll()
        ctx.equal(await ob.items.first?.state, .done)
        ctx.equal(t.appends, 1)
        ctx.equal(t.existsCalls, 1)
    },
    Check("Outbox: corners follow the upload's size; the outbox survives a restart") { ctx in
        let dir = tempDir()
        let t = FakeTransport()
        t.uploadAnswers = [.success(WindowPhotoUpload(id: "u", widthPx: 720, heightPx: 960))]
        t.appendAnswers = [TransportError(status: 503, message: "down")]
        let ob = Outbox(directory: dir, transport: t)
        try await ob.load()
        let item = try await ob.enqueue(window: sampleWindow(), measurementId: "m", address: nil, jpeg: Data([1]), imageWidthPx: 1440, imageHeightPx: 1920)
        await ob.syncAll()
        let again = Outbox(directory: dir, transport: t)
        try await again.load()
        let got = await again.items.first!
        ctx.equal(got.id, item.id)
        ctx.equal(got.uploadId, "u")
        ctx.equal(got.window.corners?.first, Vec2(50, 50))
        ctx.equal(got.imageWidthPx, 720)
        await again.syncAll()
        ctx.equal(t.saved[item.id]?.corners?[2], Vec2(250, 450))
    },
    Check("Outbox: a 429 holds the item back for Retry-After, then it goes by itself; it is never a refusal") { ctx in
        final class Clock: @unchecked Sendable {
            private let lock = NSLock()
            private var date = Date(timeIntervalSince1970: 1_800_000_000)
            var now: Date { lock.locked { date } }
            func advance(_ seconds: TimeInterval) { lock.locked { date = date.addingTimeInterval(seconds) } }
        }
        let clock = Clock()
        let t = FakeTransport()
        t.uploadAnswers = [.failure(TransportError(status: 429, message: "Too many photos at once.", retryAfter: 3))]
        let ob = Outbox(directory: tempDir(), transport: t, now: { clock.now })
        try await ob.load()
        _ = try await ob.enqueue(window: sampleWindow(), measurementId: "m", address: nil, jpeg: Data([1]), imageWidthPx: 1440, imageHeightPx: 1920)
        await ob.syncAll()
        var item = await ob.items.first!
        ctx.equal(item.state, .waiting, "a 429 is worth trying again, not a refusal")
        ctx.equal(item.lastError, "Too many photos at once.")
        ctx.equal(item.retryNotBefore, clock.now.addingTimeInterval(3), "not before the server's Retry-After")
        ctx.equal(await ob.nextRetryDate(), clock.now.addingTimeInterval(3))
        // Too early: the outbox does not knock again
        clock.advance(1)
        await ob.syncAll()
        ctx.equal(t.uploads, 1, "nothing is sent before Retry-After is over")
        ctx.equal(await ob.items.first?.state, .waiting)
        // The wait is over: it goes by itself, photo then window
        clock.advance(2.5)
        await ob.syncAll()
        item = await ob.items.first!
        ctx.equal(item.state, .done)
        ctx.equal(item.retryNotBefore, nil, "the hold is gone once it went through")
        ctx.equal(t.uploads, 2)
        ctx.equal(await ob.nextRetryDate(), nil)
    },
    Check("Outbox: the person's Retry does not wait for an old Retry-After; an old outbox file still reads") { ctx in
        var i = OutboxItem(window: sampleWindow(), measurementId: "m", address: nil, jpegFileName: "x.jpg", imageWidthPx: 1, imageHeightPx: 1)
        let t0 = Date(timeIntervalSince1970: 1_800_000_000)
        i = OutboxMachine.failed(OutboxMachine.started(i, .photo), .photo, TransportError(status: 429, message: "slow down", retryAfter: 3600), now: t0)
        ctx.equal(i.retryNotBefore, t0.addingTimeInterval(3600))
        ctx.equal(OutboxMachine.retried(i).retryNotBefore, nil)
        // A refusal (4xx) is not held back by a time: it waits for the person
        let refused = OutboxMachine.failed(OutboxMachine.started(OutboxItem(window: sampleWindow(), measurementId: "m", address: nil, jpegFileName: nil, imageWidthPx: 0, imageHeightPx: 0), .window), .window, TransportError(status: 422, message: "no", retryAfter: 60), now: t0)
        ctx.equal(refused.retryNotBefore, nil)
        ctx.equal(refused.state, .failed)
        // An outbox.json written before retryNotBefore existed decodes with it unset
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        var legacy = (try? JSONSerialization.jsonObject(with: e.encode(OutboxItem(window: sampleWindow(), measurementId: "m", address: nil, jpegFileName: nil, imageWidthPx: 0, imageHeightPx: 0)))) as? [String: Any] ?? [:]
        legacy.removeValue(forKey: "retryNotBefore")
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        let back = try d.decode(OutboxItem.self, from: JSONSerialization.data(withJSONObject: legacy))
        ctx.equal(back.retryNotBefore, nil)
    },
    Check("OutboxMachine: a refused photo upload is redone from scratch on Retry") { ctx in
        var i = OutboxItem(window: sampleWindow(), measurementId: "m", address: nil, jpegFileName: "x.jpg", imageWidthPx: 1, imageHeightPx: 1)
        i = OutboxMachine.failed(OutboxMachine.started(i, .photo), .photo, TransportError(status: 415, message: "HEIC"))
        ctx.equal(i.state, .failed)
        ctx.equal(i.nextStage, nil)
        i = OutboxMachine.retried(i)
        ctx.equal(i.nextStage, .photo)
        ctx.expect(TransportError(status: 429, message: "").isRetryable && !TransportError(status: 404, message: "").isRetryable, "retryable statuses")
    },
]
