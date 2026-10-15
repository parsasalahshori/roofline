"""The 'county' truth grade: building footprints that counties and states digitized themselves, as answer keys.

For every benchmark house a public (non-ML) footprint source covers, pick the footprint under the house point (or the
nearest within PICK_RADIUS_M), add any footprint touching it (planimetrics often split an attached garage or porch),
and accept it unless it is clearly another structure or out of date. Writes <bench>/free/county/index.json and
<bench>/free/county/<slug>/truth.json (lng/lat rings in the source's own frame: the harness aligns it like EagleView).

Never reads the reconstruction or lidar. The one outside reference is Google buildingInsights' ground area, used only
to refuse a footprint that is a different size class of building (AREA_RATIO bounds, wide on purpose: a canopy-hidden
wing makes Google's area small, and that is exactly the case the grade is for).
"""
import json, math
from pathlib import Path
from shapely.geometry import Point, mapping
from shapely.ops import unary_union
from houses import houses, BENCH, FREE
from geo import utm_for, to_xy

# A house point is a geocode on the roof; a footprint whose edge is more than this far away is not this house's.
PICK_RADIUS_M = 6.0
# Parts closer than this are one building (shared walls drawn as two polygons, attached garage).
TOUCH_M = 0.3
# Footprint plan area / Google ground area outside these bounds: a different structure or a stale footprint.
AREA_RATIO = (0.5, 2.0)

# Each source: how its footprints were made, from the publisher's own metadata (docs/roof-3d/free-sources.md).
SOURCES = {
    "pagis": {"method": "photogrammetric planimetric (stereo aerial compilation, leaf-off); 2004 base, edited since",
              "lidarDerived": False, "credit": "Pulaski Area Geographic Information System (PAgis)",
              "date": lambda p: p.get("VER_DATE"), "accept": lambda p: True},
    "ny-its": {"method": "county planimetrics compiled by NYS ITS (per-feature SOURCE); Microsoft ML rows refused",
               "lidarDerived": False, "credit": "NYS ITS Geospatial Services",
               "date": lambda p: p.get("SOURCEDATE"), "accept": lambda p: "microsoft" not in str(p.get("SOURCE", "")).lower()},
    "indiana": {"method": "lidar-derived (IndianaMap Building Footprints 2016-2020, per-feature lidaryear)",
                "lidarDerived": True, "credit": "IndianaMap / Indiana Geographic Information Office",
                "date": lambda p: p.get("lidaryear"), "accept": lambda p: True},
    "nj-dep": {"method": "lidar-derived (NJ DEP per-feature project); Microsoft rows refused",
               "lidarDerived": True, "credit": "NJ Department of Environmental Protection",
               "date": lambda p: p.get("year"), "accept": lambda p: "microsoft" not in str(p.get("project", "")).lower()},
}


def google_ground_m2(h):
    bi = json.loads((BENCH / h["dir"] / "bi.json").read_text())
    return ((bi.get("solarPotential") or {}).get("wholeRoofStats") or {}).get("groundAreaMeters2")


def pick(src, feats, h, tr):
    pt = Point(*tr.transform(h["lng"], h["lat"]))
    cands = []
    for f in feats:
        if not SOURCES[src]["accept"](f["props"]): continue
        g = to_xy(tr, f["rings"])
        if g is None: continue
        cands.append((g.distance(pt), f, g))
    if not cands: return None, "no-footprint"
    cands.sort(key=lambda c: (c[0], c[1]["id"]))
    d, f0, g0 = cands[0]
    if d > PICK_RADIUS_M: return None, "no-footprint-at-point"
    parts = [(f0, g0)] + [(f, g) for dd, f, g in cands[1:] if g.distance(g0) <= TOUCH_M]
    return parts, None


def main():
    out = FREE / "county"
    out.mkdir(parents=True, exist_ok=True)
    index = {"version": 1, "credit": "County and state GIS building footprints (see each truth.source.credit)",
             "rules": {"pickRadiusM": PICK_RADIUS_M, "touchM": TOUCH_M, "areaRatio": list(AREA_RATIO)}, "houses": {}}
    for h in houses():
        got = [s for s in SOURCES if (FREE / s / f"{h['slug']}.json").exists()]
        if not got: continue
        src = got[0]  # one source per house (no benchmark house is covered by two)
        feats = json.loads((FREE / src / f"{h['slug']}.json").read_text())["features"]
        tr = utm_for(h["lng"], h["lat"])
        parts, why = pick(src, feats, h, tr)
        entry = {"grade": "none", "reasons": [], "source": src, "lidarDerived": SOURCES[src]["lidarDerived"]}
        if parts is None:
            entry["reasons"].append(why)
        else:
            geom = unary_union([g for _, g in parts])
            gm2 = google_ground_m2(h)
            ratio = geom.area / gm2 if gm2 else None
            entry.update({"planAreaM2": round(geom.area, 2), "googleGroundM2": gm2, "areaRatio": round(ratio, 3) if ratio else None,
                          "dates": sorted({str(SOURCES[src]["date"](f["props"])) for f, _ in parts})})
            if ratio is None or not (AREA_RATIO[0] <= ratio <= AREA_RATIO[1]):
                entry["grade"] = "rejected"; entry["reasons"].append("different-structure-or-outdated")
            else:
                entry["grade"] = "county"
                # Rings back in lng/lat from the source's own coordinates (not from the metric reprojection).
                rings = []
                for f, _ in parts:
                    for r in f["rings"]:
                        rings.append({"outer": [[round(x, 8), round(y, 8)] for x, y in r], "holes": []})
                truth = {"slug": h["slug"], "ok": True, "version": 1, "grade": "county",
                         "source": {"name": src, "method": SOURCES[src]["method"], "lidarDerived": SOURCES[src]["lidarDerived"],
                                    "credit": SOURCES[src]["credit"], "featureIds": sorted(f["id"] for f, _ in parts), "dates": entry["dates"]},
                         "outline": rings, "planAreaM2": round(geom.area, 2)}
                (out / h["slug"]).mkdir(exist_ok=True)
                (out / h["slug"] / "truth.json").write_text(json.dumps(truth, sort_keys=True, indent=1))
        index["houses"][h["slug"]] = entry
        print(h["slug"], entry["grade"], entry["reasons"], entry.get("areaRatio"), entry.get("dates"))
    (out / "index.json").write_text(json.dumps(index, sort_keys=True, indent=1))


if __name__ == "__main__":
    main()
