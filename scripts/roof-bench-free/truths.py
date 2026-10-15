"""Loaders for every answer key the comparison scores on, as shapely geometry in the house's UTM metres.

eagleview: the report's roof outline (testset*/<slug>/eagleview.json), the frame offset removed by the aligned metrics.
lidar: accepted USGS 3DEP lidar truth (lidar/index.json grade 'lidar'), already registered to Google's frame.
county: this track's county/state footprint grade (free/county/index.json grade 'county').
"""
import json
from houses import BENCH, FREE
from geo import to_xy


def eagleview(h, tr):
    f = BENCH / h["dir"] / "eagleview.json"
    if h["truth"] != "eagleview" or not f.exists(): return None
    o = json.loads(f.read_text())["outline"]
    polys = [o["coordinates"]] if o["type"] == "Polygon" else o["coordinates"]
    return to_xy(tr, [p[0] for p in polys])


_lidx = None
def lidar(h, tr):
    global _lidx
    if _lidx is None: _lidx = json.loads((BENCH / "lidar" / "index.json").read_text())["houses"]
    if (_lidx.get(h["slug"]) or {}).get("grade") != "lidar": return None
    t = json.loads((BENCH / "lidar" / h["slug"] / "truth.json").read_text())
    return to_xy(tr, [p["outer"] for p in t["outline"]])


_cidx = None
def county(h, tr):
    global _cidx
    if _cidx is None:
        p = FREE / "county" / "index.json"
        _cidx = json.loads(p.read_text())["houses"] if p.exists() else {}
    e = _cidx.get(h["slug"]) or {}
    if e.get("grade") != "county": return None
    t = json.loads((FREE / "county" / h["slug"] / "truth.json").read_text())
    g = to_xy(tr, [p["outer"] for p in t["outline"]])
    return g


def county_meta(slug):
    p = FREE / "county" / "index.json"
    return (json.loads(p.read_text())["houses"].get(slug) or {}) if p.exists() else {}
