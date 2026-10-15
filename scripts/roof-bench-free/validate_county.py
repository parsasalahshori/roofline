"""Validate the county grade against the independent keys it overlaps: EagleView, and lidar (only where the county
source is not itself lidar-derived). Prints one row per house and the medians; writes free/county/validation.json."""
import json, statistics
from houses import houses, FREE
from geo import utm_for, compare
import truths

rows = []
for h in houses():
    tr = utm_for(h["lng"], h["lat"])
    c = truths.county(h, tr)
    if c is None: continue
    meta = truths.county_meta(h["slug"])
    for name, key in (("eagleview", truths.eagleview(h, tr)), ("lidar", truths.lidar(h, tr))):
        if key is None: continue
        if name == "lidar" and meta.get("lidarDerived"): continue
        m = compare(c, key)
        rows.append({"slug": h["slug"], "split": h["split"], "canopy": h["canopy"], "key": name, **m})
        print(h["slug"], h["split"], h["canopy"], name, m)
for k in ("eagleview", "lidar"):
    r = [x for x in rows if x["key"] == k]
    if r:
        print(k, "n", len(r), "median alignedIoU", statistics.median(x["alignedIoU"] for x in r),
              "median |plan err| %", statistics.median(abs(x["planErrPct"]) for x in r),
              "median signed plan err %", statistics.median(x["planErrPct"] for x in r),
              "median boundary m", statistics.median(x["alignedBoundaryM"] for x in r))
(FREE / "county" / "validation.json").write_text(json.dumps(rows, indent=1, sort_keys=True))
