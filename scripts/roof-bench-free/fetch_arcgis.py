"""Building footprints from public ArcGIS REST layers (county/state GIS) round each benchmark house it covers.

Usage: fetch_arcgis.py <source-name>   (sources are listed in SOURCES; each declares its layer URL and the states or
counties it covers, so a house outside its area is never queried). Writes free/<source>/<slug>.json in the shared
format ({"features": [{"id", "rings", "props"}]}); a source that returns nothing for a house writes an empty list.
Queries ask for WGS84 output (outSR=4326) within RADIUS_M of the house, 30 s timeout, 4 MB response limit.
"""
import json, sys, time
import requests
from houses import houses, bbox, write, UA, FREE

MAX_BYTES = 4 * 1024 * 1024

# Coverage boxes are generous lng/lat rectangles round the jurisdiction; the service itself is the real filter.
SOURCES = {
    "pagis": {
        "url": "https://www.pagis.org/arcgis/rest/services/MAPS/OperationalLayers_Basic/MapServer/9",
        "box": (-92.80, 34.55, -92.05, 35.00),  # Pulaski County, AR
        "license": "Pulaski Area GIS (PAgis) public map service; see docs/roof-3d/free-sources.md",
    },
    "geostor-composite": {
        "url": "https://gis.arkansas.gov/arcgis/rest/services/FEATURESERVICES/Structure/FeatureServer/54",
        "box": (-94.62, 33.00, -89.64, 36.50),  # Arkansas
        "license": "Arkansas GIS Office (Microsoft ML + FEMA USA Structures composite)",
    },
    "nj-dep": {
        "url": "https://mapsdep.nj.gov/arcgis/rest/services/Features/Structures/MapServer/8",
        "box": (-75.60, 38.90, -73.88, 41.36),  # New Jersey
        "license": "NJ DEP public map service (per-feature 'project': mostly lidar-derived, some Microsoft ML)",
    },
    "ny-its": {
        "url": "https://gisservices.its.ny.gov/arcgis/rest/services/BuildingFootprints/FeatureServer/2",
        "box": (-79.77, 40.49, -71.85, 45.02),  # New York
        "license": "NYS ITS Geospatial Services public service (per-feature SOURCE: county planimetrics or Microsoft)",
    },
    "indiana": {
        "url": "https://gisdata.in.gov/server/rest/services/Hosted/Building_Footprints/FeatureServer/0",
        "box": (-88.10, 37.77, -84.78, 41.77),  # Indiana
        "license": "IndianaMap public service (Indiana Building Footprints 2016-2020, lidar-derived)",
    },
}


def fetch(src, h):
    w, s, e, n = bbox(h["lng"], h["lat"])
    params = {"f": "geojson", "where": "1=1", "geometry": f"{w},{s},{e},{n}", "geometryType": "esriGeometryEnvelope",
              "inSR": 4326, "outSR": 4326, "spatialRel": "esriSpatialRelIntersects", "outFields": "*", "returnGeometry": "true"}
    for attempt in range(3):
        try:
            r = requests.get(src["url"] + "/query", params=params, headers={"User-Agent": UA}, timeout=30, stream=True)
            body = r.raw.read(MAX_BYTES + 1, decode_content=True)
            if len(body) > MAX_BYTES: raise RuntimeError("response too large")
            if r.status_code == 200:
                d = json.loads(body)
                if "error" in d: raise RuntimeError(str(d["error"])[:200])
                return d
        except (requests.RequestException, ValueError) as err:
            print("retry", h["slug"], err, flush=True)
        time.sleep(3 * (attempt + 1))
    raise RuntimeError("failed")


def main():
    name = sys.argv[1]
    src = SOURCES[name]
    x0, y0, x1, y1 = src["box"]
    for h in houses():
        if not (x0 < h["lng"] < x1 and y0 < h["lat"] < y1):
            continue
        d = fetch(src, h)
        feats = []
        for i, f in enumerate(d.get("features", [])):
            g = f.get("geometry") or {}
            polys = [g["coordinates"]] if g.get("type") == "Polygon" else g.get("coordinates", []) if g.get("type") == "MultiPolygon" else []
            rings = [p[0] for p in polys if p]
            if rings:
                feats.append({"id": f"{name}/{f.get('id', i)}", "rings": rings, "props": f.get("properties", {})})
        write(name, h["slug"], {"source": name, "layer": src["url"], "license": src["license"], "features": feats})
        print(h["slug"], len(feats), flush=True)


if __name__ == "__main__":
    main()
