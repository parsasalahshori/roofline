import Foundation
import RooflineCore

// Checks for what the phone does with the AI window finder's answer (AiWindow.swift): which box is the person's, reading the server's answer,
// the standard-size suggestion, and the debug dump's format. The checks that need a drawn scene (a box turned into a rectangle, the order of
// trust) are with the opening checks, which own the scene.

private func box(_ x: Double, _ y: Double, _ w: Double, _ h: Double, _ c: Double) -> DetectedBox { DetectedBox(x: x, y: y, w: w, h: h, confidence: c) }

let aiWindowChecks: [Check] = [
    Check("AiWindow.pick: the box that holds the photo's middle with the best score; of nested boxes the largest that scores within 70% of it") { ctx in
        let picture = box(0.8, 0.2, 0.15, 0.2, 0.5)
        let window = box(0.26, 0.23, 0.5, 0.55, 0.38)
        let sash = box(0.3, 0.4, 0.4, 0.2, 0.4)
        // A picture on the wall scores higher than the window but does not hold the middle
        ctx.equal(AiWindow.pick([picture, window]), window)
        // The sash is inside the window and scores about the same: the window (the larger) wins
        ctx.equal(AiWindow.pick([picture, window, sash]), window)
        // The sash scores far higher (the window is below 70% of it): the sash stays
        let loud = box(0.3, 0.4, 0.4, 0.2, 0.6)
        ctx.equal(AiWindow.pick([window, loud]), loud)
        // Exactly at 70% counts
        ctx.equal(AiWindow.pick([window, box(0.3, 0.4, 0.4, 0.2, 0.38 / 0.7)]), window)
        // Nothing holds the middle, nothing at all, junk numbers, a sliver
        ctx.expect(AiWindow.pick([picture]) == nil)
        ctx.expect(AiWindow.pick([]) == nil)
        ctx.expect(AiWindow.pick([box(.nan, 0.2, 0.5, 0.5, 0.4), box(0.4, 0.2, 0.01, 0.9, 0.9)]) == nil)
        // The person aimed somewhere else
        ctx.equal(AiWindow.pick([picture, window], aim: Vec2(0.85, 0.3)), picture)
        // A box outside the photo is not believable
        ctx.expect(AiWindow.pick([box(0.5, 0.2, 0.9, 0.5, 0.4)]) == nil)
    },

    Check("WindowDetection: the server's answer is read, and a part the phone does not know is left out, not a reason to drop the rest") { ctx in
        let full = """
        {"boxes":[{"x":0.27,"y":0.23,"w":0.49,"h":0.55,"confidence":0.29},{"x":0.8,"y":0.2,"w":0.15,"h":0.2,"confidence":0.4}],
         "picked":{"x":0.27,"y":0.23,"w":0.49,"h":0.55,"confidence":0.29},
         "quad":{"corners":[[0.274,0.227],[0.736,0.228],[0.737,0.76],[0.289,0.76]],"quality":0.941,"fill":1,"residual":0.0011,"maskScore":0.943},
         "widthPx":768,"heightPx":1024,"detector":"owlv2","segmenter":"sam2","ms":1330,"msDetect":830,"msSegment":500}
        """
        guard let a = try? JSONDecoder().decode(WindowDetection.self, from: Data(full.utf8)) else { return ctx.expect(false, "full answer") }
        ctx.equal(a.boxes.count, 2)
        ctx.equal(a.picked?.confidence, 0.29)
        ctx.equal(a.quad?.corners.count, 4)
        ctx.near(a.quad?.quality, 0.941)
        ctx.equal(a.ms, 1330)
        let first = a.quad?.photoCorners(photoWidthPx: 1000, photoHeightPx: 2000)?.first
        ctx.near(first?.x, 274, 1e-6)
        ctx.near(first?.y, 454, 1e-6)
        // No segmenter: no quad
        let boxesOnly = #"{"boxes":[{"x":0.27,"y":0.23,"w":0.49,"h":0.55,"confidence":0.29}],"picked":null,"quad":null,"ms":900}"#
        let b = try? JSONDecoder().decode(WindowDetection.self, from: Data(boxesOnly.utf8))
        ctx.equal(b?.boxes.count, 1)
        ctx.expect(b?.quad == nil && b?.picked == nil)
        // A quad in a shape the phone does not know, a missing list
        let odd = #"{"boxes":[{"x":0.1,"y":0.1,"w":0.5,"h":0.5,"confidence":0.3}],"quad":"later"}"#
        let c = try? JSONDecoder().decode(WindowDetection.self, from: Data(odd.utf8))
        ctx.equal(c?.boxes.count, 1)
        ctx.expect(c?.quad == nil)
        ctx.equal((try? JSONDecoder().decode(WindowDetection.self, from: Data("{}".utf8)))?.boxes.count, 0)
        // Corners outside the photo, or not four, are not a quad
        ctx.expect(DetectedQuad(corners: [[0, 0], [1, 0], [1, 1]], quality: 0.9).photoCorners(photoWidthPx: 10, photoHeightPx: 10) == nil)
        ctx.expect(DetectedQuad(corners: [[0, 0], [1, 0], [1, 1], [0, 1.4]], quality: 0.9).photoCorners(photoWidthPx: 10, photoHeightPx: 10) == nil)
        ctx.expect(DetectedQuad(corners: [[0, 0], [1, 0], [1, 1], [.nan, 1]], quality: 0.9).photoCorners(photoWidthPx: 10, photoHeightPx: 10) == nil)
    },

    Check("StandardWindowSizes: a measured size within an inch of a common size (or of it less a half inch) on BOTH sides is that size; else none") { ctx in
        func label(_ w: Double, _ h: Double) -> String? { StandardWindowSizes.suggestion(widthIn: w, heightIn: h)?.label }
        // Right on it, and the unit size (a half inch under)
        ctx.equal(label(24, 36), "24 × 36")
        ctx.equal(label(23.5, 35.5), "24 × 36")
        ctx.equal(label(35.5, 59.5), "36 × 60")
        // The mockup's window, 35 5/8 x 59 5/8
        ctx.equal(label(35.625, 59.625), "36 × 60")
        // Within an inch of the nominal, or of the unit size: 1 inch over is the edge, a hair more is out
        ctx.equal(label(25, 36), "24 × 36")
        ctx.equal(label(22.5, 34.5), "24 × 36")
        // 37 is a half inch under a 38 (its unit size is 37 1/2): that is the nearer
        ctx.equal(label(24, 37), "24 × 38")
        ctx.expect(label(25.05, 36) == nil && label(24, 41.1) == nil && label(24, 33.9) == nil, "just past an inch over or under")
        ctx.expect(label(22.4, 36) == nil, "just past an inch and a half under")
        // One side is not enough
        ctx.expect(label(24, 42) == nil)
        // The nearest wins: 29 wide is between 28 and 30, nearer 30
        ctx.equal(label(29, 37.9), "30 × 38")
        ctx.equal(label(28.2, 47.6), "28 × 48")
        // Sliders, wider than high
        ctx.equal(label(59.6, 35.6), "60 × 36")
        ctx.equal(label(47.5, 23.6), "48 × 24")
        // The small square
        ctx.equal(label(24, 24), "24 × 24")
        // Nothing for rubbish
        ctx.expect(label(0, 36) == nil && label(-3, 36) == nil && label(.nan, 36) == nil && label(24, .infinity) == nil)
        ctx.expect(label(10, 10) == nil && label(120, 80) == nil)
        // The sentence
        ctx.equal(StandardWindowSizes.line(widthIn: 23.6, heightIn: 35.7), "Looks like a standard 24 × 36 window")
        ctx.expect(StandardWindowSizes.line(widthIn: 26, heightIn: 41) == nil)
        // The list: no duplicates, every size within the ranges stocked
        ctx.equal(Set(StandardWindowSizes.all).count, StandardWindowSizes.all.count)
        ctx.expect(StandardWindowSizes.all.allSatisfy { $0.widthIn >= 24 && $0.widthIn <= 72 && $0.heightIn >= 24 && $0.heightIn <= 72 })
        ctx.expect(StandardWindowSizes.all.contains(StandardWindowSize(36, 60, .doubleHung)) && StandardWindowSizes.all.contains(StandardWindowSize(60, 36, .slider)))
    },

    Check("DebugCapture: a capture's files decode to the same capture, on disk too; a bad depth file or version is refused") { ctx in
        let lens = CameraIntrinsics(fx: 1400, fy: 1400, cx: 960, cy: 720, width: 1920, height: 1440)
        let cam = Mat4.rigid(right: Vec3(0, -1, 0), up: Vec3(1, 0, 0), back: Vec3(0, 0, 1), origin: Vec3(0.1, 1.5, 0.2))
        let wall = Plane(point: Vec3(0, 0, -1.6), normal: Vec3(0, 0, 1))!
        var depth = [Float](repeating: 1.6, count: 8 * 6)
        depth[5] = 0
        depth[20] = 2.123456
        let conf = (0..<48).map { UInt8($0 % 3) }
        let view = FrozenView(cameraTransform: cam, intrinsics: lens, wall: wall, depth: FrozenDepth(width: 8, height: 6, depthM: depth, confidence: conf), photoWidthPx: 1440, photoHeightPx: 1920)
        let jpeg = Data([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9])
        var meta = DebugCapture.Meta(captureId: "3f1c2b7e-5d0a-4c1e-9a77-0b6d0f4e1a21", createdAt: "2026-10-22T11:00:00Z", app: "WinChoice 1.0 (7)", device: "iPhone16,2", view: view, jpegBytes: jpeg.count, epoch: 2, trackingLostCount: 1)
        ctx.equal(meta.depthWidth, 8)
        ctx.expect(meta.hasConfidence)
        let rect = FrozenRect(plane: wall, viewer: view.viewer, left: -0.25, right: 0.25, top: 1.2, bottom: 0.2)!
        let ai = AiAttempt(status: "ok", detection: WindowDetection(boxes: [DetectedBox(x: 0.2, y: 0.2, w: 0.5, h: 0.5, confidence: 0.3)], quad: DetectedQuad(corners: [[0.2, 0.2], [0.7, 0.2], [0.7, 0.7], [0.2, 0.7]], quality: 0.9), ms: 1200), ms: 1500)
        let result = DebugCapture.Result(captureId: meta.captureId, source: "ai-quad", ai: ai, proposed: DebugCapture.Rect(rect, view: view), final: DebugCapture.Rect(rect.moved(.right, toPhoto: Vec2(900, 900), view: view), view: view), usedAt: "2026-10-22T11:00:20Z")
        let bundle = DebugCapture.Bundle(meta: meta, jpeg: jpeg, depth: view.depth, result: result)
        // Through the files the phone sends
        var files: [String: Data] = [:]
        for f in (try? bundle.captureFiles()) ?? [] { files[f.name] = f.data }
        if let r = try? bundle.resultFile() { files[r.name] = r.data }
        ctx.equal(Set(files.keys), Set(DebugCapture.allFiles))
        ctx.equal(files[DebugCapture.depthFile]?.count, 8 * 6 * 4)
        ctx.equal(files[DebugCapture.confidenceFile]?.count, 48)
        guard let back = try? DebugCapture.Bundle(files: files) else { return ctx.expect(false, "decode") }
        ctx.expect(back == bundle, "the capture is the same after its files")
        ctx.expect(back.view == view, "the view is the same")
        // The rectangle can be rebuilt and sized the same
        ctx.expect(result.proposed?.frozenRect(viewer: view.viewer) == rect)
        ctx.near(result.proposed?.widthIn, 0.5 * inchesPerMetre, 1e-6)
        ctx.equal(result.proposed?.photoCorners.count, 4)
        // Without depth: no depth files, and it reads back
        meta = DebugCapture.Meta(captureId: "abcdefgh-1", createdAt: "2026-10-22T11:00:00Z", view: FrozenView(cameraTransform: cam, intrinsics: lens, wall: wall, depth: nil, photoWidthPx: 1440, photoHeightPx: 1920), jpegBytes: 9)
        let flat = DebugCapture.Bundle(meta: meta, jpeg: jpeg, depth: nil)
        ctx.equal(((try? flat.captureFiles()) ?? []).map { $0.name }, [DebugCapture.metaFile, DebugCapture.photoFile])
        // On disk
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("debug-capture-check-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        do {
            try bundle.write(to: folder)
            ctx.expect(try DebugCapture.Bundle.read(from: folder) == bundle, "the capture is the same after a folder")
        } catch { ctx.expect(false, "disk: \(error)") }
        // A depth file of the wrong size, a newer version, a folder with no photo
        var bad = files
        bad[DebugCapture.depthFile] = Data(count: 10)
        ctx.expect((try? DebugCapture.Bundle(files: bad)) == nil)
        bad = files
        bad[DebugCapture.metaFile] = Data((String(data: files[DebugCapture.metaFile]!, encoding: .utf8) ?? "").replacingOccurrences(of: "\"version\" : 1", with: "\"version\" : 9").utf8)
        ctx.expect((try? DebugCapture.Bundle(files: bad)) == nil)
        bad = files
        bad[DebugCapture.photoFile] = nil
        ctx.expect((try? DebugCapture.Bundle(files: bad)) == nil)
    },
]
