import CoreGraphics
import Foundation
import ImageIO
import RooflineCore
import UniformTypeIdentifiers
import UIKit

// "Finding your window": after Capture the frozen photo goes to the server's AI window finder (OWLv2 picks the window, SAM 2 cuts it out;
// POST .../detect-windows) and its answer is where the rectangle STARTS (`WindowProposal`). Best-effort: offline, no server, a detector that is
// off, a slow answer (6 s) or a refusal all end in the old way (the depth sensor, then Apple Vision), and the person can drag the corners the
// whole time. In Debug and TestFlight builds each Capture is also dumped to the server (DebugCapture) so a bad proposal on a real phone can be
// replayed on a Mac.

/// What the measuring screen hands the editor to reach the server. All nil (`.none`): no AI, no dump (samples, tests, the old behaviour).
struct FreezeServices {
    /// Sends the downscaled photo and answers what came back (never throws: the status says why not).
    var findWindow: ((Data) async -> AiAttempt)?
    /// A Capture was taken: dump its files (testers only; the store decides whether it is on).
    var dumpCapture: ((FrozenCapture) -> Void)?
    /// The proposal was made, or the person used the size: dump what happened.
    var dumpResult: ((DebugCapture.Result) -> Void)?

    static let none = FreezeServices()
}

enum AiFinding {
    /// How long the phone waits for the server before carrying on without it.
    static let timeoutSeconds = 6.0
    /// The photo goes at about this size on its long side, as a JPEG of this quality.
    static let longSidePx = 1024
    static let jpegQuality = 0.7
    /// The editor shows the inset rectangle and the small spinner only after this long; a detector that is off answers sooner and nothing flashes.
    static let spinnerAfterSeconds = 0.5
}

struct AiTimeout: Error {}

/// `op` or `AiTimeout`, whichever comes first (the other is cancelled).
func withTimeout<T: Sendable>(seconds: Double, _ op: @escaping @Sendable () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await op() }
        group.addTask {
            try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            throw AiTimeout()
        }
        defer { group.cancelAll() }
        guard let first = try await group.next() else { throw AiTimeout() }
        return first
    }
}

enum DetectionPhoto {
    /// The upright photo cut down to about `AiFinding.longSidePx` on its long side, as a JPEG (no EXIF, orientation 1). Nil when it cannot be made.
    /// Blocking: call it off the main thread.
    static func jpeg(from image: CGImage, longSide: Int = AiFinding.longSidePx, quality: Double = AiFinding.jpegQuality) -> Data? {
        let long = max(image.width, image.height)
        guard long > 0 else { return nil }
        let k = min(1.0, Double(longSide) / Double(long))
        let w = max(1, Int((Double(image.width) * k).rounded())), h = max(1, Int((Double(image.height) * k).rounded()))
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        guard let small = ctx.makeImage() else { return nil }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, small, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        return CGImageDestinationFinalize(dest) ? out as Data : nil
    }
}

extension HomeownerStore {
    /// Asks the server where the window is in this photo (a downscaled JPEG). Never throws and never waits longer than `AiFinding.timeoutSeconds`:
    /// the status says what happened (ok, no-session, offline, off, busy, failed, timeout, error).
    func findWindow(jpeg: Data, timeout: Double = AiFinding.timeoutSeconds) async -> AiAttempt {
        let started = Date()
        func done(_ status: String, _ d: WindowDetection? = nil) -> AiAttempt { AiAttempt(status: status, detection: d, ms: Int(Date().timeIntervalSince(started) * 1000)) }
        guard let session = session else { return done("no-session") }
        guard !offline else { return done("offline") }
        let api = self.api
        do {
            let detection = try await withTimeout(seconds: timeout) { try await api.detectWindows(session, jpeg: jpeg, timeout: timeout) }
            return done("ok", detection)
        } catch is AiTimeout {
            return done("timeout")
        } catch let e as HomeownerAPIError {
            if e.code == "detector_unavailable" { return done("off") }
            if e.code == "detector_failed" { return done("failed") }
            if e.code == "no_server" { return done("no-server") }
            if e.isRateLimited { return done("busy") }
            return done(e.isNetwork ? "offline" : "error")
        } catch {
            return done("error")
        }
    }

    /// Testers only (Debug, TestFlight): sends a Capture's files to the server's dump, or writes them to `debugCaptureFolder` (`-debugCaptureDir`).
    /// Fire and forget: a failure is not shown. A server that says the dump is off (404) is not asked again until the app is restarted.
    func dumpCapture(_ capture: FrozenCapture) {
        guard let session = session, BuildEnvironment.isTesterBuild, debugCaptureFolder != nil || (!debugCapturesOff && !offline) else { return }
        let id = capture.id.uuidString.lowercased()
        let meta = DebugCapture.Meta(captureId: id, createdAt: ISO8601DateFormatter().string(from: Date()), app: Self.appVersionLine, device: DeviceCaps.modelIdentifier,
                                     view: capture.view, jpegBytes: capture.jpeg.count, epoch: capture.epoch, trackingLostCount: capture.trackingLostCount, restartsForTracking: capture.restartsForTracking)
        let bundle = DebugCapture.Bundle(meta: meta, jpeg: capture.jpeg, depth: capture.view.depth)
        guard let files = try? bundle.captureFiles() else { return }
        sendDebugFiles(files, captureId: id, session: session)
    }

    /// Testers only: what happened to a Capture (the AI's answer, the proposal, the rectangle used).
    func dumpResult(_ result: DebugCapture.Result) {
        guard let session = session, BuildEnvironment.isTesterBuild, debugCaptureFolder != nil || (!debugCapturesOff && !offline) else { return }
        guard let data = try? DebugCapture.encode(result) else { return }
        sendDebugFiles([(DebugCapture.resultFile, data)], captureId: result.captureId, session: session)
    }

    private func sendDebugFiles(_ files: [(name: String, data: Data)], captureId: String, session: HomeownerSession) {
        if let folder = debugCaptureFolder {
            let dir = folder.appendingPathComponent(captureId, isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            for f in files { try? f.data.write(to: dir.appendingPathComponent(f.name), options: .atomic) }
            return
        }
        let api = self.api
        Task.detached(priority: .utility) { [weak self] in
            for f in files {
                do {
                    try await api.uploadDebugCapture(session, captureId: captureId, file: f.name, data: f.data)
                } catch let e as HomeownerAPIError where e.code == "debug_captures_off" || e.code == "no_server" {
                    await self?.markDebugCapturesOff()
                    return
                } catch {
                    return
                }
            }
        }
    }

    func markDebugCapturesOff() { debugCapturesOff = true }

    static var appVersionLine: String {
        let info = Bundle.main.infoDictionary
        return "\(info?["CFBundleShortVersionString"] as? String ?? "?") (\(info?["CFBundleVersion"] as? String ?? "?"))"
    }
}
