"""Shared helpers: the benchmark houses (slug, split, point) and the free-data folder.

Everything this track writes lives under <ROOF_BENCH_DIR>/free/ (never in the repo). No Google request is made here.
"""
import json
import os
from pathlib import Path

BENCH = Path(os.environ.get("ROOF_BENCH_DIR", "/Users/parsasalahshori-a/RooflineWork/roof-bench"))
FREE = BENCH / "free"
UA = "roofline-bench/0.1 (internal research; contact salahshp@uci.edu)"
# Buildings are pulled within this many metres of the house point (a house plus its neighbours; a lot is < 60 m).
RADIUS_M = 70.0


def houses():
    m = json.loads((BENCH / "manifest.json").read_text())
    out = []
    for h in m["houses"]:
        lng, lat = h["point"]
        out.append({"slug": h["slug"], "split": h["split"], "truth": h["truth"], "state": h["region"]["state"],
                    "metro": h["region"]["metro"], "lng": lng, "lat": lat, "dir": h["dir"],
                    "canopy": (h["tags"].get("canopy") or {}).get("class")})
    return out


def bbox(lng, lat, r=RADIUS_M):
    import math
    dlat = r / 111_320.0
    dlng = r / (111_320.0 * math.cos(math.radians(lat)))
    return lng - dlng, lat - dlat, lng + dlng, lat + dlat


def write(source, slug, payload):
    d = FREE / source
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{slug}.json").write_text(json.dumps(payload, sort_keys=True, separators=(",", ":")))
