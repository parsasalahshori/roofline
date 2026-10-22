import CoreGraphics
import Foundation
import ImageIO
import RooflineCore

// Replays one Capture that the phone dumped (apps/ios/Core DebugCapture; the server writes it to DEBUG_CAPTURES_DIR/<capture id>/): reads
// the photo, the depth map, the lens, the camera pose and the wall, runs the same finders the phone ran (OpeningFinder's depth opening, then
// the AI pick and the edge refine with the AI answer the phone got) and prints what they make now beside what the phone proposed and what
// the person finally used, so a bad proposal on a real phone can be looked at, and a fix tried, on this Mac.
//
//   swift run RooflineReplay <capture folder> [--boxes answer.json]
//
//   --boxes   a server answer (POST .../detect-windows, as JSON: `curl ... > answer.json`) to use instead of the one the phone recorded,
//             to see what a different detector or segmenter setting would have started from. Apple Vision is not replayed (the app only).

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(2)
}

var args = Array(CommandLine.arguments.dropFirst())
var boxesFile: String?
if let i = args.firstIndex(of: "--boxes") {
    guard i + 1 < args.count else { fail("--boxes needs a file") }
    boxesFile = args[i + 1]
    args.removeSubrange(i...(i + 1))
}
guard let folder = args.first else { fail("usage: RooflineReplay <capture folder> [--boxes answer.json]") }

let bundle: DebugCapture.Bundle
do { bundle = try DebugCapture.Bundle.read(from: URL(fileURLWithPath: folder)) } catch { fail("Could not read the capture in \(folder): \(error)") }
let view = bundle.view
let meta = bundle.meta

// The photo in grey, the way the app cuts patches out of it
guard let source = CGImageSourceCreateWithData(bundle.jpeg as CFData, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fail("photo.jpg is not a picture") }
let (pw, ph) = (image.width, image.height)
var gray = [UInt8](repeating: 0, count: pw * ph)
gray.withUnsafeMutableBytes { raw in
    if let ctx = CGContext(data: raw.baseAddress, width: pw, height: ph, bitsPerComponent: 8, bytesPerRow: pw, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) {
        ctx.interpolationQuality = .none
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: pw, height: ph))
    }
}
if Double(pw) != meta.photoWidthPx || Double(ph) != meta.photoHeightPx { print("warning: photo.jpg is \(pw) x \(ph), capture.json says \(Int(meta.photoWidthPx)) x \(Int(meta.photoHeightPx))") }
let patches: OpeningFinder.PatchSource = { x, y, w, h in
    guard x >= 0, y >= 0, w > 0, h > 0, x + w <= pw, y + h <= ph else { return nil }
    var out = [UInt8](repeating: 0, count: w * h)
    for row in 0..<h { for col in 0..<w { out[row * w + col] = gray[(y + row) * pw + x + col] } }
    return GrayPatch(width: w, height: h, pixels: out)
}

func size(_ r: FrozenRect) -> String { "\(Eighths.format(r.widthM * inchesPerMetre)) x \(Eighths.format(r.heightM * inchesPerMetre)) in" }
func size(_ r: DebugCapture.Rect) -> String { "\(Eighths.format(r.widthIn)) x \(Eighths.format(r.heightIn)) in" }
func corners(_ r: FrozenRect) -> [Vec2] { r.cornersM.compactMap { view.photoPixel(ofWorld: $0) } }
func corners(_ r: DebugCapture.Rect) -> [Vec2] { r.photoCorners.map { Vec2($0[0], $0[1]) } }
/// How far each corner is from the other rectangle's, in the photo's pixels (largest and mean).
func apart(_ a: [Vec2], _ b: [Vec2]) -> String {
    guard a.count == 4, b.count == 4 else { return "n/a" }
    let d = zip(a, b).map { (p, q) in ((p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y)).squareRoot() }
    return String(format: "corners differ by %.0f px at most, %.0f px on average", d.max() ?? 0, d.reduce(0, +) / 4)
}

print("capture \(meta.captureId)  \(meta.createdAt)  \(meta.device ?? "") \(meta.app ?? "")")
print("photo \(pw) x \(ph) px, depth \(meta.depthWidth > 0 ? "\(meta.depthWidth) x \(meta.depthHeight)\(meta.hasConfidence ? " with confidence" : "")" : "none")")

// What the phone recorded
let recorded = bundle.result
if let r = recorded {
    print("\nthe phone: source \(r.source)")
    if let ai = r.ai {
        let q = ai.detection?.quad.map { String(format: ", quad quality %.2f", $0.quality) } ?? ", no quad"
        print("  AI: \(ai.status), \(ai.ms) ms, \(ai.detection?.boxes.count ?? 0) box(es)\(q)")
    } else { print("  AI: not asked") }
    if let p = r.proposed { print("  proposed \(size(p))") }
    if let f = r.final { print("  used     \(size(f))") }
    if let d = r.depthFound { print("  depth alone found \(size(d))") }
} else {
    print("\nthe phone: no result.json yet (the person has not used a size)")
}

// What the finders make now
let reticle = Vec2(view.photoWidthPx / 2, view.photoHeightPx / 2)
let depthFound = view.depth != nil ? OpeningFinder.find(view: view, reticle: reticle, photo: patches) : nil
print("\nreplay:")
if let d = depthFound {
    print("  depth opening: \(size(d.rect)), refined \(d.refined.map { $0 ? "yes" : "no" }.joined(separator: " "))")
} else {
    print("  depth opening: none\(view.depth == nil ? " (no depth)" : "")")
}
var ai = recorded?.ai?.detection
if let file = boxesFile {
    do { ai = try JSONDecoder().decode(WindowDetection.self, from: Data(contentsOf: URL(fileURLWithPath: file))) } catch { fail("Could not read \(file): \(error)") }
    print("  AI answer from \(file)")
}
if let ai = ai {
    for b in ai.boxes { print(String(format: "  AI box  x %.3f y %.3f w %.3f h %.3f conf %.3f", b.x, b.y, b.w, b.h, b.confidence)) }
    if let q = ai.quad { print("  AI quad quality \(q.quality), corners \(q.corners.map { String(format: "(%.3f, %.3f)", $0[0], $0[1]) }.joined(separator: " "))") }
    if let p = AiWindow.pick(ai.boxes) { print(String(format: "  picked  x %.3f y %.3f w %.3f h %.3f", p.x, p.y, p.w, p.h)) } else { print("  no box holds the photo's middle") }
}
let chosen = WindowProposal.choose(view: view, ai: ai, depth: depthFound, photo: patches, vision: { nil })
if let c = chosen {
    print("  proposal: source \(c.source.rawValue), \(size(c.rect)), refined \(c.refined.map { $0 ? "yes" : "no" }.joined(separator: " "))")
} else {
    print("  proposal: none (the phone would try Apple Vision, then start inset)")
}

// Against the phone
if let c = chosen, let r = recorded {
    print("\ncompare:")
    if let p = r.proposed { print("  replay vs what the phone proposed: \(size(c.rect)) vs \(size(p)); \(apart(corners(c.rect), corners(p)))") }
    if let f = r.final { print("  replay vs what the person used:    \(size(c.rect)) vs \(size(f)); \(apart(corners(c.rect), corners(f)))") }
}
if let d = depthFound, let f = recorded?.final {
    print("  depth alone vs what the person used: \(size(d.rect)) vs \(size(f)); \(apart(corners(d.rect), corners(f)))")
}
