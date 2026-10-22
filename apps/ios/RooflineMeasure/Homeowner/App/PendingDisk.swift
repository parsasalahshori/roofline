import Foundation
import RooflineCore

/// The window just measured and not yet saved (corners, scale, photo, room), kept on disk the moment it is captured: closing
/// the app, a crash or a phone call cannot lose it. One per request, in the outbox folder's own `pending` folder (not backed up
/// with the rest: the folder is excluded with it).
struct PendingDisk {
    struct Record: Codable {
        var requestId: String
        var window: PhotoWindowInput
        var imageWidthPx: Int
        var imageHeightPx: Int
        var focal35mm: Double?
        var name: String
        var number: Int
        var replacing: String?
        var method: String
        var windowFrame: WindowFrameSize?
    }

    let directory: URL

    init(outboxDirectory: URL) {
        directory = outboxDirectory.appendingPathComponent("pending", isDirectory: true)
    }

    private func recordURL(_ requestId: String) -> URL { directory.appendingPathComponent("\(requestId).json") }
    private func photoURL(_ requestId: String) -> URL { directory.appendingPathComponent("\(requestId).jpg") }

    func save(_ p: PendingWindow, requestId: String) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let input = PhotoWindowInput(id: p.id, uploadId: nil, label: nil, windowKey: nil, corners: p.corners, scale: p.scale, room: p.room, style: nil)
        let record = Record(requestId: requestId, window: input, imageWidthPx: p.imageWidthPx, imageHeightPx: p.imageHeightPx, focal35mm: p.focal35mm,
                            name: p.name, number: p.number, replacing: p.replacing, method: p.method.rawValue, windowFrame: p.windowFrame)
        if let jpeg = p.jpeg { try? jpeg.write(to: photoURL(requestId), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]) } else { try? FileManager.default.removeItem(at: photoURL(requestId)) }
        if let data = try? JSONEncoder().encode(record) { try? data.write(to: recordURL(requestId), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]) }
    }

    func load(requestId: String) -> PendingWindow? {
        guard let data = try? Data(contentsOf: recordURL(requestId)), let r = try? JSONDecoder().decode(Record.self, from: data), r.requestId == requestId else { return nil }
        let jpeg = try? Data(contentsOf: photoURL(requestId))
        let preview = LocalWindowPreview.of(r.window, imageWidthPx: r.imageWidthPx, imageHeightPx: r.imageHeightPx, focal35mm: r.focal35mm)
        return PendingWindow(id: r.window.id, scale: r.window.scale, corners: r.window.corners, jpeg: jpeg, imageWidthPx: r.imageWidthPx, imageHeightPx: r.imageHeightPx,
                             preview: preview, room: r.window.room ?? "", name: r.name, number: r.number, replacing: r.replacing,
                             focal35mm: r.focal35mm, method: MeasureMethod(rawValue: r.method) ?? .corners, windowFrame: r.windowFrame)
    }

    /// Pending windows of requests that no longer exist join this one (the saved request went stale and a new one was made).
    func adopt(into requestId: String) {
        guard let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) else { return }
        for url in files where url.pathExtension == "json" {
            let old = url.deletingPathExtension().lastPathComponent
            guard old != requestId, let data = try? Data(contentsOf: url), var r = try? JSONDecoder().decode(Record.self, from: data) else { continue }
            // One pending window per request: do not overwrite one already waiting here
            guard !FileManager.default.fileExists(atPath: recordURL(requestId).path) else { continue }
            r.requestId = requestId
            if let out = try? JSONEncoder().encode(r) { try? out.write(to: recordURL(requestId), options: .atomic) }
            if FileManager.default.fileExists(atPath: photoURL(old).path) { try? FileManager.default.moveItem(at: photoURL(old), to: photoURL(requestId)) }
            try? FileManager.default.removeItem(at: url)
        }
    }

    func clear(requestId: String) {
        try? FileManager.default.removeItem(at: recordURL(requestId))
        try? FileManager.default.removeItem(at: photoURL(requestId))
    }
}
