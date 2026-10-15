"""Free-provider comparison: our reconstruction against free footprint sources and Google buildingInsights, on every
answer key (EagleView, lidar, county), DEV and HELD-OUT separately, broken down by tree cover.

Sources (each a building at the house point: the polygon containing it, else the nearest within PICK_RADIUS_M, plus
polygons touching it, the same rule county_truth.py uses for the county grade):
  ours            the product's reconstruction (free/ours, roof-3d-free-dump.ts), Google's frame
  google-bi       Google Solar buildingInsights: wholeRoofStats ground/sloped area and segment pitches; no outline
  ms              Microsoft Global ML Building Footprints (free/ms)
  osm             OpenStreetMap buildings (free/osm, where fetched)
  overture        Overture buildings (free/overture; mostly OSM + Microsoft/Esri ML, per-feature sources)
  geostor         Arkansas GIS Office composite (Microsoft + FEMA USA Structures), Arkansas only
  county          the county grade's own footprint (only scored on EagleView and lidar, never on itself)
Independence: a source is never scored on a key built from it (county on county); geostor/ms share Microsoft's model.
Outline metrics are aligned (best translation <= 3 m, as the harness does for EagleView) for every source alike, so a
frame offset costs nobody; plan-area error is frame-free. Writes free/comparison.json; prints per-house rows to stderr.
"""
import json, math, statistics, sys
from collections import defaultdict
from shapely.geometry import Point
from shapely.ops import unary_union
from houses import houses, BENCH, FREE
from geo import utm_for, to_xy, compare
import truths
from county_truth import PICK_RADIUS_M, TOUCH_M

SQFT = 10.7639104167
# County sources that OpenStreetMap imported wholesale: Orange County CA buildings (OSM source tag
# 'esri/Orange_County_CA_Buildings_v3') and Oregon Metro RLIS (the Portland building import). OSM, and Overture's
# OSM-derived features, are copies of these keys there, so they are never scored on them.
OSM_IMPORTED_COUNTY = {"ocgis", "rlis"}
OSM_DERIVED = {"osm", "osm-ov", "overture"}
FOOTPRINTS = ["ms", "osm", "osm-ov", "overture", "geostor-composite"]


def lidar_derived(props):
    """A footprint traced from lidar (Overture's 'USGS Lidar' source, an OSM import tagged with a lidar source) is not
    independent of the lidar truth: it is never scored on it."""
    srcs = props.get("sources") or []
    if any("lidar" in str(s.get("dataset", "")).lower() for s in srcs): return True
    return any("lidar" in str(props.get(k, "")).lower() for k in ("source", "source:geometry", "building:source"))


def pick_any(feats, h, tr, with_flag=False):
    pt = Point(*tr.transform(h["lng"], h["lat"]))
    c = []
    for f in feats:
        g = to_xy(tr, f["rings"])
        if g is not None: c.append((g.distance(pt), f["id"], g, lidar_derived(f.get("props") or {})))
    if not c: return (None, False) if with_flag else None
    c.sort(key=lambda x: (x[0], x[1]))
    if c[0][0] > PICK_RADIUS_M: return (None, False) if with_flag else None
    g0 = c[0][2]
    parts = [c[0]] + [x for x in c[1:] if x[2].distance(g0) <= TOUCH_M]
    geom = unary_union([x[2] for x in parts])
    return (geom, any(x[3] for x in parts)) if with_flag else geom


def x12(deg):
    return 12 * math.tan(math.radians(deg))


def dominant(items):
    acc = defaultdict(float)
    for p, a in items: acc[round(p)] += a
    return max(acc.items(), key=lambda kv: (kv[1], -kv[0]))[0] if acc else None


def main():
    rows = []
    for h in houses():
        tr = utm_for(h["lng"], h["lat"])
        ours = json.loads((FREE / "ours" / f"{h['slug']}.json").read_text())
        keys = {}
        ev = truths.eagleview(h, tr)
        if ev is not None:
            e = json.loads((BENCH / h["dir"] / "eagleview.json").read_text())
            pp = e.get("predominant_pitch")
            keys["eagleview"] = {"geom": ev, "slopedM2": e["total_sloped_sqft"] / SQFT, "pitch": float(pp.split("/")[0]) if pp else None}
        li = truths.lidar(h, tr)
        if li is not None:
            t = json.loads((BENCH / "lidar" / h["slug"] / "truth.json").read_text())
            keys["lidar"] = {"geom": li, "slopedM2": t["slopedAreaM2"], "pitch": t["mainPitchX12"]}
        co = truths.county(h, tr)
        if co is not None:
            keys["county"] = {"geom": co, "slopedM2": None, "pitch": None, "lidarDerived": truths.county_meta(h["slug"]).get("lidarDerived")}
        if not keys: continue
        cands = {}
        if ours["roof"] is not None:
            r = ours["roof"]
            cands["ours"] = {"geom": to_xy(tr, [r["outline"]]), "slopedM2": r["slopedSqFt"] / SQFT,
                             "pitch": dominant([(f["pitchX12"], f["slopedSqFt"]) for f in r["faces"] if not f["flat"]])}
        g = ours["google"]
        if g["wholeRoof"] is not None:
            cands["google-bi"] = {"geom": None, "planM2": g["wholeRoof"]["groundM2"], "slopedM2": g["wholeRoof"]["areaM2"],
                                  "pitch": dominant([(x12(s["pitchDeg"]), s["areaM2"] or 0) for s in g["segments"] if s["pitchDeg"] is not None])}
        for s in FOOTPRINTS:
            f = FREE / s / f"{h['slug']}.json"
            if not f.exists(): continue
            geom, ld = pick_any(json.loads(f.read_text())["features"], h, tr, with_flag=True)
            if geom is not None: cands[s] = {"geom": geom, "lidarDerived": ld}
        if co is not None:
            pass
        cmeta = truths.county_meta(h["slug"])
        if cmeta.get("grade") == "county":
            cands["county"] = {"geom": co, "lidarDerived": cmeta.get("lidarDerived")}
        for kname, k in keys.items():
            for cname, c in cands.items():
                if cname == kname: continue  # never score a source on itself
                if kname == "lidar" and c.get("lidarDerived"): continue  # circular: traced from lidar
                if kname == "county" and cname in OSM_DERIVED and cmeta.get("source") in OSM_IMPORTED_COUNTY: continue
                row = {"slug": h["slug"], "split": h["split"], "canopy": h["canopy"] or "unknown", "key": kname, "source": cname}
                if c.get("geom") is not None:
                    row.update(compare(c["geom"], k["geom"]))
                else:
                    plan = c.get("planM2")
                    row["planErrPct"] = round(100 * (plan - k["geom"].area) / k["geom"].area, 2) if plan else None
                if k.get("slopedM2") and c.get("slopedM2"):
                    row["slopedErrPct"] = round(100 * (c["slopedM2"] - k["slopedM2"]) / k["slopedM2"], 2)
                if k.get("pitch") is not None and c.get("pitch") is not None:
                    row["pitchErr"] = abs(round(c["pitch"]) - round(k["pitch"]))
                rows.append(row)
                print(json.dumps(row), file=sys.stderr)
    (FREE / "comparison.json").write_text(json.dumps(rows, indent=1, sort_keys=True))
    print(len(rows), "rows")


if __name__ == "__main__":
    main()
