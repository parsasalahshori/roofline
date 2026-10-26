import CoreGraphics
import Foundation
import RooflineCore
import UIKit
import XCTest
@testable import WinChoice

/// "See it in your home": choosing and using a window, using one for all, the photo each window keeps, and the drawing on a photo.
@MainActor
final class VisualizerTests: XCTestCase {

    // MARK: Choosing, using, using for all

    func testAMeasuredWindowKeepsItsPhotoAndFourCorners() async throws {
        let h = StoreHarness()
        try await h.open()
        let id = try await h.captured(room: "Kitchen")
        let found = await h.store.visualPhoto(for: id)
        let source = try XCTUnwrap(found)
        XCTAssertEqual(source.corners.count, 4)
        XCTAssertTrue(FileManager.default.fileExists(atPath: source.url.path))
        XCTAssertGreaterThan(source.widthPx, 0)
        // A window with no photo on this phone (the server holds it from another phone) has none
        let none = await h.store.visualPhoto(for: "someone-elses-window")
        XCTAssertNil(none, "no photo on this phone: the gallery shows a drawn wall")
    }

    func testTheGalleryStartsOnTheKindTheWindowsStyleStandsFor() async throws {
        let h = StoreHarness()
        try await h.open()
        let id = try await h.captured(room: "Kitchen")
        XCTAssertEqual(h.store.startingLook(for: id).type, .doubleHung, "no style yet: the double-hung")
        await h.store.setStyle("slider-2", for: id)
        XCTAssertEqual(h.store.startingLook(for: id).type, .slider2)
        XCTAssertEqual(h.store.startingColorKey(for: id), h.store.brand.windowColors.first?.key)
    }

    func testUsingAWindowSetsItsStyleAndColorAndKeepsGridAndGlassOnThePhone() async throws {
        let h = StoreHarness()
        try await h.open()
        let id = try await h.captured(room: "Kitchen")
        let look = WindowVisualLook(type: .singleHung, grid: .prairie, glass: .lowE, cleanGlass: true)
        await h.store.useVisual(look, colorKey: "black", for: id)
        await h.settle()
        let mapping = h.store.styleMapping(for: .singleHung)
        XCTAssertEqual(mapping.key, "double-hung", "single-hung is quoted under the offered up-and-down choice")
        let row = try XCTUnwrap(h.store.windowRows.first { $0.id == id })
        XCTAssertEqual(row.style, mapping.key, "the style the existing flow sends")
        XCTAssertEqual(row.look, look, "the grid and glass stay with the window, on the phone")
        XCTAssertEqual(row.colorKey, "black")
        XCTAssertEqual(h.store.color(for: id), "black")
        // The server's window carries a style, never a grid or a glass
        let sent = h.store.outboxItems.first { $0.id == id }?.window
        XCTAssertEqual(sent?.style, mapping.key)
        // It survives a restart of the screens: the progress record has it
        let saved = h.progress.load(requestId: try XCTUnwrap(h.store.requestId))
        XCTAssertEqual(saved.visuals[id], look)
        XCTAssertEqual(saved.colors[id], "black")
    }

    func testAKindThePriceListDoesNotHaveIsQuotedAtTheVisit() async throws {
        let h = StoreHarness()
        try await h.open()
        let id = try await h.captured(room: "Front room")
        await h.store.useVisual(WindowVisualLook(type: .bay), colorKey: "white", for: id)
        await h.settle()
        let mapping = h.store.styleMapping(for: .bay)
        XCTAssertTrue(mapping.atVisit)
        XCTAssertTrue(h.store.styles.contains { $0.key == mapping.key && $0.atVisit }, "a key the catalog offers, under its 'bay, bow or odd shape' tile")
        XCTAssertEqual(h.store.windowRows.first?.style, mapping.key)
        XCTAssertEqual(mapping.quoteLine, "Quoted at your visit")
    }

    func testUsingForAllGivesEveryWindowTheSameLookAndColorButKeepsEachPhoto() async throws {
        let h = StoreHarness()
        try await h.open()
        let a = try await h.captured(room: "Kitchen")
        let b = try await h.captured(room: "Bedroom 1")
        let c = try await h.captured(room: "Living room")
        let look = WindowVisualLook(type: .slider2, grid: .colonial, glass: .clear)
        await h.store.useVisualForAll(look, colorKey: "bronze")
        await h.settle()
        XCTAssertEqual(h.store.windowRows.count, 3)
        for row in h.store.windowRows {
            XCTAssertEqual(row.style, "slider-2")
            XCTAssertEqual(row.look, look)
            XCTAssertEqual(row.colorKey, "bronze")
        }
        for id in [a, b, c] {
            let source = await h.store.visualPhoto(for: id)
            XCTAssertNotNil(source, "each window still has its own photo")
        }
        XCTAssertEqual(Set(h.store.windowRows.map(\.id)), Set([a, b, c]))
    }

    func testAChangedStyleOnASentWindowKeepsItsLookAndFindsItsPhoto() async throws {
        let h = StoreHarness()
        try await h.open()
        let id = try await h.captured(room: "Kitchen")
        await h.store.setStyle("double-hung", for: id)
        await h.settle()
        await h.store.refresh()
        XCTAssertEqual(h.store.windowRows.first?.send, .sent)
        // Now the homeowner tries another kind: the server's window is replaced by a copy under a new id
        let look = WindowVisualLook(type: .picture, grid: .none, glass: .frosted)
        await h.store.useVisual(look, colorKey: "beige", for: id)
        await h.settle()
        await h.store.refresh()
        let row = try XCTUnwrap(h.store.windowRows.first)
        XCTAssertEqual(h.store.windowRows.count, 1)
        XCTAssertNotEqual(row.id, id, "the copy has its own id")
        XCTAssertEqual(row.style, "picture")
        XCTAssertEqual(row.look, look)
        XCTAssertEqual(row.colorKey, "beige")
        let source = await h.store.visualPhoto(for: row.id)
        XCTAssertNotNil(source, "the copy keeps the photo (and does not send it again)")
    }

    func testTheOpenerPushesTheScreenAndTheProgressRecordReadsOlderOnes() async throws {
        let h = StoreHarness()
        try await h.open()
        let id = try await h.captured(room: "Kitchen")
        h.store.openVisualizer(id, from: .quote)
        XCTAssertEqual(h.store.path.last, .visualize(windowId: id, from: .quote))
        // A progress record from before this feature has no looks and still reads
        let old = Data(#"{"rooms":["Kitchen"],"colors":{"w":"white"}}"#.utf8)
        let decoded = try JSONDecoder().decode(HomeownerProgress.self, from: old)
        XCTAssertTrue(decoded.visuals.isEmpty)
        XCTAssertEqual(decoded.colors["w"], "white")
    }

    // MARK: Drawing on a photo

    /// A flat grey photo with a window-shaped quad (slightly skewed, as seen from the side) to draw on.
    private func greyPhoto(_ w: Int = 1000, _ h: Int = 1300) -> (image: CGImage, quad: [Vec2]) {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let image = UIGraphicsImageRenderer(size: CGSize(width: w, height: h), format: format).image { ctx in
            UIColor(white: 0.5, alpha: 1).setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        }.cgImage!
        return (image, [Vec2(300, 330), Vec2(690, 300), Vec2(680, 1010), Vec2(310, 960)])
    }

    private func pixels(_ image: CGImage) -> (data: [UInt8], width: Int) {
        var data = [UInt8](repeating: 0, count: image.width * image.height * 4)
        let ctx = CGContext(data: &data, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        return (data, image.width)
    }

    private func rgb(_ p: (data: [UInt8], width: Int), _ v: Vec2) -> (r: Double, g: Double, b: Double) {
        let i = (Int(v.y.rounded()) * p.width + Int(v.x.rounded())) * 4
        return (Double(p.data[i]) / 255, Double(p.data[i + 1]) / 255, Double(p.data[i + 2]) / 255)
    }

    func testTheWarpedWindowCoversItsQuadAndLeavesTheRestOfThePhoto() throws {
        let (photo, quad) = greyPhoto()
        let c = try XCTUnwrap(WindowCompositor(photo: photo, quad: quad, widthIn: 36, heightIn: 60))
        for type in [VisualWindowType.picture, .doubleHung, .casement, .slider2, .bay] {
            let look = WindowVisualLook(type: type, grid: .none, glass: .clear, cleanGlass: true)
            let after = try XCTUnwrap(c.after(look: look, colorHex: "#1D1F22"), type.rawValue)
            XCTAssertEqual(after.width, photo.width)
            let p = pixels(after)
            let face = WindowLayoutBuilder.build(type: type, grid: .none, widthIn: 36, heightIn: 60).frameFaceIn
            // The frame sits on every side of the opening, in the colour chosen (near black), where the grey photo was
            for (cx, cy) in [(-face / 2, 30.0), (36 + face / 2, 30.0), (18.0, -face / 2), (18.0, 60 + face / 2), (-face / 2, -face / 2), (36 + face / 2, 60 + face / 2)] {
                let at = try XCTUnwrap(c.photoPoint(Vec2(cx, cy)))
                let px = rgb(p, at)
                XCTAssertLessThan(px.r + px.g + px.b, 0.9, "\(type.rawValue): frame at (\(cx), \(cy)) is not the dark frame: \(px)")
            }
            // Just inside the top corners the clean glass (sky) shows, not the grey photo: the window covers the quad
            for (cx, cy) in [(6.0, 6.0), (30.0, 6.0), (30.0, 22.0), (6.0, 22.0)] where type != .bay {
                let at = try XCTUnwrap(c.photoPoint(Vec2(cx, cy)))
                let px = rgb(p, at)
                XCTAssertGreaterThan(px.b, px.r + 0.04, "\(type.rawValue): the sky shows at (\(cx), \(cy)): \(px)")
            }
            // Far from the window the photo is untouched
            let far = rgb(p, Vec2(40, 40))
            XCTAssertEqual(far.r, 0.5, accuracy: 0.01)
            XCTAssertEqual(far.b, 0.5, accuracy: 0.01)
            let far2 = rgb(p, Vec2(960, 1250))
            XCTAssertEqual(far2.g, 0.5, accuracy: 0.01)
        }
    }

    func testThePanesShowThePhotoUnlessCleanGlassIsOn() throws {
        let (photo, quad) = greyPhoto()
        let c = try XCTUnwrap(WindowCompositor(photo: photo, quad: quad, widthIn: 36, heightIn: 60))
        let centre = try XCTUnwrap(c.photoPoint(Vec2(18, 30)))
        let clear = try XCTUnwrap(c.after(look: WindowVisualLook(type: .picture), colorHex: "#F7F7F4"))
        let a = rgb(pixels(clear), centre)
        XCTAssertEqual(a.r, 0.5, accuracy: 0.08, "clear glass: the photo's own view")
        let clean = try XCTUnwrap(c.after(look: WindowVisualLook(type: .picture, cleanGlass: true), colorHex: "#F7F7F4"))
        let b = rgb(pixels(clean), centre)
        XCTAssertGreaterThan(b.b, 0.7, "clean glass: a soft sky")
        let frosted = try XCTUnwrap(c.after(look: WindowVisualLook(type: .picture, glass: .frosted), colorHex: "#F7F7F4"))
        let f = rgb(pixels(frosted), centre)
        XCTAssertGreaterThan(f.r, 0.8, "frosted: pale")
        // Low-E is a faint tint on the same view
        let lowE = try XCTUnwrap(c.after(look: WindowVisualLook(type: .picture, glass: .lowE), colorHex: "#F7F7F4"))
        let l = rgb(pixels(lowE), centre)
        XCTAssertGreaterThan(l.g, l.r, "a green-blue tint")
        XCTAssertLessThan(abs(l.g - a.g), 0.12, "faint")
    }

    func testEveryKindDrawsOnADrawnWallWithNoPhoto() throws {
        let prepared = try XCTUnwrap(VisualizeWorker.prepare(source: nil, widthIn: nil, heightIn: nil, aspect: VisualizeModel.pictureAspect))
        XCTAssertTrue(prepared.drawnWall)
        for type in VisualWindowType.allCases {
            for grid in [VisualGrid.none, .colonial] {
                XCTAssertNotNil(prepared.compositor.after(look: WindowVisualLook(type: type, grid: grid), colorHex: "#E6DCC6"), "\(type.rawValue) \(grid.rawValue)")
            }
        }
        XCTAssertNotNil(prepared.before)
    }

    func testAPhotoWhoseFileIsAnotherSizeThanItsCornersSay() throws {
        // The corners were taken at 1000 x 1300 but the file on disk is 500 x 650 (the server read it smaller): they follow the file
        let (photo, quad) = greyPhoto(500, 650)
        let jpeg = try XCTUnwrap(UIImage(cgImage: photo).jpegData(compressionQuality: 0.9))
        let made = try XCTUnwrap(VisualizerPhoto.make(jpeg: jpeg, corners: quad, widthPx: 1000, heightPx: 1300, aspect: 1.0, viewportPixels: 400))
        XCTAssertEqual(made.quad[0].x, 300 * Double(made.image.width) / 1000, accuracy: 1)
        XCTAssertEqual(made.quad[2].y, 1010 * Double(made.image.height) / 1300, accuracy: 1)
        XCTAssertTrue(made.viewport.contains(CGPoint(x: made.quad[0].x, y: made.quad[0].y)))
        // Corners that cannot carry a window give no photo (the screen then shows the drawn wall)
        XCTAssertNil(VisualizerPhoto.make(jpeg: jpeg, corners: [Vec2(0, 0), Vec2(5, 0), Vec2(5, 5), Vec2(0, 0)], widthPx: 1000, heightPx: 1300, aspect: 1.3))
    }

    func testTheScreenModelDrawsAndRedrawsOnEveryChange() async throws {
        let h = StoreHarness()
        try await h.open()
        let id = try await h.captured(room: "Kitchen")
        let model = VisualizeModel()
        await model.start(store: h.store, windowId: id)
        XCTAssertEqual(model.phase, .ready)
        XCTAssertFalse(model.drawnWall, "the measured window's own photo")
        XCTAssertNotNil(model.before)
        func waitForAfter(_ previous: UIImage?) async -> UIImage? {
            for _ in 0..<100 {
                if let a = model.after, a !== previous { return a }
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
            return nil
        }
        let first = await waitForAfter(nil)
        XCTAssertNotNil(first)
        model.set(type: .casementPair)
        let second = await waitForAfter(first)
        XCTAssertNotNil(second, "a new kind draws a new picture")
        model.set(colorKey: "black")
        let third = await waitForAfter(second)
        XCTAssertNotNil(third)
        XCTAssertEqual(model.colorLabel, "Black")
        XCTAssertNotNil(model.renderMs)
    }

    // MARK: Speed

    func testARedrawOnATwelveMegapixelPhotoIsFast() throws {
        // 4032 x 3024: a phone photo. The window is in the middle and fills a third of its width.
        let w = 4032, h = 3024
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let big = UIGraphicsImageRenderer(size: CGSize(width: w, height: h), format: format).image { ctx in
            let g = ctx.cgContext
            let grad = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [UIColor(white: 0.7, alpha: 1).cgColor, UIColor(white: 0.35, alpha: 1).cgColor] as CFArray, locations: [0, 1])!
            g.drawLinearGradient(grad, start: .zero, end: CGPoint(x: CGFloat(w), y: CGFloat(h)), options: [])
        }
        let jpeg = try XCTUnwrap(big.jpegData(compressionQuality: 0.85))
        let corners = [Vec2(1400, 700), Vec2(2650, 660), Vec2(2680, 2400), Vec2(1380, 2380)]
        let t0 = CFAbsoluteTimeGetCurrent()
        let made = try XCTUnwrap(VisualizerPhoto.make(jpeg: jpeg, corners: corners, widthPx: w, heightPx: h, aspect: VisualizeModel.pictureAspect))
        let c = try XCTUnwrap(WindowCompositor(photo: made.image, quad: made.quad, widthIn: 35, heightIn: 55, viewport: made.viewport))
        let setupMs = (CFAbsoluteTimeGetCurrent() - t0) * 1000
        _ = c.after(look: WindowVisualLook(), colorHex: "#F7F7F4")   // the first draw warms the caches
        let looks = [
            WindowVisualLook(type: .doubleHung, grid: .colonial), WindowVisualLook(type: .casement, grid: .prairie, glass: .lowE),
            WindowVisualLook(type: .picture, grid: .diamond, cleanGlass: true), WindowVisualLook(type: .bay, grid: .colonial),
            WindowVisualLook(type: .slider3, glass: .frosted), WindowVisualLook(type: .arch, grid: .queenAnne, cleanGlass: true),
        ]
        var times: [Double] = []
        var stageLines: [String] = []
        for look in looks {
            let t = CFAbsoluteTimeGetCurrent()
            XCTAssertNotNil(c.after(look: look, colorHex: "#4E3B2C"))
            times.append((CFAbsoluteTimeGetCurrent() - t) * 1000)
            stageLines.append("\(look.type.rawValue): paint \(Int(c.lastStages.paint)) warp \(Int(c.lastStages.warp)) compose \(Int(c.lastStages.compose))")
        }
        let mean = times.reduce(0, +) / Double(times.count)
        // A new colour, grid or glass on the same kind redraws only the layer it changes
        var small: [Double] = []
        for hex in ["#1D1F22", "#E6DCC6", "#7A6650", "#F7F7F4"] {
            let t = CFAbsoluteTimeGetCurrent()
            XCTAssertNotNil(c.after(look: looks[3], colorHex: hex))
            small.append((CFAbsoluteTimeGetCurrent() - t) * 1000)
        }
        let colorMean = small.reduce(0, +) / Double(small.count)
        // Both layers kept: only the Core Image composite and the read-back of the picture
        var again: [Double] = []
        for _ in 0..<3 {
            let t = CFAbsoluteTimeGetCurrent()
            XCTAssertNotNil(c.after(look: looks[3], colorHex: "#F7F7F4"))
            again.append((CFAbsoluteTimeGetCurrent() - t) * 1000)
        }
        let composeMean = again.reduce(0, +) / Double(again.count)
        print("VISUALIZER stages (ms): " + stageLines.joined(separator: "; "))
        print("VISUALIZER 12MP photo: open \(Int(setupMs)) ms (decode + setup, once); \(times.count) new kinds mean \(Int(mean)) ms, worst \(Int(times.max() ?? 0)) ms; \(small.count) new colours mean \(Int(colorMean)) ms; composite and read-back alone \(Int(composeMean)) ms; viewport \(Int(made.viewport.width))x\(Int(made.viewport.height)), layers \(Int(c.pixelsPerInch)) px/in")
        // A Debug build on the simulator is the slow case; the phone's Release build is faster
        XCTAssertLessThan(mean, 150, "redraw times: \(times)")
    }
}

extension StoreHarness {
    /// A measured window, saved, with its id.
    func captured(room: String) async throws -> String {
        let id = await capture(room: room)
        return try XCTUnwrap(id)
    }
}
