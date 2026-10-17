import Foundation
import RooflineCore

/// One case of apps/ios/RooflineMeasureTests/Fixtures/ar-sizing.json (written by the server's vitest from
/// sizeFromArPoints). The format is read loosely: a top-level array or `{ cases: [...] }`; each case has `pointsM`,
/// optional `device` (null: webxr), `cornerSpreadM`, `name`, and the expected size either at the top level or under
/// `expected` (`widthIn`, `heightIn`, `uncertaintyIn: {width, height}`, `quality`, `order`); a case whose expected
/// value is null is refused (the port must return nil too). The file's `constants` are checked against ArLimits.
public struct ArFixtureCase {
    public var name: String
    public var pointsM: [Vec3]?
    public var device: ArDevice?
    public var cornerSpreadM: [Double]?
    public var order: [Int]?
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
            order: (e["order"] as? [Any])?.compactMap { ($0 as? NSNumber)?.intValue },
            degenerate: expectedRaw is NSNull,
            widthIn: (e["widthIn"] as? NSNumber)?.doubleValue,
            heightIn: (e["heightIn"] as? NSNumber)?.doubleValue,
            uncertaintyWidth: (u?["width"] as? NSNumber)?.doubleValue,
            uncertaintyHeight: (u?["height"] as? NSNumber)?.doubleValue,
            quality: e["quality"] as? String
        )
    }
}

/// The server's constants as the fixture file records them (nil when it does not).
public func loadArFixtureConstants(path: String) -> [String: Any]? {
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
          let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    return root["constants"] as? [String: Any]
}

/// The Swift port against the server's own numbers: width, height, ±, quality and corner order to 1e-6 in (a ±
/// mismatch means ArLimits is out of step with window-photo-math.ts).
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
            let s = sizeFromArPoints(pts, device: c.device, cornerSpreadM: c.cornerSpreadM)
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
            if let o = c.order { ctx.equal(got.order, o, "\(c.name) corner order") }
        }
        if let k = loadArFixtureConstants(path: path) {
            ctx.near((k["inchesPerMetre"] as? NSNumber)?.doubleValue, inchesPerMetre, 0, "inchesPerMetre")
            ctx.near((k["scaleSigma"] as? NSNumber)?.doubleValue, ArLimits.scaleSigma, 0, "scaleSigma")
            ctx.near((k["maxOffPlaneIn"] as? NSNumber)?.doubleValue, ArLimits.maxOffPlaneIn, 0, "maxOffPlaneIn")
            ctx.near((k["maxCornerOffDeg"] as? NSNumber)?.doubleValue, ArLimits.maxCornerOffDeg, 0, "maxCornerOffDeg")
            ctx.near((k["maxSideDiff"] as? NSNumber)?.doubleValue, ArLimits.maxSideDiff, 0, "maxSideDiff")
            let byDevice = k["scaleSigmaByDevice"] as? [String: Any] ?? [:]
            for d in ArDevice.allCases { ctx.near((byDevice[d.rawValue] as? NSNumber)?.doubleValue, ArLimits.scale(d), 0, "scaleSigmaByDevice \(d.rawValue)") }
            let sig = k["pointSigmaM"] as? [String: Any] ?? [:]
            for d in ArDevice.allCases { ctx.near((sig[d.rawValue] as? NSNumber)?.doubleValue, ArLimits.pointSigmaM[d]!, 0, "pointSigmaM \(d.rawValue)") }
        }
    }
}
