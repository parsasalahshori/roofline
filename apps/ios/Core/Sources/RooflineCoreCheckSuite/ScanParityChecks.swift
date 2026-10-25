import Foundation
import RooflineCore

// Parity with the server: packages/shared/test/fixtures/window-scan/*.json (written by the server's computeScanResult; copies live in
// apps/ios/RooflineMeasureTests/Fixtures/window-scan). Each file is a whole scan (frames, marks, the phone's wall plane) and the answer the
// TypeScript gives. The Swift solver must give the same numbers within the file's own tolerance, and read the file's frames as the phone's own
// JSON (`ScanFramePayload`) so the two sides agree on the keys too.

private struct ScanFixture: Decodable {
    struct Input: Decodable {
        var frames: [ScanFramePayload]
        var marks: [ScanMark]
        var wall: ScanWall
    }

    struct Expected: Decodable {
        struct Tolerance: Decodable {
            var inches: Double
            var metres: Double
            var pixels: Double
        }

        var status: String
        var failed: [String]
        var widthIn: Double?
        var heightIn: Double?
        var cornersM: [Vec3]?
        var triangulatedM: [Vec3?]
        var quality: ScanQuality
        var tolerance: Tolerance
    }

    var name: String
    var truth: [String: Double]?
    var input: Input
    var expected: Expected
}

/// Where the fixtures are: next to the ar-sizing fixture when that path is known, else relative to this file.
private func scanFixtureDirectory(_ fixturePath: String?) -> URL? {
    var candidates: [URL] = []
    if let p = fixturePath { candidates.append(URL(fileURLWithPath: p).deletingLastPathComponent().appendingPathComponent("window-scan", isDirectory: true)) }
    // apps/ios/Core/Sources/RooflineCoreCheckSuite/ScanParityChecks.swift -> apps/ios/RooflineMeasureTests/Fixtures/window-scan
    candidates.append(URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("RooflineMeasureTests/Fixtures/window-scan", isDirectory: true))
    return candidates.first { FileManager.default.fileExists(atPath: $0.path) }
}

func scanParityCheck(path: String?) -> Check {
    Check("Parity with the server: window-scan fixtures (triangulation, rectangle, gates)") { ctx in
        guard let dir = scanFixtureDirectory(path),
              let files = try? FileManager.default.contentsOfDirectory(atPath: dir.path).filter({ $0.hasSuffix(".json") }).sorted(), !files.isEmpty else {
            return ctx.skip("no window-scan fixtures found")
        }
        for file in files {
            let f = try JSONDecoder().decode(ScanFixture.self, from: Data(contentsOf: dir.appendingPathComponent(file)))
            let name = "\(file)"
            let frames = f.input.frames.map { $0.frame }
            let sol = WindowScanSolver.solve(frames: frames, marks: f.input.marks, wall: f.input.wall.plane)
            let e = f.expected, tol = e.tolerance
            ctx.equal(sol.status.rawValue, e.status, "\(name) status")
            ctx.equal(sol.quality.failed, e.failed, "\(name) failed gates")
            if let w = e.widthIn { ctx.near(sol.widthIn, w, tol.inches, "\(name) width") } else { ctx.expect(sol.widthIn == nil, "\(name) width should be nil") }
            if let h = e.heightIn { ctx.near(sol.heightIn, h, tol.inches, "\(name) height") } else { ctx.expect(sol.heightIn == nil, "\(name) height should be nil") }
            if let corners = e.cornersM {
                for i in 0..<corners.count { ctx.near(sol.cornersM.flatMap { $0.indices.contains(i) ? $0[i].distance(to: corners[i]) : nil }, 0, tol.metres, "\(name) rectangle corner \(i)") }
            } else {
                ctx.expect(sol.cornersM == nil, "\(name) rectangle should be nil")
            }
            for (i, p) in e.triangulatedM.enumerated() {
                if let p = p { ctx.near(sol.triangulatedM[i]?.distance(to: p), 0, tol.metres, "\(name) triangulated corner \(i)") } else { ctx.expect(sol.triangulatedM[i] == nil) }
            }
            let q = sol.quality, w = e.quality
            ctx.equal(q.framesPerCorner, w.framesPerCorner, "\(name) frames per corner")
            ctx.near(q.reprojRmsPx, w.reprojRmsPx, tol.pixels, "\(name) reprojection RMS")
            ctx.near(q.reprojMaxPx, w.reprojMaxPx, tol.pixels, "\(name) reprojection max")
            ctx.near(q.minBaselineDeg, w.minBaselineDeg, 0.05, "\(name) baseline")
            ctx.near(q.symRatioDiff, w.symRatioDiff, 1e-4, "\(name) symmetry")
            ctx.near(q.planeMaxCm, w.planeMaxCm, 0.01, "\(name) plane")
            ctx.near(q.scaleDiff, w.scaleDiff, 1e-3, "\(name) scale")
            ctx.equal(q.closeups, w.closeups, "\(name) close-ups")
            // The phone's own body for the same scan has the contract's keys and reads back
            let draft = ScanDraft(scanId: "parity", windowId: "w", frames: frames, allMarks: f.input.marks, wall: f.input.wall.plane!)
            let ids = Dictionary(uniqueKeysWithValues: f.input.frames.map { ($0.frameId, $0.uploadId) })
            let body = try draft.payload(uploadIds: ids, app: "a", device: "d")!.json()
            let back = try JSONDecoder().decode(WindowScanPayload.self, from: body)
            ctx.equal(back.frames, f.input.frames, "\(name) frames survive the phone's JSON")
            ctx.equal(back.result.status.rawValue, e.status, "\(name) the phone's own result says the same")
        }
        ctx.expect(files.count >= 1)
    }
}
