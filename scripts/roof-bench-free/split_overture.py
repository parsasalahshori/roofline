"""OpenStreetMap buildings as Overture carries them (free/overture features whose first source is OpenStreetMap) into
free/osm-ov/<slug>.json: the same OSM geometry as the Overpass pull (fetch_osm.py, slow: one house a minute), for
every house at once. The Overpass files, where present, are the cross-check."""
import json
from houses import houses, write, FREE

for h in houses():
    d = json.loads((FREE / "overture" / f"{h['slug']}.json").read_text())
    feats = [f for f in d["features"] if (f["props"].get("sources") or [{}])[0].get("dataset") == "OpenStreetMap"]
    write("osm-ov", h["slug"], {"source": "osm-ov", "release": d["release"], "license": "ODbL (c) OpenStreetMap contributors, via Overture", "features": feats})
