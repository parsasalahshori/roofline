import Foundation
import RooflineCore

// Checks for the scan's outbox (ScanOutbox.swift): staged until the window is saved, photos first, the scan only after its window, a server
// that does not know the route yet, a killed app, a refused scan, a window left out.

final class FakeScanTransport: ScanTransport, @unchecked Sendable {
    private let lock = NSLock()
    var uploads = 0
    var posts = 0
    var postAnswers: [TransportError?] = []
    var uploadErrors: [TransportError?] = []
    var bodies: [Data] = []

    func uploadFrame(measurementId: String, jpeg: Data) async throws -> WindowPhotoUpload {
        try lock.locked {
            uploads += 1
            if !uploadErrors.isEmpty, let e = uploadErrors.removeFirst() { throw e }
            return WindowPhotoUpload(id: "up-\(uploads)", widthPx: 1920, heightPx: 1440)
        }
    }

    func postScan(measurementId: String, body: Data) async throws -> WindowScanAnswer {
        try lock.locked {
            posts += 1
            bodies.append(body)
            if !postAnswers.isEmpty, let e = postAnswers.removeFirst() { throw e }
            let scanId = ((try? JSONSerialization.jsonObject(with: body)) as? [String: Any])?["scanId"] as? String ?? "?"
            return WindowScanAnswer(scanId: scanId, status: "needs_review")
        }
    }
}

final class ScanClock: @unchecked Sendable {
    private let lock = NSLock()
    private var t = Date(timeIntervalSince1970: 1_800_000_000)
    var now: Date { lock.locked { t } }
    func advance(_ s: Double) { lock.locked { t = t.addingTimeInterval(s) } }
}

final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var v = false
    var value: Bool { get { lock.locked { v } } set { lock.locked { v = newValue } } }
}

private func sampleDraft(_ windowId: String = "w1", frames n: Int = 5) -> (ScanDraft, [String: Data]) {
    let s = ScanScene()
    let frames = s.regularFrames(n)
    var jpegs: [String: Data] = [:]
    for f in frames { jpegs[f.frameId] = Data("jpeg-\(f.frameId)".utf8) }
    return (ScanDraft(scanId: "scan-\(windowId)", windowId: windowId, frames: frames, allMarks: s.marks(frames), wall: s.wall), jpegs)
}

let scanOutboxChecks: [Check] = [
    Check("ScanOutbox: a staged scan sends nothing until its window is saved; then the photos go up, and the scan waits for its window on the server") { ctx in
        let dir = tempDir()
        let transport = FakeScanTransport()
        let clock = ScanClock()
        let windowThere = Flag()
        let box = ScanOutbox(directory: dir, transport: transport, now: { clock.now })
        await box.setWindowGate { _ in windowThere.value }
        let (draft, jpegs) = sampleDraft()
        try await box.stage(draft: draft, measurementId: "req1", jpegs: jpegs, app: "0.1.0 (1)", device: "iPhone17,2")
        await box.syncAll()
        ctx.equal(transport.uploads, 0, "staged: nothing sent")
        try await box.arm(windowId: "w1")
        await box.syncAll()
        ctx.equal(transport.uploads, 5, "every photo is up")
        ctx.equal(transport.posts, 0, "the window is not on the server yet")
        var item = await box.item(forWindow: "w1")
        ctx.equal(item?.uploadIds.count, 5)
        ctx.equal(item?.state, .waiting)
        windowThere.value = true
        let finished = await box.syncAll()
        ctx.equal(finished, 1)
        ctx.equal(transport.posts, 1)
        ctx.equal(transport.uploads, 5, "photos are not sent twice")
        item = await box.item(forWindow: "w1")
        ctx.equal(item?.state, .done)
        ctx.equal(item?.serverStatus, "needs_review")
        // the body is the contract's, with the upload ids in
        let body = (try JSONSerialization.jsonObject(with: transport.bodies[0])) as? [String: Any]
        ctx.equal(body?["windowId"] as? String, "w1")
        ctx.equal((body?["frames"] as? [[String: Any]])?.compactMap { $0["uploadId"] as? String }.count, 5)
        // the photos are off the phone once it is done
        ctx.equal((try FileManager.default.contentsOfDirectory(atPath: dir.path)).filter { $0.hasSuffix(".jpg") }.count, 0)
    },
    Check("ScanOutbox: a server without the route (404) keeps the scan queued without an error and tries again later") { ctx in
        let dir = tempDir()
        let transport = FakeScanTransport()
        transport.postAnswers = [TransportError(status: 404, message: "We couldn't find that.")]
        let clock = ScanClock()
        let box = ScanOutbox(directory: dir, transport: transport, now: { clock.now })
        await box.setWindowGate { _ in true }
        let (draft, jpegs) = sampleDraft()
        try await box.stage(draft: draft, measurementId: "req1", jpegs: jpegs, app: "a", device: "d")
        try await box.arm(windowId: "w1")
        await box.syncAll()
        var item = await box.item(forWindow: "w1")
        ctx.equal(transport.posts, 1)
        ctx.equal(item?.state, .waiting)
        ctx.equal(item?.lastError, nil, "no error shown for a route that is not deployed yet")
        ctx.expect(item?.retryNotBefore != nil)
        await box.syncAll()
        ctx.equal(transport.posts, 1, "not asked again at once")
        clock.advance(ScanOutboxMachine.notDeployedWaitS + 1)
        await box.syncAll()
        ctx.equal(transport.posts, 2)
        item = await box.item(forWindow: "w1")
        ctx.equal(item?.state, .done)
        ctx.equal(transport.uploads, 5, "the photos stayed up")
    },
    Check("ScanOutbox: a killed app resumes where it stopped; a network failure and a 429 wait; a refusal stops the scan") { ctx in
        let dir = tempDir()
        let transport = FakeScanTransport()
        // the third upload fails with no network
        transport.uploadErrors = [nil, nil, TransportError(status: nil, message: "The network connection was lost.")]
        let clock = ScanClock()
        var box = ScanOutbox(directory: dir, transport: transport, now: { clock.now })
        await box.setWindowGate { _ in true }
        let (draft, jpegs) = sampleDraft()
        try await box.stage(draft: draft, measurementId: "req1", jpegs: jpegs, app: "a", device: "d")
        try await box.arm(windowId: "w1")
        await box.syncAll()
        var item = await box.item(forWindow: "w1")
        ctx.equal(item?.uploadIds.count, 2)
        ctx.equal(item?.state, .waiting, "a lost network is tried again by itself")
        // the app is killed; a new outbox reads the same folder
        box = ScanOutbox(directory: dir, transport: transport, now: { clock.now })
        await box.setWindowGate { _ in true }
        try await box.load()
        item = await box.item(forWindow: "w1")
        ctx.equal(item?.uploadIds.count, 2, "the two uploads were recorded on disk")
        ctx.equal(item?.armed, true)
        transport.postAnswers = [TransportError(status: 429, message: "Slow down", retryAfter: 30)]
        await box.syncAll()
        ctx.equal(transport.uploads, 3 + 3, "only the three missing photos")
        item = await box.item(forWindow: "w1")
        ctx.equal(item?.state, .waiting)
        ctx.expect(item?.retryNotBefore != nil)
        await box.syncAll()
        ctx.equal(transport.posts, 1, "waits its Retry-After")
        clock.advance(31)
        transport.postAnswers = [TransportError(status: 400, message: "That scan is not valid.")]
        await box.syncAll()
        item = await box.item(forWindow: "w1")
        ctx.equal(item?.state, .failed)
        ctx.equal(item?.lastError, "That scan is not valid.")
        await box.syncAll()
        ctx.equal(transport.posts, 2, "a refused scan is not sent again")
    },
    Check("ScanOutbox: leaving the window out takes its scan and photos with it; a different request's scan stays") { ctx in
        let dir = tempDir()
        let box = ScanOutbox(directory: dir, transport: FakeScanTransport())
        let (d1, j1) = sampleDraft("w1")
        let (d2, j2) = sampleDraft("w2")
        try await box.stage(draft: d1, measurementId: "req1", jpegs: j1, app: "a", device: "d")
        try await box.stage(draft: d2, measurementId: "req2", jpegs: j2, app: "a", device: "d")
        func jpgs() -> Int { ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).filter { $0.hasSuffix(".jpg") }.count }
        ctx.equal(jpgs(), 10)
        try await box.discard(windowId: "w1")
        ctx.equal(jpgs(), 5)
        let left = await box.items
        ctx.equal(left.map { $0.windowId }, ["w2"])
        try await box.removeAll(measurementId: "req2")
        ctx.equal(jpgs(), 0)
        let none = await box.items
        ctx.equal(none.count, 0)
    },
    Check("ScanOutbox: a scan older than two weeks is let go, and a request that was replaced takes the unsent scan along") { ctx in
        let dir = tempDir()
        let transport = FakeScanTransport()
        let clock = ScanClock()
        let box = ScanOutbox(directory: dir, transport: transport, now: { clock.now })
        let (draft, jpegs) = sampleDraft()
        try await box.stage(draft: draft, measurementId: "old", jpegs: jpegs, app: "a", device: "d")
        try await box.arm(windowId: "w1")
        ctx.equal(try await box.reassign(from: "old", to: "new"), 1)
        let moved = await box.item(forWindow: "w1")
        ctx.equal(moved?.measurementId, "new")
        clock.advance(15 * 86_400)
        await box.syncAll()
        let after = await box.items
        ctx.equal(after.count, 0)
        ctx.equal(transport.uploads, 0)
    },
]
