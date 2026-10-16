import Foundation
import RooflineCore

let formatChecks: [Check] = [
    Check("Eighths: nearest eighth, reduced fractions") { ctx in
        ctx.equal(Eighths.format(35.875), "35 7/8")
        ctx.equal(Eighths.format(35.9), "35 7/8")
        ctx.equal(Eighths.format(35.95), "36")
        ctx.equal(Eighths.format(36), "36")
        ctx.equal(Eighths.format(0.25), "1/4")
        ctx.equal(Eighths.format(47.5), "47 1/2")
        ctx.equal(Eighths.format(12.0625), "12 1/8") // half an eighth rounds up
        ctx.equal(Eighths.format(-0.5), "-1/2")
        ctx.equal(Eighths.format(.nan), "—")
        ctx.near(Eighths.rounded(35.9), 35.875)
    },
    Check("Eighths: ± rounds up, never below 1/8") { ctx in
        ctx.equal(Eighths.formatUncertainty(0.03), "1/8")
        ctx.equal(Eighths.formatUncertainty(0.125), "1/8")
        ctx.equal(Eighths.formatUncertainty(0.13), "1/4")
        ctx.equal(Eighths.formatUncertainty(1.0), "1")
        ctx.equal(Eighths.formatUncertainty(0), "1/8")
        ctx.equal(Eighths.withPlusMinus(35.875, 0.2), "35 7/8 ± 1/4")
        ctx.equal(Eighths.withPlusMinus(35.875, nil), "35 7/8")
        ctx.equal(Eighths.size(widthIn: 35.875, heightIn: 59.5), "35 7/8 × 59 1/2 in")
    },
]

func json(_ v: Encodable) throws -> [String: Any] {
    let data = try JSONEncoder().encode(AnyEncodable(v))
    return try JSONSerialization.jsonObject(with: data) as! [String: Any]
}

struct AnyEncodable: Encodable {
    let v: Encodable
    init(_ v: Encodable) { self.v = v }
    func encode(to encoder: Encoder) throws { try v.encode(to: encoder) }
}

let serverMeasurementJSON = """
{
  "id": "6f1c2a8e-1111-4c2b-9a55-0123456789ab",
  "propertyId": "aa1c2a8e-1111-4c2b-9a55-0123456789ab",
  "address": "1 Main St, Irvine, CA",
  "center": [-117.8, 33.6],
  "createdAt": "2026-10-16T10:00:00.000Z",
  "photos": [], "windows": [], "estimated": null, "stories": 2, "detector": null, "missing": null, "needsReview": null,
  "tookMs": 1200,
  "adjustments": {
    "excludedWindowIds": [], "manualCounts": {}, "photosCoverAllWindows": false,
    "photoWindows": [
      { "id": "w1", "uploadId": "bb1c2a8e-1111-4c2b-9a55-0123456789ab", "label": "Kitchen", "windowKey": "k1",
        "corners": [[10,10],[100,10],[100,200],[10,200]],
        "scale": { "kind": "ar", "pointsM": [[0,1,-1],[1,1,-1],[1,0,-1],[0,0,-1]], "trackingLostCount": 0 } },
      { "id": "w2", "uploadId": "cc1c2a8e-1111-4c2b-9a55-0123456789ab",
        "corners": [[10,10],[100,10],[100,200],[10,200]],
        "scale": { "kind": "sheet", "paper": "letter", "imagePoints": [[1,2]], "sheetPointsIn": [[0.5,0.5]], "planeOffsetIn": 0.75 } }
    ]
  },
  "photoWindows": [
    { "id": "w1", "uploadId": "bb1c2a8e-1111-4c2b-9a55-0123456789ab", "label": "Kitchen", "windowKey": "k1",
      "corners": [[10,10],[100,10],[100,200],[10,200]],
      "scale": { "kind": "ar", "pointsM": [[0,1,-1],[1,1,-1],[1,0,-1],[0,0,-1]], "trackingLostCount": 0 },
      "widthIn": 39.37, "heightIn": 39.37, "sizeClass": "large", "uncertaintyIn": { "width": 0.2, "height": 0.3 }, "quality": "good" },
    { "id": "w3", "uploadId": "bb1c2a8e-1111-4c2b-9a55-0123456789ab", "windowKey": "k1",
      "corners": [[10,10],[100,10],[100,200],[10,200]],
      "scale": { "kind": "roomplan", "widthM": 1.0, "heightM": 1.0, "confidence": 0.66 },
      "widthIn": 39.5, "heightIn": 39.0, "sizeClass": "large", "uncertaintyIn": null, "quality": "check" },
    { "id": "w2", "uploadId": "cc1c2a8e-1111-4c2b-9a55-0123456789ab",
      "corners": [[10,10],[100,10],[100,200],[10,200]],
      "scale": { "kind": "sheet", "paper": "letter", "imagePoints": [[1,2]], "sheetPointsIn": [[0.5,0.5]], "planeOffsetIn": 0.75 },
      "widthIn": 24, "heightIn": 36, "sizeClass": "small", "quality": "good" }
  ],
  "uploads": [ { "id": "bb1c2a8e-1111-4c2b-9a55-0123456789ab", "widthPx": 1440, "heightPx": 1920, "focal35mm": null, "takenAt": null } ]
}
"""

let apiChecks: [Check] = [
    Check("PhotoWindowInput: an 'ar' window encodes exactly the server's keys") { ctx in
        let w = PhotoWindowInput(id: "w9", uploadId: "u1", label: nil, windowKey: "k", corners: [Vec2(1, 2), Vec2(3, 4), Vec2(5, 6), Vec2(7, 8)],
                                 scale: .ar(ArScale(pointsM: rect(w: 1, h: 1), trackingLostCount: 2, device: .arkitLidar, cornerSpreadM: [0.001, 0.002, 0.001, 0.002])))
        let o = try json(w)
        ctx.equal(Set(o.keys), Set(["id", "uploadId", "windowKey", "corners", "scale"]), "no label key when absent")
        let s = o["scale"] as! [String: Any]
        ctx.equal(Set(s.keys), Set(["kind", "pointsM", "trackingLostCount", "device", "cornerSpreadM"]))
        ctx.equal(s["kind"] as? String, "ar")
        ctx.equal(s["device"] as? String, "arkit-lidar")
        ctx.equal((s["pointsM"] as? [[Double]])?.count, 4)
        ctx.equal((o["corners"] as? [[Double]])?.first ?? [], [1, 2])
        // No device or spread: those keys are left out (an older server's strict schema refuses them)
        let old = PhotoWindowInput(id: "w9", uploadId: "u1", label: "", windowKey: nil, corners: [], scale: .ar(ArScale(pointsM: rect(w: 1, h: 1), trackingLostCount: 0, device: nil, cornerSpreadM: nil)))
        let oo = try json(old)
        ctx.equal(Set(oo.keys), Set(["id", "uploadId", "corners", "scale"]))
        ctx.equal(Set((oo["scale"] as! [String: Any]).keys), Set(["kind", "pointsM", "trackingLostCount"]))
        let rp = try json(PhotoWindowInput(id: "w8", uploadId: "u", label: "Bed 2", windowKey: nil, corners: [], scale: .roomplan(RoomPlanScale(widthM: 0.9, heightM: 1.2, confidence: 1))))
        ctx.equal(Set((rp["scale"] as! [String: Any]).keys), Set(["kind", "widthM", "heightM", "confidence"]))
    },
    Check("WindowMeasurementView: decodes the server's view; other scales pass through unchanged") { ctx in
        let v = try JSONDecoder().decode(WindowMeasurementView.self, from: Data(serverMeasurementJSON.utf8))
        ctx.equal(v.photoWindows?.count, 3)
        ctx.equal(v.adjustments?.photoWindows?.count, 2)
        ctx.equal(v.photoWindows?[1].input.scale.kind, "roomplan")
        ctx.equal(v.photoWindows?[0].uncertaintyIn?.height, 0.3)
        ctx.equal(v.photoWindows?[1].uncertaintyIn, nil)
        let sheet = v.adjustments!.photoWindows![1]
        ctx.equal(sheet.scale.kind, "sheet")
        let again = try JSONDecoder().decode(PhotoWindowInput.self, from: JSONEncoder().encode(sheet))
        ctx.equal(again, sheet, "round trip")
        let back = try json(sheet)["scale"] as! [String: Any]
        ctx.equal(back["planeOffsetIn"] as? Double, 0.75)
        // A sized window re-encoded as input drops the server's fields
        let input = try json(v.photoWindows![0].input)
        ctx.expect(input["widthIn"] == nil && input["quality"] == nil, "input keys only")
        ctx.equal(v.uploads?.first?.widthPx, 1440)
    },
    Check("decodeLatestMeasurement: the view, {measurement}, {measurements}, or nothing") { ctx in
        let view = Data(serverMeasurementJSON.utf8)
        ctx.equal(decodeLatestMeasurement(view)?.address, "1 Main St, Irvine, CA")
        ctx.equal(decodeLatestMeasurement(Data("{\"measurement\": \(serverMeasurementJSON)}".utf8))?.photoWindows?.count, 3)
        ctx.equal(decodeLatestMeasurement(Data("{\"measurements\": [\(serverMeasurementJSON)]}".utf8))?.id, "6f1c2a8e-1111-4c2b-9a55-0123456789ab")
        ctx.expect(decodeLatestMeasurement(Data("{\"measurement\": null}".utf8)) == nil, "null")
        ctx.expect(decodeLatestMeasurement(Data("{\"measurements\": []}".utf8)) == nil, "empty")
    },
    Check("Auth, jobs, properties, errors decode") { ctx in
        let me = try JSONDecoder().decode(AuthMe.self, from: Data("""
        {"user":{"id":"u","email":"rep@x.com","name":"Rep","emailVerified":true},"company":{"id":"c","name":"Acme Roofing","slug":"acme","status":"active"},"role":"rep","companies":[]}
        """.utf8))
        ctx.equal(me.company.name, "Acme Roofing")
        let jobs = try JSONDecoder().decode(JobsResponse.self, from: Data("""
        {"jobs":[{"id":"j","customerId":null,"propertyId":"p","stage":"inspection","stageLabel":"Inspection","stageChangedAt":"x","source":"door","assignedUserId":"u","createdByUserId":"u","lostReason":null,"nextStep":null,"nextStepOn":null,"archivedAt":null,"createdAt":"x","updatedAt":"y"}],"total":1}
        """.utf8))
        ctx.equal(jobs.jobs.first?.propertyId, "p")
        let props = try JSONDecoder().decode(PropertiesResponse.self, from: Data("""
        {"properties":[{"id":"p","customerId":null,"addressLine":"1 Main St","city":"Irvine","state":"CA","zip":"92618","lat":null,"lng":null,"timezone":null,"yearBuilt":null,"archivedAt":null,"createdAt":"x","updatedAt":"y"}],"total":1}
        """.utf8))
        ctx.equal(props.properties.first?.oneLine, "1 Main St, Irvine, CA 92618")
        let err = try JSONDecoder().decode(ApiErrorBody.self, from: Data("{\"error\":\"Nope.\",\"field\":\"photo\"}".utf8))
        ctx.equal(err.field, "photo")
    },
]

let miscChecks: [Check] = [
    Check("WindowGrouping: photos of one window are one window, sized by the median") { ctx in
        let v = try JSONDecoder().decode(WindowMeasurementView.self, from: Data(serverMeasurementJSON.utf8))
        let g = WindowGrouping.groups(v.photoWindows!)
        ctx.equal(g.count, 2)
        ctx.equal(g[0].key, "k1")
        ctx.equal(g[0].name, "Kitchen")
        ctx.equal(g[0].photos.count, 2)
        ctx.near(g[0].widthIn, (39.37 + 39.5) / 2, 1e-9)
        ctx.equal(g[0].needsCheck, true, "a scan photo says check")
        ctx.equal(g[0].scanOnly, false)
        ctx.equal(g[1].name, "Window 2")
        ctx.equal(g[1].needsCheck, false)
        ctx.equal(WindowGrouping.groups(v.photoWindows!, excluded: ["w2"]).count, 1)
    },
    Check("ServerAddress and window ids") { ctx in
        ctx.equal(ServerAddress.normalize("localhost:4500"), "http://localhost:4500")
        ctx.equal(ServerAddress.normalize(" https://mac.tail1234.ts.net/ "), "https://mac.tail1234.ts.net")
        ctx.equal(ServerAddress.normalize("http://192.168.1.20:4500"), "http://192.168.1.20:4500")
        ctx.equal(ServerAddress.normalize("ftp://x"), nil)
        ctx.equal(ServerAddress.normalize("http://x/api"), nil)
        ctx.equal(ServerAddress.normalize(""), nil)
        let id = WindowIds.new()
        ctx.expect(WindowIds.isValid(id), id)
        ctx.expect(!WindowIds.isValid("a b"), "space")
        ctx.expect(!WindowIds.isValid(String(repeating: "a", count: 65)), "too long")
    },
    Check("TestDataCSV: one row per pass, every row as wide as the header, quoted text") { ctx in
        let p = TestPass(at: Date(timeIntervalSince1970: 1_800_000_000), measurementId: "m", windowId: "w", windowKey: "k", label: "Bed, \"north\"", method: "ar", device: "arkit-lidar", lidar: true,
                         pointsM: rect(w: 1, h: 1.2), cornerSpreadM: [0.001, 0.002, 0.003, 0.004], trackingLostCount: 1, restartsForTracking: 1, wallPlaneLocked: true, maxOffPlaneMm: 1.5,
                         widthIn: 39.37, heightIn: 47.24, uncertaintyWidthIn: 0.2, uncertaintyHeightIn: 0.25, quality: "good", reasons: [], durationS: 42)
        let rp = TestPass(measurementId: "m", windowId: "w2", windowKey: nil, label: nil, method: "roomplan", device: "roomplan", lidar: true, pointsM: nil, cornerSpreadM: nil, trackingLostCount: 0, restartsForTracking: 0, wallPlaneLocked: false, maxOffPlaneMm: nil, widthIn: 30, heightIn: 40, uncertaintyWidthIn: 1, uncertaintyHeightIn: 1, quality: "check", reasons: ["scan"], durationS: 90)
        let csv = TestDataCSV.make([rp, p])
        let lines = csv.components(separatedBy: "\r\n").filter { !$0.isEmpty }
        ctx.equal(lines.count, 3)
        // Oldest first: the scan (now), then the AR pass (2027)
        ctx.expect(lines[1].contains(",roomplan,"), lines[1])
        ctx.expect(lines[2].contains("\"Bed, \"\"north\"\"\""), lines[2])
        ctx.expect(lines[2].contains(",39 3/8,"), "eighths column")
        // Count the fields of the row with no quoted text
        ctx.equal(lines[1].split(separator: ",", omittingEmptySubsequences: false).count, TestDataCSV.header.count)
    },
]
