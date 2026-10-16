import Foundation
import RooflineCore

/// One case of apps/ios/RooflineMeasureTests/Fixtures/ar-sizing.json (written by the server's vitest from
/// sizeFromArPoints). The format is read loosely: a top-level array or `{ cases: [...] }`; each case has `pointsM`,
/// optional `device`, `cornerSpreadM`, `sigmaM`, `scaleFraction`, `name`, and the expected size either at the top
/// level or under `expected` (`widthIn`, `heightIn`, `uncertaintyIn: {width, height}`, `quality`); a case whose
/// expected value is null is degenerate (the port must return nil too).
public struct ArFixtureCase {
    public var name: String
    public var pointsM: [Vec3]?
    public var device: ArDevice?
    public var cornerSpreadM: [Double]?
    public var sigmaM: Double?
    public var scaleFraction: Double?
    public var degenerate: Bool
    public var widthIn: Double?
    public var heightIn: Double?
    public var uncertaintyWidth: Double?
    public var uncertaintyHeight: Double?
    public var quality: String?
}

public func loadArFixture(path: String) throws -> [ArFixtureCase] {
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    let root = try JSONSerialization.jsonObject(with: data)
    let list: [Any]
    if let a = root as? [Any] {
        list = a
    } else if let o = root as? [String: Any], let a = o["cases"] as? [Any] {
        list = a
    } else {
        return []
    }
    return list.enumerated().compactMap { n, raw in
        guard let c = raw as? [String: Any] else { return nil }
        let nums: (Any?) -> [Double]? = { ($0 as? [Any])?.compactMap { ($0 as? NSNumber)?.doubleValue } }
        let pts = (c["pointsM"] as? [Any])?.compactMap { nums($0).flatMap { Vec3(array: $0) } }
        let expectedRaw = c["expected"]
        let e = (expectedRaw as? [String: Any]) ?? c
        let u = e["uncertaintyIn"] as? [String: Any]
        return ArFixtureCase(
            name: (c["name"] as? String) ?? "case \(n + 1)",
            pointsM: pts?.count == 4 ? pts : nil,
            device: (c["device"] as? String).flatMap { ArDevice(rawValue: $0) },
            cornerSpreadM: nums(c["cornerSpreadM"]),
            sigmaM: (c["sigmaM"] as? NSNumber)?.doubleValue,
            scaleFraction: (c["scaleFraction"] as? NSNumber)?.doubleValue,
            degenerate: expectedRaw is NSNull,
            widthIn: (e["widthIn"] as? NSNumber)?.doubleValue,
            heightIn: (e["heightIn"] as? NSNumber)?.doubleValue,
            uncertaintyWidth: (u?["width"] as? NSNumber)?.doubleValue,
            uncertaintyHeight: (u?["height"] as? NSNumber)?.doubleValue,
            quality: e["quality"] as? String
        )
    }
}

/// The Swift port against the server's own numbers. Width and height must match to 1e-6 in; the ± and quality too
/// (a ± mismatch means ArSigmaModel.default is out of step with window-photo-math.ts).
public func arFixtureCheck(path: String?) -> Check {
    Check("Parity with the server: ar-sizing.json fixtures") { ctx in
        guard let path = path, FileManager.default.fileExists(atPath: path) else {
            ctx.skip("no fixture file yet (\(path ?? "no path")): the server change writes it")
            return
        }
        let cases = try loadArFixture(path: path)
        ctx.expect(!cases.isEmpty, "the fixture has cases")
        for c in cases {
            guard let pts = c.pointsM else {
                ctx.expect(c.degenerate, "\(c.name): unreadable points")
                continue
            }
            let model = ArSigmaModel.default
            let sigma = c.sigmaM ?? model.sigma(device: c.device, cornerSpreadM: c.cornerSpreadM)
            let s = sizeFromArPoints(pts, sigmaM: sigma, scaleFraction: c.scaleFraction ?? (c.device == nil && c.cornerSpreadM == nil ? 0 : model.scaleFraction))
            if c.degenerate {
                ctx.expect(s == nil, "\(c.name): the server finds it degenerate")
                continue
            }
            guard let got = s else {
                ctx.expect(false, "\(c.name): the port returned nil")
                continue
            }
            if let w = c.widthIn { ctx.near(got.widthIn, w, 1e-6, "\(c.name) width") }
            if let h = c.heightIn { ctx.near(got.heightIn, h, 1e-6, "\(c.name) height") }
            if let q = c.quality { ctx.equal(got.quality.rawValue, q, "\(c.name) quality") }
            if let uw = c.uncertaintyWidth { ctx.near(got.uncertaintyWidthIn, uw, 1e-6, "\(c.name) ± width") }
            if let uh = c.uncertaintyHeight { ctx.near(got.uncertaintyHeightIn, uh, 1e-6, "\(c.name) ± height") }
        }
    }
}
