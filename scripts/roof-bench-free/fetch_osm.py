"""OpenStreetMap buildings (ODbL) round each benchmark house, from the Overpass API, into free/osm/<slug>.json.

Each file: {"source": "osm", "features": [{"id", "rings": [[[lng, lat], ...]], "props"}]} (outer ring first).
Multipolygon relations keep their outer rings only (holes are irrelevant at house scale).
"""
import sys, time
import requests
from houses import houses, bbox, write, UA, FREE

URL = "https://overpass-api.de/api/interpreter"


def main():
    only = set(sys.argv[1:])
    for h in houses():
        if only and h["slug"] not in only:
            continue
        if (FREE / "osm" / f"{h['slug']}.json").exists():
            continue
        w, s, e, n = bbox(h["lng"], h["lat"])
        q = f'[out:json][timeout:60];(way["building"]({s},{w},{n},{e});relation["building"]({s},{w},{n},{e}););out geom tags;'
        for attempt in range(4):
            try:
                r = requests.post(URL, data={"data": q}, headers={"User-Agent": UA}, timeout=90)
                if r.status_code == 200:
                    break
            except requests.RequestException:
                pass
            time.sleep(5 * (attempt + 1))
        else:
            print("FAILED", h["slug"]); continue
        feats = []
        for el in r.json().get("elements", []):
            rings = []
            if el["type"] == "way" and "geometry" in el:
                rings.append([[p["lon"], p["lat"]] for p in el["geometry"]])
            elif el["type"] == "relation":
                for mem in el.get("members", []):
                    if mem.get("role") == "outer" and "geometry" in mem:
                        rings.append([[p["lon"], p["lat"]] for p in mem["geometry"]])
            if rings:
                feats.append({"id": f"{el['type']}/{el['id']}", "rings": rings, "props": el.get("tags", {})})
        write("osm", h["slug"], {"source": "osm", "license": "ODbL (c) OpenStreetMap contributors", "features": feats})
        print(h["slug"], len(feats), flush=True)
        time.sleep(1.0)


if __name__ == "__main__":
    main()
